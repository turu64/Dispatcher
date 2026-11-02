import { describe, expect, it } from 'vitest'
import { formatDateJa, fromInputDate, todayInJapan, toInputDate, WEEKDAY_LABELS } from './dates'

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
