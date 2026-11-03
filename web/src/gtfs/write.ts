import JSZip from 'jszip'
import Papa from 'papaparse'
import type { GtfsFeed, GtfsTable } from './load'

/**
 * GTFS の書き出し(取り決め 1104 §9)。
 *
 * - 書き換えた表は serializeTable で CSV にする。書き方(BOM、改行、見出し、最後の改行)は読み込んだときに合わせる
 * - 書き換えない表は、元の ZIP のエントリのバイト列をそのまま写す
 * - 同じ入力からは同じバイト列にする(エントリの日時は作成日時から作り、機械の時刻帯に左右されない)
 */

const BOM_CHAR = '﻿'
/** 引用符で囲む必要のある文字(Python の csv.QUOTE_MINIMAL と同じ。前後の空白では囲まない) */
const NEEDS_QUOTE = /[",\r\n]/

function quote(value: string): string {
  return NEEDS_QUOTE.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * 元の見出しの文字列から、読み込みと同じ規則で列名を取り出す(load.ts の loadGtfsZip と同じ Papa Parse の設定)。
 * 同じ列名の2つ目以降は Papa Parse が名前を変えるので、それも読み込みのときと同じになる
 */
function fieldsOfHeader(header: string): string[] {
  if (header === '') return []
  const parsed = Papa.parse<Record<string, string>>(header, {
    header: true,
    delimiter: ',',
    newline: '\n',
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  return parsed.meta.fields ?? []
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i])
}

/**
 * 表を CSV のバイト列(UTF-8)にする。
 *
 * - 見出し:列が読み込んだときと同じなら元の1行目をそのまま書く。違えば(列を足した feed_info など)列名を , でつなぐ
 * - 各行は fields の順に値を並べる。列が無い値は空。値は元のまま(前後の空白も残す)
 * - 値に , " CR LF のどれかがあるときだけ " で囲み、中の " は2つにする
 * - 改行・BOM・最後の改行は format に従う。format が無い表(手で作った表)は CRLF、BOM なし、最後に改行を付ける
 *
 * 読み込みで落ちるもの(空行、引用符の有無、値の中の CRLF)は戻らない
 */
export function serializeTable(table: GtfsTable): Uint8Array {
  const format = table.format
  const newline = format?.newline ?? '\r\n'
  const header =
    format && sameFields(table.fields, fieldsOfHeader(format.header)) ? format.header : table.fields.map(quote).join(',')

  const fields = table.fields
  const lines = new Array<string>(table.rows.length + 1)
  lines[0] = header
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i]
    let line = ''
    for (let j = 0; j < fields.length; j++) {
      const value = row[fields[j]] ?? ''
      line += j === 0 ? quote(value) : `,${quote(value)}`
    }
    lines[i + 1] = line
  }

  const finalNewline = format?.finalNewline ?? true
  const text = (format?.bom ? BOM_CHAR : '') + lines.join(newline) + (finalNewline ? newline : '')
  return new TextEncoder().encode(text)
}

export interface WriteGtfsZipInput {
  /** 読み込んだ元の ZIP のバイト列 */
  original: ArrayBuffer
  base: GtfsFeed
  edited: GtfsFeed
  /** 作成日時 'YYYYMMDDhhmm'(日本時間)。ZIP のエントリの日時に使う */
  generatedAt: string
  /** ATTRIBUTION.md の中身(UTF-8、BOM なし、改行は '\n')。画面が出典の文から作る */
  attribution: string
}

const GENERATED_AT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/**
 * ZIP のエントリに入れる日時。JSZip は ZIP の日時(DOS の日時)を getUTCHours などで書くので、
 * UTC の値に日本時間の数字を入れておくと、ZIP には日本時間の壁時計の日時が入る(機械の時刻帯によらない)
 */
export function zipEntryDate(generatedAt: string): Date {
  const m = GENERATED_AT.exec(generatedAt)
  if (!m) throw new Error(`作成日時の形が正しくありません(${JSON.stringify(generatedAt)})。YYYYMMDDhhmm の12桁にしてください。`)
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])))
}

