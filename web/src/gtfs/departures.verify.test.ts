import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeServiceIds, servicesFor } from './calendar'
import { departureCountsByBand, makeBands, parseGtfsTime, type DepartureCounts } from './departures'
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

// 実装から独立した基準(オラクル)との照合。実データが無くても走る。
// オラクルは実装の関数を使わず、取り決めの文面どおりに素直に書く(stop_sequence は BigInt で比べる)
describe('独立した基準との照合(乱数で作った小さなフィード)', () => {
  type Services = { today: Set<string>; yesterday: Set<string> }

  // 取り決めに書かれた値の書き方と、書かれていない崩れた書き方を混ぜる
  const SEQUENCES = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '01', '02', '010', ' 3 ', '0', '000',
    '0x0A', '1e1', '1.5', '-1', '+9', '９', '', 'abc', '1_0',
    '9'.repeat(20), `${'9'.repeat(19)}8`, `${'0'.repeat(20)}5`,
  ]
  const PICKUPS = ['0', '0', '0', '1', ' 1 ', '01', '1.0', '+1', '1e0', '', '2', '3']
  const TIMES = [
    '06:00:00', '6:00:00', '07:59:59', '08:00:00', '09:00:00', '12:30:00', '23:59:59', '24:00:00', '25:10:00',
    '29:59:59', '30:00:00', '30:10:00', '47:59:59', '48:00:00', '100:00:00', ' 07:00:00 ', '',
    '   ', '7:5:00', '07.10.00', '07:60:00', '07:00', 'abc',
  ]
  const STOPS = ['A', 'B', 'C', ' A ', 'D', '']
  const SERVICE_NAMES = ['W', 'S', 'X']

  function pick<T>(xs: readonly T[], next: () => number): T {
    return xs[Math.floor(next() * xs.length)]
  }
  function randomSubset(xs: readonly string[], next: () => number): Set<string> {
    return new Set(xs.filter(() => next() < 0.5))
  }

  /** 線形合同法の乱数(0 以上 1 未満) */
  function generator(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  function randomFeed(next: () => number): GtfsFeed {
    const trips: GtfsRow[] = []
    const stopTimes: GtfsRow[] = []
    const tripCount = 1 + Math.floor(next() * 5)
    for (let i = 0; i < tripCount; i++) {
      const id = `T${i}`
      trips.push({ trip_id: next() < 0.2 ? ` ${id} ` : id, service_id: pick(['W', 'S', 'X', ' W '], next) })
      const rowCount = 1 + Math.floor(next() * 7)
      for (let k = 0; k < rowCount; k++) {
        stopTimes.push({
          trip_id: next() < 0.2 ? `${id}\t` : id,
          stop_id: pick(STOPS, next),
          stop_sequence: next() < 0.6 ? String(k + 1) : pick(SEQUENCES, next),
          pickup_type: pick(PICKUPS, next),
          departure_time: pick(TIMES, next),
        })
      }
    }
    // 運行しない便の行と、trips に無い便の行も混ぜる
    stopTimes.push({ trip_id: 'NOWHERE', stop_id: 'A', stop_sequence: '1', pickup_type: '0', departure_time: '07:00:00' })
    const table = (name: string, rows: GtfsRow[]): [string, GtfsTable] => [name, { fileName: `${name}.txt`, fields: [], rows }]
    return { tables: new Map([table('trips', trips), table('stop_times', stopTimes)]), warnings: [] }
  }

  /** 取り決めの文面を、そのまま素直に書いた数え方 */
  function oracle(feed: GtfsFeed, services: Services, stepHours: 1 | 3) {
    const serviceOfTrip = new Map<string, string>()
    for (const t of feed.tables.get('trips')?.rows ?? []) serviceOfTrip.set((t.trip_id ?? '').trim(), (t.service_id ?? '').trim())
    const byTrip = new Map<string, GtfsRow[]>()
    for (const r of feed.tables.get('stop_times')?.rows ?? []) {
      const id = (r.trip_id ?? '').trim()
      byTrip.set(id, [...(byTrip.get(id) ?? []), r])
    }

    const counts = new Map<string, number[]>()
    const bandCount = 18 / stepHours
    let blank = 0
    let invalid = 0
    for (const [tripId, rows] of byTrip) {
      const service = serviceOfTrip.get(tripId)
      if (service === undefined) continue
      const offsets: number[] = []
      if (services.today.has(service)) offsets.push(0)
      if (services.yesterday.has(service)) offsets.push(-86400)
      if (offsets.length === 0) continue

      // 0 以上の10進の整数として読める stop_sequence の最大
      let last: bigint | null = null
      for (const r of rows) {
        const s = (r.stop_sequence ?? '').trim()
        if (!/^[0-9]+$/.test(s)) continue
        const n = BigInt(s)
        if (last === null || n > last) last = n
      }

      for (const r of rows) {
        if ((r.pickup_type ?? '').trim() === '1') continue
        const s = (r.stop_sequence ?? '').trim()
        if (last !== null && /^[0-9]+$/.test(s) && BigInt(s) === last) continue
        const dep = (r.departure_time ?? '').trim()
        if (dep === '') {
          blank++
          continue
        }
        const m = /^([0-9]{1,3}):([0-5][0-9]):([0-5][0-9])$/.exec(dep)
        if (!m) {
          invalid++
          continue
        }
        const stop = (r.stop_id ?? '').trim()
        if (stop === '') continue
        for (const off of offsets) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + off
          if (sec < 6 * 3600 || sec >= 24 * 3600) continue
          const index = Math.floor((sec - 6 * 3600) / (stepHours * 3600))
          const arr = counts.get(stop) ?? new Array<number>(bandCount).fill(0)
          arr[index]++
          counts.set(stop, arr)
        }
      }
    }
    return { counts, blank, invalid }
  }

  it('500 通りのフィード・運行日・時間帯の幅で、オラクルと一致する(停留所ごとの配列と、数えなかった行の数)', () => {
    const next = generator(20261103)
    let withCounts = 0
    let withInvalid = 0
    for (let i = 0; i < 500; i++) {
      const feed = randomFeed(next)
      const services: Services = { today: randomSubset(SERVICE_NAMES, next), yesterday: randomSubset(SERVICE_NAMES, next) }
      const step = next() < 0.5 ? 1 : 3
      const actual = departureCountsByBand(feed, services, makeBands(step))
      const expected = oracle(feed, services, step)
      const label = `${i} 回目 ${JSON.stringify([...services.today])}/${JSON.stringify([...services.yesterday])} 幅${step}`
      expect(sorted(actual), label).toEqual([...expected.counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      expect(actual.skippedBlankTime, label).toBe(expected.blank)
      expect(actual.skippedInvalidTime, label).toBe(expected.invalid)
      if (actual.counts.size > 0) withCounts++
      if (expected.invalid > 0) withInvalid++
    }
    // 乱数の偏りで、どの場合も試されていない状態になっていないこと
    expect(withCounts).toBeGreaterThan(100)
    expect(withInvalid).toBeGreaterThan(50)
  })
})

// calendar(運行日の判定)と departures(出発の数え方)は、「1」の書き方を同じ規則で読む:
// 前後の空白を除いた文字列が '1' のときだけ。数としては読まない
describe('calendar と departures で「1」の読み方がそろっている', () => {
  // [書き方, 「1」として読むか]
  const TOKENS: [string, boolean][] = [
    ['1', true], [' 1 ', true], ['\t1', true], ['1\t', true],
    ['01', false], ['001', false], ['1.0', false], ['+1', false], ['1e0', false], ['0x1', false], ['１', false],
    ['', false], ['  ', false], ['0', false], ['2', false], ['true', false], ['-1', false],
  ]
  const DATE = '20261102' // 月曜
  const table = (name: string, rows: GtfsRow[]): [string, GtfsTable] => [name, { fileName: `${name}.txt`, fields: [], rows }]

  /** calendar_dates の exception_type が token の追加の行で、運行する service_id になるか */
  function addedByExceptionType(token: string): boolean {
    const feed: GtfsFeed = {
      tables: new Map([table('calendar_dates', [{ service_id: 'A', date: DATE, exception_type: token }])]),
      warnings: [],
    }
    return activeServiceIds(feed, DATE).has('A')
  }

  /** calendar の月曜の列が token のとき、月曜に運行する service_id になるか */
  function runsByWeekdayColumn(token: string): boolean {
    const row: GtfsRow = {
      service_id: 'A', monday: token, tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '0', sunday: '0',
      start_date: '20261001', end_date: '20261130',
    }
    return activeServiceIds({ tables: new Map([table('calendar', [row])]), warnings: [] }, DATE).has('A')
  }

  /** pickup_type が token の行が、乗車できない行として除かれるか */
  function skippedByPickupType(token: string): boolean {
    const feed: GtfsFeed = {
      tables: new Map([
        table('trips', [{ trip_id: 'T', service_id: 'S' }]),
        table('stop_times', [
          { trip_id: 'T', stop_id: 'A', stop_sequence: '1', pickup_type: token, departure_time: '07:00:00' },
          { trip_id: 'T', stop_id: 'Z', stop_sequence: '2', pickup_type: '0', departure_time: '07:10:00' },
        ]),
      ]),
      warnings: [],
    }
    const result = departureCountsByBand(feed, { today: new Set(['S']), yesterday: new Set() }, makeBands(3))
    return !result.counts.has('A')
  }

  for (const [token, isOne] of TOKENS) {
    it(`${JSON.stringify(token)} は ${isOne ? '「1」として読む' : '「1」として読まない'}(exception_type・曜日の列・pickup_type で同じ)`, () => {
      expect(addedByExceptionType(token)).toBe(isOne)
      expect(runsByWeekdayColumn(token)).toBe(isOne)
      expect(skippedByPickupType(token)).toBe(isOne)
    })
  }

  it("exception_type の削除('2')も、前後の空白を除いた文字列が '2' のときだけ", () => {
    const feed = (token: string): GtfsFeed => ({
      tables: new Map([
        table('calendar', [{
          service_id: 'A', monday: '1', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '0', sunday: '0',
          start_date: '20261001', end_date: '20261130',
        }]),
        table('calendar_dates', [{ service_id: 'A', date: DATE, exception_type: token }]),
      ]),
      warnings: [],
    })
    for (const [token, removes] of [['2', true], [' 2 ', true], ['02', false], ['2.0', false], ['+2', false], ['2e0', false], ['', false]] as const) {
      expect(activeServiceIds(feed(token), DATE).has('A'), JSON.stringify(token)).toBe(!removes)
    }
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

  it('stop_times の値の書き方は厳密な読み方でも変わらない(pickup_type は 0 か 1、stop_sequence は10進の整数、時刻は読める、frequencies.txt は無い)', () => {
    // 数え方を厳密にした(pickup_type は文字列の '1' だけ、stop_sequence は10進の整数だけ)あとも
    // 期待値が変わらないのは、実データがこの書き方だけで書かれているため
    const rows = feed.tables.get('stop_times')?.rows ?? []
    expect(new Set(rows.map((r) => r.pickup_type))).toEqual(new Set(['0', '1']))
    expect(rows.filter((r) => !/^\d+$/.test(r.stop_sequence ?? '')).length).toBe(0)
    expect(rows.filter((r) => parseGtfsTime(r.departure_time) === null).length).toBe(0)
    expect(feed.tables.has('frequencies')).toBe(false)
  })

  it('3時間ごとの合計は朝(6〜9時)が多く、夜(21〜24時)が最も少ない', () => {
    const bands = makeBands(3)
    const result = departureCountsByBand(feed, NOV2, bands)
    const totals = bandTotals(result, bands.length)
    console.info('減便前 2026-11-02 3時間ごと', Object.fromEntries(bands.map((b, i) => [b.label, totals[i]])))

    expect(totals).toEqual([3105, 3787, 3792, 3488, 2365, 282])
    expect(sum(totals)).toBe(16819)
    expect(result.counts.size).toBe(1443)
    expect(result.skippedBlankTime).toBe(0)
    // 実データの departure_time はすべて時刻として読める
    expect(result.skippedInvalidTime).toBe(0)
    expect(result.hasFrequencies).toBe(false)

    expect(totals[0]).toBeGreaterThan(totals[5] * 10)
    expect(Math.min(...totals)).toBe(totals[5])
    // 夕方以降は減っていく
    expect(totals[3]).toBeGreaterThan(totals[4])
    expect(totals[4]).toBeGreaterThan(totals[5])
  })

  it('servicesFor の結果をそのまま渡すと、手で書いた NOV2 と同じ結果になる(11/2 と祝日の 11/3)', () => {
    const bands = makeBands(3)
    const viaCalendar = departureCountsByBand(feed, servicesFor(feed, '20261102'), bands)
    expect(bandTotals(viaCalendar, bands.length)).toEqual([3105, 3787, 3792, 3488, 2365, 282])
    expect(sorted(viaCalendar)).toEqual(sorted(departureCountsByBand(feed, NOV2, bands)))
    // 祝日の 11/3(当日 06、前日 01)
    const holiday = departureCountsByBand(feed, servicesFor(feed, '20261103'), bands)
    expect(bandTotals(holiday, bands.length)).toEqual([2324, 3500, 3391, 3120, 1867, 235])
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

  it('通し:servicesFor(カレンダー)→ departureCountsByBand。11/2(月)・11/3(祝日)・11/9(月)・11/23(祝日)を Python で数えた値と比べる', () => {
    // 期待値は検証担当が Python で別に数えた値。日付から運行する service_id を求める段と、
    // その service_id で出発を数える段を、つなげた形で確かめる
    const bands = makeBands(3)
    const run = (date: string) => {
      const services = servicesFor(feed, date)
      return { services, result: departureCountsByBand(feed, services, bands) }
    }
    const names = (set: Set<string>) => [...set].sort()

    // 平日(月曜)。当日は平日 01、前日の日曜は 06
    const nov2 = run('20261102')
    expect([names(nov2.services.today), names(nov2.services.yesterday)]).toEqual([['01'], ['06']])
    expect(bandTotals(nov2.result, bands.length)).toEqual([3105, 3787, 3792, 3488, 2365, 282])
    expect(nov2.result.counts.size).toBe(1443)
    expect(nov2.result.counts.get('2880_02')).toEqual([27, 38, 42, 41, 28, 1])

    // 祝日(火曜の文化の日)。calendar_dates で 01 が外れ、06 が足される。当日は 06、前日の 11/2 は 01
    const nov3 = run('20261103')
    expect([names(nov3.services.today), names(nov3.services.yesterday)]).toEqual([['06'], ['01']])
    expect(bandTotals(nov3.result, bands.length)).toEqual([2324, 3500, 3391, 3120, 1867, 235])
    expect(nov3.result.counts.size).toBe(1301)
    expect(nov3.result.counts.get('2880_02')).toEqual([21, 36, 34, 33, 24, 0])

    // 翌週の月曜。calendar_dates に載っていない日なので、11/2 と同じ service_id になり、同じ結果になる
    const nov9 = run('20261109')
    expect([names(nov9.services.today), names(nov9.services.yesterday)]).toEqual([['01'], ['06']])
    expect(bandTotals(nov9.result, bands.length)).toEqual([3105, 3787, 3792, 3488, 2365, 282])
    expect(nov9.result.counts.size).toBe(1443)
    expect(nov9.result.counts.get('2880_02')).toEqual([27, 38, 42, 41, 28, 1])
    expect(sorted(nov9.result)).toEqual(sorted(nov2.result))

    // 祝日の勤労感謝の日(月曜)。前日の日曜も 06 なので、当日・前日の両方に 06 が入る(1つの便が両方の旗を持つ)。
    // 24時を超える出発が無いので、前日の分は何も足さず、11/3 と同じ結果になる
    const nov23 = run('20261123')
    expect([names(nov23.services.today), names(nov23.services.yesterday)]).toEqual([['06'], ['06']])
    expect(bandTotals(nov23.result, bands.length)).toEqual([2324, 3500, 3391, 3120, 1867, 235])
    expect(nov23.result.counts.size).toBe(1301)
    expect(nov23.result.skippedBlankTime).toBe(0)
    expect(nov23.result.skippedInvalidTime).toBe(0)
    expect(sorted(nov23.result)).toEqual(sorted(nov3.result))

    // 日付を替えても結果が変わらない(平日の 11/2 と 11/9 は同じ、祝日の 11/3 と 11/23 は同じ)一方で、
    // 平日と祝日は違う。日付から service_id を求める段が効いている
    expect(sorted(nov9.result)).not.toEqual(sorted(nov3.result))
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
    const afterResult = departureCountsByBand(after, NOV2, bands)
    expect(afterResult.skippedBlankTime).toBe(0)
    expect(afterResult.skippedInvalidTime).toBe(0)
    expect(afterResult.hasFrequencies).toBe(false)
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

  it('通し:減便後の servicesFor → departureCountsByBand(11/2・11/3・11/9・11/23)。期間の最初の 11/1 は前日が期間の外', async () => {
    // 期待値は検証担当が Python で別に数えた値
    const after = await loadSample(AFTER)
    const bands = makeBands(3)
    const run = (date: string) => departureCountsByBand(after, servicesFor(after, date), bands)
    const weekday = [2784, 3496, 3390, 3231, 1906, 238]
    const holiday = [2324, 3496, 3379, 3118, 1867, 235]

    const nov2 = run('20261102')
    expect(bandTotals(nov2, bands.length)).toEqual(weekday)
    expect(nov2.counts.size).toBe(1354)
    expect(nov2.counts.get('2880_02')).toEqual([24, 36, 35, 35, 24, 0])

    const nov3 = run('20261103')
    expect(bandTotals(nov3, bands.length)).toEqual(holiday)
    expect(nov3.counts.size).toBe(1296)
    expect(nov3.counts.get('2880_02')).toEqual([21, 36, 34, 33, 24, 0])

    const nov9 = run('20261109')
    expect(bandTotals(nov9, bands.length)).toEqual(weekday)
    expect(sorted(nov9)).toEqual(sorted(nov2))

    const nov23 = run('20261123')
    expect(bandTotals(nov23, bands.length)).toEqual(holiday)
    expect(sorted(nov23)).toEqual(sorted(nov3))

    // 期間の最初の日 11/1(日曜、06)は、前日の 10/31 が期間の外なので yesterday が空
    const nov1 = servicesFor(after, '20261101')
    expect([...nov1.today]).toEqual(['06'])
    expect(nov1.yesterday.size).toBe(0)
    expect(bandTotals(departureCountsByBand(after, nov1, bands), bands.length)).toEqual(holiday)
  }, 60_000)
})
