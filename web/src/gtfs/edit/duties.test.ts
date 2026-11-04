import { describe, expect, it } from 'vitest'
import {
  BOUND_LIMIT_MIN,
  DUTY_DEFAULTS,
  LONG_DEPOT_DEADHEAD_MIN,
  dutyAssumptions,
  estimateDuties,
  operatorRunsOf,
  stopPointsOf,
  type DutyPlace,
  type StopPoint,
} from './duties'
import { feedOf } from './form2.fixture'
import type { TripLeg } from './serviceHours'

const A = { lat: 43.77, lon: 142.36 }
/** 停留所。A2 は A と名前が同じ(空白と全角の違いだけ)で 500m 離れる。N は A から 200m。B は A から約 2km(回送 約 7.8 分) */
const STOPS = new Map<string, StopPoint>([
  ['A', { name: '駅前', point: A }],
  ['A2', { name: '駅 前', point: { lat: A.lat + 0.0045, lon: A.lon } }],
  ['N', { name: '近く', point: { lat: A.lat + 0.0018, lon: A.lon } }],
  ['B', { name: '団地', point: { lat: A.lat + 0.018, lon: A.lon } }],
  ['X', { name: '座標なし', point: null }],
])

/** 'HH:MM' を秒に */
const sec = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 3600 + m * 60
}
const leg = (tripId: string, dep: string, arr: string, from = 'A', to = 'A'): TripLeg => ({
  tripId,
  dep: sec(dep),
  arr: sec(arr),
  firstStopId: from,
  lastStopId: to,
})

/** A → A の便を、start から run 分の運転・gap 分のすき間で count 便並べる */
function shuttle(count: number, start: string, run: number, gap: number, prefix = 't'): TripLeg[] {
  const legs: TripLeg[] = []
  let t = sec(start)
  for (let i = 0; i < count; i++) {
    legs.push({ tripId: `${prefix}${String(i).padStart(2, '0')}`, dep: t, arr: t + run * 60, firstStopId: 'A', lastStopId: 'A' })
    t += (run + gap) * 60
  }
  return legs
}

const tripsPerDuty = (legs: TripLeg[], params = {}, places: DutyPlace[] = []) =>
  estimateDuties(legs, STOPS, params, places).duties.map((d) => d.trips)

describe('estimateDuties:拘束時間', () => {
  // 6:00 から1時間ごとに 40 分の便を 13 便(最後は 18:00〜18:40)。拘束は 5:30 からで、13 時間なら 18:30 まで
  const legs = shuttle(13, '06:00', 40, 20)

  it('拘束 13 時間を超える便で、勤務が分かれる', () => {
    const est = estimateDuties(legs, STOPS)
    expect(est.dutyCount).toBe(2)
    expect(est.duties[0].trips).toBe(12)
    expect(est.duties[0].start).toBe('05:30')
    expect(est.duties[0].end).toBe('17:55')
    expect(est.duties[0].boundMin).toBe(12 * 60 + 25)
    expect(est.duties[0].drivingMin).toBe(12 * 40)
    expect(est.duties[1].tripIds).toEqual(['t12'])
  })

  it('拘束を 15 時間に切り替えると1つの勤務になる', () => {
    const est = estimateDuties(legs, STOPS, { maxBoundMin: BOUND_LIMIT_MIN.extended })
    expect(est.dutyCount).toBe(1)
    expect(est.duties[0].boundMin).toBe(13 * 60 + 25)
    expect(est.duties[0].drivingMin).toBe(13 * 40)
  })

  it('運転時間 9 時間を超える便で分かれる', () => {
    // 50 分の便を 11 便(運転 550 分)。拘束は 15 時間にして運転時間だけで分ける
    const est = estimateDuties(shuttle(11, '06:00', 50, 15), STOPS, { maxBoundMin: BOUND_LIMIT_MIN.extended })
    expect(est.duties.map((d) => d.trips)).toEqual([10, 1])
    expect(est.duties[0].drivingMin).toBe(500)
  })
})

describe('estimateDuties:連続運転', () => {
  it('すき間が 10 分に満たないまま 4 時間を超えると分かれる', () => {
    // 55 分の便を 5 分の折り返しで 5 便。4 便で 220 分、5 便目で 275 分
    const est = estimateDuties(shuttle(5, '06:00', 55, 5), STOPS)
    expect(est.duties.map((d) => d.trips)).toEqual([4, 1])
    expect(est.duties[0].maxContinuousMin).toBe(220)
  })

  it('30 分のすき間で連続運転を数え直し、つながる', () => {
    const legs = shuttle(4, '06:00', 55, 5)
    legs.push(leg('t04', '10:25', '11:20'))
    const est = estimateDuties(legs, STOPS)
    expect(est.dutyCount).toBe(1)
    expect(est.duties[0].maxContinuousMin).toBe(220)
  })

  it('10 分以上のすき間を合わせて 30 分で数え直す。10 分未満のすき間は数えない', () => {
    // 15 分のすき間が2回で 30 分になる
    expect(tripsPerDuty(shuttle(6, '06:00', 55, 15))).toEqual([6])
    // 9 分のすき間は休憩に数えない
    expect(tripsPerDuty(shuttle(6, '06:00', 55, 9))).toEqual([4, 2])
  })
})

