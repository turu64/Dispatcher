import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DUTY_DEFAULTS, BOUND_LIMIT_MIN } from '@/gtfs/edit/duties'
import { feedOf, basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import { applyForm2, activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import { loadGtfsZip, type GtfsFeed } from '@/gtfs/load'
import { MAX_PLACES } from '@/lib/placesFile'
import { compareDrivers, defaultPlaceName, dutyKindOf, useDriversStore, weekdayServicesOfEdit, type DriverInput } from './drivers'
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
  useDriversStore.setState({ shortage: null, roster: null, params: { ...DUTY_DEFAULTS }, places: [], placing: null })
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

  it('在籍の運転士の数は 0〜9999 の整数か null だけを受け付ける', () => {
    const s = useDriversStore.getState()
    s.setRoster(110)
    s.setRoster(10000)
    s.setRoster(-1)
    s.setRoster(1.5)
    expect(useDriversStore.getState().roster).toBe(110)
    s.setRoster(9999)
    expect(useDriversStore.getState().roster).toBe(9999)
    s.setRoster(null)
    expect(useDriversStore.getState().roster).toBeNull()
  })

  it('仮定を変えて、既定に戻せる', () => {
    useDriversStore.getState().setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended, preCheckMin: 20 })
    expect(useDriversStore.getState().params).toEqual({ ...DUTY_DEFAULTS, maxBoundMin: 900, preCheckMin: 20 })
    useDriversStore.getState().resetParams()
    expect(useDriversStore.getState().params).toEqual(DUTY_DEFAULTS)
  })

  it('GTFS を読み込み直すと欠員・在籍の運転士の数と施設は消え、仮定は残る', () => {
    useGtfsStore.getState().setLoaded({ label: 'a.zip', feed: smallFeed() })
    const s = useDriversStore.getState()
    s.setShortage(20)
    s.setRoster(110)
    s.addPlace({ type: 'garage', name: '車庫', lat: 43.76, lon: 142.36 })
    s.startPlacing('rest')
    s.setParams({ maxBoundMin: BOUND_LIMIT_MIN.extended })
    useGtfsStore.getState().setLoaded({ label: 'b.zip', feed: smallFeed() })
    expect(useDriversStore.getState().shortage).toBeNull()
    expect(useDriversStore.getState().roster).toBeNull()
    expect(useDriversStore.getState().places).toEqual([])
    expect(useDriversStore.getState().placing).toBeNull()
    expect(useDriversStore.getState().params.maxBoundMin).toBe(BOUND_LIMIT_MIN.extended)
  })

  it('場所を足す・名前を変える・消す。種類は推定の種類(営業所は depot、車庫は garage、休憩施設は rest)に対応させる', () => {
    const s = useDriversStore.getState()
    s.startPlacing('office')
    expect(useDriversStore.getState().placing).toBe('office')
    const office = s.addPlace({ type: 'office', name: ' 営業所 1 ', lat: 43.7712345678, lon: 142.36 })
    const garage = s.addPlace({ type: 'garage', name: '車庫', lat: 43.8, lon: 142.4 })
    const rest = s.addPlace({ type: 'rest', name: '休憩所', lat: 43.75, lon: 142.3 })
    // 置き終えたら、地図で置くのをやめる
    expect(useDriversStore.getState().placing).toBeNull()
    expect(useDriversStore.getState().places).toEqual([
      { id: office, type: 'office', kind: 'depot', name: '営業所 1', lat: 43.771235, lon: 142.36 },
      { id: garage, type: 'garage', kind: 'garage', name: '車庫', lat: 43.8, lon: 142.4 },
      { id: rest, type: 'rest', kind: 'rest', name: '休憩所', lat: 43.75, lon: 142.3 },
    ])
    // 営業所は出庫・入庫と休憩の場所(depot)、車庫は出庫・入庫だけの場所(garage)、休憩施設は rest
    expect(dutyKindOf('office')).toBe('depot')
    expect(dutyKindOf('garage')).toBe('garage')
    expect(dutyKindOf('rest')).toBe('rest')
    // 読めない名前・緯度経度は足さない
    expect(s.addPlace({ type: 'rest', name: '  ', lat: 43, lon: 142 })).toBeNull()
    expect(s.addPlace({ type: 'rest', name: 'x', lat: Number.NaN, lon: 142 })).toBeNull()
    expect(useDriversStore.getState().places).toHaveLength(3)
    s.renamePlace(garage!, '  旭川車庫 ')
    s.renamePlace(rest!, '')
    expect(useDriversStore.getState().places.map((p) => p.name)).toEqual(['営業所 1', '旭川車庫', '休憩所'])
    s.removePlace(office!)
    expect(useDriversStore.getState().places.map((p) => p.id)).toEqual([garage, rest])
    s.startPlacing('rest')
    s.cancelPlacing()
    expect(useDriversStore.getState().placing).toBeNull()
  })

  it('読み込みで一覧を置き換える。上限を超える分は入れない', () => {
    const s = useDriversStore.getState()
    s.addPlace({ type: 'office', name: '前の営業所', lat: 43, lon: 142 })
    s.replacePlaces(Array.from({ length: MAX_PLACES + 2 }, (_, i) => ({ type: 'rest' as const, name: `休憩${i}`, lat: 43, lon: 142 })))
    const places = useDriversStore.getState().places
    expect(places).toHaveLength(MAX_PLACES)
    expect(places[0].name).toBe('休憩0')
    expect(new Set(places.map((p) => p.id)).size).toBe(MAX_PLACES)
    // 上限に達したら、地図で置き始めず、足しもしない
    s.startPlacing('office')
    expect(useDriversStore.getState().placing).toBeNull()
    expect(s.addPlace({ type: 'office', name: '営業所', lat: 43, lon: 142 })).toBeNull()
  })

  it('地図で置いた場所の名前は、使っていない一番小さい番号にする', () => {
    expect(defaultPlaceName('営業所', [])).toBe('営業所 1')
    expect(defaultPlaceName('営業所', [{ name: '営業所 1' }, { name: '営業所 3' }])).toBe('営業所 2')
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
    // 場所を置かなければ、置く前と後の比較は出さない
    expect(c1.placesEffect).toBeNull()
    // 停留所から約 50km 離れた車庫を置くと、出庫・入庫の回送(片道 3 時間 15 分)が拘束と運転に加わり、勤務が分かれる
    const far = [{ id: 'p1', type: 'garage' as const, kind: 'garage' as const, name: '車庫', lat: 44.21, lon: 142.36 }]
    const placed = compareDrivers({ ...input(1), places: far })
    expect(placed.placesEffect).toEqual({
      count: 1,
      before: { without: 2, with: placed.before.duties.dutyCount },
      after: { without: 1, with: placed.after!.duties.dutyCount },
    })
    expect(placed.before.duties.dutyCount).toBeGreaterThan(2)
    expect(placed.after!.duties.dutyCount).toBeGreaterThan(1)
    expect(placed.assumptions.some((line) => line.includes('営業所・車庫(1 か所)'))).toBe(true)
    // 名前を変えても、推定は計算し直さない(同じ結果を使う)
    const renamed = compareDrivers({ ...input(1), places: [{ ...far[0], name: '別の名前' }] })
    expect(renamed.before).toBe(placed.before)
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

describe('compareDrivers(在籍の運転士の数の参考)', () => {
  it('在籍を入れなければ rosterCheck は null。入れれば在籍 − 欠員と、減便後(無ければ減便前)の勤務の数を比べる', () => {
    const base = smallFeed()
    const result = applied(base)
    expect(compareDrivers(inputOf(base, result, WEDNESDAY, { shortage: 1 })).rosterCheck).toBeNull()
    const c = compareDrivers(inputOf(base, result, WEDNESDAY, { shortage: 1, roster: 3 }))
    expect(c.rosterCheck).toMatchObject({ roster: 3, shortage: 1, available: 2, basis: 'after', needed: c.after!.duties.dutyCount })
    expect(c.rosterCheck!.over).toBe(Math.max(0, c.after!.duties.dutyCount - 2))
    const noEdit = compareDrivers(inputOf(base, null, WEDNESDAY, { roster: 0 }))
    expect(noEdit.rosterCheck).toMatchObject({ roster: 0, shortage: null, available: 0, basis: 'before', needed: noEdit.before.duties.dutyCount })
    expect(noEdit.rosterCheck!.over).toBe(noEdit.before.duties.dutyCount)
    // 欠員が在籍より多いときは 0 人とし、数の入れ違いの疑いを立てる
    expect(compareDrivers(inputOf(base, null, WEDNESDAY, { roster: 1, shortage: 5 })).rosterCheck).toMatchObject({ available: 0, shortageOverRoster: true })
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

  it('在籍 110・欠員 20 を入れても勤務の数と判定は変わらず(82 → 57)、乗務できる運転士 90 人と減便後に要る勤務の数 57 を参考に出す', () => {
    const result = applied(base, basePlan({ weekdayService: '01', replacementService: '03', period: { start: '20261101', end: null } }))
    const c = compareDrivers(inputOf(base, result, WEDNESDAY, { shortage: 20, roster: 110 }))
    expect([c.before.duties.dutyCount, c.after!.duties.dutyCount]).toEqual([82, 57])
    expect(c.verdict).toEqual({ kind: 'enough', reduced: 25, shortage: 20 })
    expect(c.rosterCheck).toEqual({ roster: 110, shortage: 20, available: 90, shortageOverRoster: false, needed: 57, basis: 'after', over: 0 })
    expect(compareDrivers(inputOf(base, null, SATURDAY, { roster: 110 })).before.duties.dutyCount).toBe(57)
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

  it('営業所を置くと出庫・入庫の回送が加わり、置く前と後の勤務の数を出す', () => {
    const result = applied(base, basePlan({ weekdayService: '01', replacementService: '03', period: { start: '20261101', end: null } }))
    // 旭川駅の近く(確かめた営業所の位置ではない。テストのための点)
    const office = { id: 'p1', type: 'office' as const, kind: 'depot' as const, name: '営業所', lat: 43.763, lon: 142.358 }
    const c = compareDrivers(inputOf(base, result, WEDNESDAY, { shortage: 20, places: [office] }))
    expect(c.placesEffect).toMatchObject({ count: 1, before: { without: 82 }, after: { without: 57 } })
    expect(c.placesEffect!.before.with).toBe(c.before.duties.dutyCount)
    expect(c.placesEffect!.before.with).toBeGreaterThanOrEqual(82)
    expect(c.dutyDiff).toBe(c.placesEffect!.before.with - c.placesEffect!.after!.with)
  })

  it('場所を置かなければ、上限を超えた勤務と回送が長すぎる勤務は無い(9/17 平日 82・土曜 57、10/29 平日 68 のまま)', () => {
    const result = applied(base, basePlan({ weekdayService: '01', replacementService: '03', period: { start: '20261101', end: null } }))
    const c = compareDrivers(inputOf(base, result, WEDNESDAY))
    const oct = compareDrivers({ ...inputOf(base, null, WEDNESDAY), edited: { feed: october, draft: false }, weekdayServices: new Set(['01']) })
    const saturday = compareDrivers(inputOf(base, null, SATURDAY))
    expect([c.before.duties.dutyCount, c.after!.duties.dutyCount, oct.after!.duties.dutyCount]).toEqual([82, 57, 68])
    expect(saturday.before.duties.dutyCount).toBe(57)
    for (const side of [c.before, c.after!, oct.after!, saturday.before]) {
      expect(side.duties.overLimitDuties).toBe(0)
      expect(side.duties.longDeadheadDuties).toBe(0)
    }
  })

  it('車庫を置いても数は営業所と同じ(休憩施設が無ければ休憩の数え方は変わらない)。休憩施設を足すと、車庫の近くは休憩に数えない', () => {
    // 旭川駅の近く(確かめた位置ではない。テストのための点)
    const at = { lat: 43.763, lon: 142.358 }
    const office = { id: 'p1', type: 'office' as const, kind: 'depot' as const, name: '営業所', ...at }
    const garage = { id: 'p2', type: 'garage' as const, kind: 'garage' as const, name: '車庫', ...at }
    const count = (places: DriverInput['places']) => compareDrivers(inputOf(base, null, WEDNESDAY, { places })).before.duties.dutyCount
    expect(count([garage])).toBe(count([office]))
    // 遠い休憩施設を足すと、駅の近くのすき間は営業所なら休憩に数え、車庫なら数えないので、車庫のほうが勤務が多い
    const rest = { id: 'p3', type: 'rest' as const, kind: 'rest' as const, name: '休憩所', lat: 44.21, lon: 142.36 }
    expect(count([garage, rest])).toBeGreaterThan(count([office, rest]))
  })

  it('網から遠い営業所を置くと勤務の数が跳ね上がり、上限を超えた勤務と回送が長すぎる勤務を数える', () => {
    const far = { id: 'p1', type: 'office' as const, kind: 'depot' as const, name: '遠い営業所', lat: 44.21, lon: 142.36 }
    const c = compareDrivers(inputOf(base, null, WEDNESDAY, { places: [far] }))
    expect(c.before.duties.dutyCount).toBeGreaterThan(400)
    expect(c.before.duties.overLimitDuties).toBeGreaterThan(0)
    expect(c.before.duties.longDeadheadDuties).toBe(c.before.duties.dutyCount)
  })
})
