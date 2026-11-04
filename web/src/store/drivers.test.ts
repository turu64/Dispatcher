import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DUTY_DEFAULTS, BOUND_LIMIT_MIN } from '@/gtfs/edit/duties'
import { feedOf, basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import { applyForm2, activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import { loadGtfsZip, type GtfsFeed } from '@/gtfs/load'
import { compareDrivers, useDriversStore, weekdayServicesOfEdit, type DriverInput } from './drivers'
import { useGtfsStore } from './gtfs'

const OPTS = { generatedAt: '202611051200' }
const WEDNESDAY = '20261104'
const SATURDAY = '20261107'

function applied(feed: GtfsFeed, plan = basePlan()): Form2Result {
  const outcome = applyForm2(feed, plan, OPTS)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result
}

function inputOf(base: GtfsFeed, result: Form2Result | null, date: string, extra: Partial<DriverInput> = {}): DriverInput {
  return {
    base,
    edited: result ? { feed: result.feed, draft: false } : null,
    date,
    weekdayServices: result ? activeWeekdayServicesOf(result) : null,
    params: { ...DUTY_DEFAULTS },
    places: [],
    shortage: null,
    ...extra,
  }
}

afterEach(() => {
  useDriversStore.setState({ shortage: null, params: { ...DUTY_DEFAULTS }, places: [] })
  useGtfsStore.getState().clear()
})

describe('useDriversStore(欠員・仮定・施設)', () => {
  it('欠員は 0〜999 の整数か null だけを受け付ける', () => {
    const s = useDriversStore.getState()
    s.setShortage(20)
    expect(useDriversStore.getState().shortage).toBe(20)
    s.setShortage(1000)
    s.setShortage(-1)
    s.setShortage(2.5)
    expect(useDriversStore.getState().shortage).toBe(20)
    s.setShortage(0)
    expect(useDriversStore.getState().shortage).toBe(0)
    s.setShortage(null)
    expect(useDriversStore.getState().shortage).toBeNull()
  })

  it('仮定を変えて、既定に戻せる', () => {
    useDriversStore.getState().setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended, preCheckMin: 20 })
    expect(useDriversStore.getState().params).toEqual({ ...DUTY_DEFAULTS, maxBoundMin: 900, preCheckMin: 20 })
    useDriversStore.getState().resetParams()
    expect(useDriversStore.getState().params).toEqual(DUTY_DEFAULTS)
  })

  it('GTFS を読み込み直すと欠員と施設は消え、仮定は残る', () => {
    useGtfsStore.getState().setLoaded({ label: 'a.zip', feed: smallFeed() })
    const s = useDriversStore.getState()
    s.setShortage(20)
    s.setPlaces([{ kind: 'depot', name: '車庫', lat: 43.76, lon: 142.36 }])
    s.setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended })
    useGtfsStore.getState().setLoaded({ label: 'b.zip', feed: smallFeed() })
    expect(useDriversStore.getState().shortage).toBeNull()
    expect(useDriversStore.getState().places).toEqual([])
    expect(useDriversStore.getState().params.maxBoundMin).toBe(BOUND_LIMIT_MIN.extended)
  })

  it('GTFS を削除しても(clear)欠員は消える', () => {
    useGtfsStore.getState().setLoaded({ label: 'a.zip', feed: smallFeed() })
    useDriversStore.getState().setShortage(3)
    useGtfsStore.getState().clear()
    expect(useDriversStore.getState().shortage).toBeNull()
  })
})