describe('estimateDuties:折り返しと回送', () => {
  it('別の停留所へは、折り返し 5 分に回送を足した時間が無いと分かれる', () => {
    // A → B の回送は約 7.8 分(2km × 1.3 を時速 20km)。折り返しと合わせて約 12.8 分
    expect(tripsPerDuty([leg('a', '06:00', '07:00'), leg('b', '07:10', '08:00', 'B', 'B')])).toEqual([1, 1])
    const est = estimateDuties([leg('a', '06:00', '07:00'), leg('b', '07:15', '08:00', 'B', 'B')], STOPS)
    expect(est.dutyCount).toBe(1)
    expect(est.duties[0].deadheadMin).toBe(8)
    // 回送は運転時間に入る
    expect(est.duties[0].drivingMin).toBe(60 + 45 + 8)
    expect(est.duties[0].firstStopName).toBe('駅前')
    expect(est.duties[0].lastStopName).toBe('団地')
  })

  it('停留所名が同じか 300m 以内なら同じ停留所として、折り返し 5 分でつなぐ', () => {
    const named = estimateDuties([leg('a', '06:00', '07:00'), leg('b', '07:05', '08:00', 'A2', 'A2')], STOPS)
    expect(named.dutyCount).toBe(1)
    expect(named.duties[0].deadheadMin).toBe(0)
    expect(tripsPerDuty([leg('a', '06:00', '07:00'), leg('b', '07:05', '08:00', 'N', 'N')])).toEqual([2])
    // 折り返しが 5 分に満たないと分かれる
    expect(tripsPerDuty([leg('a', '06:00', '07:00'), leg('b', '07:04', '08:00', 'N', 'N')])).toEqual([1, 1])
  })

  it('座標の無い停留所は、名前が違えばつながない', () => {
    const est = estimateDuties([leg('a', '06:00', '07:00'), leg('b', '09:00', '10:00', 'X', 'X')], STOPS)
    expect(est.dutyCount).toBe(2)
    expect(est.stopsWithoutPoint).toBe(1)
  })
})

