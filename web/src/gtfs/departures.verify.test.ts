import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { departureCountsByBand, makeBands, type DepartureCounts } from './departures'
import { loadGtfsZip, type GtfsFeed, type GtfsRow, type GtfsTable } from './load'

// 道北バスの GTFS(data/raw/gtfs/ に置く。コミットしない)。ファイルがあるときだけ走る。
// 期待値は、同じ条件を Python で別に数えた値(便ごとの最後の停留所と pickup_type=1 を除く)。
function samplePath(file: string): string {
  return fileURLToPath(new URL(`../../../data/raw/gtfs/${file}`, import.meta.url))
}

async function loadSample(path: string): Promise<GtfsFeed> {
  const buf = readFileSync(path)
  return loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** 時間帯ごとの、全停留所の出発の合計 */
function bandTotals(result: DepartureCounts, bandCount: number): number[] {
  const totals = new Array<number>(bandCount).fill(0)
  for (const arr of result.counts.values()) arr.forEach((n, i) => (totals[i] += n))
  return totals
}

function sum(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0)
}

/** 停留所ごとの配列を、キーの順に並べた [stop_id, 配列] の一覧にする(Map の挿入順に左右されずに比べるため) */
function sorted(result: DepartureCounts): [string, number[]][] {
  return [...result.counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 2つの結果を停留所ごとに足す */
function addCounts(a: DepartureCounts, b: DepartureCounts, bandCount: number): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const r of [a, b]) {
    for (const [stop, arr] of r.counts) {
      const acc = out.get(stop) ?? new Array<number>(bandCount).fill(0)
      arr.forEach((n, i) => (acc[i] += n))
      out.set(stop, acc)
    }
  }
  return out
}

/** stop_times だけを差し替えた、フィードの写し(元のフィードは変えない) */
function withStopTimes(feed: GtfsFeed, rows: GtfsRow[]): GtfsFeed {
  const tables = new Map(feed.tables)
  const st = feed.tables.get('stop_times')
  if (!st) throw new Error('stop_times がありません')
  tables.set('stop_times', { ...st, rows })
  return { ...feed, tables }
}

/** 決まった種から行を並べ替える(Fisher–Yates と線形合同法) */
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = xs.slice()
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 'HH:MM:SS' に h 時間を足す */
function shiftHours(time: string | undefined, h: number): string | undefined {
  if (time === undefined || time.trim() === '') return time
  const [hh, mm, ss] = time.trim().split(':')
  return `${Number(hh) + h}:${mm}:${ss}`
}

