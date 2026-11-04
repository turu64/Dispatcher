import { describe, expect, it } from 'vitest'
import { periodDays, pickStartDate } from './periodRange'

describe('pickStartDate', () => {
  it('押した日を開始日にする。終了日と同じ日か前なら、終了日はそのまま', () => {
    expect(pickStartDate({ start: '20261109', end: '20261130', indefinite: false }, '20261115')).toEqual({ start: '20261115', end: '20261130' })
    expect(pickStartDate({ start: '20261109', end: '20261130', indefinite: false }, '20261130')).toEqual({ start: '20261130', end: '20261130' })
    expect(pickStartDate({ start: '20261109', end: '20261130', indefinite: false }, '20261102')).toEqual({ start: '20261102', end: '20261130' })
  })

  it('終了日より後を押すと、終了日を空にする', () => {
    expect(pickStartDate({ start: '20261109', end: '20261113', indefinite: false }, '20261116')).toEqual({ start: '20261116', end: '' })
  })

  it('終了日がまだ・当面の間なら、終了日はそのまま(当面の間では使わない)', () => {
    expect(pickStartDate({ start: '', end: '', indefinite: false }, '20261105')).toEqual({ start: '20261105', end: '' })
    expect(pickStartDate({ start: '20261109', end: '20261113', indefinite: true }, '20261120')).toEqual({ start: '20261120', end: '20261113' })
  })
})

describe('periodDays', () => {
  it('両端を含む日数。月・年をまたいでよい', () => {
    expect(periodDays('20261109', '20261130')).toBe(22)
    expect(periodDays('20261109', '20261109')).toBe(1)
    expect(periodDays('20261225', '20270105')).toBe(12)
  })
})
