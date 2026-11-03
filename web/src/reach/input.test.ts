import { describe, expect, it } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import type { GtfsFeed, GtfsRow } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import {
  bandIndexForHour,
  boardingStopIds,
  buildReachStops,
  cloneParams,
  originStops,
  parseDensityThreshold,
  parseWalkMinutes,
  refMarginM,
} from './input'
import { DEFAULT_REACH_PARAMS } from './reach'

describe('cloneParams', () => {
  it('入れ子まで写す(写しを変えても既定値は変わらない)', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    expect(p).toEqual(DEFAULT_REACH_PARAMS)
    p.walkMinutes.urban.bus = 7
    p.densityThreshold = 5
    expect(DEFAULT_REACH_PARAMS.walkMinutes.urban.bus).toBe(5)
    expect(DEFAULT_REACH_PARAMS.densityThreshold).toBe(1000)
  })
})

describe('refMarginM', () => {
  it('既定では、バス停の距離の最大 15分 × 80m = 1,200m と、駅の距離の最大 20分 × 80m = 1,600m の和 2,800m', () => {
    expect(refMarginM(DEFAULT_REACH_PARAMS)).toBe(2800)
  })

  it('バス停と駅の最大は、別々の区分から取る(6つの値の最大ではない)', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    p.walkMinutes.urban.bus = 30
    // バス停の最大は都市部の 30分、駅の最大は中山間・地方の 20分
    expect(refMarginM(p)).toBe((30 + 20) * 80)
    p.walkMinutes.suburban.rail = 40
    expect(refMarginM(p)).toBe((30 + 40) * 80)
  })

  it('分速を掛ける', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    p.speedMPerMin = 60
    expect(refMarginM(p)).toBe((15 + 20) * 60)
  })

  it('すべて 0 分なら 0m', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    for (const c of ['urban', 'suburban', 'rural'] as const) p.walkMinutes[c] = { bus: 0, rail: 0 }
    expect(refMarginM(p)).toBe(0)
  })
})

describe('originStops', () => {
  function feedOf(stops: GtfsRow[], stopTimes: GtfsRow[] | null): GtfsFeed {
    const tables = new Map([['stops', { fileName: 'stops.txt', fields: Object.keys(stops[0] ?? {}), rows: stops }]])
    if (stopTimes) tables.set('stop_times', { fileName: 'stop_times.txt', fields: ['trip_id', 'stop_id'], rows: stopTimes })
    return { tables, warnings: [] }
  }

  const STOPS: GtfsRow[] = [
    { stop_id: 'A', stop_name: 'A', stop_lat: '43.70', stop_lon: '142.30', location_type: '' },
    { stop_id: 'B', stop_name: 'B', stop_lat: '43.71', stop_lon: '142.31', location_type: '0' },
    { stop_id: 'C', stop_name: '使われない', stop_lat: '43.72', stop_lon: '142.32' },
    { stop_id: 'S', stop_name: '駅舎', stop_lat: '43.73', stop_lon: '142.33', location_type: '1' },
    { stop_id: 'E', stop_name: '出入口', stop_lat: '43.74', stop_lon: '142.34', location_type: '2', parent_station: 'S' },
    { stop_id: 'D', stop_name: '列の無い停留所', stop_lat: '43.75', stop_lon: '142.35' },
  ]

  it('stop_times に出てくる、location_type が 0 か空の停留所だけを stops の並びのまま選ぶ', () => {
    const feed = feedOf(STOPS, [
      { trip_id: 'T', stop_id: 'B' },
      { trip_id: 'T', stop_id: 'A' },
      { trip_id: 'T', stop_id: 'S' },
      { trip_id: 'T', stop_id: 'D' },
    ])
    const r = originStops(feed, toStops(feed).stops)
    expect(r.stops.map((s) => s.id)).toEqual(['A', 'B', 'D'])
    expect(r.unused).toBe(1)
    // 駅舎(1)と出入口(2)。駅舎は stop_times に出てきても起点にしない
    expect(r.nonStop).toBe(2)
  })

  it('stop_id は前後の空白を取って照合する', () => {
    const feed = feedOf(
      [{ stop_id: ' A ', stop_name: 'A', stop_lat: '43.70', stop_lon: '142.30' }],
      [{ trip_id: 'T', stop_id: 'A  ' }],
    )
    expect(originStops(feed, toStops(feed).stops).stops.map((s) => s.id)).toEqual(['A'])
  })

  it('stop_times.txt が無ければ起点は無い(すべて「使われない」)', () => {
    const feed = feedOf(STOPS, null)
    const r = originStops(feed, toStops(feed).stops)
    expect(r.stops).toEqual([])
    expect(r.unused).toBe(4)
    expect(r.nonStop).toBe(2)
  })

  it('stop_id が空の行は照合しない', () => {
    const feed = feedOf([{ stop_id: '', stop_name: '空', stop_lat: '43.70', stop_lon: '142.30' }], [{ trip_id: 'T', stop_id: ' ' }])
    expect(originStops(feed, toStops(feed).stops)).toEqual({ stops: [], unused: 1, nonStop: 0, noBoarding: 0 })
  })

  it('乗れる行が1つも無い停留所(すべて終点か pickup_type 1)は起点にせず、noBoarding に数える', () => {
    const stops: GtfsRow[] = [
      { stop_id: 'A', stop_name: 'A', stop_lat: '43.70', stop_lon: '142.30' },
      { stop_id: 'B', stop_name: '終点だけ', stop_lat: '43.71', stop_lon: '142.31' },
      { stop_id: 'P', stop_name: '降車専用', stop_lat: '43.72', stop_lon: '142.32' },
      { stop_id: 'C', stop_name: '使われない', stop_lat: '43.73', stop_lon: '142.33' },
      { stop_id: 'S', stop_name: '駅舎', stop_lat: '43.74', stop_lon: '142.34', location_type: '1' },
    ]
    const feed = feedOf(stops, [
      { trip_id: 'T1', stop_id: 'A', stop_sequence: '1' },
      { trip_id: 'T1', stop_id: 'P', stop_sequence: '2', pickup_type: ' 1 ' },
      { trip_id: 'T1', stop_id: 'B', stop_sequence: '3' },
      { trip_id: 'T2', stop_id: 'A', stop_sequence: '1' },
      { trip_id: 'T2', stop_id: 'B', stop_sequence: '10' },
      // 駅舎は乗れる行があっても起点にしない(location_type で先に除く)
      { trip_id: 'T2', stop_id: 'S', stop_sequence: '2' },
    ])
    const r = originStops(feed, toStops(feed).stops)
    expect(r.stops.map((s) => s.id)).toEqual(['A'])
    expect(r).toMatchObject({ unused: 1, nonStop: 1, noBoarding: 2 })
  })
})