// 実データが無くても走る、検証担当が足した端のケース
describe('前日の便の時間帯の端(手で作ったデータ)', () => {
  /** 便ごとに、数える停留所 A と終点 Z の2行を作る */
  function feedOf(list: { trip: string; service: string; time: string }[]): GtfsFeed {
    const trips = list.map((x) => ({ trip_id: x.trip, service_id: x.service }))
    const stopTimes = list.flatMap((x) => [
      { trip_id: x.trip, stop_id: 'A', stop_sequence: '1', departure_time: x.time },
      { trip_id: x.trip, stop_id: 'Z', stop_sequence: '2', departure_time: x.time },
    ])
    const table = (name: string, rows: GtfsRow[]): [string, GtfsTable] => [name, { fileName: `${name}.txt`, fields: [], rows }]
    return { tables: new Map([table('trips', trips), table('stop_times', stopTimes)]), warnings: [] }
  }
  const YESTERDAY_ONLY = { today: new Set<string>(), yesterday: new Set(['日曜']) }

  it('前日の 29:59:59 は入らず、30:00:00 は 6〜7時、47:59:59 は 23〜24時、48:00:00 は入らない', () => {
    const feed = feedOf([
      { trip: 'T1', service: '日曜', time: '29:59:59' },
      { trip: 'T2', service: '日曜', time: '30:00:00' },
      { trip: 'T3', service: '日曜', time: '47:59:59' },
      { trip: 'T4', service: '日曜', time: '48:00:00' },
      { trip: 'T5', service: '日曜', time: '24:00:00' },
    ])
    const bands = makeBands(1)
    const a = departureCountsByBand(feed, YESTERDAY_ONLY, bands).counts.get('A')
    const expected = new Array<number>(18).fill(0)
    expected[0] = 1
    expected[17] = 1
    expect(a).toEqual(expected)
  })

  it('当日と前日の両方で走る便の 24:00:00 は、どちらとしても入らない', () => {
    const feed = feedOf([{ trip: 'T1', service: '平日', time: '24:00:00' }])
    const both = new Set(['平日'])
    expect(departureCountsByBand(feed, { today: both, yesterday: both }, makeBands(1)).counts.size).toBe(0)
  })

  it('当日と前日の両方で走る便の空の departure_time は、1行として1回だけ数える', () => {
    const feed = feedOf([{ trip: 'T1', service: '平日', time: '' }])
    const both = new Set(['平日'])
    const result = departureCountsByBand(feed, { today: both, yesterday: both }, makeBands(3))
    expect(result.counts.size).toBe(0)
    expect(result.skippedBlankTime).toBe(1)
  })

  it('当日の便と前日の便が同じ停留所に出発すると、同じ配列に足す', () => {
    const feed = feedOf([
      { trip: 'T1', service: '平日', time: '07:00:00' },
      { trip: 'T2', service: '日曜', time: '31:00:00' },
    ])
    const result = departureCountsByBand(feed, { today: new Set(['平日']), yesterday: new Set(['日曜']) }, makeBands(3))
    expect([...result.counts.entries()]).toEqual([['A', [2, 0, 0, 0, 0, 0]]])
  })
})

// 2026-11-02(月曜)。当日は平日ダイヤ 01、前日の 11/1(日曜)は日祝ダイヤ 06
const NOV2 = { today: new Set(['01']), yesterday: new Set(['06']) }

const BEFORE = samplePath('dohoku_bus_減便前.zip')
const AFTER = samplePath('dohoku_bus_減便後.zip')

