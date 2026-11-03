import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyForm2, type Form2Result } from './edit/form2'
import type { Form2Plan } from './edit/ops'
import { loadGtfsZip, type GtfsFeed } from './load'
import { serializeTable, writeGtfsZip, zipEntryDate } from './write'

// 道北バスの GTFS(data/raw/gtfs/ に置く。コミットしない)。ファイルがあるときだけ走る。
// 書き出す編集は、形2の正解データ(edit/form2.golden.json)の main の場面の方針。
// 正解データとの照合(書き換えた 5 表の SHA-256)は、ZIP の SHA-256 が正解データと合うときだけ行う(取り決め 1104 §11)
const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./edit/form2.golden.json', import.meta.url))
const GENERATED_AT = '202611041200'
/** 形2で書き換える表(§5.9)。ほかの表は元のエントリのバイト列のまま写す */
const REWRITTEN = ['trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_info']
const ATTRIBUTION_TEXT = '# 出典\n\n元データ:道北バス GTFS(北海道オープンデータプラットフォーム)。\n'

interface Golden {
  input: { sha256: string }
  generatedAt: string
  scenarios: {
    main: {
      policy: Omit<Form2Plan, 'kind'>
      summary: { files: Record<string, { rows: number; sha256: string }> }
    }
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 表として読むエントリなら、表の名前(拡張子を除いて小文字)。write.ts・load.ts と同じ規則 */
function tableNameOf(path: string): string | null {
  const fileName = path.split('/').pop() ?? ''
  const lower = fileName.toLowerCase()
  if (!lower.endsWith('.txt') || fileName.startsWith('.')) return null
  return lower.slice(0, -'.txt'.length)
}

/** ZIP のファイルのエントリ(フォルダだけのエントリと __MACOSX/ を除く)を、ZIP の中の順に */
function fileEntries(zip: JSZip): JSZip.JSZipObject[] {
  return Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith('__MACOSX/'))
}

const golden: Golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'))

describe.skipIf(!existsSync(ZIP))('道北バス(9/17 版)の書き出し(正解データの main の方針)', () => {
  let original: ArrayBuffer
  let base: GtfsFeed
  let result: Form2Result
  let source: JSZip
  let output: JSZip
  let written: ArrayBuffer
  let matches = false

  beforeAll(async () => {
    const buf = readFileSync(ZIP)
    const digest = sha256(buf)
    matches = digest === golden.input.sha256
    if (!matches) {
      console.warn(`道北バスの ZIP の SHA-256(${digest})が正解データ(${golden.input.sha256})と違うため、正解データとの照合を飛ばします。`)
    }
    original = toArrayBuffer(buf)
    base = await loadGtfsZip(original)
    // applyForm2 と writeGtfsZip は1回だけ呼び、結果を使い回す
    const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...golden.scenarios.main.policy }, { generatedAt: GENERATED_AT })
    if (!outcome.ok) throw new Error(outcome.message)
    result = outcome.result
    const blob = await writeGtfsZip({ original, base, edited: result.feed, generatedAt: GENERATED_AT, attribution: ATTRIBUTION_TEXT })
    written = await blob.arrayBuffer()
    source = await JSZip.loadAsync(original)
    output = await JSZip.loadAsync(written)
  })

  it('全 .txt を読み込んで serializeTable で書くと、元のエントリとバイト単位で同じになる', async () => {
    const checked: string[] = []
    for (const [name, table] of base.tables) {
      const path = table.format?.path
      expect(path, name).toBeDefined()
      const bytes = await source.file(path ?? '')!.async('uint8array')
      const serialized = serializeTable(table)
      // 違うときに場所が分かるよう、長さと最初に違うバイトの位置を出す
      let firstDiff = -1
      const n = Math.min(bytes.length, serialized.length)
      for (let i = 0; i < n; i++) {
        if (bytes[i] !== serialized[i]) {
          firstDiff = i
          break
        }
      }
      expect({ name, length: serialized.length, firstDiff }).toEqual({ name, length: bytes.length, firstDiff: -1 })
      checked.push(name)
    }
    expect(checked).toContain('stop_times')
    expect(checked).toContain('fare_rules')
  })

