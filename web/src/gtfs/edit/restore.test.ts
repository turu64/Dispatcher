import { describe, expect, it } from 'vitest'
import { buildReachStops, originStops } from '../../reach/input'
import { cellsWithinRadius, distanceM, meshCenter } from '../../reach/mesh'
import { computeReach, type RefData } from '../../reach/reach'
import { servicesFor } from '../calendar'
import { departureCountsByBand, makeBands } from '../departures'
import type { GtfsFeed } from '../load'
import { toStops } from '../parse'
import { diffWeekdayTrips, START_BAND_LABELS, startBandOf } from './diff'
import { defaultFacilityWindows, facilityWindows } from './facilityHours'
import { applyForm2 } from './form2'
import { basePlan, shiftTrip, smallFeed, withRows } from './form2.fixture'
import type { Form2Plan } from './ops'
import {
  bestFacilityRank,
  compareByHints,
  createRestoreHinter,
  FACILITY_NEAR_WEIGHT,
  HINT_WEIGHT_HEAVY,
  HINT_WEIGHT_LIGHT,
  HINT_WEIGHT_MEDIUM,
  HINT_WEIGHTS,
  hintSentence,
  NEAR_HOSPITAL_ONLY_WEIGHT,
  hintWeight,
  nearFacilityText,
  RESTORE_HINT_LABELS,
  restoreHints,
  type HintFacility,
  type NearFacility,
  type RestoreHint,
  type RestoreHintContext,
} from './restore'
import { cellAt, centerAt, DATE, REACH_PARAMS, reachBaseFeed, reachPlan, reachRef, reachSetup, STATION_CELL, STOP_CELLS } from './restore.fixture'

/** compareByHints に渡す手がかりの、並びに使わない項目(時間帯と系統の便数) */
const NO_COUNTS = { band: null, routeTrips: { before: 0, after: 0 } }

// 小さなフィード(form2.fixture.ts)を「平日を土曜ダイヤに」した版で、消える平日便は R1_0800_WK・R2_0900_WK・R3_0730_WK
function setup(feed: GtfsFeed = smallFeed()) {
  const base = feed
  const plan = basePlan()
  const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  const edited = outcome.result.feed
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base, plan, edited, diff, hinter, byId }
}

describe('足し戻しの手がかり(restoreHints)', () => {
  it('系統の終発の便と、足し戻さないと帯の便が 0 になる便に印を付ける', () => {
    const { hinter, byId } = setup()
    // R1 の平日は 07:00 と 08:00。08:00 は終発で、朝(6〜9時)。6〜9時には写した土曜便が残るので、帯の便は 0 にならない
    expect(hinter(byId.get('R1_0800_WK')!).hints).toEqual(['lastTripOfRoute', 'morning'])
    // R2 の平日は 09:00 の1本だけ(始発かつ終発)。土曜便は 10:00 で、どちらも 9〜12時(3時間ごと)なので帯の便は 0 にならない
    // (U05 の前は公示第47号の区分で、09:00 は 6〜9時台、10:00 は 10〜14時台に分かれて onlyTripInBand が付いていた)。
    // 9:00 は朝に入らない。減便後の平日の始発は写した土曜の 10:00 で、この便(9:00)より 60 分遅いので firstTripLater が付く
    expect(hinter(byId.get('R2_0900_WK')!).hints).toEqual(['firstTripOfRoute', 'lastTripOfRoute', 'firstTripLater'])
    expect(hinter(byId.get('R2_0900_WK')!).firstLater).toEqual({ trip: '09:00', after: '10:00', minutes: 60 })
    // R1 の 08:00 は、減便後の平日の始発(07:00 の写した土曜便)より遅いので付かない
    expect(hinter(byId.get('R1_0800_WK')!).firstLater).toBeUndefined()
    // R3 は平日だけの系統で、入れ替えると全曜日で便がなくなる
    expect(hinter(byId.get('R3_0730_WK')!)).toEqual({
      hints: ['weekdayOnlyRoute', 'routeWouldVanish', 'firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand', 'morning'],
      lostCells: null,
      band: { label: '6〜9時', before: 1, after: 0 },
      routeTrips: { before: 1, after: 0 },
    })
  })

  it('1つの便だけを調べても、索引を作って調べた結果と同じ', () => {
    const { base, plan, edited, hinter, byId } = setup()
    for (const trip of byId.values()) expect(restoreHints(base, edited, plan, trip)).toEqual(hinter(trip))
  })

  it('判断材料の重み(HINT_WEIGHTS)の大きい順に並べる', () => {
    const { diff, hinter } = setup()
    const sorted = diff.removed
      .map((trip) => ({ trip, detail: hinter(trip) }))
      .sort(compareByHints)
      .map((c) => c.trip.tripId)
    // R2_0900_WK は始発・終発(軽い 1 + 1)と始発が遅くなる(中くらい 2)で 4、R1_0800_WK は終発と朝(軽い 1 + 1)で 2
    expect(sorted.map((id) => hintWeight(hinter(diff.removed.find((t) => t.tripId === id)!)))).toEqual([11, 4, 2])
    expect(sorted).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
  })

  it('重みの表は、学校の窓と方向ごとの時間帯が重く、病院だけの窓は中くらい、始発・終発・朝・夕方が軽い。窓に当たらない施設だけなら軽い重みを足す', () => {
    expect(HINT_WEIGHTS.nearFacility).toBe(HINT_WEIGHT_HEAVY)
    expect(HINT_WEIGHTS.onlyTripInBand).toBe(HINT_WEIGHT_HEAVY)
    for (const h of ['weekdayOnlyRoute', 'routeWouldVanish', 'onlyServiceAtStop', 'restoresLostCells', 'firstTripLater'] as const) expect(HINT_WEIGHTS[h]).toBe(HINT_WEIGHT_MEDIUM)
    expect(HINT_WEIGHTS.firstTripOfRoute).toBe(HINT_WEIGHT_LIGHT)
    expect(HINT_WEIGHTS.lastTripOfRoute).toBe(HINT_WEIGHT_LIGHT)
    expect(HINT_WEIGHTS.morning).toBe(HINT_WEIGHT_LIGHT)
    expect(HINT_WEIGHTS.evening).toBe(HINT_WEIGHT_LIGHT)
    const near = (kind: 'school' | 'hospital', matched: boolean) => ({
      facility: { kind } as NearFacility['facility'],
      stopId: 's',
      stopName: 's',
      distanceM: 100,
      matches: matched ? [{ timing: 'arrive' as const, stopId: 's', stopName: 's', time: '07:40', distanceM: 100 }] : [],
    })
    expect(hintWeight({ hints: [], lostCells: null, ...NO_COUNTS })).toBe(0)
    expect(hintWeight({ hints: [], lostCells: null, ...NO_COUNTS, facilities: [near('school', false)] })).toBe(FACILITY_NEAR_WEIGHT)
    expect(hintWeight({ hints: ['nearFacility'], lostCells: null, ...NO_COUNTS, facilities: [near('school', true)] })).toBe(HINT_WEIGHT_HEAVY)
    expect(hintWeight({ hints: ['nearFacility'], lostCells: null, ...NO_COUNTS, facilities: [near('hospital', true)] })).toBe(NEAR_HOSPITAL_ONLY_WEIGHT)
    expect(hintWeight({ hints: ['nearFacility'], lostCells: null, ...NO_COUNTS, facilities: [near('hospital', true), near('school', true)] })).toBe(HINT_WEIGHT_HEAVY)
  })

  it('onlyTripInBand は始発の時間帯を到達圏と同じ3時間ごと(START_BANDS)で見る。公示第47号の区分では見ない(U05)', () => {
    // 土曜の R2 を 10:00 → 12:00 にずらすと、平日の 09:00(9〜12時)の時間帯の便が 0 になる
    const later = setup(shiftTrip(smallFeed(), 'R2_1000_SA', 2 * 3600))
    expect(later.hinter(later.byId.get('R2_0900_WK')!).hints).toContain('onlyTripInBand')
    // 11:59 なら同じ 9〜12時なので付かない(時間帯は開始を含み終わりを含まない)
    const justBefore = setup(shiftTrip(smallFeed(), 'R2_1000_SA', 3600 + 59 * 60))
    expect(justBefore.hinter(justBefore.byId.get('R2_0900_WK')!).hints).not.toContain('onlyTripInBand')
    // 公示第47号なら同じ 6〜9時台の 09:40 と 08:50 も、3時間ごとでは 9〜12時と 6〜9時に分かれる
    const split = setup(shiftTrip(shiftTrip(smallFeed(), 'R2_0900_WK', 40 * 60), 'R2_1000_SA', -70 * 60))
    expect(split.hinter(split.byId.get('R2_0900_WK')!).hints).toContain('onlyTripInBand')
  })

  it('evening は始発が 15〜21時(3時間の帯2つ)。21:00 ちょうどは入らない(U05)', () => {
    const at = (seconds: number) => {
      // R3_0730_WK(07:30)の時刻をずらして、evening が付くかを見る
      const { hinter, byId } = setup(shiftTrip(smallFeed(), 'R3_0730_WK', seconds - (7 * 3600 + 30 * 60)))
      return hinter(byId.get('R3_0730_WK')!).hints.includes('evening')
    }
    expect(at(15 * 3600 - 60)).toBe(false)
    expect(at(15 * 3600)).toBe(true)
    // 19時台(U05 の前は 15〜19時で入らなかった)
    expect(at(19 * 3600 + 30 * 60)).toBe(true)
    expect(at(20 * 3600 + 59 * 60)).toBe(true)
    expect(at(21 * 3600)).toBe(false)
  })

  it('始発の時間帯(startBandOf)は3時間ごとで、前後に「6時より前」「24時以降」、時刻が無ければ「時刻なし」', () => {
    expect(START_BAND_LABELS).toEqual(['6時より前', '6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時', '24時以降', '時刻なし'])
    expect(startBandOf(null)).toBe('時刻なし')
    expect(startBandOf(5 * 3600 + 59 * 60)).toBe('6時より前')
    expect(startBandOf(6 * 3600)).toBe('6〜9時')
    expect(startBandOf(9 * 3600 + 59 * 60)).toBe('9〜12時')
    expect(startBandOf(20 * 3600 + 59 * 60)).toBe('18〜21時')
    expect(startBandOf(24 * 3600)).toBe('24時以降')
  })

  it('手がかりの数が同じなら始発の時刻順にする', () => {
    const { byId } = setup()
    const a = { trip: byId.get('R1_0800_WK')!, detail: { hints: ['morning' as const], lostCells: null, ...NO_COUNTS } }
    const b = { trip: byId.get('R3_0730_WK')!, detail: { hints: ['morning' as const], lostCells: null, ...NO_COUNTS } }
    expect([a, b].sort(compareByHints).map((c) => c.trip.tripId)).toEqual(['R3_0730_WK', 'R1_0800_WK'])
  })
})