describe.skipIf(!existsSync(BEFORE))('道北バス(減便前)の 2026-11-02 の出発', () => {
  let feed: GtfsFeed
  beforeAll(async () => {
    feed = await loadSample(BEFORE)
    expect(feed.tables.get('feed_info')?.rows[0]?.feed_version).toBe('202609171038')
  }, 60_000)

  it('3時間ごとの合計は朝(6〜9時)が多く、夜(21〜24時)が最も少ない', () => {
    const bands = makeBands(3)
    const result = departureCountsByBand(feed, NOV2, bands)
    const totals = bandTotals(result, bands.length)
    console.info('減便前 2026-11-02 3時間ごと', Object.fromEntries(bands.map((b, i) => [b.label, totals[i]])))

    expect(totals).toEqual([3105, 3787, 3792, 3488, 2365, 282])
    expect(sum(totals)).toBe(16819)
    expect(result.counts.size).toBe(1443)
    expect(result.skippedBlankTime).toBe(0)
    expect(result.hasFrequencies).toBe(false)

    expect(totals[0]).toBeGreaterThan(totals[5] * 10)
    expect(Math.min(...totals)).toBe(totals[5])
    // 夕方以降は減っていく
    expect(totals[3]).toBeGreaterThan(totals[4])
    expect(totals[4]).toBeGreaterThan(totals[5])
  })

  it('1時間ごとの合計は3時間ごとと一致し、23〜24時は0本', () => {
    const bands = makeBands(1)
    const totals = bandTotals(departureCountsByBand(feed, NOV2, bands), bands.length)
    console.info('減便前 2026-11-02 1時間ごと', Object.fromEntries(bands.map((b, i) => [b.label, totals[i]])))

    expect(totals).toEqual([
      159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0,
    ])
    // 3時間ずつ足すと3時間ごとの値になる
    const grouped = [0, 1, 2, 3, 4, 5].map((g) => sum(totals.slice(g * 3, g * 3 + 3)))
    expect(grouped).toEqual([3105, 3787, 3792, 3488, 2365, 282])
  })

  it('24時を超える便が無いため、前日(日曜)の便は 11/2 の時間帯に入らない', () => {
    const result = departureCountsByBand(feed, { today: new Set(), yesterday: new Set(['06']) }, makeBands(3))
    expect(result.counts.size).toBe(0)
  })

  // 以下は検証担当が足したもの。期待値は検証担当が Python で別に数えた値(実装者の値を写していない)

  it('停留所ごとの配列も Python で数えた値と一致する(合計だけでなく、どの停留所に入ったかを確かめる)', () => {
    const result = departureCountsByBand(feed, NOV2, makeBands(3))
    // 最も出発が多い停留所
    expect(result.counts.get('2880_02')).toEqual([27, 38, 42, 41, 28, 1])
    const busiest = sorted(result).reduce((best, cur) => (sum(cur[1]) > sum(best[1]) ? cur : best))
    expect(busiest[0]).toBe('2880_02')
    expect(sum(busiest[1])).toBe(177)
    // 出発が1本だけの停留所
    expect(result.counts.get('0240_04')).toEqual([0, 0, 0, 1, 0, 0])
    // 85 便で終点、71 便で途中の停留所。終点の行だけを除く
    expect(result.counts.get('0010_01')).toEqual([5, 8, 11, 9, 8, 2])
    expect(result.counts.get('5020_01')).toEqual([3, 2, 1, 0, 0, 0])
    // 平日の 9 行のうち 4 行が pickup_type=1(終点ではない)。残りの 5 行だけを数える
    expect(result.counts.get('7010_01')).toEqual([2, 0, 1, 1, 1, 0])
    // 平日の1行が pickup_type=1 だけの停留所と、終点にしかならない停留所は入らない
    expect(result.counts.has('6891_01')).toBe(false)
    expect(result.counts.has('0010_10')).toBe(false)
    // 入っている停留所は、どれも1本以上ある
    for (const [, arr] of result.counts) expect(sum(arr)).toBeGreaterThan(0)
  })

  it('停留所ごとに、1時間ごとの3つ分の和が3時間ごとの値と一致する', () => {
    const r3 = departureCountsByBand(feed, NOV2, makeBands(3))
    const r1 = departureCountsByBand(feed, NOV2, makeBands(1))
    expect([...r1.counts.keys()].sort()).toEqual([...r3.counts.keys()].sort())
    for (const [stop, arr3] of r3.counts) {
      const arr1 = r1.counts.get(stop) ?? []
      expect(arr1).toHaveLength(18)
      expect([0, 1, 2, 3, 4, 5].map((g) => sum(arr1.slice(g * 3, g * 3 + 3)))).toEqual(arr3)
    }
  })

  it('当日に 01 と 06 の両方を与えた結果は、01 だけと 06 だけの結果を停留所ごとに足したものと同じ', () => {
    const bands = makeBands(3)
    const none = new Set<string>()
    const both = departureCountsByBand(feed, { today: new Set(['01', '06']), yesterday: none }, bands)
    const only01 = departureCountsByBand(feed, { today: new Set(['01']), yesterday: none }, bands)
    const only06 = departureCountsByBand(feed, { today: new Set(['06']), yesterday: none }, bands)
    const added = addCounts(only01, only06, bands.length)
    expect(both.counts.size).toBe(added.size)
    for (const [stop, arr] of both.counts) expect(arr).toEqual(added.get(stop))
    // Python で数えた値
    expect(bandTotals(both, bands.length)).toEqual([5429, 7287, 7183, 6608, 4232, 517])
    expect(both.counts.size).toBe(1450)
  })

  it('stop_times の行の順番を入れ替えても、停留所ごとの結果は変わらない', () => {
    const bands = makeBands(1)
    const base = departureCountsByBand(feed, NOV2, bands)
    const rows = feed.tables.get('stop_times')?.rows ?? []
    for (const seed of [1, 20261102]) {
      const result = departureCountsByBand(withStopTimes(feed, shuffled(rows, seed)), NOV2, bands)
      expect(sorted(result)).toEqual(sorted(base))
    }
  })

  it('前日の便に 24時を超える出発が無いので、前日の service を与えても与えなくても停留所ごとに同じ', () => {
    const bands = makeBands(1)
    const withYesterday = departureCountsByBand(feed, NOV2, bands)
    const withoutYesterday = departureCountsByBand(feed, { today: new Set(['01']), yesterday: new Set() }, bands)
    expect(sorted(withYesterday)).toEqual(sorted(withoutYesterday))
  })

  it('日祝ダイヤの便の時刻をすべて24時間遅らせ、前日の便として与えると、当日の便として数えた結果と同じ', () => {
    // 実データには 24時を超える時刻が無いため、日祝(06)の便を作り替えて前日の便の扱いを大きなデータで試す
    const bands = makeBands(1)
    const tripService = new Map(
      (feed.tables.get('trips')?.rows ?? []).map((t) => [t.trip_id?.trim() ?? '', t.service_id?.trim() ?? '']),
    )
    const rows = (feed.tables.get('stop_times')?.rows ?? []).map((r) =>
      tripService.get(r.trip_id?.trim() ?? '') === '06' ? { ...r, departure_time: shiftHours(r.departure_time, 24) } : r,
    )
    const shiftedFeed = withStopTimes(feed, rows)
    // 作り替えた時刻は 30:10:00 のように 24 以上になっている
    expect(rows.some((r) => (r.departure_time ?? '').startsWith('30:'))).toBe(true)

    const asToday = departureCountsByBand(feed, { today: new Set(['06']), yesterday: new Set() }, bands)
    const asYesterday = departureCountsByBand(shiftedFeed, { today: new Set(), yesterday: new Set(['06']) }, bands)
    expect(sorted(asYesterday)).toEqual(sorted(asToday))
    // 作り替えたフィードで 06 を当日の便として与えると、24時以降なのでどこにも入らない
    expect(departureCountsByBand(shiftedFeed, { today: new Set(['06']), yesterday: new Set() }, bands).counts.size).toBe(0)
    // Python で数えた日祝ダイヤ(11/3 の祝日)の値と一致する
    expect(bandTotals(asYesterday, bands.length)).toEqual([
      115, 1024, 1185, 1112, 1105, 1283, 1222, 975, 1194, 1130, 1101, 889, 902, 619, 346, 184, 51, 0,
    ])
  })

  it('ID の前後に空白を足し、時を1桁にしても結果は変わらない', () => {
    const bands = makeBands(3)
    const pad = (v: string | undefined) => (v === undefined ? v : ` ${v}\t`)
    const trips = feed.tables.get('trips')
    if (!trips) throw new Error('trips がありません')
    const tables = new Map(feed.tables)
    tables.set('trips', {
      ...trips,
      rows: trips.rows.map((t) => ({ ...t, trip_id: pad(t.trip_id), service_id: pad(t.service_id) })),
    })
    const rows = (feed.tables.get('stop_times')?.rows ?? []).map((r) => ({
      ...r,
      trip_id: pad(r.trip_id),
      stop_id: pad(r.stop_id),
      stop_sequence: pad(r.stop_sequence),
      pickup_type: pad(r.pickup_type),
      departure_time: r.departure_time?.replace(/^0(\d):/, '$1:'),
    }))
    tables.set('stop_times', { ...feed.tables.get('stop_times')!, rows })
    // 1桁の時が実際に入っている
    expect(rows.some((r) => /^\d:/.test(r.departure_time ?? ''))).toBe(true)
    const padded = departureCountsByBand({ ...feed, tables }, NOV2, bands)
    expect(sorted(padded)).toEqual(sorted(departureCountsByBand(feed, NOV2, bands)))
  })

  it('pickup_type をすべて 0 にしても、各便の終点は数えない(実データの終点はすべて pickup_type=1 のため、終点の規則を別に試す)', () => {
    const bands = makeBands(3)
    const rows = (feed.tables.get('stop_times')?.rows ?? []).map((r) => ({ ...r, pickup_type: '0' }))
    const result = departureCountsByBand(withStopTimes(feed, rows), NOV2, bands)
    // Python で、pickup_type を見ずに終点だけを除いて数えた値。元の値との差は、途中の pickup_type=1 の 5 行
    expect(bandTotals(result, bands.length)).toEqual([3108, 3787, 3792, 3488, 2366, 283])
    expect(result.counts.size).toBe(1444)
    // 終点にしかならない停留所は、乗車できる扱いにしても入らない
    expect(result.counts.has('0010_10')).toBe(false)
    expect(result.counts.get('0010_01')).toEqual([5, 8, 11, 9, 8, 2])
    expect(result.counts.get('6891_01')).toEqual([1, 0, 0, 0, 0, 0])
  })

  it('祝日の 2026-11-03(当日は日祝 06、前日は平日 01)も Python で数えた値と一致する', () => {
    const bands = makeBands(3)
    const result = departureCountsByBand(feed, { today: new Set(['06']), yesterday: new Set(['01']) }, bands)
    expect(bandTotals(result, bands.length)).toEqual([2324, 3500, 3391, 3120, 1867, 235])
    expect(result.counts.size).toBe(1301)
    expect(result.counts.get('2880_02')).toEqual([21, 36, 34, 33, 24, 0])
    expect(result.counts.get('0010_01')).toEqual([1, 4, 10, 7, 4, 2])
    expect(result.counts.get('7010_01')).toEqual([1, 0, 1, 1, 1, 0])
  })

  it('実データで1回の計算が 1 秒を超えない', () => {
    const times: Record<string, number[]> = { '3時間ごと': [], '1時間ごと': [] }
    for (let i = 0; i < 5; i++) {
      for (const [name, step] of [['3時間ごと', 3], ['1時間ごと', 1]] as const) {
        const bands = makeBands(step)
        const t0 = performance.now()
        departureCountsByBand(feed, NOV2, bands)
        times[name].push(performance.now() - t0)
      }
    }
    const rows = feed.tables.get('stop_times')?.rows.length ?? 0
    console.info(
      `stop_times ${rows} 行の計算時間(ミリ秒、5回)`,
      Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v.map((x) => Math.round(x * 10) / 10)])),
    )
    expect(rows).toBeGreaterThan(40000)
    for (const v of Object.values(times)) expect(Math.max(...v)).toBeLessThan(1000)
  })
})