describe('compareDrivers(減便の前後と欠員の比較)', () => {
  // 平日 WK は 4 便(7:00 A→B、7:30 A→B、8:00 A→B、9:00 A→C)。土曜 SA も 4 便(7:00 A→B、8:00 C→B、8:05 A→B、10:00 A→C)
  it('減便後が無ければ減便前だけを出し、判定は noEdited', () => {
    const base = smallFeed()
    const c = compareDrivers(inputOf(base, null, WEDNESDAY, { shortage: 2 }))
    expect(c.before.hours.trips).toBe(4)
    expect(c.after).toBeNull()
    expect(c.hours).toBeNull()
    expect(c.dutyDiff).toBeNull()
    expect(c.weekday).toBeNull()
    expect(c.verdict).toEqual({ kind: 'noEdited' })
    expect(c.assumptions.length).toBeGreaterThan(0)
  })

  it('平日の日付では、前後の便・営業運行時間・勤務の数と差を出す', () => {
    const base = smallFeed()
    const result = applied(base)
    const c = compareDrivers(inputOf(base, result, WEDNESDAY))
    expect(c.weekday).toBe(true)
    expect(c.after).not.toBeNull()
    expect(c.before.hours.serviceMinutes).toBe(10 + 20 + 10 + 20)
    expect(c.after!.hours.serviceMinutes).toBe(10 + 10 + 10 + 20)
    expect(c.hours!.reduction.serviceMinutes).toBe(10)
    expect(c.dutyDiff).toBe(c.before.duties.dutyCount - c.after!.duties.dutyCount)
    expect(c.verdict).toEqual({ kind: 'noShortage', reduced: c.dutyDiff })
  })

  it('減る勤務の数が欠員以上なら enough、足りなければ short と不足の数', () => {
    // 平日は 6:00 から 1 時間ごとに A→A の 30 分の便を 14 便(拘束 14 時間 15 分。13 時間を超えるので2つの勤務、15 時間なら1つ)。減便後は 6:00〜11:00 の 6 便だけ
    const shuttle = (service: string, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const h = String(6 + i).padStart(2, '0')
        return { route_id: 'R1', service_id: service, trip_id: `R1_${h}00_${service}` }
      })
    const stopTimesOf = (trips: { trip_id: string }[]) =>
      trips.flatMap((t) => {
        const h = t.trip_id.slice(3, 5)
        return [
          { trip_id: t.trip_id, arrival_time: `${h}:00:00`, departure_time: `${h}:00:00`, stop_id: 'A', stop_sequence: '1' },
          { trip_id: t.trip_id, arrival_time: `${h}:30:00`, departure_time: `${h}:30:00`, stop_id: 'A', stop_sequence: '2' },
        ]
      })
    const calendar = [
      { service_id: 'WK', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
      { service_id: 'SA', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0', start_date: '20261001', end_date: '20261130' },
    ]
    const make = (wk: number) => {
      const trips = [...shuttle('WK', wk), ...shuttle('SA', 6)]
      return feedOf({
        stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }],
        calendar,
        trips,
        stop_times: stopTimesOf(trips),
      })
    }
    const base = make(14)
    const edited = make(6)
    const weekdays = new Set(['WK'])
    const input = (shortage: number): DriverInput => ({
      base,
      edited: { feed: edited, draft: true },
      date: WEDNESDAY,
      weekdayServices: weekdays,
      params: { ...DUTY_DEFAULTS },
      places: [],
      shortage,
    })
    const c1 = compareDrivers(input(1))
    expect(c1.before.duties.dutyCount).toBe(2)
    expect(c1.after!.duties.dutyCount).toBe(1)
    expect(c1.dutyDiff).toBe(1)
    expect(c1.draft).toBe(true)
    expect(c1.verdict).toEqual({ kind: 'enough', reduced: 1, shortage: 1 })
    expect(compareDrivers(input(3)).verdict).toEqual({ kind: 'short', reduced: 1, shortage: 3, missing: 2 })
    expect(compareDrivers(input(0)).verdict).toEqual({ kind: 'enough', reduced: 1, shortage: 0 })
    // 拘束を 15 時間にすると、減便前も1つの勤務に収まり、減る勤務の数は 0
    const extended = compareDrivers({ ...input(1), params: { ...DUTY_DEFAULTS, maxBoundMin: BOUND_LIMIT_MIN.extended } })
    expect(extended.before.duties.dutyCount).toBe(1)
    expect(extended.verdict).toEqual({ kind: 'short', reduced: 0, shortage: 1, missing: 1 })
  })

  it('比較する日付に平日ダイヤが走らないときは notWeekday で、前後の差は無い', () => {
    const base = smallFeed()
    const result = applied(base)
    const c = compareDrivers(inputOf(base, result, SATURDAY, { shortage: 5 }))
    expect(c.weekday).toBe(false)
    expect(c.dutyDiff).toBe(0)
    expect(c.hours!.reduction.trips).toBe(0)
    expect(c.verdict).toEqual({ kind: 'notWeekday' })
  })

  it('入力の運用番号の数は、trip_id が運用番号の形のときだけ出す', () => {
    // smallFeed の trip_id は R1_0700_WK の形(5つに分かれない)
    expect(compareDrivers(inputOf(smallFeed(), null, WEDNESDAY)).operatorRuns).toBeNull()
    const feed = feedOf({
      stops: [{ stop_id: 'A', stop_name: '駅前', stop_lat: '43.76', stop_lon: '142.36' }],
      calendar: [
        { service_id: '01', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0', start_date: '20261001', end_date: '20261130' },
      ],
      trips: [
        { route_id: 'R1', service_id: '01', trip_id: '101_1_01_01_0600' },
        { route_id: 'R1', service_id: '01', trip_id: '101_2_01_01_0700' },
        { route_id: 'R1', service_id: '01', trip_id: '102_1_01_01_0630' },
      ],
      stop_times: [],
    })
    expect(compareDrivers(inputOf(feed, null, WEDNESDAY)).operatorRuns).toBe(2)
  })
})

