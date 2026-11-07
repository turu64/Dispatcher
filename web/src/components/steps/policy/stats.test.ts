import { describe, expect, it } from 'vitest'
import { multiFeed, smallFeed, withRows } from '@/gtfs/edit/form2.fixture'
import type { PolicyKind } from '@/gtfs/edit/ops'
import type { GroupChoice } from '@/gtfs/groups/view'
import type { GtfsFeed } from '@/gtfs/load'
import { routeTripCounts, sameGroupTimetable } from './stats'

describe('routeTripCounts', () => {
  it('service の並びを渡すと、組のすべての平日の service と入れ替えに使う service の便を系統ごとに数える', () => {
    const feed = multiFeed()
    const stats = routeTripCounts(feed, ['01001', '01001_A', 'WB'], ['03001', '03001_A', 'SB1', 'SB2'])
    const byRoute = Object.fromEntries(stats.map((s) => [s.routeId, [s.weekday, s.replacement]]))
    // R1:01001 の 2 便と 01001_A の 1 便 / 03001 の 3 便と 03001_A の 1 便。R2:WB の 1 便 / SB1・SB2 の 2 便。R3:01001 の 1 便 / なし
    expect(byRoute).toEqual({ R1: [3, 4], R2: [1, 2], R3: [1, 0] })
    // 入れ替えに使う便が無い系統を先に並べる
    expect(stats[0].routeId).toBe('R3')
  })

  it('1つの service を渡したときと、1つだけの並びを渡したときは同じ', () => {
    const feed = multiFeed()
    expect(routeTripCounts(feed, ['01001'], ['03001'])).toEqual(routeTripCounts(feed, '01001', '03001'))
    expect(routeTripCounts(feed, [], ['03001'])).toEqual([])
    expect(routeTripCounts(feed, null, null)).toEqual([])
  })
})

/** smallFeed の SU の便を、SA の便と同じ時刻・停留所にしたもの */
function sameSatSunFeed(): GtfsFeed {
  const base = smallFeed()
  const saTrips = base.tables.get('trips')!.rows.filter((t) => t.service_id === 'SA')
  const suTrips = saTrips.map((t) => ({ ...t, service_id: 'SU', trip_id: t.trip_id!.replace('_SA', '_SU') }))
  let feed = withRows(base, 'trips', [...base.tables.get('trips')!.rows.filter((t) => t.service_id !== 'SU'), ...suTrips])
  const saStopTimes = base.tables.get('stop_times')!.rows.filter((r) => r.trip_id!.endsWith('_SA'))
  feed = withRows(feed, 'stop_times', [
    ...base.tables.get('stop_times')!.rows.filter((r) => !r.trip_id!.endsWith('_SU')),
    ...saStopTimes.map((r) => ({ ...r, trip_id: r.trip_id!.replace('_SA', '_SU') })),
  ])
  return feed
}

function choice(kind: PolicyKind, pairs: { weekday: string; replacements: string[] }[]): GroupChoice {
  return { kind, weekdayService: pairs[0].weekday, replacementService: pairs[0].replacements[0] ?? '', pairs, keptWeekdayServices: [] }
}

describe('sameGroupTimetable', () => {
  it('すべての組で、土曜と日祝の入れ替えに使う service が同じ時刻表なら true', () => {
    const feed = sameSatSunFeed()
    const byKind = {
      weekdayToSaturday: choice('weekdayToSaturday', [{ weekday: 'WK', replacements: ['SA'] }]),
      weekdayToSundayHoliday: choice('weekdayToSundayHoliday', [{ weekday: 'WK', replacements: ['SU'] }]),
    }
    expect(sameGroupTimetable(feed, byKind)).toBe(true)
    // 時刻表が違えば false
    expect(sameGroupTimetable(smallFeed(), byKind)).toBe(false)
  })

  it('同じ service だけで入れ替える(土日祝の service)・組の数や平日の service が違う・作れない種類があるときは false', () => {
    const feed = sameSatSunFeed()
    const same = choice('weekdayToSaturday', [{ weekday: 'WK', replacements: ['SA'] }])
    expect(sameGroupTimetable(feed, { weekdayToSaturday: same, weekdayToSundayHoliday: { ...same, kind: 'weekdayToSundayHoliday' } })).toBe(false)
    expect(
      sameGroupTimetable(feed, {
        weekdayToSaturday: choice('weekdayToSaturday', [{ weekday: 'WK', replacements: ['SA'] }]),
        weekdayToSundayHoliday: choice('weekdayToSundayHoliday', [
          { weekday: 'WK', replacements: ['SU'] },
          { weekday: 'X', replacements: [] },
        ]),
      }),
    ).toBe(false)
    expect(
      sameGroupTimetable(feed, {
        weekdayToSaturday: same,
        weekdayToSundayHoliday: { error: [] },
      }),
    ).toBe(false)
  })
})