describe.skipIf(!existsSync(BEFORE) || !existsSync(AFTER))('道北バス(減便前と減便後)の比較', () => {
  it('2026-11-02 の出発は減便後のほうが少ない', async () => {
    const [before, after] = await Promise.all([loadSample(BEFORE), loadSample(AFTER)])
    expect(after.tables.get('feed_info')?.rows[0]?.feed_version).toBe('202610291429')
    const bands = makeBands(3)
    const b = bandTotals(departureCountsByBand(before, NOV2, bands), bands.length)
    const a = bandTotals(departureCountsByBand(after, NOV2, bands), bands.length)
    console.info('2026-11-02 3時間ごと 減便前', b, '減便後', a)

    expect(a).toEqual([2784, 3496, 3390, 3231, 1906, 238])
    expect(sum(a)).toBe(15045)
    for (let i = 0; i < bands.length; i++) expect(a[i]).toBeLessThanOrEqual(b[i])

    // 検証担当が Python で別に数えた値:減便後の祝日 11/3(当日 06、前日 01)と、1時間ごとの 11/2
    const holiday = departureCountsByBand(after, { today: new Set(['06']), yesterday: new Set(['01']) }, bands)
    expect(bandTotals(holiday, bands.length)).toEqual([2324, 3496, 3379, 3118, 1867, 235])
    expect(holiday.counts.size).toBe(1296)
    const hourly = makeBands(1)
    expect(bandTotals(departureCountsByBand(after, NOV2, hourly), hourly.length)).toEqual([
      126, 1331, 1327, 1110, 1105, 1281, 1230, 966, 1194, 1164, 1182, 885, 919, 636, 351, 187, 51, 0,
    ])
  }, 60_000)
})