describe('estimateDuties:営業所・車庫と休憩施設', () => {
  // 55 分の便を 30 分のすき間で 5 便(運転 275 分)。すき間を休憩に数えなければ連続運転 4 時間を超える
  const legs = shuttle(5, '06:00', 55, 30)

  it('休憩施設が無ければ、どの停留所のすき間も休憩に数える', () => {
    expect(tripsPerDuty(legs)).toEqual([5])
  })

  it('休憩施設があれば、その 300m 以内の停留所でのすき間だけを休憩に数える', () => {
    const far: DutyPlace[] = [{ kind: 'rest', name: '休憩所', ...STOPS.get('B')!.point! }]
    expect(tripsPerDuty(legs, {}, far)).toEqual([4, 1])
    const near: DutyPlace[] = [...far, { kind: 'rest', name: '駅の休憩所', lat: A.lat + 0.001, lon: A.lon }]
    expect(tripsPerDuty(legs, {}, near)).toEqual([5])
  })

  it('営業所があれば、最寄りの営業所との回送を拘束時間と運転時間に足す', () => {
    const depots: DutyPlace[] = [
      { kind: 'depot', name: '遠い営業所', lat: A.lat + 0.1, lon: A.lon },
      { kind: 'depot', name: '営業所', ...STOPS.get('B')!.point! },
    ]
    const est = estimateDuties([leg('a', '06:00', '07:00')], STOPS, {}, depots)
    // 出庫 7.8 分・入庫 7.8 分の回送(秒で切り上げ)と点呼 30 分・15 分
    expect(est.duties[0].start).toBe('05:22')
    expect(est.duties[0].end).toBe('07:22')
    expect(est.duties[0].deadheadMin).toBe(16)
    expect(est.duties[0].pullOutMin).toBe(8)
    expect(est.duties[0].pullInMin).toBe(8)
    expect(est.duties[0].drivingMin).toBe(76)
    expect(est.assumptions.some((s) => s.includes('営業所・車庫(2 か所)'))).toBe(true)
    // 片道 8 分の回送は長すぎない
    expect(est.longDeadheadDuties).toBe(0)
  })

  it('車庫も出庫・入庫の回送の場所に数える', () => {
    const garage: DutyPlace[] = [{ kind: 'garage', name: '車庫', ...STOPS.get('B')!.point! }]
    const est = estimateDuties([leg('a', '06:00', '07:00')], STOPS, {}, garage)
    expect(est.duties[0].deadheadMin).toBe(16)
    expect(est.assumptions.some((s) => s.includes('営業所・車庫(1 か所)'))).toBe(true)
  })

  it('休憩施設があるとき、営業所の近くのすき間は休憩に数え、車庫の近くのすき間は数えない', () => {
    const far: DutyPlace[] = [{ kind: 'rest', name: '休憩所', ...STOPS.get('B')!.point! }]
    // A の近くの車庫:A でのすき間は休憩に数えず、連続運転 4 時間を超えて分かれる
    expect(tripsPerDuty(legs, {}, [...far, { kind: 'garage', name: '車庫', lat: A.lat + 0.001, lon: A.lon }])).toEqual([4, 1])
    // A の近くの営業所:A でのすき間を休憩に数え、1つの勤務につながる
    expect(tripsPerDuty(legs, {}, [...far, { kind: 'depot', name: '営業所', lat: A.lat + 0.001, lon: A.lon }])).toEqual([5])
    const lines = dutyAssumptions(DUTY_DEFAULTS, [...far, { kind: 'garage', name: '車庫', ...A }])
    expect(lines.join('\n')).toContain('休憩は、休憩施設(1 か所)・営業所の 300m 以内の停留所でのすき間だけに数えます(車庫は出庫・入庫の場所で、休憩には数えません)')
  })

  it(`出庫か入庫の回送が片道 ${LONG_DEPOT_DEADHEAD_MIN} 分を超える勤務を数える`, () => {
    // A から約 22km 北(回送 約 86 分)の営業所。出庫・入庫とも片道 60 分を超える
    const farDepot: DutyPlace[] = [{ kind: 'depot', name: '遠い営業所', lat: A.lat + 0.2, lon: A.lon }]
    const est = estimateDuties([leg('a', '06:00', '07:00'), leg('b', '12:00', '13:00')], STOPS, {}, farDepot)
    expect(est.duties.every((d) => d.pullOutMin > LONG_DEPOT_DEADHEAD_MIN && d.pullInMin > LONG_DEPOT_DEADHEAD_MIN)).toBe(true)
    expect(est.longDeadheadDuties).toBe(est.dutyCount)
    // 営業所・車庫が無ければ回送は 0
    const none = estimateDuties([leg('a', '06:00', '07:00')], STOPS)
    expect(none.duties[0].pullOutMin).toBe(0)
    expect(none.duties[0].pullInMin).toBe(0)
    expect(none.longDeadheadDuties).toBe(0)
  })

  it('事業場外の休憩の上限を使うと、営業所の外のすき間の合計で分かれる', () => {
    const legs4 = shuttle(4, '06:00', 30, 40)
    expect(tripsPerDuty(legs4)).toEqual([4])
    expect(tripsPerDuty(legs4, { offSiteBreakMaxMin: 60 })).toEqual([2, 2])
    // 営業所の近くのすき間は数えない
    const depot: DutyPlace[] = [{ kind: 'depot', name: '営業所', ...A }]
    expect(tripsPerDuty(legs4, { offSiteBreakMaxMin: 60 }, depot)).toEqual([4])
  })
})