// ---- 時間帯と系統の便数(A03、指摘15.3)----

/** 学校線(R3)の便を足したフィード。便は A(駅前)→ S9(学校前)→ B(市役所)を 10 分ずつで走る。hhmm は始発の時刻 */
function withR3Trips(feed: GtfsFeed, trips: { service: string; hhmm: string }[]): GtfsFeed {
  const time = (hhmm: string, plus: number) => {
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + plus
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
  }
  const tripRows = trips.map(({ service, hhmm }) => ({ route_id: 'R3', service_id: service, trip_id: `R3_${hhmm}_${service}`, trip_headsign: '市役所', block_id: '' }))
  const stopRows = trips.flatMap(({ service, hhmm }) =>
    (
      [
        ['A', 0, '0', '1'],
        ['S9', 10, '0', '0'],
        ['B', 20, '1', '0'],
      ] as const
    ).map(([stop, plus, pickup, dropOff], i) => ({
      trip_id: `R3_${hhmm}_${service}`,
      arrival_time: time(hhmm, plus),
      departure_time: time(hhmm, plus),
      stop_id: stop,
      stop_sequence: String(i + 1),
      pickup_type: pickup,
      drop_off_type: dropOff,
    })),
  )
  const withTrips = withRows(feed, 'trips', [...feed.tables.get('trips')!.rows, ...tripRows])
  return withRows(withTrips, 'stop_times', [...feed.tables.get('stop_times')!.rows, ...stopRows])
}

/** 学校線の平日を 07:00・07:30・08:45 の3便(どれも 6〜9時)にしたフィード */
function threeMorningR3(): GtfsFeed {
  return withR3Trips(smallFeed(), [
    { service: 'WK', hhmm: '0700' },
    { service: 'WK', hhmm: '0845' },
  ])
}

const R3_MORNING = ['R3_0700_WK', 'R3_0730_WK', 'R3_0845_WK']

describe('足し戻しの手がかり:時間帯と系統の便数(band・routeTrips)', () => {
  it('同じ系統・同じ時間帯の 3 便がすべてなくなるとき、3 便とも onlyTripInBand で、band は減便前 3 便・減便後 0 便', () => {
    const { hinter, byId } = setup(threeMorningR3())
    for (const id of R3_MORNING) {
      const d = hinter(byId.get(id)!)
      expect(d.hints).toContain('onlyTripInBand')
      expect(d.band).toEqual({ label: '6〜9時', before: 3, after: 0 })
      expect(d.routeTrips).toEqual({ before: 3, after: 0 })
    }
    // 始発・終発は系統の全体(方向を分けない)で1便ずつ
    expect(hinter(byId.get('R3_0700_WK')!).hints).toContain('firstTripOfRoute')
    expect(hinter(byId.get('R3_0730_WK')!).hints).not.toContain('firstTripOfRoute')
    expect(hinter(byId.get('R3_0845_WK')!).hints).toContain('lastTripOfRoute')
  })

  it('同じ時間帯に1便でも残れば(入れ替えに使うダイヤの便・平日に戻した便)、どの便にも onlyTripInBand は付かず、band は null', () => {
    // 土曜の学校線が 08:30 にあれば、6〜9時の減便後の平日の便は 1
    const sat = setup(withR3Trips(threeMorningR3(), [{ service: 'SA', hhmm: '0830' }]))
    for (const id of R3_MORNING) {
      const d = sat.hinter(sat.byId.get(id)!)
      expect(d.hints).not.toContain('onlyTripInBand')
      expect(d.band).toBeNull()
      expect(d.routeTrips).toEqual({ before: 3, after: 1 })
    }

    // 07:00 を平日に戻すと、残りの2便には付かない
    const base = threeMorningR3()
    const plan = basePlan({ addBackTripIds: ['R3_0700_WK'] })
    const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    const edited = outcome.result.feed
    const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
    const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    const removed = new Map(diff.removed.map((t) => [t.tripId, t]))
    expect([...removed.keys()].filter((id) => id.startsWith('R3_')).sort()).toEqual(['R3_0730_WK', 'R3_0845_WK'])
    for (const id of ['R3_0730_WK', 'R3_0845_WK']) {
      const d = hinter(removed.get(id)!)
      expect(d.hints).not.toContain('onlyTripInBand')
      expect(d.band).toBeNull()
      expect(d.routeTrips).toEqual({ before: 3, after: 1 })
    }
  })

  it('別の時間帯の便は数えない(6〜9時の便がなくなっても、9〜12時の便が残る系統の 6〜9時の便には付く)', () => {
    // 土曜の学校線が 09:00(9〜12時)にだけある
    const { hinter, byId } = setup(withR3Trips(threeMorningR3(), [{ service: 'SA', hhmm: '0900' }]))
    expect(hinter(byId.get('R3_0730_WK')!).band).toEqual({ label: '6〜9時', before: 3, after: 0 })
    expect(hinter(byId.get('R3_0730_WK')!).routeTrips).toEqual({ before: 3, after: 1 })
  })

  it('routeTrips は、系統ごとの減便前・減便後の平日(WK)の便数と合う', () => {
    for (const feed of [smallFeed(), threeMorningR3()]) {
      const { base, edited, hinter, byId } = setup(feed)
      const weekdayCount = (f: GtfsFeed, route: string) =>
        f.tables.get('trips')!.rows.filter((t) => t.route_id === route && t.service_id === 'WK').length
      for (const trip of byId.values()) {
        expect(hinter(trip).routeTrips).toEqual({ before: weekdayCount(base, trip.routeId), after: weekdayCount(edited, trip.routeId) })
      }
    }
    // 小さなフィードでは、R1 は 2 → 3 便(土曜の3便が入る)、R2 は 1 → 1 便、R3 は 1 → 0 便
    const { hinter, byId } = setup()
    expect(hinter(byId.get('R1_0800_WK')!).routeTrips).toEqual({ before: 2, after: 3 })
    expect(hinter(byId.get('R2_0900_WK')!).routeTrips).toEqual({ before: 1, after: 1 })
    expect(hinter(byId.get('R3_0730_WK')!).routeTrips).toEqual({ before: 1, after: 0 })
  })
})

