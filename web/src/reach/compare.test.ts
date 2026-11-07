import { describe, expect, it } from 'vitest'
import { servicesFor } from '@/gtfs/calendar'
import { departureCountsByBand, makeBands } from '@/gtfs/departures'
import type { GtfsFeed, GtfsRow } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import { compareReach, zeroServiceRoutes, zeroServiceStops } from './compare'
import { originStops } from './input'
import type { ReachResult } from './reach'

// ---- compareReach ----

/** 5つのセル。4つ目は見込みが無い(ダイヤと関係なく外れる) */
const BEFORE: ReachResult = {
  cells: ['65420000111', '65420000112', '65420000113', '65420000114', '65420000121'],
  classes: ['urban', 'suburban', 'rural', 'rural', 'urban'],
  reachable: [
    [true, true, false, false, true],
    [true, false, false, false, true],
  ],
  coverable: [true, true, true, false, true],
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [10, 2.5, 7.25, 3, 0.5],
}

function afterOf(reachable: boolean[][]): ReachResult {
  return { ...BEFORE, reachable }
}

describe('compareReach', () => {
  it('時間帯ごとに、減便で外れたセルと新たに到達したセル(と推計人口)を数える', () => {
    const after = afterOf([
      // 1つ目は外れ、3つ目は新たに到達
      [false, true, true, false, true],
      // 1つ目と5つ目が外れる
      [false, false, false, false, false],
    ])
    expect(compareReach(BEFORE, after)).toEqual({
      bands: [
        { lostCells: 1, lostPopulation: 10, gainedCells: 1, gainedPopulation: 7.25 },
        { lostCells: 2, lostPopulation: 10.5, gainedCells: 0, gainedPopulation: 0 },
      ],
      // 1つ目は 6〜9時も 9〜12時も外れる。5つ目は 6〜9時に到達できる。2つ目は 6〜9時に到達できる
      dayLostCells: 1,
      dayLostPopulation: 10,
    })
  })

  it('一日を通して乗れなくなる場所は、基準でどれかの時間帯に到達でき、編集後はどの時間帯にも到達できないセル', () => {
    const after = afterOf([
      [false, false, false, false, false],
      [false, false, false, false, false],
    ])
    const c = compareReach(BEFORE, after)
    // 基準でどれかの時間帯に到達できたのは 1・2・5 つ目(3つ目はどの時間帯も外れる)
    expect(c.dayLostCells).toBe(3)
    expect(c.dayLostPopulation).toBe(13)
  })

  it('同じ結果どうしなら差は 0', () => {
    const c = compareReach(BEFORE, afterOf(BEFORE.reachable.map((row) => [...row])))
    expect(c.bands.every((b) => b.lostCells === 0 && b.gainedCells === 0)).toBe(true)
    expect(c.dayLostCells).toBe(0)
  })

  it('見込みの無いセルは数えない', () => {
    // 見込みの無いセルが(本来ありえないが)到達できると出ても、差に入れない
    const before: ReachResult = { ...BEFORE, reachable: [[false, false, false, true, false]] }
    const after: ReachResult = { ...BEFORE, reachable: [[false, false, false, false, false]] }
    expect(compareReach(before, after).bands[0].lostCells).toBe(0)
    expect(compareReach(after, before).bands[0].gainedCells).toBe(0)
  })

  it('調べたセル・区分・見込み・推計人口・時間帯の数が前後で違えばエラーにする', () => {
    const msg = /到達圏を調べた区画が一致しません/
    expect(() => compareReach(BEFORE, { ...BEFORE, cells: BEFORE.cells.slice(0, 4) })).toThrow(msg)
    expect(() => compareReach(BEFORE, { ...BEFORE, classes: ['urban', 'urban', 'rural', 'rural', 'urban'] })).toThrow(msg)
    expect(() => compareReach(BEFORE, { ...BEFORE, coverable: [true, true, true, true, true] })).toThrow(msg)
    expect(() => compareReach(BEFORE, { ...BEFORE, cellPopulation: [10, 2.5, 7.25, 3, 1] })).toThrow(msg)
    expect(() => compareReach(BEFORE, { ...BEFORE, reachable: [BEFORE.reachable[0]] })).toThrow('時間帯の数が一致しません')
  })
})

// ---- zeroServiceStops・zeroServiceRoutes ----

