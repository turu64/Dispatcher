import { describe, expect, it } from 'vitest'
import type { GtfsRow } from '../load'
import { restoreTotals } from './diff'
import { feedOf } from './form2.fixture'
import { compareServiceHours, serviceHours, tripLegs } from './serviceHours'

/** 便の stop_times。times は [stop_id, arrival_time, departure_time] を stop_sequence の順に */
function stopTimes(tripId: string, times: [string, string, string][]): GtfsRow[] {
  return times.map(([stop_id, arrival_time, departure_time], i) => ({
    trip_id: tripId,
    stop_sequence: String(i + 1),
    stop_id,
    arrival_time,
    departure_time,
  }))
}

/** 平日(WK)3 便・土曜(SA)1 便。WK_LATE は 24時を超える */
function feed(extra: { stopTimes?: GtfsRow[]; trips?: GtfsRow[] } = {}) {
  return feedOf({
    trips: [
      { route_id: 'R1', service_id: 'WK', trip_id: 'WK_0700' },
      { route_id: 'R1', service_id: ' WK ', trip_id: ' WK_0630 ' },
      { route_id: 'R2', service_id: 'WK', trip_id: 'WK_LATE' },
      { route_id: 'R1', service_id: 'SA', trip_id: 'SA_0800' },
      ...(extra.trips ?? []),
    ],
    stop_times: [
      // stop_sequence の順と行の順が違っても、並べ替えて最初と最後を取る
      ...stopTimes('WK_0700', [
        ['A', '07:00:00', '07:00:00'],
        ['B', '07:10:00', '07:11:00'],
        ['C', '07:30:00', '07:30:00'],
      ]).reverse(),
      ...stopTimes('WK_0630', [
        ['C', '06:30:00', '06:30:00'],
        ['A', '06:50:00', '06:50:00'],
      ]),
      ...stopTimes('WK_LATE', [
        ['A', '23:50:00', '23:50:00'],
        ['D', '24:35:00', '24:35:00'],
      ]),
      ...stopTimes('SA_0800', [
        ['A', '08:00:00', '08:00:00'],
        ['C', '08:40:00', '08:40:00'],
      ]),
      ...(extra.stopTimes ?? []),
    ],
  })
}

describe('serviceHours', () => {
  it('その日に走る service の便だけを数え、24時を超える時刻はそのまま足す', () => {
    // 30 分 + 20 分 + 45 分(23:50〜24:35)
    expect(serviceHours(feed(), new Set(['WK']))).toEqual({
      trips: 3,
      serviceMinutes: 95,
      unknownDuration: 0,
      firstDeparture: '06:30',
      lastArrival: '24:35',
    })
    // 走らない service(SA)の便は入らない。配列でも渡せる
    expect(serviceHours(feed(), ['SA']).trips).toBe(1)
    expect(serviceHours(feed(), new Set(['SA', 'NONE'])).serviceMinutes).toBe(40)
  })

  it('走る service が無ければ 0 便で、時刻は null', () => {
    expect(serviceHours(feed(), new Set())).toEqual({
      trips: 0,
      serviceMinutes: 0,
      unknownDuration: 0,
      firstDeparture: null,
      lastArrival: null,
    })
  })

  it('到着・出発の片方が空ならもう一方を使い、両方とも読めない便は合計に入れず数を別にする', () => {
    const f = feed({
      trips: [
        { route_id: 'R1', service_id: 'WK', trip_id: 'WK_HALF' },
        { route_id: 'R1', service_id: 'WK', trip_id: 'WK_BLANK' },
        { route_id: 'R1', service_id: 'WK', trip_id: 'WK_NOSTOPS' },
      ],
      stopTimes: [
        // 最初の出発が空 → 到着の 09:00 を使う。最後の到着が空 → 出発の 09:25 を使う
        ...stopTimes('WK_HALF', [
          ['A', '09:00:00', ''],
          ['B', '', '09:25:00'],
        ]),
        // 最初の停留所の時刻が両方とも空(途中の停留所の時刻は補間しない)
        ...stopTimes('WK_BLANK', [
          ['A', '', ''],
          ['B', '10:20:00', '10:20:00'],
        ]),
      ],
    })
    const h = serviceHours(f, new Set(['WK']))
    expect(h.trips).toBe(6)
    expect(h.serviceMinutes).toBe(95 + 25)
    expect(h.unknownDuration).toBe(2)
    // 読めた片側の時刻は、最初の出発・最後の到着に入れる(restoreTotals と同じ)
    expect(h.firstDeparture).toBe('06:30')
    expect(h.lastArrival).toBe('24:35')
  })

  it('同じ数え方の restoreTotals と、同じ便の集まりで合計が一致する', () => {
    const f = feed()
    const totals = restoreTotals(f, ['WK_0700', 'WK_0630', 'WK_LATE'])
    const h = serviceHours(f, new Set(['WK']))
    expect(h.serviceMinutes).toBe(totals.serviceMinutes)
    expect(h.trips).toBe(totals.trips)
    expect(h.firstDeparture).toBe(totals.earliestStart)
    expect(h.lastArrival).toBe(totals.latestEnd)
  })

  it('trips に同じ trip_id の行が重なっていても1便として数える', () => {
    const f = feed({ trips: [{ route_id: 'R1', service_id: 'WK', trip_id: 'WK_0700' }] })
    expect(serviceHours(f, new Set(['WK'])).trips).toBe(3)
  })
})

