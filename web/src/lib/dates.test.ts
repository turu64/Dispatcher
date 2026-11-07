import { describe, expect, it } from 'vitest'
import { appNow, appToday, fixedTodayFrom, formatDateJa, fromInputDate, todayInJapan, toInputDate, WEEKDAY_LABELS } from './dates'

describe('toInputDate', () => {
  it('YYYYMMDD を YYYY-MM-DD にする', () => {
    expect(toInputDate('20261104')).toBe('2026-11-04')
    expect(toInputDate('20240229')).toBe('2024-02-29')
  })

  it('不正な日付は空文字にする', () => {
    expect(toInputDate('20261131')).toBe('')
    expect(toInputDate('2026-11-04')).toBe('')
    expect(toInputDate('')).toBe('')
  })
})

describe('fromInputDate', () => {
  it('YYYY-MM-DD を YYYYMMDD にする', () => {
    expect(fromInputDate('2026-11-04')).toBe('20261104')
  })

  it('空・形の違う値・実在しない日付は null', () => {
    expect(fromInputDate('')).toBeNull()
    expect(fromInputDate('20261104')).toBeNull()
    expect(fromInputDate('2026-11-4')).toBeNull()
    expect(fromInputDate('2026-02-29')).toBeNull()
    expect(fromInputDate(' 2026-11-04')).toBeNull()
  })

  it('toInputDate と往復する', () => {
    for (const d of ['20000101', '20261231', '20280229', '99991231']) expect(fromInputDate(toInputDate(d))).toBe(d)
  })
})

describe('todayInJapan', () => {
  it('日本時間の日付を返す(UTC の 15時で日付が変わる)', () => {
    expect(todayInJapan(new Date(Date.UTC(2026, 10, 2, 14, 59, 59)))).toBe('20261102')
    expect(todayInJapan(new Date(Date.UTC(2026, 10, 2, 15, 0, 0)))).toBe('20261103')
  })

  it('年末をまたぐ', () => {
    expect(todayInJapan(new Date(Date.UTC(2026, 11, 31, 15, 0, 0)))).toBe('20270101')
  })
})

describe('formatDateJa', () => {
  it('年月日と曜日を出す', () => {
    expect(formatDateJa('20261104')).toBe('2026年11月4日(水)')
    expect(formatDateJa('20261103')).toBe('2026年11月3日(火)')
    expect(formatDateJa('20261108')).toBe('2026年11月8日(日)')
  })

  it('不正な日付はそのまま返す', () => {
    expect(formatDateJa('2026')).toBe('2026')
  })

  it('曜日は月曜から7つ', () => {
    expect(WEEKDAY_LABELS).toEqual(['月', '火', '水', '木', '金', '土', '日'])
  })
})

describe('fixedTodayFrom(デモの ?today=)', () => {
  it('?today=YYYY-MM-DD を YYYYMMDD にする', () => {
    expect(fixedTodayFrom('?today=2026-10-25')).toBe('20261025')
    expect(fixedTodayFrom('?foo=1&today=2026-10-25')).toBe('20261025')
    expect(fixedTodayFrom('today=2026-10-25')).toBe('20261025')
  })

  it('渡していない・形が違う・実在しない日付は無視する(null)', () => {
    expect(fixedTodayFrom('')).toBeNull()
    expect(fixedTodayFrom('?foo=1')).toBeNull()
    expect(fixedTodayFrom('?today=')).toBeNull()
    expect(fixedTodayFrom('?today=20261025')).toBeNull()
    expect(fixedTodayFrom('?today=2026-13-01')).toBeNull()
    expect(fixedTodayFrom('?today=2026-02-29')).toBeNull()
    expect(fixedTodayFrom('?today=abc')).toBeNull()
  })
})

describe('appToday・appNow', () => {
  it('固定していなければ今日(日本時間)', () => {
    expect(appToday('')).toBe(todayInJapan(new Date()))
    expect(appToday('?today=bad')).toBe(todayInJapan(new Date()))
  })

  it('固定しているときは、その日を今日にする', () => {
    expect(appToday('?today=2026-10-25')).toBe('20261025')
    expect(formatDateJa(appToday('?today=2026-10-25'))).toBe('2026年10月25日(日)')
  })

  it('appNow は固定していなければ渡した時刻のまま', () => {
    const real = new Date('2026-11-06T08:30:00Z')
    expect(appNow('', real)).toBe(real)
  })

  it('appNow は固定した日の、今の時刻(日本時間)にする', () => {
    // 日本時間 2026-11-06 13:45:12 → 2026-10-25 13:45:12
    const real = new Date('2026-11-06T04:45:12Z')
    const now = appNow('?today=2026-10-25', real)
    expect(now.toISOString()).toBe('2026-10-25T04:45:12.000Z')
    expect(todayInJapan(now)).toBe('20261025')
    // 日本時間で日付が変わった直後(UTC では前日)も、固定した日のまま
    const lateNight = new Date('2026-11-06T15:10:00Z') // 日本時間 11/7 0:10
    expect(todayInJapan(appNow('?today=2026-10-25', lateNight))).toBe('20261025')
    expect(appNow('?today=2026-10-25', lateNight).toISOString()).toBe('2026-10-24T15:10:00.000Z')
  })
})
