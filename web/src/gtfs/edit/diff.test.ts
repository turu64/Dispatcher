import { describe, expect, it } from 'vitest'
import type { GtfsFeed } from '../load'
import { diffWeekdayTrips, restoreTotals } from './diff'
import { applyForm2 } from './form2'
import { basePlan, feedOf, shiftTrip, smallFeed, withRows } from './form2.fixture'
import type { Form2Plan } from './ops'

function edited(base: GtfsFeed, plan: Form2Plan = basePlan()): GtfsFeed {
  const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result.feed
}

describe('diffWeekdayTrips', () => {
  it('署名の多重集合で、消える便・入る便・残る便に分ける', () => {
    const base = smallFeed()
    const diff = diffWeekdayTrips(base, edited(base), 'WK')
    // R1_0700_WK は土曜の R1_0700_SA と同じ時刻・停留所なので残る(編集後の側の便)
    expect(diff.same.map((b) => [b.feed, b.tripId])).toEqual([['edited', 'R1_0700_WK']])
    expect(diff.removed.map((b) => [b.feed, b.tripId])).toEqual([
      ['base', 'R3_0730_WK'],
      ['base', 'R1_0800_WK'],
      ['base', 'R2_0900_WK'],
    ])
    // R1_0800_WK(編集後)は C→B で、基準の R1_0800_WK(A→B)とは別の便
    expect(diff.added.map((b) => [b.feed, b.tripId])).toEqual([
      ['edited', 'R1_0800_WK'],
      ['edited', 'R1_0805_WK'],
      ['edited', 'R2_1000_WK'],
    ])
    const r3 = diff.removed[0]
    expect(r3).toMatchObject({
      routeId: 'R3',
      routeName: '3',
      headsign: '市役所',
      firstStopName: '駅前',
      lastStopName: '市役所',
      stopNames: ['駅前', '学校前', '市役所'],
      firstDeparture: '07:30',
      lastArrival: '07:50',
      firstSeconds: 7.5 * 3600,
      durationMin: 20,
    })
    expect(diff.byStartBand.find((b) => b.label === '6〜9時')).toEqual({ label: '6〜9時', before: 3, after: 3, removed: 2, added: 2 })
    expect(diff.byStartBand.find((b) => b.label === '9〜12時')).toEqual({ label: '9〜12時', before: 1, after: 1, removed: 1, added: 1 })
    expect(diff.byStartBand.map((b) => b.label)).toEqual([
      '6時より前',
      '6〜9時',
      '9〜12時',
      '12〜15時',
      '15〜18時',
      '18〜21時',
      '21〜24時',
      '24時以降',
      '時刻なし',
    ])
  })

  it('同じ署名の便が複数あれば、trip_id の順に組にする', () => {
    const stopTimes = (ids: string[]) =>
      ids.flatMap((id) => [
        { trip_id: id, arrival_time: '07:00:00', departure_time: '07:00:00', stop_id: 'A', stop_sequence: '1' },
        { trip_id: id, arrival_time: '07:10:00', departure_time: '07:10:00', stop_id: 'B', stop_sequence: '2' },
      ])
    const feed = (ids: string[]) =>
      feedOf({
        trips: ids.map((trip_id) => ({ route_id: 'R1', service_id: 'WK', trip_id })),
        stop_times: stopTimes(ids),
      })
    const diff = diffWeekdayTrips(feed(['b2', 'b1']), feed(['e3', 'e1', 'e2']), 'WK')
    expect(diff.same.map((b) => b.tripId)).toEqual(['e1', 'e2'])
    expect(diff.added.map((b) => b.tripId)).toEqual(['e3'])
    expect(diff.removed).toEqual([])
    const fewer = diffWeekdayTrips(feed(['b2', 'b3', 'b1']), feed(['e1']), 'WK')
    expect(fewer.same.map((b) => b.tripId)).toEqual(['e1'])
    expect(fewer.removed.map((b) => b.tripId)).toEqual(['b2', 'b3'])
  })

  it('同じ trip_id で署名の違う便が、消える便(基準)と入る便(編集後)の両方に出る', () => {
    // R1_0700_SA を 07:10 にした版。写しの trip_id は R1_0700_WK のまま、署名は消える平日便と違う
    const base = shiftTrip(smallFeed(), 'R1_0700_SA', 600)
    const diff = diffWeekdayTrips(base, edited(base), 'WK')
    const removed = diff.removed.find((b) => b.tripId === 'R1_0700_WK')
    const added = diff.added.find((b) => b.tripId === 'R1_0700_WK')
    expect(removed?.feed).toBe('base')
    expect(added?.feed).toBe('edited')
    expect(removed?.firstDeparture).toBe('07:00')
    expect(added?.firstDeparture).toBe('07:10')
    expect(removed?.signature).not.toBe(added?.signature)
    expect(diff.same).toEqual([])
  })

  it('系統ごとの始発・終発の前後と、全曜日で便がなくなる系統を出す', () => {
    const base = smallFeed()
    const diff = diffWeekdayTrips(base, edited(base, basePlan({ excludedRoutes: ['R2'] })), 'WK', ['R2'])
    expect(diff.byRoute).toEqual([
      {
        routeId: 'R1',
        routeName: '1',
        before: 2,
        after: 3,
        removed: 1,
        added: 2,
        same: 1,
        excluded: false,
        firstDepartureBefore: '07:00',
        firstDepartureAfter: '07:00',
        lastDepartureBefore: '08:00',
        lastDepartureAfter: '08:05',
        vanishes: false,
      },
      {
        routeId: 'R2',
        routeName: '2',
        before: 1,
        after: 1,
        removed: 0,
        added: 0,
        same: 1,
        excluded: true,
        firstDepartureBefore: '09:00',
        firstDepartureAfter: '09:00',
        lastDepartureBefore: '09:00',
        lastDepartureAfter: '09:00',
        vanishes: false,
      },
      {
        routeId: 'R3',
        routeName: '3',
        before: 1,
        after: 0,
        removed: 1,
        added: 0,
        same: 0,
        excluded: false,
        firstDepartureBefore: '07:30',
        firstDepartureAfter: null,
        lastDepartureBefore: '07:30',
        lastDepartureAfter: null,
        vanishes: true,
      },
    ])
    expect(diff.vanishingRoutes).toBe(1)
  })

  it('公示第47号の時間帯で、始発停留所の出発時刻の時で数える', () => {
    // R1_0800_WK を 9:59、R2_0900_WK を 10:00、R3_0730_WK を 24:30 にした基準(終点の到着ではなく始発の出発で数える)
    let base = shiftTrip(smallFeed(), 'R1_0800_WK', 7140)
    base = shiftTrip(base, 'R2_0900_WK', 3600)
    base = shiftTrip(base, 'R3_0730_WK', 17 * 3600)
    const diff = diffWeekdayTrips(base, edited(smallFeed()), 'WK')
    const band = (routeId: string, b: string) => diff.byNotice47Band.find((x) => x.routeId === routeId && x.band === b)
    expect(band('R1', '6〜9時台')).toMatchObject({ before: 2, after: 3 })
    expect(band('R2', '6〜9時台')).toMatchObject({ before: 0, after: 0 })
    expect(band('R2', '10〜14時台')).toMatchObject({ before: 1, after: 1 })
    expect(band('R3', '20時台〜翌5時台')).toMatchObject({ before: 1, after: 0 })
    expect(band('R3', '6〜9時台')).toMatchObject({ before: 0, after: 0 })
    // 系統ごとに 4 つの帯をすべて出す
    expect(diff.byNotice47Band).toHaveLength(diff.byRoute.length * 4)
  })

  it('足し戻した便の営業運行時間を合計し、時刻の読めない便は数を別にする', () => {
    const base = smallFeed()
    expect(restoreTotals(base, ['R1_0700_WK', 'R3_0730_WK', 'NONE'])).toEqual({
      trips: 2,
      serviceMinutes: 30,
      unknownDuration: 0,
      earliestStart: '07:00',
      latestEnd: '07:50',
    })
    // 到着・出発が空なら、もう一方の時刻を使う。両方とも読めなければ合計に入れない
    const rows = base.tables.get('stop_times')!.rows.map((r) => {
      if (r.trip_id === 'R2_0900_WK' && r.stop_sequence === '2') return { ...r, arrival_time: '' }
      if (r.trip_id === 'R1_0800_WK' && r.stop_sequence === '1') return { ...r, arrival_time: '', departure_time: '' }
      return r
    })
    const blank = withRows(base, 'stop_times', rows)
    expect(restoreTotals(blank, ['R2_0900_WK', 'R1_0800_WK'])).toEqual({
      trips: 2,
      serviceMinutes: 20,
      unknownDuration: 1,
      earliestStart: '09:00',
      latestEnd: '09:20',
    })
  })
})
