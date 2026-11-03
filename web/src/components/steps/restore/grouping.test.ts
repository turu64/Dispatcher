import { describe, expect, it } from 'vitest'
import type { TripBrief } from '@/gtfs/edit/diff'
import { feedOf, rowsOf } from '@/gtfs/edit/form2.fixture'
import type { RestoreHint } from '@/gtfs/edit/restore'
import type { RouteDirection } from '@/gtfs/edit/stopDiff'
import { compareCandidates, groupCandidates, tripEndpoints, type Candidate } from './grouping'

function cand(tripId: string, routeId: string, firstSeconds: number | null, hints: RestoreHint[] = [], population?: number): Candidate {
  const trip = {
    feed: 'base',
    tripId,
    routeId,
    routeName: routeId,
    headsign: '',
    firstStopName: '駅前',
    lastStopName: '市役所',
    stopNames: [],
    firstDeparture: null,
    lastArrival: null,
    firstSeconds,
    durationMin: null,
    signature: '',
  } satisfies TripBrief
  return { trip, detail: { hints, lostCells: population === undefined ? null : { cells: 1, population } } }
}

describe('compareCandidates', () => {
  it('手がかりの多い順、次に外れたセルの人口の多い順、次に始発の時刻の順(時刻の無い便は後ろ)、次に trip_id の順', () => {
    const list = [
      cand('e', 'R', null, ['morning']),
      cand('d', 'R', 3600, ['morning']),
      cand('c', 'R', 7200, ['morning'], 100),
      cand('b', 'R', 0, ['morning', 'evening']),
      cand('a', 'R', 3600, ['morning']),
      cand('f', 'R', 0),
    ]
    expect([...list].sort(compareCandidates).map((c) => c.trip.tripId)).toEqual(['b', 'c', 'a', 'd', 'e', 'f'])
  })
})

describe('groupCandidates', () => {
  // 名前の同じ停留所 A1・A2(どちらも「駅前」)を始発にする便は、別の方向にする
  const feed = feedOf({
    stop_times: rowsOf(`
trip_id,arrival_time,departure_time,stop_id,stop_sequence
t2,09:00:00,09:00:00,A2,1
t2,09:10:00,09:10:00,B,2
t1,08:00:00,08:00:00,A1,1
t1,08:10:00,08:10:00,B,2
t3,10:00:00,10:00:00,B,2
t3,09:50:00,09:50:00,A1,1
u1,07:00:00,07:00:00,A1,1
u1,07:10:00,07:10:00,B,2`),
  })
  const endpoints = tripEndpoints(feed)
  const candidates = [cand('t3', 'R', 35400), cand('t2', 'R', 32400, ['morning']), cand('t1', 'R', 28800), cand('u1', 'U', 25200)]
  const editedDir: RouteDirection = { firstStopId: 'A1', firstStopName: '駅前', lastStopId: 'B', lastStopName: '市役所', trips: [], maxGapMin: 90 }

  it('stop_sequence の順の最初と最後の stop_id を始発・終着にする', () => {
    expect(endpoints.get('t3')).toEqual({ firstStopId: 'A1', lastStopId: 'B' })
  })

  it('系統 × 方向(stop_id)にまとめ、方向の中は時刻の順。全曜日で便がなくなる系統を先頭にする', () => {
    const groups = groupCandidates(candidates, endpoints, new Set(['U']), (routeId) => (routeId === 'R' ? [editedDir] : []))
    expect(groups.map((g) => [g.routeId, g.vanishes, g.hinted])).toEqual([
      ['U', true, 0],
      ['R', false, 1],
    ])
    const r = groups[1]
    expect(r.candidates[0].trip.tripId).toBe('t2')
    expect(r.directions.map((d) => [d.trips.map((c) => c.trip.tripId), d.edited?.maxGapMin ?? d.edited])).toEqual([
      [['t1', 't3'], 90],
      [['t2'], null],
    ])
    // 比べる日が無ければ、編集後の方向は undefined
    expect(groupCandidates(candidates, endpoints, new Set(), null)[0].directions[0].edited).toBeUndefined()
  })

  it('全曜日で便がなくなる系統が無ければ、系統の中で最も上位の候補の順に並べる', () => {
    expect(groupCandidates(candidates, endpoints, new Set(), null).map((g) => g.routeId)).toEqual(['R', 'U'])
  })
})