describe('tripLegs', () => {
  it('その日の便を出発の順の区間にし、時刻が読めない便は数だけを返す', () => {
    const f = feed({
      trips: [
        { route_id: 'R1', service_id: 'WK', trip_id: 'WK_0630_B' },
        { route_id: 'R1', service_id: 'WK', trip_id: 'WK_BLANK' },
      ],
      stopTimes: [
        ...stopTimes('WK_0630_B', [
          ['A', '06:30:00', '06:30:00'],
          ['B', '06:40:00', '06:40:00'],
        ]),
        ...stopTimes('WK_BLANK', [
          ['A', '08:00:00', '08:00:00'],
          ['B', '', ''],
        ]),
      ],
    })
    const { legs, unknownTrips } = tripLegs(f, new Set(['WK']))
    expect(unknownTrips).toBe(1)
    // 出発が同じ 06:30 の 2 便は trip_id の昇順。trip_id・stop_id は空白を取る
    expect(legs).toEqual([
      { tripId: 'WK_0630', dep: 6.5 * 3600, arr: 6 * 3600 + 50 * 60, firstStopId: 'C', lastStopId: 'A' },
      { tripId: 'WK_0630_B', dep: 6.5 * 3600, arr: 6 * 3600 + 40 * 60, firstStopId: 'A', lastStopId: 'B' },
      { tripId: 'WK_0700', dep: 7 * 3600, arr: 7.5 * 3600, firstStopId: 'A', lastStopId: 'C' },
      { tripId: 'WK_LATE', dep: 23 * 3600 + 50 * 60, arr: 24 * 3600 + 35 * 60, firstStopId: 'A', lastStopId: 'D' },
    ])
  })

  it('走らない service の便は区間にしない', () => {
    expect(tripLegs(feed(), new Set(['SA'])).legs.map((l) => l.tripId)).toEqual(['SA_0800'])
    expect(tripLegs(feed(), new Set())).toEqual({ legs: [], unknownTrips: 0 })
  })
})

describe('compareServiceHours', () => {
  it('前 − 後の便の数と分、分の割合を返す', () => {
    const f = feed()
    const c = compareServiceHours(serviceHours(f, new Set(['WK'])), serviceHours(f, new Set(['SA'])))
    expect(c.reduction).toEqual({ trips: 2, serviceMinutes: 55, ratio: 55 / 95 })
    expect(c.before.trips).toBe(3)
    expect(c.after.trips).toBe(1)
  })

  it('増えたら負の削減量になり、前が 0 分なら割合は null', () => {
    const f = feed()
    const none = serviceHours(f, new Set())
    const wk = serviceHours(f, new Set(['WK']))
    expect(compareServiceHours(none, wk).reduction).toEqual({ trips: -3, serviceMinutes: -95, ratio: null })
    expect(compareServiceHours(wk, none).reduction.ratio).toBe(1)
  })
})
