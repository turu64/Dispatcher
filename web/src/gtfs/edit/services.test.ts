import { describe, expect, it } from 'vitest'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { rowsOf, smallFeed, withRows } from './form2.fixture'
import { activeDaysIn, describeServices, feedValidity, guessServiceChoice, policyValidity, sameTimetable } from './services'

const HOLIDAYS: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
  ]),
  first: '19550101',
  coveredUntil: '20271231',
  source: 'テスト用の祝日一覧',
}

const NOVEMBER = { start: '20261101', end: '20261130' }

/** calendar と、service ごとに1便ずつの trips・stop_times を持つフィード */
function feedWith(calendar: string, calendarDates = 'service_id,date,exception_type'): GtfsFeed {
  const cal = rowsOf(calendar)
  const ids = [...new Set([...cal, ...rowsOf(calendarDates)].map((r) => r.service_id ?? ''))]
  const trips: GtfsRow[] = ids.map((sid) => ({ route_id: 'R1', service_id: sid, trip_id: `T_${sid}` }))
  const stopTimes: GtfsRow[] = ids.flatMap((sid) => [
    { trip_id: `T_${sid}`, arrival_time: '07:00:00', departure_time: '07:00:00', stop_id: 'A', stop_sequence: '1' },
    { trip_id: `T_${sid}`, arrival_time: '07:10:00', departure_time: '07:10:00', stop_id: 'B', stop_sequence: '2' },
  ])
  let feed = withRows(smallFeed(), 'calendar', cal)
  feed = withRows(feed, 'calendar_dates', rowsOf(calendarDates), ['service_id', 'date', 'exception_type'])
  feed = withRows(feed, 'trips', trips)
  return withRows(feed, 'stop_times', stopTimes)
}

const HEADER = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date'