describe('weekdayServicesOfEdit(減便の方針の平日の service)', () => {
  it('下書き・承認済みの版の順に選び、編集が無ければ null', () => {
    const base = smallFeed()
    const result = applied(base)
    expect(weekdayServicesOfEdit({ draft: null, versions: [] })).toBeNull()
    expect(weekdayServicesOfEdit({ draft: null, versions: [result] })).toEqual(new Set(['WK']))
    expect(weekdayServicesOfEdit({ draft: { kind: 'undo', id: '2', by: 'user', result: null, diff: null }, versions: [result] })).toBeNull()
  })
})

// 道北バスのデモの筋:欠員 20 人に対して、平日を土曜ダイヤにすると足りる目安(82 → 57、25 減る)、
// 10/29 版の形(平日に 25 便戻す。82 → 68、14 減る)では足りない目安。ZIP はコミットしないので、無ければスキップする
const BEFORE_ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const AFTER_ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))

describe.skipIf(!existsSync(BEFORE_ZIP) || !existsSync(AFTER_ZIP))('compareDrivers(道北バス)', () => {
  let base: GtfsFeed
  let october: GtfsFeed
  beforeAll(async () => {
    base = await loadGtfsZip(new Uint8Array(readFileSync(BEFORE_ZIP)).buffer)
    october = await loadGtfsZip(new Uint8Array(readFileSync(AFTER_ZIP)).buffer)
  })

  it('平日を土曜ダイヤにすると、勤務の数は 25 減り、欠員 20 人に足りる目安', () => {
    const result = applied(base, basePlan({ weekdayService: '01', replacementService: '03', period: { start: '20261101', end: null } }))
    const c = compareDrivers(inputOf(base, result, WEDNESDAY, { shortage: 20 }))
    expect(c.before.duties.dutyCount).toBe(82)
    expect(c.after!.duties.dutyCount).toBe(57)
    expect(c.operatorRuns).toBe(101)
    expect(c.verdict).toEqual({ kind: 'enough', reduced: 25, shortage: 20 })
  })

  it('10/29 版の形では、勤務の数は 14 減り、欠員 20 人にあと 6 足りない目安', () => {
    const c = compareDrivers({
      ...inputOf(base, null, WEDNESDAY, { shortage: 20 }),
      edited: { feed: october, draft: false },
      weekdayServices: new Set(['01']),
    })
    expect(c.before.duties.dutyCount).toBe(82)
    expect(c.after!.duties.dutyCount).toBe(68)
    expect(c.verdict).toEqual({ kind: 'short', reduced: 14, shortage: 20, missing: 6 })
  })
})