  it('書き換えない表(agency・stops・routes・fare_attributes・fare_rules・translations など)は、元の ZIP のエントリとバイト単位で同じ', async () => {
    const kept: string[] = []
    for (const entry of fileEntries(source)) {
      const name = tableNameOf(entry.name)
      if (name !== null && REWRITTEN.includes(name)) continue
      const out = output.file(entry.name)
      expect(out, entry.name).not.toBeNull()
      const before = await entry.async('uint8array')
      const after = await out!.async('uint8array')
      expect({ entry: entry.name, length: after.length, sha256: sha256(after) }).toEqual({
        entry: entry.name,
        length: before.length,
        sha256: sha256(before),
      })
      kept.push(name ?? entry.name)
    }
    expect(kept).toEqual(expect.arrayContaining(['agency', 'stops', 'routes', 'fare_attributes', 'fare_rules', 'translations']))
  })

  it('書き換えた 5 表(trips・stop_times・calendar・calendar_dates・feed_info)のエントリは、正解データの SHA-256 と行数に一致する', async () => {
    expect(golden.generatedAt).toBe(GENERATED_AT)
    if (!matches) return
    const files = golden.scenarios.main.summary.files
    for (const name of REWRITTEN) {
      const path = base.tables.get(name)?.format?.path
      expect(path, name).toBeDefined()
      const out = output.file(path ?? '')
      expect(out, name).not.toBeNull()
      const bytes = await out!.async('uint8array')
      const rows = result.feed.tables.get(name)!.rows.length
      // 正解データの files は ZIP の中の名前ではなく、ファイル名(trips.txt など)で引く
      expect({ name, rows, sha256: sha256(bytes) }).toEqual({ name, ...files[`${name}.txt`] })
    }
  })

  it('エントリの並びは元の ZIP と同じで、最後に ATTRIBUTION.md が1つだけ足され、日時はすべて作成日時(日本時間)', async () => {
    const tripsPath = base.tables.get('trips')?.format?.path ?? 'trips.txt'
    const folder = tripsPath.includes('/') ? tripsPath.slice(0, tripsPath.lastIndexOf('/') + 1) : ''
    const names = fileEntries(output).map((e) => e.name)
    expect(names).toEqual([...fileEntries(source).map((e) => e.name), `${folder}ATTRIBUTION.md`])
    expect(names.filter((n) => n.toLowerCase().endsWith('attribution.md'))).toHaveLength(1)
    // 出典のファイルは渡した文のまま(UTF-8、BOM なし)
    expect(await output.file(`${folder}ATTRIBUTION.md`)!.async('string')).toBe(ATTRIBUTION_TEXT)
    // ZIP の日時は 2026-11-04 12:00(日本時間の壁時計)。JSZip は ZIP の日時を UTC の値として読む
    const expected = zipEntryDate(GENERATED_AT).getTime()
    expect(fileEntries(output).filter((e) => e.date.getTime() !== expected).map((e) => e.name)).toEqual([])
  })

  it('writeGtfsZip で書いた ZIP をもう一度読むと、表の名前・行数が編集後と同じになる', async () => {
    const reread = await loadGtfsZip(written)
    const shape = (feed: GtfsFeed) =>
      [...feed.tables.entries()].map(([name, t]) => [name, t.rows.length]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    expect(shape(reread)).toEqual(shape(result.feed))
    // 書き換えた表は、書き出したバイト列から読み直しても同じ行になる
    expect(reread.tables.get('trips')?.rows).toEqual(result.feed.tables.get('trips')?.rows)
    expect(reread.tables.get('feed_info')?.rows).toEqual(result.feed.tables.get('feed_info')?.rows)
  })
})
