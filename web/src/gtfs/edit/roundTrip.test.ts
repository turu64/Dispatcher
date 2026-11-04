import { describe, expect, it } from 'vitest'
import type { GtfsFeed, GtfsRow } from '../load'
import { roundTripCheck, type RoundTripDirection, type RoundTripResult } from './roundTrip'

// 比較する日付は 2026-11-04(水)。W は平日(月〜金)、S は土曜の service
const DATE = '20261104'
const SATURDAY = '20261107'

const STOPS: [id: string, name: string][] = [
  ['A', '駅前'],
  ['B', '病院前'],
  ['C', '団地'],
  ['D', '高校前'],
  ['L1', '旭川駅前'],
  ['L2', '旭川駅前'],
  ['E', '空港'],
  ['F', '温泉'],
  ['G1', '1条8丁目'],
  ['G2', '1条7丁目'],
  ['H', '永山'],
  // 名前は同じ(NFKC にして空白を除くと「4条通」)で stop_id が違う、向かい合う停留所
  ['P1', '４条通'],
  ['P2', '4条 通'],
  ['Q', '市役所'],
]

/** 便:[route_id, trip_id, service_id, [[stop_id, 'HH:MM:SS'(空なら時刻なし)], ...]] */
type TripSpec = [route: string, trip: string, service: string, stops: [string, string][]]