/** 出力する ZIP の名前。'{入力の ZIP 名から .zip を除いたもの}_dispatcher_{generatedAt}.zip' */
export function exportFileName(inputName: string, generatedAt: string): string {
  const stem = inputName.replace(/\.zip$/i, '')
  return `${stem}_dispatcher_${generatedAt}.zip`
}

function baseName(path: string): string {
  return path.split('/').pop() ?? ''
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

/** 表として読むエントリなら、表の名前(拡張子を除いて小文字)。load.ts の loadGtfsZip と同じ規則 */
function tableNameOf(path: string): string | null {
  const fileName = baseName(path)
  const lower = fileName.toLowerCase()
  if (!lower.endsWith('.txt') || fileName.startsWith('.')) return null
  return lower.slice(0, -'.txt'.length)
}

const ATTRIBUTION = 'ATTRIBUTION.md'
const ATTRIBUTION_FALLBACK = 'ATTRIBUTION_dispatcher.md'

/**
 * 編集後の GTFS を ZIP に書く。
 *
 * - 元の ZIP のエントリを元の順で書く。表の名前ごとに、編集後の表が基準と別の参照なら serializeTable の結果、
 *   同じ参照なら元のエントリのバイト列をそのまま書く。フォルダの中のエントリはフォルダごと保つ
 * - .txt 以外のエントリもそのまま写す。__MACOSX/ とフォルダだけのエントリは写さない
 * - 編集後にだけある表(作った feed_info)は trips.txt と同じフォルダの最後に足す
 * - 出典のファイル ATTRIBUTION.md を trips.txt と同じフォルダの最後に足す。基準に同じ名前のエントリがあれば
 *   そのエントリは元のまま写し、出典のファイルは ATTRIBUTION_dispatcher.md にする
 * - 基準にある表は、すべて出力にある(編集後に無ければ誤りとして止める)
 * - 圧縮は DEFLATE。エントリの日時は generatedAt(日本時間の数字)
 */
export async function writeGtfsZip(input: WriteGtfsZipInput): Promise<Blob> {
  let source: JSZip
  try {
    source = await JSZip.loadAsync(input.original)
  } catch {
    throw new Error('元の ZIP を開けませんでした。GTFS を読み込み直してください。')
  }
  const date = zipEntryDate(input.generatedAt)
  const options = { date, binary: true, createFolders: false } as const
  const out = new JSZip()

  const entries = Object.values(source.files).filter((e) => !e.dir && !e.name.startsWith('__MACOSX/'))
  const written = new Set<string>()
  let tripsFolder: string | null = null

  for (const entry of entries) {
    const name = tableNameOf(entry.name)
    const baseTable = name === null ? undefined : input.base.tables.get(name)
    if (name !== null && baseTable) {
      if (name === 'trips') tripsFolder = folderOf(entry.name)
      const editedTable = input.edited.tables.get(name)
      if (!editedTable) throw new Error(`出力する GTFS に ${baseTable.fileName} がありません。読み込んだ GTFS にある表はすべて出力します。`)
      written.add(name)
      if (editedTable !== baseTable) {
        out.file(entry.name, serializeTable(editedTable), options)
        continue
      }
    }
    out.file(entry.name, await entry.async('uint8array'), options)
  }

  for (const [name, table] of input.base.tables) {
    if (!written.has(name)) throw new Error(`${table.fileName} が元の ZIP にありません。読み込んだ ZIP と同じものを渡してください。`)
  }

  const folder = tripsFolder ?? ''
  for (const [name, table] of input.edited.tables) {
    if (input.base.tables.has(name)) continue
    out.file(`${folder}${table.fileName}`, serializeTable(table), options)
  }

  const taken = new Set(entries.map((e) => e.name.toLowerCase()))
  const attributionName = taken.has(`${folder}${ATTRIBUTION}`.toLowerCase()) ? ATTRIBUTION_FALLBACK : ATTRIBUTION
  out.file(`${folder}${attributionName}`, new TextEncoder().encode(input.attribution), options)

  return out.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