// ---- 方向ごとの時間帯と始発(2026-11-07)----

/** 学校線(R3)の逆向き(B 市役所 → A 駅前)の便を足したフィード。directionId を渡すと、その便の direction_id にする */
function withReverseR3(feed: GtfsFeed, service: string, hhmm: string, directionId = ''): GtfsFeed {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))
  const time = (plus: number) => `${String(Math.floor((m + plus) / 60)).padStart(2, '0')}:${String((m + plus) % 60).padStart(2, '0')}:00`
  const id = `R3R_${hhmm}_${service}`
  const trips = [...feed.tables.get('trips')!.rows, { route_id: 'R3', service_id: service, trip_id: id, trip_headsign: '駅前', block_id: '', direction_id: directionId }]
  const rows = [
    { trip_id: id, arrival_time: time(0), departure_time: time(0), stop_id: 'B', stop_sequence: '1', pickup_type: '0', drop_off_type: '1' },
    { trip_id: id, arrival_time: time(20), departure_time: time(20), stop_id: 'A', stop_sequence: '2', pickup_type: '1', drop_off_type: '0' },
  ]
  return withRows(withRows(feed, 'trips', trips), 'stop_times', [...feed.tables.get('stop_times')!.rows, ...rows])
}

/** 便の direction_id を書き換えたフィード */
function withDirectionIds(feed: GtfsFeed, ids: Record<string, string>): GtfsFeed {
  return withRows(
    feed,
    'trips',
    feed.tables.get('trips')!.rows.map((t) => (t.trip_id !== undefined && t.trip_id in ids ? { ...t, direction_id: ids[t.trip_id] } : t)),
  )
}

describe('足し戻しの手がかり:方向ごとの時間帯の便(onlyTripInBand)と始発が遅くなる(firstTripLater)', () => {
  it('同じ時間帯に逆向きの便だけが残るときも、この方向の便には onlyTripInBand が付き、band はこの方向の便数', () => {
    // 土曜の学校線は 07:40 の逆向き(市役所 → 駅前)だけ。6〜9時の系統の便は残るが、駅前 → 市役所の向きは 0 になる
    const { hinter, byId } = setup(withReverseR3(threeMorningR3(), 'SA', '0740'))
    for (const id of R3_MORNING) {
      const d = hinter(byId.get(id)!)
      expect(d.hints).toContain('onlyTripInBand')
      expect(d.band).toEqual({ label: '6〜9時', before: 3, after: 0 })
      // 系統の便数は方向を分けない
      expect(d.routeTrips).toEqual({ before: 3, after: 1 })
    }
  })

  it('同じ向きの便が残れば付かない。direction_id があれば、停留所名ではなく direction_id で方向を分ける', () => {
    const same = setup(withR3Trips(threeMorningR3(), [{ service: 'SA', hhmm: '0840' }]))
    expect(same.hinter(same.byId.get('R3_0730_WK')!).hints).not.toContain('onlyTripInBand')
    // 逆向きの便に平日の便と同じ direction_id を付けると、同じ方向とみなす(付かない)
    const ids = { R3_0700_WK: '0', R3_0730_WK: '0', R3_0845_WK: '0', R3R_0740_SA: '0' }
    const byId = setup(withDirectionIds(withReverseR3(threeMorningR3(), 'SA', '0740'), ids))
    expect(byId.hinter(byId.byId.get('R3_0730_WK')!).hints).not.toContain('onlyTripInBand')
    const other = setup(withDirectionIds(withReverseR3(threeMorningR3(), 'SA', '0740'), { ...ids, R3R_0740_SA: '1' }))
    expect(other.hinter(other.byId.get('R3_0730_WK')!).hints).toContain('onlyTripInBand')
  })

  it('firstTripLater は、減便後のこの方向の始発がこの便より 30 分以上遅いときだけ。29 分なら付かず、この方向の便が無ければ付かない', () => {
    // 土曜の同じ向きの便が 07:29 → 07:00 の便は 29 分で付かず、08:00 なら 07:00・07:30 の便に付く(08:45 は付かない)
    const near = setup(withR3Trips(threeMorningR3(), [{ service: 'SA', hhmm: '0729' }]))
    expect(near.hinter(near.byId.get('R3_0700_WK')!).hints).not.toContain('firstTripLater')
    const far = setup(withR3Trips(threeMorningR3(), [{ service: 'SA', hhmm: '0800' }]))
    expect(far.hinter(far.byId.get('R3_0700_WK')!).firstLater).toEqual({ trip: '07:00', after: '08:00', minutes: 60 })
    expect(far.hinter(far.byId.get('R3_0730_WK')!).firstLater).toEqual({ trip: '07:30', after: '08:00', minutes: 30 })
    expect(far.hinter(far.byId.get('R3_0845_WK')!).hints).not.toContain('firstTripLater')
    // 逆向きの便だけが残るとき(この方向の便は減便後 0)は付けない(onlyTripInBand が付く)
    const reverse = setup(withReverseR3(threeMorningR3(), 'SA', '1000'))
    expect(reverse.hinter(reverse.byId.get('R3_0700_WK')!).hints).not.toContain('firstTripLater')
    expect(hintSentence('firstTripLater', far.hinter(far.byId.get('R3_0700_WK')!))).toBe(
      '平日に戻さないと、この方向の平日の始発が減便後は 08:00 発になり、この便(07:00 発)より 60 分遅くなります',
    )
  })
})

