import JSZip from 'jszip'
import Papa from 'papaparse'

/** 1行分の値。列が足りない行では、その列のキーが無いことがある */
export type GtfsRow = Record<string, string | undefined>

/**
 * 読み込んだファイルの書き方。書き出し(write.ts の serializeTable)で、書き換えた表を入力と同じ書き方にするために残す。
 * 手で作る表(テスト)には無くてよい
 */
export interface TableFormat {
  /** ZIP の中のエントリ名(フォルダを含む) */
  path: string
  bom: boolean
  /** ファイルの中で最初に出てくる改行。改行が無ければ '\r\n' */
  newline: '\r\n' | '\n'
  /** 1行目の元の文字列(BOM と改行を除く) */
  header: string
  /** 最後の行が改行で終わっている */
  finalNewline: boolean
}

export interface GtfsTable {
  /** ZIP の中の元のファイル名(フォルダを除く) */
  fileName: string
  /** 列名(入力の順番のまま。出力で同じ列・順番にするために残す) */
  fields: string[]
  rows: GtfsRow[]
  /** 読み込んだファイルの書き方(loadGtfsZip が入れる) */
  format?: TableFormat
}

export interface GtfsWarning {
  file: string
  /** ファイルの中の行番号(見出しを1行目とする)。ファイル全体の問題では無い */
  line?: number
  message: string
}

export interface GtfsFeed {
  /** ファイル名から拡張子を除き、小文字にした名前(stops、stop_times など)ごとの表 */
  tables: Map<string, GtfsTable>
  /** 読み込みは続けられたが、確かめたほうがよい点 */
  warnings: GtfsWarning[]
}

const BOM = /^\uFEFF/
const BOM_CHAR = '\uFEFF'
const REPLACEMENT_CHAR = '\uFFFD'

const WARNING_MESSAGES: Record<string, string> = {
  TooFewFields: '列が見出しより少ない行があります',
  TooManyFields: '列が見出しより多い行があります',
}

/**
 * GTFS の ZIP を開き、各 .txt を表として読む。
 * ファイル選択とサンプルの読み込みは、どちらもここを通す。
 * 値は文字列のまま、前後の空白も含めて元のまま返す(型の変換と検証は後の段で行う)。
 */
export async function loadGtfsZip(data: Blob | ArrayBuffer): Promise<GtfsFeed> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new Error('ZIP として開けませんでした。GTFS の ZIP ファイルを選んでください。')
  }

  const tables = new Map<string, GtfsTable>()
  const warnings: GtfsWarning[] = []

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry.name.startsWith('__MACOSX/')) continue
    // フォルダに入れて圧縮された ZIP もあるため、ファイル名だけを見る
    const fileName = entry.name.split('/').pop() ?? ''
    const lower = fileName.toLowerCase()
    if (!lower.endsWith('.txt') || fileName.startsWith('.')) continue

    const name = lower.slice(0, -'.txt'.length)
    if (tables.has(name)) {
      throw new Error(`同じ名前のファイル(${fileName})が ZIP の中に複数あります。1つの GTFS だけを入れた ZIP を選んでください。`)
    }

    const raw = await entry.async('string')
    const format = formatOf(entry.name, raw)
    const text = raw.replace(BOM, '').replace(/\r\n?/g, '\n')
    if (text.includes(REPLACEMENT_CHAR)) {
      warnings.push({ file: fileName, message: 'UTF-8 として読めない文字があります(GTFS-JP は UTF-8 が必須です)' })
    }

    const parsed = Papa.parse<GtfsRow>(text, {
      header: true,
      delimiter: ',',
      newline: '\n',
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    })

    for (const err of parsed.errors) {
      // 見出しが1行目なので、データの n 行目(0 始まり)はファイルの n + 2 行目
      const line = err.row === undefined ? undefined : err.row + 2
      if (err.code === 'MissingQuotes') {
        // 以降の行が1つの値に吸い込まれ、行が消えるため止める。
        // この場合の row は実際の行とずれるので、引用符の位置(index)から行を数える
        const quoteLine = err.index === undefined ? line : text.slice(0, err.index).split('\n').length
        throw new Error(`${fileName} の ${quoteLine ?? '?'} 行目付近に、閉じていない引用符(")があります。`)
      }
      warnings.push({ file: fileName, line, message: WARNING_MESSAGES[err.code] ?? `読み取りに問題があります(${err.code})` })
    }

    const renamed = parsed.meta.renamedHeaders
    if (renamed && Object.keys(renamed).length > 0) {
      warnings.push({ file: fileName, line: 1, message: `同じ列名が複数あります(${Object.values(renamed).join('、')})` })
    }

    // 列が多い行に付く __parsed_extra は表に残さない(警告には出している)
    const rows = parsed.data.map((row) => {
      if (!('__parsed_extra' in row)) return row
      const { __parsed_extra: _extra, ...rest } = row
      return rest
    })
    tables.set(name, { fileName, fields: parsed.meta.fields ?? [], rows, format })
  }

  if (tables.size === 0) throw new Error('GTFS のファイル(.txt)が見つかりません。')
  return { tables, warnings }
}

/**
 * ファイルの書き方(BOM、改行、見出しの元の文字列、最後の改行)を、改行をそろえる前の文字列から読む。
 * 改行は最初に出てくるもの(LF の前が CR なら CRLF)。LF が1つも無ければ CRLF とする
 */
function formatOf(path: string, raw: string): TableFormat {
  const bom = raw.startsWith(BOM_CHAR)
  const body = bom ? raw.slice(BOM_CHAR.length) : raw
  const lf = body.indexOf('\n')
  const newline = lf > 0 && body[lf - 1] === '\r' ? '\r\n' : lf >= 0 ? '\n' : '\r\n'
  const header = body.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const finalNewline = body.endsWith('\n') || body.endsWith('\r')
  return { path, bom, newline, header, finalNewline }
}
