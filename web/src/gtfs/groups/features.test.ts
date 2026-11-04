import { describe, expect, it } from 'vitest'
import type { HolidayList } from '../holidays'
import { basisOf, computeServiceFeatures, levelOf, routeOverlap, splitServiceName } from './features'
import { feedFrom, svc } from './groups.fixture'

const HOLIDAYS: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
  ]),
  first: '19550101',
  coveredUntil: '20271231',
  source: 'テスト用の祝日一覧',
}

// 2026年11月:日曜 5 日(1・8・15・22・29)、土曜 4 日、祝日 2 日(3日火・23日月)、平日 19 日
function novemberFeed() {
  return feedFrom({
    agency: `agency_id,agency_name
A1,テスト交通`,
    feed_info: `feed_publisher_name,feed_lang,feed_start_date,feed_end_date
テスト,ja,20261101,20261130`,
    routes: `route_id,route_short_name,route_long_name
R1,1,一番の系統
R2,,長い名前`,
    calendar: `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WK,1,1,1,1,1,0,0,20261101,20261130
SA,0,0,0,0,0,1,0,20261101,20261130
SU,0,0,0,0,0,0,1,20261101,20261130
WE,0,0,1,0,0,0,0,20261101,20261130`,
    calendar_dates: `service_id,date,exception_type
WK,20261103,2
WK,20261123,2
SU,20261103,1
SU,20261123,1
SP,20261105,1
NOTRIP,20261106,1`,
    trips: `route_id,service_id,trip_id,trip_headsign
R1,WK,T1,駅前
R1,WK,T2,駅前
R2,WK,T3,
R2,WK,T4,病院
R3,WK,T9,
R1,SA,T5,駅前
R1,SU,T6,駅前
R1,WE,T7,大学
R1,SP,T8,`,
    stop_times: `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,06:05:00,06:05:00,A,1
T1,,,B,2
T1,06:30:00,06:30:00,C,3
T4,24:50:00,24:50:00,A,1
T4,25:10:00,25:10:00,C,2
T9,7:00:00,7:00:00,A,1
T5,08:00:00,08:00:00,A,1
T5,08:20:00,08:20:00,B,2`,
  })
}

describe('splitServiceName', () => {
  it('最初の _ で頭と接尾辞に分ける', () => {
    expect(splitServiceName('01001_A')).toEqual({ head: '01001', suffix: 'A' })
    expect(splitServiceName('SRV_8_10600_01_A')).toEqual({ head: 'SRV', suffix: '8_10600_01_A' })
    expect(splitServiceName('S000001')).toEqual({ head: 'S000001', suffix: '' })
  })
})

describe('水準と basis', () => {
  it('網羅率の境目(0.7・0.15)を整数で比べる', () => {
    expect(levelOf(7, 10)).toBe('regular')
    expect(levelOf(69, 100)).toBe('partial')
    expect(levelOf(15, 100)).toBe('partial')
    expect(levelOf(14, 100)).toBe('rare')
    expect(levelOf(0, 10)).toBe('none')
    expect(levelOf(3, 0)).toBe('none')
  })

  it('regular → partial → special → noDays の順に決める', () => {
    expect(basisOf({ weekday: 'regular', saturday: 'partial', sundayHoliday: 'rare' }, { weekday: 90, saturday: 5, sundayHoliday: 1 })).toEqual({
      basis: 'regular',
      runs: { weekday: true, saturday: false, sundayHoliday: false },
    })
    expect(basisOf({ weekday: 'partial', saturday: 'rare', sundayHoliday: 'none' }, { weekday: 50, saturday: 1, sundayHoliday: 0 })).toEqual({
      basis: 'partial',
      runs: { weekday: true, saturday: false, sundayHoliday: false },
    })
    expect(basisOf({ weekday: 'none', saturday: 'rare', sundayHoliday: 'rare' }, { weekday: 0, saturday: 1, sundayHoliday: 2 })).toEqual({
      basis: 'special',
      runs: { weekday: false, saturday: true, sundayHoliday: true },
    })
    expect(basisOf({ weekday: 'none', saturday: 'none', sundayHoliday: 'none' }, { weekday: 0, saturday: 0, sundayHoliday: 0 })).toEqual({
      basis: 'noDays',
      runs: { weekday: false, saturday: false, sundayHoliday: false },
    })
  })

  it('毎日運行は {平日・土曜・日祝}、土日祝は {土曜・日祝} になる(M1)', () => {
    expect(svc('ALL', { weekday: 99, saturday: 19, sundayHoliday: 24 }).runs).toEqual({ weekday: true, saturday: true, sundayHoliday: true })
    expect(svc('SH', { saturday: 19, sundayHoliday: 19 }).runs).toEqual({ weekday: false, saturday: true, sundayHoliday: true })
  })
})