describe('boardingStopIds', () => {
  function feedOf(stopTimes: GtfsRow[]): GtfsFeed {
    return { tables: new Map([['stop_times', { fileName: 'stop_times.txt', fields: [], rows: stopTimes }]]), warnings: [] }
  }

  it('各便の最後の停留所(stop_sequence の数値が最大)と pickup_type 1 の行は乗れる行にしない', () => {
    const feed = feedOf([
      { trip_id: 'T1', stop_id: 'A', stop_sequence: '9' },
      { trip_id: 'T1', stop_id: 'B', stop_sequence: '10' },
      { trip_id: 'T2', stop_id: 'C', stop_sequence: '1', pickup_type: '1' },
      { trip_id: 'T2', stop_id: 'D', stop_sequence: '2', pickup_type: '' },
      { trip_id: 'T2', stop_id: 'E', stop_sequence: '3' },
    ])
    // '10' は '9' より大きい(文字の並びではなく数値で比べる)
    expect([...boardingStopIds(feed)].sort()).toEqual(['A', 'D'])
  })

  it('ほかの便で乗れる行があれば、ある便の終点でも乗れる停留所にする', () => {
    const feed = feedOf([
      { trip_id: 'T1', stop_id: 'A', stop_sequence: '1' },
      { trip_id: 'T1', stop_id: 'B', stop_sequence: '2' },
      { trip_id: 'T2', stop_id: 'B', stop_sequence: '1' },
      { trip_id: 'T2', stop_id: 'A', stop_sequence: '2' },
    ])
    expect([...boardingStopIds(feed)].sort()).toEqual(['A', 'B'])
  })

  it('stop_sequence が読めない行は終点の判定に使わず、乗れる行として扱う(departures.ts と同じ)', () => {
    const feed = feedOf([
      { trip_id: 'T1', stop_id: 'A', stop_sequence: '1' },
      { trip_id: 'T1', stop_id: 'X', stop_sequence: '0x0A' },
      { trip_id: 'T1', stop_id: 'B', stop_sequence: '002' },
      // 1つしか行の無い便は、その行が終点
      { trip_id: 'T2', stop_id: 'C', stop_sequence: '5' },
    ])
    expect([...boardingStopIds(feed)].sort()).toEqual(['A', 'X'])
  })

  it('trip_id・stop_id・pickup_type は前後の空白を取って照合する', () => {
    const feed = feedOf([
      { trip_id: ' T1', stop_id: ' A ', stop_sequence: ' 1 ' },
      { trip_id: 'T1 ', stop_id: 'B', stop_sequence: '2' },
      { trip_id: 'T2', stop_id: 'C', stop_sequence: '1', pickup_type: ' 1' },
      { trip_id: 'T2', stop_id: 'D', stop_sequence: '2' },
      { trip_id: 'T3', stop_id: ' ', stop_sequence: '1' },
      { trip_id: 'T3', stop_id: 'E', stop_sequence: '2' },
    ])
    expect([...boardingStopIds(feed)]).toEqual(['A'])
  })

  it('stop_times.txt が無ければ空', () => {
    expect(boardingStopIds({ tables: new Map(), warnings: [] }).size).toBe(0)
  })
})