function feedOf(trips: TripSpec[]): GtfsFeed {
  const routeIds = [...new Set(trips.map((t) => t[0]))]
  const tables: Record<string, GtfsRow[]> = {
    routes: routeIds.map((id) => ({ route_id: id, route_short_name: `${id}線`, route_type: '3' })),
    stops: STOPS.map(([id, name], i) => ({ stop_id: id, stop_name: name, stop_lat: String(43.7 + i / 1000), stop_lon: '142.3' })),
    calendar: [
      { service_id: 'W', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20270331' },
      { service_id: 'S', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0', start_date: '20261001', end_date: '20270331' },
    ],
    trips: trips.map(([route, trip, service]) => ({ route_id: route, trip_id: trip, service_id: service })),
    // stop_sequence は 10, 20, … にして、行の順を逆にして入れる(並べ替えを確かめる)
    stop_times: trips.flatMap(([, trip, , stops]) =>
      stops
        .map(([stop, time], i) => ({ trip_id: trip, stop_id: stop, stop_sequence: String((i + 1) * 10), arrival_time: time, departure_time: time }))
        .reverse(),
    ),
  }
  return {
    tables: new Map(Object.entries(tables).map(([name, rows]) => [name, { fileName: `${name}.txt`, fields: Object.keys(rows[0] ?? {}), rows }])),
    warnings: [],
  }
}

/** 2停留所の便(始発の出発と、その 20 分後の到着) */
function trip(route: string, id: string, from: string, to: string, departure: string, service = 'W'): TripSpec {
  const [h, m] = departure.split(':').map(Number)
  const arrival = h * 60 + m + 20
  const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`
  return [route, id, service, [[from, `${departure}:00`], [to, clock(arrival)]]]
}

function directionOf(result: RoundTripResult, routeId: string, fromName: string, toName: string): RoundTripDirection {
  const dir = result.directions.find((d) => d.routeId === routeId && d.fromName === fromName && d.toName === toName)
  if (!dir) throw new Error(`${routeId} ${fromName} → ${toName} がありません`)
  return dir
}

describe('roundTripCheck:同じ系統の往復', () => {
  // R1:駅前 → 病院前 は 06:50・07:30、病院前 → 駅前 は 17:00・20:00。
  // 減便後は 06:50 と 20:00 がなくなる(始発が 30 分遅く、終発が 3 時間早くなる。帰りの 17:00 は残る)
  const base = feedOf([trip('R1', 'a1', 'A', 'B', '06:50'), trip('R1', 'a2', 'A', 'B', '07:30'), trip('R1', 'b1', 'B', 'A', '17:00'), trip('R1', 'b2', 'B', 'A', '20:00')])
  const edited = feedOf([trip('R1', 'a2', 'A', 'B', '07:30'), trip('R1', 'b1', 'B', 'A', '17:00')])
  const result = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })

  it('方向ごとに前後の便数・始発・終発と、朝・帰りの窓の便数を出す', () => {
    expect(result.emptyReason).toBeNull()
    expect(result.routes).toEqual({ withReverse: 1, sameRoute: 1, otherRoute: 0, noReverse: 0, afterOnly: 0 })
    const out = directionOf(result, 'R1', '駅前', '病院前')
    expect(out.routeName).toBe('R1線')
    expect(out.before).toEqual({ trips: 2, first: '06:50', last: '07:30', morning: 2, evening: 0 })
    expect(out.after).toEqual({ trips: 1, first: '07:30', last: '07:30', morning: 1, evening: 0 })
    expect(out.reverse).toEqual({ scope: 'sameRoute', routeIds: ['R1'], loop: false })
    const back = directionOf(result, 'R1', '病院前', '駅前')
    expect(back.before).toEqual({ trips: 2, first: '17:00', last: '20:00', morning: 0, evening: 2 })
    expect(back.after).toEqual({ trips: 1, first: '17:00', last: '17:00', morning: 0, evening: 1 })
  })

  it('始発が 30 分以上遅くなる・終発が 30 分以上早まるを問題にする(帰りの便は残るので noReturn は出ない)', () => {
    // 駅前 → 病院前 の終発は 07:30 のまま、始発は 06:50 → 07:30(40 分)。病院前 → 駅前 の終発は 20:00 → 17:00(180 分)
    expect(result.problems.map((p) => [p.kind, p.fromName, p.toName, p.shiftMin])).toEqual([
      ['lastEarlier', '病院前', '駅前', 180],
      ['firstLater', '駅前', '病院前', 40],
    ])
    expect(result.counts).toEqual({ directionVanishes: 0, noReturn: 0, lastEarlier: 1, firstLater: 1 })
  })

  it('ずれの分数と窓は options で変えられる', () => {
    const strict = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'], shiftMin: 41 })
    expect(strict.counts).toEqual({ directionVanishes: 0, noReturn: 0, lastEarlier: 1, firstLater: 0 })
    expect(strict.windows.shiftMin).toBe(41)
    // 帰りの窓を 18〜21時にすると、減便後の帰り(17:00)は窓の外になり、noReturn が出る
    const late = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'], evening: { startMin: 18 * 60, endMin: 21 * 60 } })
    expect(late.counts.noReturn).toBe(1)
    expect(late.problems.find((p) => p.kind === 'noReturn')).toMatchObject({
      fromName: '駅前',
      toName: '病院前',
      returnTrips: { routeIds: ['R1'], eveningBefore: 1, eveningAfter: 0 },
    })
    // 既定の窓は 6〜9時・15〜21時、ずれは 30 分
    expect(result.windows).toEqual({ morning: { startMin: 360, endMin: 540 }, evening: { startMin: 900, endMin: 1260 }, shiftMin: 30 })
  })

  it('ずれがちょうど shiftMin 分のときも問題にする', () => {
    const exact = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'], shiftMin: 40 })
    expect(exact.counts.firstLater).toBe(1)
  })
})

describe('roundTripCheck:朝だけ残して帰りが 0', () => {
  // R1 の行きは 07:00 が残り、帰りの 16:00・18:00 がなくなる(帰りの方向は 12:00 だけ残る)
  const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b0', 'B', 'A', '12:00'), trip('R1', 'b1', 'B', 'A', '16:00'), trip('R1', 'b2', 'B', 'A', '18:00')])
  const edited = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b0', 'B', 'A', '12:00')])
  const result = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })

  it('noReturn を行きの方向に出し、帰りの窓の便数を前後で返す', () => {
    const noReturn = result.problems.filter((p) => p.kind === 'noReturn')
    expect(noReturn).toHaveLength(1)
    expect(noReturn[0]).toMatchObject({
      routeId: 'R1',
      fromName: '駅前',
      toName: '病院前',
      shiftMin: null,
      returnTrips: { routeIds: ['R1'], eveningBefore: 2, eveningAfter: 0 },
    })
    expect(noReturn[0].after.morning).toBe(1)
    // 帰りの方向は便が残るので、方向がなくなる問題ではない(終発が 6 時間早まる)
    expect(result.counts).toEqual({ directionVanishes: 0, noReturn: 1, lastEarlier: 1, firstLater: 0 })
  })

  it('減便前にも帰りの窓の便が無ければ、noReturn にしない', () => {
    const noEvening = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b0', 'B', 'A', '12:00')])
    expect(roundTripCheck(noEvening, noEvening, DATE, { weekdayServices: ['W'] }).problems).toEqual([])
  })

  it('減便後に行きの朝の便が無ければ、noReturn にしない', () => {
    const noMorning = feedOf([trip('R1', 'a1', 'A', 'B', '10:00'), trip('R1', 'b0', 'B', 'A', '12:00')])
    const r = roundTripCheck(base, noMorning, DATE, { weekdayServices: ['W'] })
    expect(r.counts.noReturn).toBe(0)
  })
})

describe('roundTripCheck:別の系統の逆向き', () => {
  // R2 は 団地 → 高校前 だけ、帰りは R3 と R4(高校前 → 団地)。減便後は R3・R4 の便がすべてなくなる
  const base = feedOf([trip('R2', 'c1', 'C', 'D', '07:10'), trip('R3', 'd1', 'D', 'C', '16:10'), trip('R4', 'd2', 'D', 'C', '17:10')])
  const edited = feedOf([trip('R2', 'c1', 'C', 'D', '07:10')])
  const result = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })

  it('同じ系統に無ければ、ほかの系統の逆向きをすべて合わせる', () => {
    expect(result.routes).toEqual({ withReverse: 3, sameRoute: 0, otherRoute: 3, noReverse: 0, afterOnly: 0 })
    expect(directionOf(result, 'R2', '団地', '高校前').reverse).toEqual({ scope: 'otherRoute', routeIds: ['R3', 'R4'], loop: false })
    expect(directionOf(result, 'R3', '高校前', '団地').reverse).toEqual({ scope: 'otherRoute', routeIds: ['R2'], loop: false })
  })

  it('方向がなくなる問題と、帰りの便が無い問題を出す(種類の順、次に系統の順)', () => {
    expect(result.problems.map((p) => [p.kind, p.routeId])).toEqual([
      ['directionVanishes', 'R3'],
      ['directionVanishes', 'R4'],
      ['noReturn', 'R2'],
    ])
    expect(result.problems[2].returnTrips).toEqual({ routeIds: ['R3', 'R4'], eveningBefore: 2, eveningAfter: 0 })
    expect(result.problems[0].after).toEqual({ trips: 0, first: null, last: null, morning: 0, evening: 0 })
  })

  it('同じ系統に逆向きがあれば、ほかの系統は見ない', () => {
    const both = feedOf([trip('R2', 'c1', 'C', 'D', '07:10'), trip('R2', 'c2', 'D', 'C', '12:00'), trip('R3', 'd1', 'D', 'C', '16:10')])
    const r = roundTripCheck(both, both, DATE, { weekdayServices: ['W'] })
    expect(directionOf(r, 'R2', '団地', '高校前').reverse).toEqual({ scope: 'sameRoute', routeIds: ['R2'], loop: false })
    expect(r.routes).toMatchObject({ sameRoute: 1, otherRoute: 1 })
  })
})

describe('roundTripCheck:循環と片道', () => {
  // R5 は 旭川駅前 → 旭川駅前 の循環(始発と終着の stop_id は違うが名前が同じ)。R6 は片道。
  // R7 は 1条8丁目 → 永山 → 1条7丁目(端の名前が違うので、名前では往復と分からない)
  const base = feedOf([
    ['R5', 'l1', 'W', [['L1', '07:00:00'], ['H', '07:20:00'], ['L2', '07:40:00']]],
    ['R5', 'l2', 'W', [['L1', '17:00:00'], ['H', '17:20:00'], ['L2', '17:40:00']]],
    trip('R6', 'e1', 'E', 'F', '08:00'),
    trip('R7', 'g1', 'G1', 'H', '07:00'),
    trip('R7', 'g2', 'H', 'G2', '17:00'),
  ])
  const edited = feedOf([
    ['R5', 'l1', 'W', [['L1', '07:00:00'], ['H', '07:20:00'], ['L2', '07:40:00']]],
    trip('R6', 'e1', 'E', 'F', '08:00'),
    trip('R7', 'g1', 'G1', 'H', '07:00'),
  ])
  const result = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })

  it('始発と終着が同じ名前の循環は、それ自身を逆向きとし、帰りの窓の便が無くなれば noReturn にする', () => {
    const loop = directionOf(result, 'R5', '旭川駅前', '旭川駅前')
    expect(loop.reverse).toEqual({ scope: 'sameRoute', routeIds: ['R5'], loop: true })
    expect(loop.before).toMatchObject({ trips: 2, morning: 1, evening: 1 })
    expect(result.problems.filter((p) => p.routeId === 'R5').map((p) => p.kind)).toEqual(['noReturn', 'lastEarlier'])
  })

  it('どこにも逆向きが無い系統は noReverse として数だけ返し、方向の一覧と問題に入れない', () => {
    expect(result.routes).toEqual({ withReverse: 1, sameRoute: 1, otherRoute: 0, noReverse: 2, afterOnly: 0 })
    expect(result.directions.map((d) => d.routeId)).toEqual(['R5'])
    expect(result.problems.some((p) => p.routeId === 'R6' || p.routeId === 'R7')).toBe(false)
  })
})

describe('roundTripCheck:名前は同じで stop_id が違う停留所', () => {
  // R8 は ４条通(P1)→ 市役所 と、市役所 → 4条 通(P2)。NFKC にして空白を除くと同じ名前
  const base = feedOf([trip('R8', 'p1', 'P1', 'Q', '07:00'), trip('R8', 'p2', 'Q', 'P2', '17:00')])
  const edited = feedOf([trip('R8', 'p1', 'P1', 'Q', '07:00')])
  const result = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })

  it('名前で逆向きを見つけ、表示には元の名前を使う', () => {
    expect(result.routes).toMatchObject({ sameRoute: 1, noReverse: 0 })
    const out = directionOf(result, 'R8', '４条通', '市役所')
    expect(out.reverse).toEqual({ scope: 'sameRoute', routeIds: ['R8'], loop: false })
    expect(result.problems.map((p) => [p.kind, p.fromName, p.toName])).toEqual([
      ['directionVanishes', '市役所', '4条 通'],
      ['noReturn', '４条通', '市役所'],
    ])
  })
})

describe('roundTripCheck:時刻・日付・系統の扱い', () => {
  it('時刻が読めない便は便数に入れ、始発・終発・窓には入れない', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), ['R1', 'a2', 'W', [['A', ''], ['B', '']]], trip('R1', 'b1', 'B', 'A', '17:00')])
    const r = roundTripCheck(base, base, DATE, { weekdayServices: ['W'] })
    expect(directionOf(r, 'R1', '駅前', '病院前').before).toEqual({ trips: 2, first: '07:00', last: '07:00', morning: 1, evening: 0 })
    expect(r.problems).toEqual([])
  })

  it('24時を超える時刻はそのまま扱い、終発が早まるずれも数える', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'a2', 'A', 'B', '24:30'), trip('R1', 'b1', 'B', 'A', '17:00')])
    const edited = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b1', 'B', 'A', '17:00')])
    const r = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })
    expect(directionOf(r, 'R1', '駅前', '病院前').before.last).toBe('24:30')
    expect(r.problems).toMatchObject([{ kind: 'lastEarlier', shiftMin: 17 * 60 + 30 }])
  })

  it('その日に走らない service の便は数えない', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b1', 'B', 'A', '17:00'), trip('R1', 's1', 'A', 'B', '05:00', 'S')])
    expect(directionOf(roundTripCheck(base, base, DATE, { weekdayServices: ['W'] }), 'R1', '駅前', '病院前').before.trips).toBe(1)
  })

  it('減便後にだけその日の便がある系統は数だけ返す', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b1', 'B', 'A', '17:00')])
    const edited = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b1', 'B', 'A', '17:00'), trip('R9', 'x1', 'C', 'D', '09:00')])
    const r = roundTripCheck(base, edited, DATE, { weekdayServices: ['W'] })
    expect(r.routes.afterOnly).toBe(1)
    expect(r.directions.some((d) => d.routeId === 'R9')).toBe(false)
  })

  it('比較する日付に平日ダイヤが走らないときは、理由つきの空の結果を返す', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00'), trip('R1', 'b1', 'B', 'A', '17:00'), trip('R1', 's1', 'A', 'B', '08:00', 'S')])
    const sat = roundTripCheck(base, base, SATURDAY, { weekdayServices: ['W'] })
    expect(sat.emptyReason?.code).toBe('noWeekdayService')
    expect(sat.emptyReason?.message).toContain('平日ダイヤが走らない')
    expect(sat).toMatchObject({ directions: [], problems: [], counts: { directionVanishes: 0, noReturn: 0, lastEarlier: 0, firstLater: 0 } })
    // 平日の service を渡さなければ、その日に走る service があれば確かめる
    expect(roundTripCheck(base, base, SATURDAY).emptyReason).toBeNull()
  })

  it('日付として読めない値は、例外にせず理由つきの空の結果を返す', () => {
    const base = feedOf([trip('R1', 'a1', 'A', 'B', '07:00')])
    expect(roundTripCheck(base, base, '20261332', { weekdayServices: ['W'] }).emptyReason?.code).toBe('invalidDate')
  })
})