describe('判断材料の文(hintSentence)', () => {
  it('時間帯の便の数と、系統の平日の便数を detail から入れる', () => {
    const detail = { hints: [], lostCells: null, band: { label: '6〜9時', before: 3, after: 0 }, routeTrips: { before: 11, after: 4 } }
    expect(hintSentence('onlyTripInBand', detail)).toBe('6〜9時に、この系統のこの方向の便が減便後 0 便になります(減便前 3 便)')
    expect(hintSentence('firstTripOfRoute', detail)).toBe('系統の平日の始発です(系統の平日 11 便。方向は分けていません)')
    expect(hintSentence('lastTripOfRoute', detail)).toBe('系統の平日の終発です(系統の平日 11 便。方向は分けていません)')
    expect(hintSentence('evening', detail)).toBe('始発が夕方・夜(15〜21時)の便です')
    expect(hintSentence('restoresLostCells', { ...detail, lostCells: { cells: 1234, population: 5678.4 } })).toBe(
      '平日に戻すと、到達圏から外れる区画のうち 1,234 区画(推計人口 約 5,678 人)が戻ります(この便だけを平日に戻したときの値)',
    )
  })

  it('3 便がすべてなくなる時間帯の文は、どの便でも同じ数で、「唯一」とは書かない', () => {
    const { hinter, byId } = setup(threeMorningR3())
    for (const id of R3_MORNING) {
      const d = hinter(byId.get(id)!)
      expect(hintSentence('onlyTripInBand', d)).toBe('6〜9時に、この系統のこの方向の便が減便後 0 便になります(減便前 3 便)')
    }
    const first = hinter(byId.get('R3_0700_WK')!)
    expect(hintSentence('firstTripOfRoute', first)).toBe('系統の平日の始発です(系統の平日 3 便。方向は分けていません)')
    // どの判断材料の文にも「唯一」は無い
    for (const h of Object.keys(RESTORE_HINT_LABELS) as RestoreHint[]) {
      expect(hintSentence(h, first)).not.toContain('唯一')
      expect(hintSentence(h, first).length).toBeGreaterThan(0)
    }
  })

  it('画面の名前に「唯一」を使わない(onlyTripInBand は「時間帯の便がなくなる」、onlyServiceAtStop は「停留所の発車がなくなる」)', () => {
    expect(RESTORE_HINT_LABELS.onlyTripInBand).toBe('時間帯の便がなくなる')
    expect(RESTORE_HINT_LABELS.onlyServiceAtStop).toBe('停留所の発車がなくなる')
    for (const label of Object.values(RESTORE_HINT_LABELS)) expect(label).not.toContain('唯一')
  })
})

// ---- 到達圏を使う2つ(docs/interfaces-1105.md §7)。restore.fixture.ts の小さなフィードと到達圏を使う ----

const REACH_HINTS: RestoreHint[] = ['onlyServiceAtStop', 'restoresLostCells']

function reachHinter() {
  const setup = reachSetup()
  const { base, edited, plan } = setup
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { ...setup, diff, hinter, byId }
}

/** 停留所(STOP_CELLS の名前)から距離 r 以内に中心があるセルのコード */
function cellsNear(stop: string, r: number): Set<string> {
  const [dr, dc] = STOP_CELLS[stop]
  return new Set(cellsWithinRadius([centerAt(dr, dc)], r))
}

/**
 * 総当たりで数え直す(索引を使わない):乗れる行(停留所と時間帯の組。手で書き出したもの)ごとに、すべてのセルを見て、
 * その時間帯に減便で外れ、停留所からの距離がセルの区分のバス停の距離以内のものを集める
 */
function bruteForce(ctx: RestoreHintContext, rows: [string, number][]): { cells: number; population: number } {
  const { beforeResult: before, afterResult: after, params } = ctx
  const got = new Set<number>()
  for (const [stop, b] of rows) {
    const [dr, dc] = STOP_CELLS[stop]
    const p = centerAt(dr, dc)
    before.cells.forEach((code, i) => {
      const lost = before.coverable[i] && before.reachable[b][i] && !after.reachable[b][i]
      const r = params.walkMinutes[before.classes[i]].bus * params.speedMPerMin
      if (lost && distanceM(meshCenter(code), p) <= r) got.add(i)
    })
  }
  let population = 0
  for (const i of got) population += before.cellPopulation[i]
  return { cells: got.size, population }
}

describe('足し戻しの手がかり:到達圏を使う2つ(onlyServiceAtStop・restoresLostCells)', () => {
  it('手で作った到達圏の前提:停留所のまわり 240m に 11 セル、P と Q の重なりは 2 セル、駅の徒歩圏との重なりは 2 セル', () => {
    const { ctx } = reachSetup()
    expect(cellsNear('P', 240).size).toBe(11)
    const p = cellsNear('P', 240)
    const q = cellsNear('Q', 240)
    expect([...p].filter((c) => q.has(c)).sort()).toEqual([cellAt(1, 0), cellAt(2, 0)].sort())
    const station = new Set(cellsWithinRadius([centerAt(...STATION_CELL)], 240))
    expect([...p].filter((c) => station.has(c)).sort()).toEqual([cellAt(-1, 0), cellAt(-2, 0)].sort())
    // すべて中山間・地方で、推計人口は 10 人
    expect(new Set(ctx.beforeResult.classes)).toEqual(new Set(['rural']))
    expect(new Set(ctx.beforeResult.cellPopulation)).toEqual(new Set([10]))
    // 起点は Z(どの便でも最後の停留所)を除く 6 つ
    expect(ctx.stops.map((s) => s.id).sort()).toEqual(['D', 'E', 'F', 'G', 'P', 'Q'])
    // 6〜9時に外れるのは P(駅の 2 セルを除く 9)・D・E のまわり、9〜12時は Q のまわり
    const lostIn = (b: number) => ctx.beforeResult.reachable[b].filter((r, i) => r && !ctx.afterResult.reachable[b][i]).length
    expect([0, 1, 2, 3, 4, 5].map(lostIn)).toEqual([9 + 11 + 11, 11, 0, 0, 0, 0])
  })

  it('ctx を渡すと、乗れる停留所の時間帯で外れたセルの数と推計人口を出す', () => {
    const { hinter, byId, ctx } = reachHinter()
    const a = hinter(byId.get('A_0700_WK')!, ctx)
    expect(a.hints.filter((h) => REACH_HINTS.includes(h))).toEqual(['onlyServiceAtStop', 'restoresLostCells'])
    // P のまわりの 11 セルのうち、駅の徒歩圏の 2 セルは前後とも到達できるので外れたセルにならない
    expect(a.lostCells).toEqual({ cells: 9, population: 90 })
    expect(hinter(byId.get('D_0745_WK')!, ctx).lostCells).toEqual({ cells: 11, population: 110 })
    expect(hinter(byId.get('E_0750_WK')!, ctx).lostCells).toEqual({ cells: 11, population: 110 })
  })

  it('2つの時間帯で戻る同じセルは1つと数え、推計人口も1回だけ足す', () => {
    const { hinter, byId, ctx } = reachHinter()
    // B は 6〜9時の P(9 セル)と 9〜12時の Q(11 セル)。(1,0) と (2,0) は両方で戻るが、1つと数える(9 + 11 − 2)
    expect(hinter(byId.get('B_0855_WK')!, ctx)).toMatchObject({
      hints: expect.arrayContaining(['onlyServiceAtStop', 'restoresLostCells']),
      lostCells: { cells: 18, population: 180 },
    })
  })

  it('降車だけの停留所と、便の最後の行は数えない', () => {
    const { hinter, byId, ctx } = reachHinter()
    // C は F(編集後も 6〜9時の出発が残る)・D(pickup_type=1)・E(最後の行)。D と E のまわりは外れているが、C では乗れない
    const c = hinter(byId.get('C_0720_WK')!, ctx)
    expect(c.hints.filter((h) => REACH_HINTS.includes(h))).toEqual([])
    expect(c.lostCells).toBeNull()
  })

  it('比較の日付に基準で走らない便と、編集後の便には出さない', () => {
    const { hinter, byId, ctx, diff } = reachHinter()
    // 20261103 は WK が運休(calendar_dates)。外れたセルはあっても、その日に走らない便には出さない
    const holiday = { ...ctx, date: '20261103' }
    for (const trip of byId.values()) {
      const d = hinter(trip, holiday)
      expect(d.hints.filter((h) => REACH_HINTS.includes(h))).toEqual([])
      expect(d.lostCells).toBeNull()
    }
    // 編集後(feed が edited)の便は、基準の便の表に無いので出さない
    for (const trip of diff.added) expect(hinter(trip, ctx).lostCells).toBeNull()
    expect(hinter({ ...byId.get('A_0700_WK')!, feed: 'edited' }, ctx).lostCells).toBeNull()
  })

  it('索引を使った結果が、総当たりで数え直した結果と同じ', () => {
    const { hinter, byId, ctx } = reachHinter()
    const rows: Record<string, [string, number][]> = {
      A_0700_WK: [['P', 0]],
      B_0855_WK: [
        ['P', 0],
        ['Q', 1],
      ],
      C_0720_WK: [['F', 0]],
      D_0745_WK: [['D', 0]],
      E_0750_WK: [['E', 0]],
    }
    expect([...byId.keys()].sort()).toEqual(Object.keys(rows).sort())
    for (const [id, list] of Object.entries(rows)) {
      const expected = bruteForce(ctx, list)
      expect(hinter(byId.get(id)!, ctx).lostCells).toEqual(expected.cells > 0 ? expected : null)
    }
  })

  it('ctx を渡しても、ほかの手がかりは ctx が無いときと同じ。1つの便だけを調べても同じ', () => {
    const { base, edited, plan, hinter, byId, ctx } = reachHinter()
    for (const trip of byId.values()) {
      const withCtx = hinter(trip, ctx)
      const without = hinter(trip)
      expect(without.lostCells).toBeNull()
      expect(without.hints.some((h) => REACH_HINTS.includes(h))).toBe(false)
      expect(withCtx.hints.filter((h) => !REACH_HINTS.includes(h))).toEqual(without.hints)
      expect(restoreHints(base, edited, plan, trip, ctx)).toEqual(withCtx)
    }
  })

  it('外れたセルが戻らなくても、乗れる停留所で編集後の出発が 0 なら onlyServiceAtStop を出す', () => {
    const { hinter, byId, ctx } = reachHinter()
    // P のまわりのセルが、編集後も別の理由で到達できるとみなした比較(外れたセルは 0、P の出発は 0 のまま)
    const noLost: RestoreHintContext = { ...ctx, afterResult: { ...ctx.afterResult, reachable: ctx.beforeResult.reachable } }
    const a = hinter(byId.get('A_0700_WK')!, noLost)
    expect(a.hints.filter((h) => REACH_HINTS.includes(h))).toEqual(['onlyServiceAtStop'])
    expect(a.lostCells).toBeNull()
  })

  it('基準と編集後の結果の形が合わない ctx はエラーにする', () => {
    const { hinter, byId, ctx } = reachHinter()
    const broken: RestoreHintContext = { ...ctx, bands: ctx.bands.slice(0, 3) }
    expect(() => hinter(byId.get('A_0700_WK')!, broken)).toThrow('到達圏の比較の形が合いません')
  })
})

