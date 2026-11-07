import { describe, expect, it } from 'vitest'
import { applyForm2 } from './form2'
import { basePlan, feedOf, rowsOf, smallFeed } from './form2.fixture'
import { createRouteDirectionTimeline, routeDirectionTimeline, stopDiff, type StopChange, type StopDiffResult } from './stopDiff'

/** 形2の小さなフィードに「平日を土曜ダイヤに」を当てた、基準と編集後 */
function smallPair() {
  const base = smallFeed()
  const outcome = applyForm2(base, basePlan(), { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return { base, edited: outcome.result.feed }
}

function stopOf(result: StopDiffResult, stopId: string): StopChange {
  const stop = result.stops.find((s) => s.stopId === stopId)
  if (!stop) throw new Error(`停留所 ${stopId} がありません`)
  return stop
}

const times = (list: { routeId: string; time: string }[]) => list.map((d) => `${d.routeId} ${d.time}`)

describe('stopDiff(形2の小さなフィード)', () => {
  // 20261104(水)。基準の平日:R1 07:00・R3 07:30・R1 08:00・R2 09:00(どれも A 発)、R3 は S9 も 07:40 に通る。
  // 編集後の平日は土曜の写し:R1 07:00(A)・R1 08:00(C 発)・R1 08:05(A)・R2 10:00(A)。B はどの便でも終点
  const { base, edited } = smallPair()
  const result = stopDiff(base, edited, '20261104')

  it('どちらかに発車がある停留所を stop_id の順に出し、終点だけの停留所は出さない', () => {
    expect(result.stops.map((s) => s.stopId)).toEqual(['A', 'C', 'S9'])
    expect(result.date).toBe('20261104')
  })

  it('本数・始発・最終便・最大間隔を前後で出す', () => {
    const a = stopOf(result, 'A')
    expect(a.stopName).toBe('駅前')
    expect(a.before).toMatchObject({ count: 4, first: '07:00', last: '09:00', maxGapMin: 60 })
    expect(a.after).toMatchObject({ count: 3, first: '07:00', last: '10:00', maxGapMin: 115 })
  })

  it('系統ごとの発車時刻を route_id の順に出す', () => {
    const a = stopOf(result, 'A')
    expect(a.before.byRoute.map((r) => [r.routeId, r.routeName, r.departures.map((d) => d.time)])).toEqual([
      ['R1', '1', ['07:00', '08:00']],
      ['R2', '2', ['09:00']],
      ['R3', '3', ['07:30']],
    ])
    expect(a.after.byRoute.map((r) => [r.routeId, r.departures.map((d) => d.time)])).toEqual([
      ['R1', ['07:00', '08:05']],
      ['R2', ['10:00']],
    ])
  })

  it('新しく生じる発車時刻と無くなる発車時刻を、系統と時刻で照合して出す', () => {
    const a = stopOf(result, 'A')
    expect(times(a.added)).toEqual(['R1 08:05', 'R2 10:00'])
    expect(times(a.removed)).toEqual(['R3 07:30', 'R1 08:00', 'R2 09:00'])
    expect(a.removed.map((d) => d.tripId)).toEqual(['R3_0730_WK', 'R1_0800_WK', 'R2_0900_WK'])
    expect(a.needsRepost).toBe(true)
    expect(times(stopOf(result, 'C').added)).toEqual(['R1 08:00'])
    expect(stopOf(result, 'C').before).toEqual({ count: 0, first: null, last: null, maxGapMin: null, byRoute: [] })
  })

  it('編集後に stop_times から消えた停留所(S9)も、基準の GTFS から数える(1103 追記3)', () => {
    expect(edited.tables.get('stop_times')!.rows.some((r) => r.stop_id === 'S9')).toBe(false)
    const s9 = stopOf(result, 'S9')
    expect(s9.stopName).toBe('学校前')
    expect(s9.before).toMatchObject({ count: 1, first: '07:40', last: '07:40', maxGapMin: null })
    expect(s9.after.count).toBe(0)
    expect(times(s9.removed)).toEqual(['R3 07:40'])
    expect(s9.added).toEqual([])
  })

  it('掲示の差し替えが要る停留所などの件数を返す', () => {
    expect(result).toMatchObject({
      repostCount: 3,
      stopsWithAdded: 2,
      stopsWithRemoved: 2,
      stopsLosingAll: 1,
      skippedBlankTime: { base: 0, edited: 0 },
      skippedInvalidTime: { base: 0, edited: 0 },
    })
  })

  it('入れ替えの無い日(20261103 は平日が運休で日曜の便が走る)は差し替えが要らない', () => {
    const holiday = stopDiff(base, edited, '20261103')
    expect(holiday.stops.map((s) => [s.stopId, s.before.count, s.after.count])).toEqual([['A', 1, 1]])
    expect(holiday.repostCount).toBe(0)
    expect(holiday.stops[0].needsRepost).toBe(false)
  })

  it('同じフィードどうしなら差は無い', () => {
    const same = stopDiff(base, base, '20261104')
    expect(same.repostCount).toBe(0)
    expect(same.stops.every((s) => s.added.length === 0 && s.removed.length === 0)).toBe(true)
  })

  it('不正な日付はエラーにする', () => {
    expect(() => stopDiff(base, edited, '20261131')).toThrow()
  })
})

// 手で作る、行の扱いを確かめるフィード。service は D(毎日、20261101〜20261130)
const ROUTES = `
route_id,route_short_name,route_long_name
X,,X線
Y,Y1,`

const STOPS = `
stop_id,stop_name
P,本町
Q,
T,終点`

const CALENDAR = `
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
D,1,1,1,1,1,1,1,20261101,20261130
N,0,0,0,0,0,0,0,20261101,20261130`

function handFeed(trips: string, stopTimes: string) {
  return feedOf({
    routes: rowsOf(ROUTES),
    stops: rowsOf(STOPS),
    calendar: rowsOf(CALENDAR),
    trips: rowsOf(trips),
    stop_times: rowsOf(stopTimes),
  })
}

const HAND_TRIPS = `
route_id,service_id,trip_id,trip_headsign
X,D,x1,北行
X,D,x2,北行
X,D,x3,北行
Y,D,y1,南行
Y,D,y2,南行
Y,N,y9,走らない`

// x1・x2 は P 06:30 の同じ時刻(多重集合の確かめ)。x3 は 25:10(24時を超える発車)。
// y1 は stop_sequence が 9 と 10(数として比べると 10 が終点)で、P の行は stop_headsign がある。
// y2 は P が pickup_type=1(数えない)、Q の departure_time が空(数えない)、T の departure_time が読めない値(数えない)
const HAND_STOP_TIMES = `
trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,stop_headsign
x1,06:30:00,06:30:00,P,1,0,
x1,06:40:00,06:40:00,T,2,0,
x2,06:30:00,06:30:00,P,1,0,
x2,06:40:00,06:40:00,T,2,0,
x3,25:10:00,25:10:00,P,1,0,
x3,25:20:00,25:20:00,T,2,0,
y1,08:00:00,08:00:00,P,9,0,駅経由
y1,08:30:00,08:30:00,Q,10,0,
y2,09:00:00,09:00:00,P,1,1,
y2,09:10:00,,Q,2,0,
y2,09:15:00,9.15.00,T,3,0,
y2,09:30:00,09:30:00,Q,4,0,
y9,12:00:00,12:00:00,P,1,0,
y9,12:30:00,12:30:00,Q,2,0,`

describe('stopDiff(行の扱い)', () => {
  const base = handFeed(HAND_TRIPS, HAND_STOP_TIMES)
  // 編集後:x2 を消し、y1 の P を 08:05 にずらす
  const edited = handFeed(
    HAND_TRIPS.replace('X,D,x2,北行\n', ''),
    HAND_STOP_TIMES.replace(/x2,.*\n/g, '').replace('y1,08:00:00,08:00:00,P', 'y1,08:05:00,08:05:00,P'),
  )
  const result = stopDiff(base, edited, '20261110')

  it('乗れない行・終点・時刻の空や読めない行・走らない便を数えず、空と読めない行の数を返す', () => {
    // y2 の終点は Q(stop_sequence 4)。T(3)は終点ではないが時刻が読めない
    expect(result.stops.map((s) => [s.stopId, s.before.count])).toEqual([['P', 4]])
    expect(result.skippedBlankTime).toEqual({ base: 1, edited: 1 })
    expect(result.skippedInvalidTime).toEqual({ base: 1, edited: 1 })
  })

  it('stop_sequence を数として比べ、24時を超える時刻をそのまま扱う', () => {
    const p = stopOf(result, 'P')
    expect(p.before).toMatchObject({ first: '06:30', last: '25:10', maxGapMin: 1030 })
    expect(p.before.byRoute.map((r) => [r.routeId, r.routeName, r.departures.map((d) => `${d.time} ${d.headsign}`)])).toEqual([
      ['X', 'X線', ['06:30 北行', '06:30 北行', '25:10 北行']],
      ['Y', 'Y1', ['08:00 駅経由']],
    ])
    // 最大間隔は始発から最終便までの間だけ(同じ時刻の2本の間は 0 分)
    expect(p.before.byRoute[0].departures.map((d) => d.seconds)).toEqual([23400, 23400, 90600])
  })

  it('同じ系統・同じ時刻の発車は回数で照合し、ずれた時刻は無くなる・新しく生じるの両方に出る', () => {
    const p = stopOf(result, 'P')
    expect(p.after.count).toBe(3)
    expect(times(p.removed)).toEqual(['X 06:30', 'Y 08:00'])
    expect(times(p.added)).toEqual(['Y 08:05'])
    expect(p.added[0]).toMatchObject({ tripId: 'y1', seconds: 29100, headsign: '駅経由' })
    expect(p.needsRepost).toBe(true)
    expect(result.repostCount).toBe(1)
  })

  it('本数が同じでも時刻が変われば差し替えが要る', () => {
    const shifted = handFeed(HAND_TRIPS, HAND_STOP_TIMES.replace('y1,08:00:00,08:00:00,P', 'y1,08:05:00,08:05:00,P'))
    const r = stopDiff(base, shifted, '20261110')
    const p = stopOf(r, 'P')
    expect(p.before.count).toBe(p.after.count)
    expect(p.needsRepost).toBe(true)
    expect(r.repostCount).toBe(1)
  })

  it('停留所名が無ければ stop_id を名前にする', () => {
    const named = handFeed(HAND_TRIPS, 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nx1,06:30:00,06:30:00,Q,1\nx1,06:40:00,06:40:00,T,2')
    expect(stopOf(stopDiff(named, named, '20261110'), 'Q').stopName).toBe('Q')
  })
})

describe('routeDirectionTimeline', () => {
  const { base, edited } = smallPair()

  it('方向(始発 → 終着の停留所)ごとに便を時刻の順に並べ、最大間隔を出す', () => {
    expect(routeDirectionTimeline(base, 'R1', '20261104')).toEqual([
      {
        firstStopId: 'A',
        firstStopName: '駅前',
        lastStopId: 'B',
        lastStopName: '市役所',
        trips: [
          { tripId: 'R1_0700_WK', headsign: '市役所', departure: '07:00', seconds: 25200, arrival: '07:10' },
          { tripId: 'R1_0800_WK', headsign: '市役所', departure: '08:00', seconds: 28800, arrival: '08:10' },
        ],
        maxGapMin: 60,
      },
    ])
  })

  it('始発の停留所が違う便は別の方向にし、方向は最初の便の時刻の順に並べる', () => {
    const dirs = routeDirectionTimeline(edited, 'R1', '20261104')
    expect(dirs.map((d) => [`${d.firstStopId}→${d.lastStopId}`, d.trips.map((t) => t.departure), d.maxGapMin])).toEqual([
      ['A→B', ['07:00', '08:05'], 65],
      ['C→B', ['08:00'], null],
    ])
  })

  it('その日に走る便だけを並べ、便の無い系統は空', () => {
    expect(routeDirectionTimeline(edited, 'R3', '20261104')).toEqual([])
    expect(routeDirectionTimeline(base, 'R3', '20261104').map((d) => d.trips.length)).toEqual([1])
    expect(routeDirectionTimeline(base, 'R1', '20261103').map((d) => d.trips.map((t) => t.tripId))).toEqual([['R1_0805_SU']])
    expect(routeDirectionTimeline(base, 'NONE', '20261104')).toEqual([])
  })

  it('時刻の読めない便は後ろに置き、最大間隔に入れない', () => {
    const feed = handFeed(
      `route_id,service_id,trip_id
X,D,a
X,D,b
X,D,c`,
      `trip_id,arrival_time,departure_time,stop_id,stop_sequence
a,07:00:00,07:00:00,P,1
a,07:20:00,07:20:00,T,2
b,,x,P,1
b,,,T,2
c,,07:45:00,P,1
c,08:05:00,,T,2`,
    )
    const [dir] = createRouteDirectionTimeline(feed, '20261110')('X')
    expect(dir.trips.map((t) => [t.tripId, t.departure, t.arrival])).toEqual([
      ['a', '07:00', '07:20'],
      ['c', '07:45', '08:05'],
      ['b', null, null],
    ])
    expect(dir.maxGapMin).toBe(45)
  })
})