describe('service の役割', () => {
  it('曜日の列から平日・土曜・日曜・土休日を見分ける', () => {
    const feed = feedWith(
      `${HEADER}
WK,1,1,1,1,1,0,0,20261001,20261130
SA, 1 ,0,0,0,0,1,0,20261001,20261130
SU,0,0,0,0,0,0,1,20261001,20261130
SS,0,0,0,0,0,1,1,20261001,20261130
MS,1,1,1,1,1,1,0,20261001,20261130`,
      `service_id,date,exception_type
SC,20261104,1`,
    )
    const services = describeServices(feed, null)
    expect(services.map((s) => [s.serviceId, s.role])).toEqual([
      ['MS', 'other'],
      ['SA', 'other'],
      ['SC', 'other'],
      ['SS', 'saturdaySunday'],
      ['SU', 'sunday'],
      ['WK', 'weekday'],
    ])
    const wk = services.find((s) => s.serviceId === 'WK')
    expect(wk).toEqual({
      serviceId: 'WK',
      role: 'weekday',
      days: [true, true, true, true, true, false, false],
      addedOnHolidays: null,
      tripCount: 1,
      calendarRange: { start: '20261001', end: '20261130' },
    })
    // calendar_dates だけの service は役割を決めない
    expect(services.find((s) => s.serviceId === 'SC')).toMatchObject({ days: null, calendarRange: null })
    // 小さなフィード:WK=平日、SA=土曜、SU=日曜
    expect(describeServices(smallFeed(), HOLIDAYS).map((s) => [s.serviceId, s.role, s.addedOnHolidays, s.tripCount])).toEqual([
      ['SA', 'saturday', false, 4],
      ['SU', 'sunday', true, 1],
      ['WK', 'weekday', false, 4],
    ])
    expect(guessServiceChoice(smallFeed(), describeServices(smallFeed(), HOLIDAYS), NOVEMBER)).toEqual({
      weekday: 'WK',
      saturday: 'SA',
      sundayHoliday: 'SU',
      notes: [],
    })
  })

  it('候補が 0 個か複数なら null にして利用者に選ばせる', () => {
    const feed = feedWith(`${HEADER}
W1,1,1,1,1,1,0,0,20261001,20261130
W2,1,1,1,1,1,0,0,20261001,20261130
SU,0,0,0,0,0,0,1,20261001,20261130`)
    const choice = guessServiceChoice(feed, describeServices(feed, HOLIDAYS), NOVEMBER)
    expect(choice.weekday).toBeNull()
    expect(choice.saturday).toBeNull()
    expect(choice.sundayHoliday).toBe('SU')
    expect(choice.notes).toEqual([
      '平日(月〜金)のダイヤの service が 2 個(W1、W2)あるため、決められません。選んでください。',
      '土曜のダイヤの service が見つかりません。選んでください。',
    ])
    // 便の無い service は候補にしない
    const noTrips = withRows(feed, 'trips', feed.tables.get('trips')!.rows.filter((t) => t.service_id !== 'W2'))
    expect(guessServiceChoice(noTrips, describeServices(noTrips, HOLIDAYS), NOVEMBER).weekday).toBe('W1')
  })

  it('祝日に追加される service を日祝とみなす', () => {
    const feed = feedWith(
      `${HEADER}
WK,1,1,1,1,1,0,0,20261001,20261130
SA,0,0,0,0,0,1,0,20261001,20261130
S1,0,0,0,0,0,0,1,20261001,20261130
S2,0,0,0,0,0,0,1,20261001,20261130`,
      `service_id,date,exception_type
S2,20261103,1
S1,20261104,1`,
    )
    const services = describeServices(feed, HOLIDAYS)
    expect(services.filter((s) => s.role === 'sunday').map((s) => [s.serviceId, s.addedOnHolidays])).toEqual([
      ['S1', false],
      ['S2', true],
    ])
    expect(guessServiceChoice(feed, services, NOVEMBER)).toEqual({ weekday: 'WK', saturday: 'SA', sundayHoliday: 'S2', notes: [] })
  })

  it('祝日一覧が無ければ、日祝を祝日で選ばず利用者に選ばせる', () => {
    const feed = feedWith(
      `${HEADER}
WK,1,1,1,1,1,0,0,20261001,20261130
S1,0,0,0,0,0,0,1,20261001,20261130
S2,0,0,0,0,0,0,1,20261001,20261130`,
      `service_id,date,exception_type
S2,20261103,1`,
    )
    const choice = guessServiceChoice(feed, describeServices(feed, null), NOVEMBER)
    expect(choice.sundayHoliday).toBeNull()
    expect(choice.notes).toContain('祝日一覧を読めないため、日祝のダイヤを決められません。')
  })

  it('新しい有効期間に走らない service を候補にしない', () => {
    // 夏の土曜 03(10/31 まで)と、冬の土休日 13(11/1 から)
    const feed = feedWith(`${HEADER}
01,1,1,1,1,1,0,0,20261001,20261130
03,0,0,0,0,0,1,0,20261001,20261031
13,0,0,0,0,0,1,1,20261101,20261130`)
    expect(activeDaysIn(feed, '03', '20261101', '20261130')).toBe(0)
    expect(activeDaysIn(feed, '03', '20261001', '20261031')).toBe(5)
    expect(activeDaysIn(feed, '13', '20261101', '20261130')).toBe(9)
    expect(guessServiceChoice(feed, describeServices(feed, HOLIDAYS), NOVEMBER)).toEqual({
      weekday: '01',
      saturday: '13',
      sundayHoliday: '13',
      notes: [],
    })
    // 10 月の期間なら夏の土曜を選ぶ(土休日の 13 は走らないので候補にしない)
    expect(guessServiceChoice(feed, describeServices(feed, HOLIDAYS), { start: '20261001', end: '20261031' })).toMatchObject({
      saturday: '03',
      sundayHoliday: null,
    })
    // 削除の例外は数えない(11/3 は WK が運休)
    expect(activeDaysIn(smallFeed(), 'WK', '20261101', '20261130')).toBe(20)
    expect(activeDaysIn(smallFeed(), 'SU', '20261101', '20261130')).toBe(6)
  })

  it('土曜と日祝が同じ時刻表かを署名で判定する', () => {
    const base = smallFeed()
    expect(sameTimetable(base, 'SA', 'SU')).toBe(false)
    // 日曜の便を土曜の便と同じ時刻・停留所にする(trip_id は違ってよい)
    const saTrips = base.tables.get('trips')!.rows.filter((t) => t.service_id === 'SA')
    const suTrips = saTrips.map((t) => ({ ...t, service_id: 'SU', trip_id: t.trip_id!.replace('_SA', '_SU') }))
    let feed = withRows(base, 'trips', [...base.tables.get('trips')!.rows.filter((t) => t.service_id !== 'SU'), ...suTrips])
    const saStopTimes = base.tables.get('stop_times')!.rows.filter((r) => r.trip_id!.endsWith('_SA'))
    feed = withRows(feed, 'stop_times', [
      ...base.tables.get('stop_times')!.rows.filter((r) => !r.trip_id!.endsWith('_SU')),
      ...saStopTimes.map((r) => ({ ...r, trip_id: r.trip_id!.replace('_SA', '_SU') })),
    ])
    expect(sameTimetable(feed, 'SA', 'SU')).toBe(true)
    expect(sameTimetable(feed, 'SA', 'WK')).toBe(false)
  })
})

describe('有効期間', () => {
  it('入力の有効期間は feed_info から、無ければ calendar と calendar_dates から決め、方針の期間で切る', () => {
    expect(feedValidity(smallFeed())).toEqual({ start: '20261001', end: '20261130' })
    const noInfo = withRows(smallFeed(), 'feed_info', [])
    expect(feedValidity(noInfo)).toEqual({ start: '20261001', end: '20261130' })
    expect(policyValidity({ start: '20261001', end: '20261130' }, { start: '20261101', end: null })).toEqual({
      start: '20261101',
      end: '20261130',
      days: 30,
    })
    expect(policyValidity({ start: '20261001', end: '20261130' }, { start: '20260901', end: '20261231' })).toEqual({
      start: '20261001',
      end: '20261130',
      days: 61,
    })
    expect(policyValidity({ start: '20261001', end: '20261130' }, { start: '20261201', end: null })).toBeNull()
  })
})