describe('buildReachStops', () => {
  const stops = [
    { id: 'A', lat: 43.7, lon: 142.3 },
    { id: 'B', lat: 43.8, lon: 142.4 },
    { id: 'A', lat: 43.71, lon: 142.31 },
  ]

  it('counts の値を時間帯ごとに並べ、無い停留所は 0 で埋める', () => {
    const counts = new Map([['A', [1, 0, 2]]])
    expect(buildReachStops(stops, counts, 3)).toEqual([
      { lat: 43.7, lon: 142.3, bandCounts: [1, 0, 2] },
      { lat: 43.8, lon: 142.4, bandCounts: [0, 0, 0] },
      { lat: 43.71, lon: 142.31, bandCounts: [1, 0, 2] },
    ])
  })

  it('counts の配列が短ければ、足りない時間帯は 0', () => {
    expect(buildReachStops(stops.slice(0, 1), new Map([['A', [4]]]), 3)[0].bandCounts).toEqual([4, 0, 0])
  })

  it('counts の配列を共有しない(書き換えても counts は変わらない)', () => {
    const counts = new Map([['A', [1, 1, 1]]])
    const r = buildReachStops(stops.slice(0, 1), counts, 3)
    r[0].bandCounts[0] = 9
    expect(counts.get('A')).toEqual([1, 1, 1])
  })
})

describe('bandIndexForHour', () => {
  const three = makeBands(3)
  const one = makeBands(1)

  it('その時刻を含む時間帯', () => {
    expect(bandIndexForHour(three, 6)).toBe(0)
    expect(bandIndexForHour(three, 8)).toBe(0)
    expect(bandIndexForHour(three, 9)).toBe(1)
    expect(bandIndexForHour(three, 23)).toBe(5)
    expect(bandIndexForHour(one, 10)).toBe(4)
    expect(bandIndexForHour(one, 23)).toBe(17)
  })

  it('3時間ごとと1時間ごとを行き来しても、同じ時刻を含む時間帯になる', () => {
    for (let h = 6; h < 24; h++) {
      const b3 = three[bandIndexForHour(three, h)]
      const b1 = one[bandIndexForHour(one, h)]
      expect(b3.startHour <= b1.startHour && b1.endHour <= b3.endHour).toBe(true)
    }
  })

  it('範囲の外は近いほうの端。時間帯が無ければ -1', () => {
    expect(bandIndexForHour(three, 3)).toBe(0)
    expect(bandIndexForHour(three, 24)).toBe(5)
    expect(bandIndexForHour([], 9)).toBe(-1)
  })
})

describe('parseWalkMinutes', () => {
  it('0〜60 の整数を読む(全角・前後の空白も読む)', () => {
    expect(parseWalkMinutes('5')).toEqual({ ok: true, value: 5 })
    expect(parseWalkMinutes(' 12 ')).toEqual({ ok: true, value: 12 })
    expect(parseWalkMinutes('０')).toEqual({ ok: true, value: 0 })
    expect(parseWalkMinutes('１５')).toEqual({ ok: true, value: 15 })
    expect(parseWalkMinutes('60')).toEqual({ ok: true, value: 60 })
    expect(parseWalkMinutes('007')).toEqual({ ok: true, value: 7 })
  })

  it('小数は整数を入れるよう理由を返す', () => {
    expect(parseWalkMinutes('12.5')).toEqual({ ok: false, message: '整数を入れてください' })
    expect(parseWalkMinutes('１２．５')).toEqual({ ok: false, message: '整数を入れてください' })
    expect(parseWalkMinutes('5.0')).toEqual({ ok: false, message: '整数を入れてください' })
  })

  it('空・負・数でない値・上限を超える値は理由を返す', () => {
    expect(parseWalkMinutes('')).toEqual({ ok: false, message: '数を入れてください' })
    expect(parseWalkMinutes('-1')).toEqual({ ok: false, message: '0 以上の整数を入れてください' })
    expect(parseWalkMinutes('1e2')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('0x10')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('abc')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('.5')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('61')).toEqual({ ok: false, message: '60分以下にしてください' })
  })
})

describe('parseDensityThreshold', () => {
  it('0〜100,000 の数を読む(小数も読む)', () => {
    expect(parseDensityThreshold('1000')).toEqual({ ok: true, value: 1000 })
    expect(parseDensityThreshold('0')).toEqual({ ok: true, value: 0 })
    expect(parseDensityThreshold('1000.5')).toEqual({ ok: true, value: 1000.5 })
    expect(parseDensityThreshold('100000')).toEqual({ ok: true, value: 100000 })
    expect(parseDensityThreshold('-1')).toEqual({ ok: false, message: '0 以上の数を入れてください' })
  })

  it('上限を超えれば理由を返す', () => {
    expect(parseDensityThreshold('100001')).toEqual({ ok: false, message: '100,000人/km²以下にしてください' })
    expect(parseDensityThreshold('1,000')).toMatchObject({ ok: false })
  })
})