function table(fileName: string, rows: GtfsRow[]) {
  return { fileName, fields: Object.keys(rows[0] ?? {}), rows }
}

const CALENDAR: GtfsRow[] = [
  { service_id: 'WK', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
  { service_id: 'SA', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0', start_date: '20261001', end_date: '20261130' },
]

const STOPS: GtfsRow[] = [
  { stop_id: 'A', stop_name: '駅前', stop_lat: '43.70', stop_lon: '142.30' },
  { stop_id: 'D', stop_name: '土曜だけ残る', stop_lat: '43.71', stop_lon: '142.31' },
  { stop_id: 'E', stop_name: 'どの日も来ない', stop_lat: '43.72', stop_lon: '142.32' },
  { stop_id: 'F', stop_name: '平日も残る', stop_lat: '43.73', stop_lon: '142.33' },
  { stop_id: 'B', stop_name: '終点', stop_lat: '43.74', stop_lon: '142.34' },
]

const ROUTES: GtfsRow[] = [
  { route_id: 'R1', route_short_name: '1', route_long_name: '駅前線' },
  { route_id: 'R2', route_short_name: '', route_long_name: '平日だけの線' },
  { route_id: 'R3', route_short_name: ' ', route_long_name: '' },
]

/** stop_times の行を作る(stops は [stop_id, 'HH:MM:SS'] の並び) */
function stopTimes(tripId: string, stops: [string, string][]): GtfsRow[] {
  return stops.map(([stopId, time], i) => ({
    trip_id: tripId,
    stop_id: stopId,
    stop_sequence: String(i + 1),
    arrival_time: time,
    departure_time: time,
  }))
}

function feedOf(trips: GtfsRow[], times: GtfsRow[]): GtfsFeed {
  return {
    tables: new Map([
      ['stops', table('stops.txt', STOPS)],
      ['routes', table('routes.txt', ROUTES)],
      ['calendar', table('calendar.txt', CALENDAR)],
      ['trips', table('trips.txt', trips)],
      ['stop_times', table('stop_times.txt', times)],
    ]),
    warnings: [],
  }
}

/**
 * 基準:平日 R1 は A→D→E→B を 7:00 と A→F→B を 19:00、R2 は F→B を 8:00 と 9:00、R3 は A→B を 10:00。土曜 R1 は A→D→B を 8:00。
 * 編集後:平日の R1 は A→F→B の 19:00 だけ(D・E を通らない)、R2 は無い(全曜日で便がなくなる)、R3 は平日に無く土曜に残る。土曜はそのまま
 */
const BASE = feedOf(
  [
    { route_id: 'R1', service_id: 'WK', trip_id: 'R1_0700_WK' },
    { route_id: 'R1', service_id: 'WK', trip_id: 'R1_1900_WK' },
    { route_id: 'R2', service_id: 'WK', trip_id: 'R2_0800_WK' },
    { route_id: 'R2', service_id: 'WK', trip_id: 'R2_0900_WK' },
    { route_id: 'R3', service_id: 'WK', trip_id: 'R3_1000_WK' },
    { route_id: 'R1', service_id: 'SA', trip_id: 'R1_0800_SA' },
    { route_id: 'R3', service_id: 'SA', trip_id: 'R3_1000_SA' },
  ],
  [
    ...stopTimes('R1_0700_WK', [['A', '07:00:00'], ['D', '07:05:00'], ['E', '07:10:00'], ['B', '07:20:00']]),
    ...stopTimes('R1_1900_WK', [['A', '19:00:00'], ['F', '19:05:00'], ['B', '19:10:00']]),
    ...stopTimes('R2_0800_WK', [['F', '08:00:00'], ['B', '08:10:00']]),
    ...stopTimes('R2_0900_WK', [['F', '09:00:00'], ['B', '09:10:00']]),
    ...stopTimes('R3_1000_WK', [['A', '10:00:00'], ['B', '10:10:00']]),
    ...stopTimes('R1_0800_SA', [['A', '08:00:00'], ['D', '08:05:00'], ['B', '08:10:00']]),
    ...stopTimes('R3_1000_SA', [['A', '10:00:00'], ['B', '10:10:00']]),
  ],
)

const EDITED = feedOf(
  [
    { route_id: 'R1', service_id: 'WK', trip_id: 'R1_1900_WK' },
    { route_id: 'R1', service_id: 'SA', trip_id: 'R1_0800_SA' },
    { route_id: 'R3', service_id: 'SA', trip_id: 'R3_1000_SA' },
  ],
  [
    ...stopTimes('R1_1900_WK', [['A', '19:00:00'], ['F', '19:05:00'], ['B', '19:10:00']]),
    ...stopTimes('R1_0800_SA', [['A', '08:00:00'], ['D', '08:05:00'], ['B', '08:10:00']]),
    ...stopTimes('R3_1000_SA', [['A', '10:00:00'], ['B', '10:10:00']]),
  ],
)

/** 2026-11-04 は水曜 */
const WEDNESDAY = '20261104'

function countsOn(feed: GtfsFeed, date: string) {
  return departureCountsByBand(feed, servicesFor(feed, date), makeBands(3))
}

describe('zeroServiceStops', () => {
  const origins = originStops(BASE, toStops(BASE).stops).stops

  it('全便で乗れる行が無くなった停留所は feed、その日だけ 0 なら day にし、feed・出発の数の降順・stop_id の順に並べる', () => {
    expect(origins.map((s) => s.id)).toEqual(['A', 'D', 'E', 'F'])
    const zero = zeroServiceStops(origins, countsOn(BASE, WEDNESDAY), countsOn(EDITED, WEDNESDAY), EDITED)
    expect(zero).toEqual([
      // E は編集後のどの便も通らない
      { stopId: 'E', name: 'どの日も来ない', beforeDepartures: 1, scope: 'feed' },
      // D は土曜の便で乗れる(平日だけ 0)
      { stopId: 'D', name: '土曜だけ残る', beforeDepartures: 1, scope: 'day' },
    ])
    // A は 19:00 が残り、F も 19:05 が残る(R2 の 8:00・9:00 は消えるが 0 にはならない)
  })

  it('基準でその日に出発の無い停留所は出さない', () => {
    // 土曜(11/7)は D・A に出発があり、編集後も同じ
    expect(zeroServiceStops(origins, countsOn(BASE, '20261107'), countsOn(EDITED, '20261107'), EDITED)).toEqual([])
  })

  it('出発の数の多い停留所を先に並べ、同じ stop_id の停留所は1つにまとめる', () => {
    const counts = (entries: [string, number[]][]) => ({
      counts: new Map(entries),
      skippedBlankTime: 0,
      skippedInvalidTime: 0,
      hasFrequencies: false,
    })
    const stop = (id: string) => ({ id, name: id, lat: 43.7, lon: 142.3, locationType: 0, parentStation: '' })
    const zero = zeroServiceStops(
      [stop('Y'), stop('X'), stop('Z'), stop('Y')],
      counts([
        ['X', [1, 1]],
        ['Y', [0, 1]],
        ['Z', [2, 0]],
      ]),
      counts([]),
      // 編集後に乗れる行が無いので、すべて feed
      { tables: new Map(), warnings: [] },
    )
    expect(zero.map((z) => [z.stopId, z.beforeDepartures])).toEqual([
      ['X', 2],
      ['Z', 2],
      ['Y', 1],
    ])
  })
})

describe('zeroServiceRoutes', () => {
  it('全曜日で便がなくなる系統は feed(全便の数)、その日だけ 0 なら day(その日の便の数)にする', () => {
    expect(zeroServiceRoutes(BASE, EDITED, WEDNESDAY)).toEqual([
      // R2 は編集後の trips に1本も無い。名前は route_short_name が空なので route_long_name
      { routeId: 'R2', name: '平日だけの線', beforeTrips: 2, scope: 'feed' },
      // R3 は平日だけ 0(土曜に残る)。名前は short・long とも空なので route_id
      { routeId: 'R3', name: 'R3', beforeTrips: 1, scope: 'day' },
    ])
  })

  it('全曜日で便がなくなる系統は、その日に便が無くても出す。その日の便が 0 にならない系統は出さない', () => {
    // 土曜(11/7)は R2 の便がもともと無いが、出力のどの日にも便が無いので出す。R1・R3 は土曜の便が残る
    expect(zeroServiceRoutes(BASE, EDITED, '20261107')).toEqual([{ routeId: 'R2', name: '平日だけの線', beforeTrips: 2, scope: 'feed' }])
  })

  it('同じフィードなら何も出さない', () => {
    expect(zeroServiceRoutes(BASE, BASE, WEDNESDAY)).toEqual([])
  })
})