describe('estimateDuties:結果の形', () => {
  const legs = [
    ...shuttle(13, '06:00', 40, 20, 'x'),
    ...shuttle(6, '06:30', 55, 9, 'y'),
    leg('b1', '07:15', '08:00', 'B', 'B'),
    leg('b2', '07:15', '08:00', 'B', 'A'),
    leg('n1', '08:05', '09:00', 'N', 'B'),
  ]

  it('入力の順を変えても同じ結果になる', () => {
    const forward = estimateDuties(legs, STOPS)
    const reversed = estimateDuties([...legs].reverse(), STOPS)
    const shuffled = estimateDuties([...legs].sort((a, b) => (a.tripId.charCodeAt(1) % 3) - (b.tripId.charCodeAt(1) % 3)), STOPS)
    expect(reversed).toEqual(forward)
    expect(shuffled).toEqual(forward)
    // 入力の配列は並べ替えない
    expect(legs[0].tripId).toBe('x00')
  })

  it('全便を1回ずつ、勤務は最初の便の出発の順', () => {
    const est = estimateDuties(legs, STOPS)
    const ids = est.duties.flatMap((d) => d.tripIds)
    expect(ids.sort()).toEqual(legs.map((l) => l.tripId).sort())
    const firstDeps = est.duties.map((d) => d.start)
    expect([...firstDeps].sort()).toEqual(firstDeps)
  })

  it('車両の数の下限は、折り返しと回送だけでつないだ数と、同時に営業運行中の便の最大', () => {
    // 6:00〜7:00 と 6:30〜7:30 が重なる。7:00 着の便は 7:05 発につながる。7:30 ちょうどの発は 7:30 着と重ねない
    const est = estimateDuties(
      [leg('a', '06:00', '07:00'), leg('b', '06:30', '07:30'), leg('c', '07:05', '08:00'), leg('d', '07:30', '08:30', 'B', 'B')],
      STOPS,
    )
    expect(est.vehicles.maxConcurrent).toBe(2)
    // d は B 発で、7:30 着の b から回送が間に合わない
    expect(est.vehicles.chained).toBe(3)
  })

  it('1便だけで条件を超える便は、その便だけの勤務にして印を付ける', () => {
    const est = estimateDuties([leg('long', '06:00', '11:00'), leg('a', '11:30', '12:00')], STOPS)
    expect(est.overLimitDuties).toBe(1)
    expect(est.duties[0].overLimit).toBe(true)
    expect(est.duties[0].tripIds).toEqual(['long'])
    expect(est.duties[1].overLimit).toBe(false)
  })

  it('便が無ければ 0', () => {
    const est = estimateDuties([], STOPS)
    expect(est.dutyCount).toBe(0)
    expect(est.vehicles).toEqual({ chained: 0, maxConcurrent: 0 })
  })

  it('使った仮定の文を返す', () => {
    const lines = estimateDuties([], STOPS).assumptions
    expect(lines).toEqual(dutyAssumptions(DUTY_DEFAULTS))
    expect(lines.join('\n')).toContain('拘束時間は 13 時間以内(改善基準告示 第5条。延長の上限の 15 時間に切り替えられます)')
    expect(lines.join('\n')).toContain('出庫前の点呼 30 分と入庫後の点呼 15 分')
    expect(lines.join('\n')).toContain('営業所・車庫の位置がないため')
    expect(lines.join('\n')).toContain('休憩施設の位置がないため')
    expect(lines.join('\n')).not.toContain('営業所・車庫の外での休憩')
    expect(lines[lines.length - 1]).toContain('下限の目安')
    const extended = dutyAssumptions({ ...DUTY_DEFAULTS, maxBoundMin: BOUND_LIMIT_MIN.extended, offSiteBreakMaxMin: 180 })
    expect(extended.join('\n')).toContain('拘束時間は 15 時間以内(改善基準告示 第5条の延長の上限)')
    expect(extended.join('\n')).toContain('営業所・車庫の外での休憩は、合わせて 3 時間以内')
  })
})

describe('stopPointsOf', () => {
  it('名前と座標を読み、読めない座標は null にする', () => {
    const feed = feedOf({
      stops: [
        { stop_id: ' S1 ', stop_name: ' 駅前 ', stop_lat: '43.77', stop_lon: '142.36' },
        { stop_id: 'S2', stop_name: '団地', stop_lat: '', stop_lon: '142.36' },
        { stop_id: 'S1', stop_name: '重複', stop_lat: '0', stop_lon: '0' },
      ],
    })
    const points = stopPointsOf(feed)
    expect(points.get('S1')).toEqual({ name: '駅前', point: { lat: 43.77, lon: 142.36 } })
    expect(points.get('S2')).toEqual({ name: '団地', point: null })
  })
})

describe('operatorRunsOf', () => {
  const feed = feedOf({
    trips: [
      { route_id: 'R', service_id: '01', trip_id: '0001_01_01_01_0600' },
      { route_id: 'R', service_id: '01', trip_id: '0001_02_01_01_0700' },
      { route_id: 'R', service_id: ' 01 ', trip_id: ' 0002_01_01_01_0800 ' },
      { route_id: 'R', service_id: '03', trip_id: '0001_01_01_03_0600' },
      { route_id: 'R', service_id: 'MX', trip_id: '0001_01_01_MX_0600' },
      { route_id: 'R', service_id: 'MX', trip_id: 'MX_0700' },
      { route_id: 'R', service_id: 'NG', trip_id: '0001_01_01_01_0600x' },
    ],
  })

  it('5つの部分で4つ目が service_id の形なら、先頭の部分の種類の数', () => {
    expect(operatorRunsOf(feed, '01')).toBe(2)
    expect(operatorRunsOf(feed, ' 03 ')).toBe(1)
  })

  it('形の違う便が1つでもあるか、便が無ければ null', () => {
    expect(operatorRunsOf(feed, 'MX')).toBeNull()
    expect(operatorRunsOf(feed, 'NG')).toBeNull()
    expect(operatorRunsOf(feed, '99')).toBeNull()
  })
})
