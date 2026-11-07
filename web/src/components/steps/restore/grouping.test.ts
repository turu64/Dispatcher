import { describe, expect, it } from 'vitest'
import type { TripBrief } from '@/gtfs/edit/diff'
import { feedOf, rowsOf } from '@/gtfs/edit/form2.fixture'
import type { NearFacility, RestoreHint } from '@/gtfs/edit/restore'
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
  return { trip, detail: { hints, lostCells: population === undefined ? null : { cells: 1, population }, band: null, routeTrips: { before: 0, after: 0 } } }
}

describe('compareCandidates', () => {
  it('判断材料の重みの大きい順、次に外れたセルの人口の多い順、次に始発の時刻の順(時刻の無い便は後ろ)、次に trip_id の順', () => {
    const list = [
      cand('e', 'R', null, ['lastTripOfRoute']),
      cand('d', 'R', 3600, ['lastTripOfRoute']),
      cand('c', 'R', 7200, ['lastTripOfRoute'], 100),
      cand('b', 'R', 0, ['firstTripOfRoute', 'lastTripOfRoute']),
      cand('a', 'R', 3600, ['lastTripOfRoute']),
      cand('f', 'R', 0),
    ]
    expect([...list].sort(compareCandidates).map((c) => c.trip.tripId)).toEqual(['b', 'c', 'a', 'd', 'e', 'f'])
  })

  it('数ではなく重みで並べる。重い判断材料1つ(時間帯の便がなくなる)は、軽い判断材料2つ(始発・終発)と朝より上', () => {
    const list = [
      cand('light', 'R', 0, ['firstTripOfRoute', 'lastTripOfRoute', 'morning']),
      cand('heavy', 'R', 3600, ['onlyTripInBand']),
      cand('medium', 'R', 0, ['firstTripLater']),
      cand('morningOnly', 'R', 0, ['morning', 'evening']),
    ]
    expect([...list].sort(compareCandidates).map((c) => c.trip.tripId)).toEqual(['heavy', 'light', 'medium', 'morningOnly'])
  })

  it('手がかりの数が同じなら、時間帯の窓に当たる施設の重要拠点の優先順位の高い便を、人口より先にする', () => {
    const withFacility = (tripId: string, rank: number, matched: boolean, population?: number): Candidate => {
      const c = cand(tripId, 'R', 0, ['nearFacility'], population)
      const facility = { rank } as NearFacility['facility']
      return { ...c, detail: { ...c.detail, facilities: [{ facility, stopId: 's', stopName: 's', distanceM: 100, matches: matched ? ([{}] as NearFacility['matches']) : [] }] } }
    }
    const list = [
      withFacility('noMatch', 1, false, 1000),
      withFacility('rank3', 3, true),
      withFacility('rank1', 1, true),
      cand('none', 'R', 0, ['morning'], 500),
    ]
    // 窓に当たる施設のある便が優先順位の順に先。当たる施設の無い便どうしは人口の順
    expect([...list].sort(compareCandidates).map((c) => c.trip.tripId)).toEqual(['rank1', 'rank3', 'noMatch', 'none'])
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
  const candidates = [cand('t3', 'R', 35400), cand('t2', 'R', 32400, ['lastTripOfRoute']), cand('t1', 'R', 28800), cand('u1', 'U', 25200)]
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