// ---- 到達圏の計算と照らす(取り決めの定義を写した計算どうしの比較では見つからない、定義のずれを見つける) ----

/** reachSetup と同じ手順で、基準・方針・参照データ・時間帯の幅を変えた ctx を作る(起点と分母は基準から。1103 の追記3) */
function ctxFor(o: { base?: GtfsFeed; plan?: Form2Plan; ref?: RefData; stepHours?: 1 | 3 } = {}) {
  const base = o.base ?? reachBaseFeed()
  const plan = o.plan ?? reachPlan()
  const ref = o.ref ?? reachRef()
  const bands = makeBands(o.stepHours ?? 3)
  const origins = originStops(base, toStops(base).stops)
  const edit = (p: Form2Plan) => {
    const outcome = applyForm2(base, p, { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    return outcome.result.feed
  }
  const countsOf = (feed: GtfsFeed) => departureCountsByBand(feed, servicesFor(feed, DATE), bands)
  const reachOf = (counts: Map<string, number[]>) =>
    computeReach({
      stops: buildReachStops(origins.stops, counts, bands.length),
      ref,
      fallbackClass: 'suburban',
      params: REACH_PARAMS,
      bandCount: bands.length,
    })
  const edited = edit(plan)
  const before = countsOf(base)
  const after = countsOf(edited)
  const ctx: RestoreHintContext = {
    before,
    after,
    bands,
    beforeResult: reachOf(before.counts),
    afterResult: reachOf(after.counts),
    date: DATE,
    params: REACH_PARAMS,
    stops: origins.stops,
  }
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base, plan, edited, ctx, hinter, byId, edit, countsOf, reachOf }
}

/** A_0700_WK の P の行(乗れる行)の時刻を変えた基準のフィード */
function baseWithATime(time: string): GtfsFeed {
  const base = reachBaseFeed()
  for (const row of base.tables.get('stop_times')!.rows) {
    if (row.trip_id === 'A_0700_WK' && row.stop_id === 'P') {
      row.arrival_time = time
      row.departure_time = time
    }
  }
  return base
}

describe('足し戻しの手がかり:到達圏の計算との往復', () => {
  for (const stepHours of [3, 1] as const) {
    it(`候補を1便ずつ足し戻して到達圏を計算し直すと、戻るセルと出発が 0 から増える停留所が手がかりと一致する(${stepHours}時間ごと)`, () => {
      const { plan, ctx, hinter, byId, edit, countsOf, reachOf } = ctxFor({ stepHours })
      const { beforeResult: before, afterResult: after } = ctx
      expect(byId.size).toBe(5)
      for (const [tripId, trip] of byId) {
        const added = edit({ ...plan, addBackTripIds: [tripId] })
        const counts = countsOf(added)
        const result = reachOf(counts.counts)
        // 足し戻した後に到達できるようになった「減便で外れた」セル(時間帯をまたいで重なりを除く)
        const restored = new Set<number>()
        ctx.bands.forEach((_, b) => {
          before.cells.forEach((_, i) => {
            if (before.coverable[i] && before.reachable[b][i] && !after.reachable[b][i] && result.reachable[b][i]) restored.add(i)
          })
        })
        let population = 0
        for (const i of restored) population += before.cellPopulation[i]
        const detail = hinter(trip, ctx)
        expect(detail.lostCells, tripId).toEqual(restored.size > 0 ? { cells: restored.size, population } : null)
        expect(detail.hints.includes('restoresLostCells'), tripId).toBe(restored.size > 0)
        // 編集後の出発が 0 で、足し戻すと 1 以上になる停留所と時間帯があるか
        let zeroToSome = false
        for (const [stop, list] of counts.counts) {
          list.forEach((n, b) => {
            if (n > 0 && (ctx.after.counts.get(stop)?.[b] ?? 0) === 0) zeroToSome = true
          })
        }
        expect(detail.hints.includes('onlyServiceAtStop'), tripId).toBe(zeroToSome)
      }
    })
  }

  it('時間帯は開始を含み終わりを含まない。24時以降の出発は数えない', () => {
    // 比較(ctx)は元のフィードのもの:6〜9時に外れるのは P(9 セル)・D・E のまわり、9〜12時は Q のまわり(P と重なるのは 2 セル)
    const { ctx } = reachSetup()
    const hintsAt = (time: string) => {
      const base = baseWithATime(time)
      const { edited, plan } = reachSetup()
      const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
      const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
      return hinter(diff.removed.find((t) => t.tripId === 'A_0700_WK')!, ctx)
    }
    // 08:59:59 は 6〜9時:P のまわりの 9 セル
    expect(hintsAt('08:59:59').lostCells).toEqual({ cells: 9, population: 90 })
    // 09:00:00 は 9〜12時:9〜12時に外れるのは Q のまわりで、P から届くのは重なりの 2 セル
    expect(hintsAt('09:00:00').lostCells).toEqual({ cells: 2, population: 20 })
    expect(hintsAt('09:00:00').hints).toContain('onlyServiceAtStop')
    // 24:00:00 と 25:10:00 は 6〜24時の外
    for (const t of ['24:00:00', '25:10:00']) {
      const d = hintsAt(t)
      expect(d.lostCells, t).toBeNull()
      expect(d.hints.some((h) => REACH_HINTS.includes(h)), t).toBe(false)
    }
  })

  it('出発が空で到着だけの行は、到達圏の出発の数と同じく数えない(到着の時刻で代えない)', () => {
    const { ctx } = reachSetup()
    const hintsWith = (arrival: string, departure: string) => {
      const base = reachBaseFeed()
      for (const row of base.tables.get('stop_times')!.rows) {
        if (row.trip_id === 'A_0700_WK' && row.stop_id === 'P') {
          row.arrival_time = arrival
          row.departure_time = departure
        }
      }
      const { edited, plan } = reachSetup()
      const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
      const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
      return hinter(diff.removed.find((t) => t.tripId === 'A_0700_WK')!, ctx)
    }
    const withDeparture = hintsWith('07:00:00', '07:00:00')
    const arrivalOnly = hintsWith('07:00:00', '')
    const noTime = hintsWith('', '')
    // 出発がある行は P のまわり(6〜9時)を数える
    expect(withDeparture.lostCells?.cells ?? 0).toBeGreaterThanOrEqual(9)
    // 到着だけの行は、時刻の無い行と同じ扱い(P を数えない)。到達圏と関係ない手がかり(始発の時刻から決まるもの)は比べない
    const reachPart = (d: typeof arrivalOnly) => ({
      hints: d.hints.filter((h) => REACH_HINTS.includes(h)),
      lostCells: d.lostCells,
    })
    expect(reachPart(arrivalOnly)).toEqual(reachPart(noTime))
    expect(reachPart(arrivalOnly)).not.toEqual(reachPart(withDeparture))
  })

  it('1時間ごとの時間帯でも、乗れる行の時刻が入る時間帯で数える', () => {
    const { ctx, hinter, byId } = ctxFor({ stepHours: 1 })
    expect(ctx.bands).toHaveLength(18)
    // B は 8〜9時の P(9 セル)と 9〜10時の Q(11 セル)。重なりの 2 セルは1つと数える
    expect(hinter(byId.get('B_0855_WK')!, ctx).lostCells).toEqual({ cells: 18, population: 180 })
    // A は 7〜8時の P だけ
    expect(hinter(byId.get('A_0700_WK')!, ctx).lostCells).toEqual({ cells: 9, population: 90 })
    const rows: Record<string, [string, number][]> = {
      A_0700_WK: [['P', 1]],
      B_0855_WK: [
        ['P', 2],
        ['Q', 3],
      ],
      D_0745_WK: [['D', 1]],
      E_0750_WK: [['E', 1]],
    }
    for (const [id, list] of Object.entries(rows)) {
      const expected = bruteForce(ctx, list)
      expect(hinter(byId.get(id)!, ctx).lostCells, id).toEqual(expected.cells > 0 ? expected : null)
    }
  })

  it('セルの区分ごとのバス停の距離で数える(DID の中の都市部は短い)', () => {
    // P のまわりのセルを DID にすると都市部になり、バス停の距離は 1分(80m)。P のセルの中心だけが届く
    const ref = reachRef()
    const did125 = new Set(cellsNear('P', 240))
    const { ctx, hinter, byId } = ctxFor({ ref: { ...ref, did125 } })
    const pCells = [...cellsNear('P', 240)]
    const indexOf = new Map(ctx.beforeResult.cells.map((c, i) => [c, i]))
    for (const c of pCells) expect(ctx.beforeResult.classes[indexOf.get(c)!]).toBe('urban')
    expect(hinter(byId.get('A_0700_WK')!, ctx).lostCells).toEqual({ cells: 1, population: 10 })
    // 中山間・地方のまま(240m)なら 9 セル
    const rural = ctxFor()
    expect(rural.hinter(rural.byId.get('A_0700_WK')!, rural.ctx).lostCells).toEqual({ cells: 9, population: 90 })
    // 総当たり(区分ごとの距離)とも一致する
    expect(hinter(byId.get('B_0855_WK')!, ctx).lostCells).toEqual(
      bruteForce(ctx, [
        ['P', 0],
        ['Q', 1],
      ]),
    )
  })
})

// ---- 学校・病院の手がかり(nearFacility。docs/tasks-1103.md の T19)。form2.fixture の小さなフィードを使う ----
// 停留所:A 駅前 (43.76, 142.36)、B 市役所 (43.77, 142.37)、C 病院前 (43.78, 142.38)、S9 学校前 (43.79, 142.39)
// 消える平日便:R1_0800_WK(A 08:00 → B 08:10)、R2_0900_WK(A 09:00 → C 09:20。C は終点)、R3_0730_WK(A 07:30 → S9 07:40 → B 07:50)

const S9 = { lat: 43.79, lon: 142.39 }
const C = { lat: 43.78, lon: 142.38 }
const A = { lat: 43.76, lon: 142.36 }

/** 点 p から北へ約 m メートルの点 */
function north(p: { lat: number; lon: number }, m: number) {
  return { lat: p.lat + m / 111_000, lon: p.lon }
}

/** 手がかりの施設(窓は、渡さなければ種類の既定の窓) */
function facility(o: Partial<HintFacility> & Pick<HintFacility, 'targetId' | 'lat' | 'lon'>): HintFacility {
  const kind = o.kind ?? 'school'
  return { name: o.targetId, kind, categoryLabel: '高校・特別支援学校', rank: 3, radiusM: 400, windows: defaultFacilityWindows(kind), longBreaks: [], ...o }
}

const HIGH = facility({ targetId: 'P29:高校', name: '学校前高校', ...north(S9, 100) })
const COLLEGE = facility({ targetId: 'P29:大学', name: '学校前大学', categoryLabel: '大学・高専・専修学校', rank: 4, ...north(S9, 50) })
const HOSPITAL = facility({ targetId: 'P04:病院', name: '病院前病院', kind: 'hospital', categoryLabel: '入院設備のある病院', rank: 1, ...north(C, 200) })
const HOSPITAL_A = facility({ targetId: 'P04:駅前病院', name: '駅前病院', kind: 'hospital', categoryLabel: '入院設備のある病院', rank: 1, ...north(A, 100) })

/** 到達圏を使う2つが出ない(比較の日付が土曜で、平日の便が走らない)空の比較に、施設だけを入れた ctx */
function facilityCtx(facilities: readonly HintFacility[] | undefined): RestoreHintContext {
  const bands = makeBands(3)
  const counts = { counts: new Map<string, number[]>(), skippedBlankTime: 0, skippedInvalidTime: 0, hasFrequencies: false }
  const empty = { cells: [], classes: [], reachable: bands.map(() => []), coverable: [], usedFallback: false, excludedStops: 0, cellPopulation: [] }
  return {
    before: counts,
    after: counts,
    bands,
    beforeResult: empty,
    afterResult: empty,
    date: '20261114',
    params: REACH_PARAMS,
    stops: [],
    ...(facilities ? { facilities } : {}),
  }
}

function facilitySetup(feed: GtfsFeed = smallFeed()) {
  const plan = basePlan()
  const outcome = applyForm2(feed, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  const edited = outcome.result.feed
  const diff = diffWeekdayTrips(feed, edited, plan.weekdayService)
  const hinter = createRestoreHinter(feed, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base: feed, plan, edited, diff, hinter, byId }
}

describe('足し戻しの手がかり:学校・病院(nearFacility)', () => {
  it('学校の徒歩圏の停留所に 7〜9時に着く便に nearFacility を付け、理由の文に施設名と種類を入れる', () => {
    const { hinter, byId } = facilitySetup()
    const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
    expect(d.hints).toContain('nearFacility')
    expect(d.facilities).toHaveLength(1)
    const n = d.facilities![0]
    const dist = Math.round(distanceM(S9, HIGH))
    expect(n).toEqual({
      facility: HIGH,
      stopId: 'S9',
      stopName: '学校前',
      distanceM: dist,
      matches: [{ timing: 'arrive', stopId: 'S9', stopName: '学校前', time: '07:40', distanceM: dist }],
    })
    expect(nearFacilityText(n)).toBe(`学校前高校(高校・特別支援学校)の始業前(7〜9時着)に学校前 07:40着(施設まで約 ${dist}m)`)
    // 判断材料の文(A03)は、窓に当たる施設の文をそのまま入れる
    expect(hintSentence('nearFacility', d)).toBe(`停留所の徒歩圏にある学校・病院の時間帯に当たります(${nearFacilityText(n)})`)
    // 学校の近くを通らない便には付けない(項目ごと無い)
    expect(hinter(byId.get('R1_0800_WK')!, facilityCtx([HIGH]))).toEqual({
      hints: ['lastTripOfRoute', 'morning'],
      lostCells: null,
      band: null,
      routeTrips: { before: 2, after: 3 },
    })
  })

  it('病院の徒歩圏の終点(乗れない停留所)に 8〜11時に着く便にも付ける', () => {
    const { hinter, byId } = facilitySetup()
    const d = hinter(byId.get('R2_0900_WK')!, facilityCtx([HOSPITAL]))
    expect(d.hints).toContain('nearFacility')
    expect(d.facilities![0].matches).toEqual([{ timing: 'arrive', stopId: 'C', stopName: '病院前', time: '09:20', distanceM: Math.round(distanceM(C, HOSPITAL)) }])
    expect(nearFacilityText(d.facilities![0])).toContain('病院前病院(入院設備のある病院)の通院の行き(8〜11時着)に病院前 09:20着')
  })

  it('窓は開始を含み終わりを含まない(病院に 11:00 ちょうどに着く便には付けない)', () => {
    // R2 を 1時間40分遅らせると、C に 11:00:00 に着く
    const { hinter, byId } = facilitySetup(shiftTrip(smallFeed(), 'R2_0900_WK', 6000))
    const d = hinter(byId.get('R2_0900_WK')!, facilityCtx([HOSPITAL]))
    expect(d.hints).not.toContain('nearFacility')
    // 徒歩圏にはあるので facilities には入る(窓には当たらない)
    expect(d.facilities?.map((n) => [n.facility.targetId, n.matches.length])).toEqual([['P04:病院', 0]])
    expect(nearFacilityText(d.facilities![0])).toBe(`病院前病院(入院設備のある病院):病院前から約 ${Math.round(distanceM(C, HOSPITAL))}m`)
  })

  it('学校の下校(14〜18時に出る)にも付ける。始発の停留所には着かない', () => {
    // R3 を 7時間遅らせる:A 14:30 発 → S9 14:40 → B 14:50
    const { hinter, byId } = facilitySetup(shiftTrip(smallFeed(), 'R3_0730_WK', 7 * 3600))
    const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH, HOSPITAL_A]))
    expect(d.hints).toContain('nearFacility')
    const high = d.facilities!.find((n) => n.facility.targetId === HIGH.targetId)!
    expect(high.matches.map((m) => [m.timing, m.stopId, m.time])).toEqual([['depart', 'S9', '14:40']])
    expect(nearFacilityText(high)).toContain('下校(14〜18時発)に学校前 14:40発')
    // 駅前病院は始発の A の近く。A では降りられない(最初の停留所)ので着く窓に当たらず、14:30 発は病院の帰りの窓(11〜16時)に当たる
    const hospital = d.facilities!.find((n) => n.facility.targetId === HOSPITAL_A.targetId)!
    expect(hospital.matches.map((m) => [m.timing, m.stopId, m.time])).toEqual([['depart', 'A', '14:30']])
  })

  describe('調べた受付時間・始業から決めた施設ごとの窓(T27)', () => {
    /** data/demo/research_dohoku.json の名寄市立総合病院の外来受付時間(着く 7:30〜11:30、出る 11:30〜17:15) */
    const NAYORO_FACTS = [{ label: '外来受付時間', value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15（公式ページ記載。診療可能日は診療科によって異なる）', url: null }]
    const RESEARCHED_HOSPITAL = facility({ ...HOSPITAL, windows: facilityWindows('hospital', NAYORO_FACTS) })

    it('調べた窓に当たれば nearFacility を付け、理由の文に窓の時刻と出どころを入れる', () => {
      const { hinter, byId } = facilitySetup()
      const d = hinter(byId.get('R2_0900_WK')!, facilityCtx([RESEARCHED_HOSPITAL]))
      expect(d.hints).toContain('nearFacility')
      expect(nearFacilityText(d.facilities![0])).toBe(
        `病院前病院(入院設備のある病院)の通院の行き(7:30〜11:30着。調べた外来の受付 8:00〜11:30・13:00〜15:15 に合わせた窓)に病院前 09:20着(施設まで約 ${Math.round(distanceM(C, HOSPITAL))}m)`,
      )
    })

    it('既定の窓(8〜11時着)の外でも、調べた窓(〜11:30)に入れば付ける', () => {
      // R2 を 2時間遅らせると、C に 11:20 に着く
      const { hinter, byId } = facilitySetup(shiftTrip(smallFeed(), 'R2_0900_WK', 7200))
      expect(hinter(byId.get('R2_0900_WK')!, facilityCtx([HOSPITAL])).hints).not.toContain('nearFacility')
      const d = hinter(byId.get('R2_0900_WK')!, facilityCtx([RESEARCHED_HOSPITAL]))
      expect(d.hints).toContain('nearFacility')
      expect(d.facilities![0].matches.map((m) => [m.timing, m.time])).toEqual([['arrive', '11:20']])
    })

    it('調べた始業が早ければ、既定の窓(7〜9時着)に入る便にも付けない。始まりちょうどは含み、終わりちょうどは含まない', () => {
      const { hinter, byId } = facilitySetup()
      const early = facility({ ...HIGH, windows: facilityWindows('school', [{ label: '始業', value: '7時30分' }]) })
      expect(early.windows.arrive).toMatchObject({ from: 6 * 60 + 30, to: 7 * 60 + 30, source: 'research' })
      // R3 は S9 に 07:40 に着く(既定なら始業前に当たる)
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([early]))
      expect(d.hints).not.toContain('nearFacility')
      expect(d.facilities!.map((n) => n.matches.length)).toEqual([0])

      // 始業 8:40 → 着く窓は 7:40〜8:40。07:40 に着く便は始まりちょうどで当たり、08:40 に着く便は終わりちょうどで当たらない
      const at840 = facility({ ...HIGH, windows: facilityWindows('school', [{ label: '始業', value: '8時40分' }]) })
      const hit = hinter(byId.get('R3_0730_WK')!, facilityCtx([at840]))
      expect(hit.facilities![0].matches.map((m) => [m.timing, m.time])).toEqual([['arrive', '07:40']])
      expect(nearFacilityText(hit.facilities![0])).toContain('始業前(7:40〜8:40着。調べた始業 8:40 に合わせた窓)に学校前 07:40着')
      const late = facilitySetup(shiftTrip(smallFeed(), 'R3_0730_WK', 3600))
      expect(late.hinter(late.byId.get('R3_0730_WK')!, facilityCtx([at840])).hints).not.toContain('nearFacility')
    })

    it('始業だけ調べた学校の下校は、既定の窓(14〜18時発)の名前のまま', () => {
      const { hinter, byId } = facilitySetup(shiftTrip(smallFeed(), 'R3_0730_WK', 7 * 3600))
      const onlyStart = facility({ ...HIGH, windows: facilityWindows('school', [{ label: '始業', value: '8時40分' }]) })
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([onlyStart]))
      expect(nearFacilityText(d.facilities![0])).toContain('下校(14〜18時発)に学校前 14:40発')
    })
  })

  it('徒歩圏(radiusM)の外の施設は入れない。ちょうどの距離は届く', () => {
    const { hinter, byId } = facilitySetup()
    const exact = distanceM(S9, HIGH)
    const out = hinter(byId.get('R3_0730_WK')!, facilityCtx([{ ...HIGH, radiusM: exact - 0.5 }]))
    expect(out.hints).not.toContain('nearFacility')
    expect(out.facilities).toBeUndefined()
    const edge = hinter(byId.get('R3_0730_WK')!, facilityCtx([{ ...HIGH, radiusM: exact }]))
    expect(edge.hints).toContain('nearFacility')
  })

  it('施設は、窓に当たるもの、重要拠点の優先順位、距離の順に並べる', () => {
    const { hinter, byId } = facilitySetup()
    // 大学(4位)は高校(3位)より近いが、優先順位で後ろ。駅前病院(1位)は窓に当たらない(A は始発で 07:30 発)ので最後
    const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([COLLEGE, HOSPITAL_A, HIGH]))
    expect(d.facilities!.map((n) => n.facility.targetId)).toEqual([HIGH.targetId, COLLEGE.targetId, HOSPITAL_A.targetId])
    expect(bestFacilityRank(d)).toBe(3)
    // 優先順位を入れ替えると(大学を 2位に)並びも変わる
    const swapped = hinter(byId.get('R3_0730_WK')!, facilityCtx([{ ...COLLEGE, rank: 2 }, HOSPITAL_A, HIGH]))
    expect(swapped.facilities!.map((n) => n.facility.targetId)).toEqual([COLLEGE.targetId, HIGH.targetId, HOSPITAL_A.targetId])
  })

  it('ctx に施設が無ければ(周辺の施設を読めていない)出さない。編集後の便には出さない', () => {
    const { hinter, byId, diff } = facilitySetup()
    const trip = byId.get('R3_0730_WK')!
    expect(hinter(trip, facilityCtx(undefined))).toEqual(hinter(trip))
    expect(hinter(trip, facilityCtx([]))).toEqual(hinter(trip))
    for (const t of diff.added) expect(hinter(t, facilityCtx([HIGH, HOSPITAL, HOSPITAL_A])).facilities).toBeUndefined()
  })

  it('1つの便だけを調べても、索引を作って調べた結果と同じ', () => {
    const { base, plan, edited, hinter, byId } = facilitySetup()
    const ctx = facilityCtx([HIGH, COLLEGE, HOSPITAL, HOSPITAL_A])
    for (const trip of byId.values()) expect(restoreHints(base, edited, plan, trip, ctx)).toEqual(hinter(trip, ctx))
  })

  it('手がかりの数が同じなら、窓に当たる施設の優先順位の高い便を先にする', () => {
    const { byId } = facilitySetup()
    const near = (rank: number) => [{ facility: { ...HIGH, rank }, stopId: 'S9', stopName: '学校前', distanceM: 100, matches: [{ timing: 'arrive' as const, stopId: 'S9', stopName: '学校前', time: '07:40', distanceM: 100 }] }]
    const a = { trip: byId.get('R3_0730_WK')!, detail: { hints: ['nearFacility' as const], lostCells: null, ...NO_COUNTS, facilities: near(8) } }
    const b = { trip: byId.get('R1_0800_WK')!, detail: { hints: ['nearFacility' as const], lostCells: null, ...NO_COUNTS, facilities: near(1) } }
    expect([a, b].sort(compareByHints).map((c) => c.trip.tripId)).toEqual(['R1_0800_WK', 'R3_0730_WK'])
  })

  describe('乗り降りの扱い(pickup_type・drop_off_type)', () => {
    /** R3_0730_WK の S9 学校前の行の pickup_type・drop_off_type を変えたフィード(ほかの行は同じ) */
    function withS9Flags(feed: GtfsFeed, pickup: string, dropOff: string): GtfsFeed {
      return withRows(
        feed,
        'stop_times',
        feed.tables.get('stop_times')!.rows.map((r) => (r.trip_id === 'R3_0730_WK' && r.stop_id === 'S9' ? { ...r, pickup_type: pickup, drop_off_type: dropOff } : r)),
      )
    }

    it('途中の停留所で降りられない(drop_off_type=1)便は、07:40 に着いても始業前の窓に当たらない', () => {
      const { hinter, byId } = facilitySetup(withS9Flags(smallFeed(), '0', '1'))
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
      expect(d.hints).not.toContain('nearFacility')
      // 乗れる停留所なので徒歩圏の施設には入る(窓には当たらない)
      expect(d.facilities?.map((n) => [n.facility.targetId, n.stopId, n.matches.length])).toEqual([[HIGH.targetId, 'S9', 0]])
    })

    it('途中の停留所で乗れない(pickup_type=1)便は、15:00 に出ても下校の窓に当たらない', () => {
      // R3 を 7時間30分遅らせる:A 15:00 発 → S9 15:10 → B 15:20。S9 は降りられるが、着く 15:10 は始業前の窓の外
      const shifted = shiftTrip(smallFeed(), 'R3_0730_WK', 7.5 * 3600)
      const plain = facilitySetup(shifted)
      const open = plain.hinter(plain.byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
      expect(open.facilities![0].matches.map((m) => [m.timing, m.time])).toEqual([['depart', '15:10']])
      const { hinter, byId } = facilitySetup(withS9Flags(shifted, '1', '0'))
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
      expect(d.hints).not.toContain('nearFacility')
      expect(d.facilities?.map((n) => [n.facility.targetId, n.matches.length])).toEqual([[HIGH.targetId, 0]])
    })

    it('乗ることも降りることもできない停留所しか徒歩圏に無い施設は入れない', () => {
      const { hinter, byId } = facilitySetup(withS9Flags(smallFeed(), '1', '1'))
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
      expect(d.hints).not.toContain('nearFacility')
      expect(d.facilities).toBeUndefined()
    })

    it('最寄りの停留所は、乗り降りできる停留所から選ぶ(近くの通過する停留所は使わない)', () => {
      // 学校前高校の北 約 250m に乗り降りできる S8 を足し、R3 は S9(学校から約 100m)を通過して S8 に 07:45 に着く
      const base = smallFeed()
      const s8 = north(S9, 350)
      const stops = withRows(base, 'stops', [...base.tables.get('stops')!.rows, { stop_id: 'S8', stop_name: '学校北', stop_lat: String(s8.lat), stop_lon: String(s8.lon) }])
      const rows = withS9Flags(stops, '1', '1').tables.get('stop_times')!.rows.flatMap((r) =>
        r.trip_id === 'R3_0730_WK' && r.stop_id === 'B'
          ? [{ ...r, stop_id: 'S8', arrival_time: '07:45:00', departure_time: '07:45:00', stop_sequence: '3', pickup_type: '0', drop_off_type: '0' }, { ...r, stop_sequence: '4' }]
          : [r],
      )
      const { hinter, byId } = facilitySetup(withRows(stops, 'stop_times', rows))
      const d = hinter(byId.get('R3_0730_WK')!, facilityCtx([HIGH]))
      const dist = Math.round(distanceM(s8, HIGH))
      expect(dist).toBeGreaterThan(240)
      expect(d.facilities).toEqual([
        {
          facility: HIGH,
          stopId: 'S8',
          stopName: '学校北',
          distanceM: dist,
          matches: [{ timing: 'arrive', stopId: 'S8', stopName: '学校北', time: '07:45', distanceM: dist }],
        },
      ])
    })
  })

  it('到達圏を使う2つの手がかりは、施設を足しても変わらない', () => {
    const { ctx, hinter, byId } = reachHinter()
    const stops = new Map(Object.entries(STOP_CELLS).map(([id, [dr, dc]]) => [id, centerAt(dr, dc)]))
    // P の近くの高校(P を 07:00 に出る A_0700_WK は、P が始発なので着く窓には当たらない。Q に 09:05 に着く B_0855_WK も 9時を過ぎる)
    const withFacilities = { ...ctx, facilities: [facility({ targetId: 'P29:P', ...north(stops.get('Q')!, 30) })] }
    for (const trip of byId.values()) {
      const plain = hinter(trip, ctx)
      const got = hinter(trip, withFacilities)
      expect(got.hints.filter((h) => h !== 'nearFacility'), trip.tripId).toEqual(plain.hints)
      expect(got.lostCells).toEqual(plain.lostCells)
    }
    // B_0855_WK は Q に 09:05 に着く(9時を過ぎる)ので窓に当たらないが、徒歩圏にはある
    expect(hinter(byId.get('B_0855_WK')!, withFacilities).facilities?.map((n) => n.matches.length)).toEqual([0])
  })
})