describe('computeServiceFeatures', () => {
  it('祝日一覧を当てて、区分ごとの運行日と網羅率を数える(calendar だけ・calendar_dates だけ・両方)', () => {
    const f = computeServiceFeatures(novemberFeed(), HOLIDAYS)
    expect(f.holidays).toBe('loaded')
    expect(f.validity).toEqual({ start: '20261101', end: '20261130' })
    expect(f.daysInPeriod).toEqual({ weekday: 19, saturday: 4, sundayHoliday: 7 })
    expect(f.agency).toBe('テスト交通')
    // 便の無い NOTRIP は入れない
    expect(f.services.map((s) => s.serviceId)).toEqual(['SA', 'SP', 'SU', 'WE', 'WK'])
    const by = new Map(f.services.map((s) => [s.serviceId, s]))

    const wk = by.get('WK')!
    expect(wk.runningDays).toEqual({ weekday: 19, saturday: 0, sundayHoliday: 0, total: 19 })
    expect(wk.coverage.weekday).toBe(1)
    expect(wk.basis).toBe('regular')
    expect(wk.runningDates).toBeNull()

    const su = by.get('SU')!
    // 日曜 5 日と、祝日に追加した 2 日
    expect(su.runningDays).toEqual({ weekday: 0, saturday: 0, sundayHoliday: 7, total: 7 })
    expect(su.runs).toEqual({ weekday: false, saturday: false, sundayHoliday: true })
    expect(su.runningDates).toEqual(['20261101', '20261103', '20261108', '20261115', '20261122', '20261123', '20261129'])

    const sa = by.get('SA')!
    expect(sa.runningDates).toEqual(['20261107', '20261114', '20261121', '20261128'])

    const we = by.get('WE')!
    expect(we.runningDays.weekday).toBe(4)
    expect(we.levels.weekday).toBe('partial')
    expect(we.basis).toBe('partial')

    const sp = by.get('SP')!
    expect(sp.basis).toBe('special')
    expect(sp.levels.weekday).toBe('rare')
    expect(sp.runningDates).toEqual(['20261105'])
    expect(sp.nearThreshold).toEqual([])
  })

  it('祝日一覧が無ければ、日曜だけを日祝として数える', () => {
    const f = computeServiceFeatures(novemberFeed(), null)
    expect(f.holidays).toBe('missing')
    expect(f.daysInPeriod).toEqual({ weekday: 21, saturday: 4, sundayHoliday: 5 })
    const su = f.services.find((s) => s.serviceId === 'SU')!
    expect(su.runningDays).toEqual({ weekday: 2, saturday: 0, sundayHoliday: 5, total: 7 })
    expect(su.levels.weekday).toBe('rare')
    expect(su.basis).toBe('regular')
    // 0.095 は 0.15 から 0.055 離れているので境目に近くない
    expect(su.nearThreshold).toEqual([])
    const wk = f.services.find((s) => s.serviceId === 'WK')!
    expect(wk.runningDays.weekday).toBe(19)
    expect(wk.levels.weekday).toBe('regular')
  })

  it('系統・行き先・時刻を数える(24 時を超える時刻、空の行き先、時が 1 桁の時刻)', () => {
    const f = computeServiceFeatures(novemberFeed(), HOLIDAYS)
    const wk = f.services.find((s) => s.serviceId === 'WK')!
    expect(wk.tripCount).toBe(5)
    expect(wk.routeCount).toBe(3)
    expect(wk.routes).toEqual([
      { routeId: 'R1', name: '1', trips: 2 },
      { routeId: 'R2', name: '長い名前', trips: 2 },
      { routeId: 'R3', name: 'R3', trips: 1 },
    ])
    expect(wk.routeIds).toEqual(['R1', 'R2', 'R3'])
    expect(wk.headsigns).toEqual(['駅前', '病院'])
    expect(wk.firstDeparture).toBe('06:05')
    expect(wk.lastArrival).toBe('25:10')
    const sp = f.services.find((s) => s.serviceId === 'SP')!
    expect(sp.headsigns).toEqual([])
    expect(sp.firstDeparture).toBeNull()
    expect(sp.lastArrival).toBeNull()
  })

  it('有効期間を決められないフィードでは、運行日がすべて 0 になる', () => {
    const feed = feedFrom({
      trips: `route_id,service_id,trip_id
R1,X,T1`,
    })
    const f = computeServiceFeatures(feed, HOLIDAYS)
    expect(f.validity).toEqual({ start: '', end: '' })
    expect(f.services[0].basis).toBe('noDays')
    expect(f.services[0].runningDates).toEqual([])
  })

  it('境目に近い網羅率を印にする', () => {
    expect(svc('X', { weekday: 66 }).nearThreshold).toEqual(['weekday'])
    expect(svc('X', { weekday: 76 }).nearThreshold).toEqual([])
    expect(svc('X', { weekday: 75 }).nearThreshold).toEqual(['weekday'])
    expect(svc('X', { sundayHoliday: 3 }).nearThreshold).toEqual(['sundayHoliday'])
  })
})

describe('routeOverlap', () => {
  it('A の系統のうち B にもあるものの割合', () => {
    const a = svc('A', { weekday: 90 }, { routes: ['1', '2', '3', '4'] })
    const b = svc('B', { saturday: 19 }, { routes: ['1', '2', '9'] })
    expect(routeOverlap(a, b)).toBe(0.5)
    expect(routeOverlap(b, a)).toBeCloseTo(2 / 3)
    expect(routeOverlap(svc('E', { weekday: 1 }, { routes: [] }), a)).toBe(0)
  })
})
