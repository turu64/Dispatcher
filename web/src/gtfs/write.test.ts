import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { applyForm2 } from './edit/form2'
import {
  AGENCY,
  CALENDAR,
  CALENDAR_DATES,
  FEED_INFO,
  ROUTES,
  STOP_TIMES,
  STOPS,
  TRIPS,
  basePlan,
} from './edit/form2.fixture'
import { loadGtfsZip, type GtfsFeed, type GtfsTable } from './load'
import { exportFileName, serializeTable, writeGtfsZip, zipEntryDate } from './write'

const BOM = '﻿'
const GENERATED_AT = '202611041200'

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

/** fixture の CSV(先頭の改行を除き、CRLF にして最後に改行を付ける) */
function crlf(csv: string): string {
  return `${csv.trim().split('\n').join('\r\n')}\r\n`
}

const SMALL_FILES: Record<string, string> = {
  'agency.txt': crlf(AGENCY),
  'routes.txt': crlf(ROUTES),
  'stops.txt': crlf(STOPS),
  'calendar.txt': crlf(CALENDAR),
  'calendar_dates.txt': crlf(CALENDAR_DATES),
  'trips.txt': crlf(TRIPS),
  'stop_times.txt': crlf(STOP_TIMES),
  'feed_info.txt': crlf(FEED_INFO),
}

async function makeZip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'arraybuffer' })
}

/** ZIP を作って読み込み、形2を当てる */
async function prepare(files: Record<string, string | Uint8Array>) {
  const original = await makeZip(files)
  const base = await loadGtfsZip(original)
  const outcome = applyForm2(base, basePlan(), { generatedAt: GENERATED_AT })
  if (!outcome.ok) throw new Error(outcome.message)
  return { original, base, edited: outcome.result.feed }
}

async function write(input: { original: ArrayBuffer; base: GtfsFeed; edited: GtfsFeed }, attribution = '出典\n') {
  const blob = await writeGtfsZip({ ...input, generatedAt: GENERATED_AT, attribution })
  return new Uint8Array(await blob.arrayBuffer())
}

async function entriesOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, Uint8Array>()
  for (const entry of Object.values(zip.files)) out.set(entry.name, entry.dir ? new Uint8Array() : await entry.async('uint8array'))
  return out
}

describe('serializeTable', () => {
  it('値に , と " と改行があるときだけ引用符で囲む(前後の空白では囲まない)', () => {
    const table: GtfsTable = {
      fileName: 'stops.txt',
      fields: ['a', 'b', 'c'],
      rows: [
        { a: 'x,y', b: 'say "hi"', c: ' pad ' },
        { a: 'line1\nline2', b: 'cr\rx', c: '' },
        { a: 'plain' },
      ],
    }
    expect(text(serializeTable(table))).toBe('a,b,c\r\n"x,y","say ""hi""", pad \r\n"line1\nline2","cr\rx",\r\nplain,,\r\n')
  })

  it('BOM・改行・最後の改行を入力に合わせる', async () => {
    const original = {
      'stops.txt': `${BOM}stop_id,stop_name\nA,駅前\nB, 市役所 `,
      'routes.txt': ' route_id ,route_short_name\r\n10,旭川線\r\n',
    }
    const feed = await loadGtfsZip(await makeZip(original))
    // 読み込んだ表をそのまま書くと、元の文字列と同じ(見出しの空白も元のまま)
    expect(text(serializeTable(feed.tables.get('stops')!))).toBe(original['stops.txt'])
    expect(text(serializeTable(feed.tables.get('routes')!))).toBe(original['routes.txt'])
    // 列を足した表は、見出しを列名から作り直す(書き方は元のまま)
    const stops = feed.tables.get('stops')!
    const added = { ...stops, fields: [...stops.fields, 'stop_lat'], rows: stops.rows.map((r) => ({ ...r, stop_lat: '43.7' })) }
    expect(text(serializeTable(added))).toBe(`${BOM}stop_id,stop_name,stop_lat\nA,駅前,43.7\nB, 市役所 ,43.7`)
    // 書き方の無い表は CRLF、BOM なし、最後に改行
    expect(text(serializeTable({ fileName: 'x.txt', fields: ['a'], rows: [{ a: '1' }] }))).toBe('a\r\n1\r\n')
  })
})

describe('writeGtfsZip', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    process.env.TZ = originalTz
  })

  it('変えない表は元のエントリのバイト列をそのまま書く', async () => {
    // 引用符で囲んだ stops.txt は、読み込んで書き直すと引用符が消える。変えない表なので元のまま写る
    const quotedStops = 'stop_id,stop_name,stop_lat,stop_lon\r\n"A","駅前",43.76,142.36\r\n"B","市役所",43.77,142.37\r\n"C","病院前",43.78,142.38\r\n"S9","学校前",43.79,142.39\r\n'
    const input = await prepare({ ...SMALL_FILES, 'stops.txt': quotedStops })
    const entries = await entriesOf(await write(input))
    expect(text(entries.get('stops.txt')!)).toBe(quotedStops)
    for (const name of ['agency.txt', 'routes.txt']) expect(text(entries.get(name)!)).toBe(SMALL_FILES[name])
    // 書き換えた表は serializeTable の結果
    expect(text(entries.get('trips.txt')!)).toBe(text(serializeTable(input.edited.tables.get('trips')!)))
    expect(text(entries.get('feed_info.txt')!)).toContain('20261101,20261130,202611041200')
  })

  it('フォルダに入った ZIP は同じフォルダに書く', async () => {
    const files: Record<string, string> = {}
    for (const [name, content] of Object.entries(SMALL_FILES)) if (name !== 'feed_info.txt') files[`gtfs/${name}`] = content
    files['gtfs/readme.md'] = '説明'
    files['__MACOSX/gtfs/._trips.txt'] = 'x'
    const input = await prepare(files)
    const entries = await entriesOf(await write(input))
    expect([...entries.keys()]).toEqual([
      'gtfs/agency.txt',
      'gtfs/routes.txt',
      'gtfs/stops.txt',
      'gtfs/calendar.txt',
      'gtfs/calendar_dates.txt',
      'gtfs/trips.txt',
      'gtfs/stop_times.txt',
      'gtfs/readme.md',
      // 編集後にだけある表(作った feed_info)と出典のファイルは、trips.txt と同じフォルダの最後に足す
      'gtfs/feed_info.txt',
      'gtfs/ATTRIBUTION.md',
    ])
    expect(text(entries.get('gtfs/readme.md')!)).toBe('説明')
  })

  it('基準にある表は、すべて出力にある', async () => {
    const input = await prepare(SMALL_FILES)
    const reread = await loadGtfsZip(new Blob([await write(input)]))
    expect([...reread.tables.keys()].sort()).toEqual([...input.base.tables.keys()].sort())
    for (const [name, table] of input.edited.tables) expect(reread.tables.get(name)?.rows, name).toEqual(table.rows)
    // 編集後に表が欠けていれば、書かずに止める
    const missing = new Map(input.edited.tables)
    missing.delete('stops')
    await expect(write({ ...input, edited: { tables: missing, warnings: [] } })).rejects.toThrow('出力する GTFS に stops.txt がありません')
  })

  it('出典のファイルを足し、基準に同じ名前があれば別の名前にする', async () => {
    const input = await prepare(SMALL_FILES)
    const entries = await entriesOf(await write(input, '元データ:テスト\n'))
    expect(text(entries.get('ATTRIBUTION.md')!)).toBe('元データ:テスト\n')
    expect([...entries.keys()].pop()).toBe('ATTRIBUTION.md')

    const withOwn = await prepare({ ...SMALL_FILES, 'ATTRIBUTION.md': '事業者の出典' })
    const second = await entriesOf(await write(withOwn, '元データ:テスト\n'))
    expect(text(second.get('ATTRIBUTION.md')!)).toBe('事業者の出典')
    expect(text(second.get('ATTRIBUTION_dispatcher.md')!)).toBe('元データ:テスト\n')
    expect(exportFileName('dohoku_bus_減便前.zip', GENERATED_AT)).toBe('dohoku_bus_減便前_dispatcher_202611041200.zip')
  })

  it('同じ入力から同じバイト列になり、時刻帯を変えても変わらない', async () => {
    const input = await prepare(SMALL_FILES)
    process.env.TZ = 'UTC'
    const utc = await write(input)
    process.env.TZ = 'Asia/Tokyo'
    const tokyo = await write(input)
    const again = await write(input)
    expect(Buffer.from(tokyo).equals(Buffer.from(utc))).toBe(true)
    expect(Buffer.from(again).equals(Buffer.from(tokyo))).toBe(true)
    // 最初のローカルファイルヘッダーの DOS の日時が、generatedAt の日本時間の数字になる
    const view = new DataView(utc.buffer, utc.byteOffset, utc.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const time = view.getUint16(10, true)
    const date = view.getUint16(12, true)
    expect({ hour: time >> 11, minute: (time >> 5) & 0x3f, year: (date >> 9) + 1980, month: (date >> 5) & 0x0f, day: date & 0x1f }).toEqual({
      hour: 12,
      minute: 0,
      year: 2026,
      month: 11,
      day: 4,
    })
    expect(zipEntryDate(GENERATED_AT).toISOString()).toBe('2026-11-04T12:00:00.000Z')
  })
})
