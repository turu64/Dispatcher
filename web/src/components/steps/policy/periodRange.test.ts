import { describe, expect, it } from 'vitest'
import { nextPeriod, nextPeriodFor, periodDays } from './periodRange'

describe('nextPeriod', () => {
  it('1回目に押した日が開始日、2回目に押した日が終了日', () => {
    const first = nextPeriod({ start: '', end: '', indefinite: false }, '20261109')
    expect(first).toEqual({ start: '20261109', end: '' })
    expect(nextPeriod({ ...first, indefinite: false }, '20261130')).toEqual({ start: '20261109', end: '20261130' })
  })

  it('開始日より前を押すと、それを新しい開始日にする。開始日と同じ日は終了日になる', () => {
    expect(nextPeriod({ start: '20261109', end: '', indefinite: false }, '20261105')).toEqual({ start: '20261105', end: '' })
    expect(nextPeriod({ start: '20261109', end: '', indefinite: false }, '20261109')).toEqual({ start: '20261109', end: '20261109' })
  })

  it('開始日と終了日が決まっていれば、押した日から選び直す', () => {
    expect(nextPeriod({ start: '20261109', end: '20261130', indefinite: false }, '20261115')).toEqual({ start: '20261115', end: '' })
  })

  it('当面の間なら、押した日を開始日にする(終了日はそのまま。使わない)', () => {
    expect(nextPeriod({ start: '20261109', end: '20261130', indefinite: true }, '20261102')).toEqual({ start: '20261102', end: '20261130' })
    expect(nextPeriod({ start: '20261109', end: '', indefinite: true }, '20261120')).toEqual({ start: '20261120', end: '' })
  })
})

describe('nextPeriodFor', () => {
  it('開始日の穴から開いたときは nextPeriod と同じ(期間が決まったあとに押すと、その日から選び直す)', () => {
    expect(nextPeriodFor({ start: '20261109', end: '20261130', indefinite: false }, '20261115', 'start')).toEqual({ start: '20261115', end: '' })
  })

  it('終了日の穴から開いたときは、開始日と同じ日か後を押すと終了日だけを変える', () => {
    expect(nextPeriodFor({ start: '20261109', end: '20261130', indefinite: false }, '20261115', 'end')).toEqual({ start: '20261109', end: '20261115' })
    expect(nextPeriodFor({ start: '20261109', end: '', indefinite: false }, '20261109', 'end')).toEqual({ start: '20261109', end: '20261109' })
  })

  it('終了日の穴からでも、開始日より前を押すと新しい開始日にし、開始日が無ければ開始日にし、当面の間なら開始日にする', () => {
    expect(nextPeriodFor({ start: '20261109', end: '20261130', indefinite: false }, '20261105', 'end')).toEqual({ start: '20261105', end: '' })
    expect(nextPeriodFor({ start: '', end: '', indefinite: false }, '20261105', 'end')).toEqual({ start: '20261105', end: '' })
    expect(nextPeriodFor({ start: '20261109', end: '', indefinite: true }, '20261120', 'end')).toEqual({ start: '20261120', end: '' })
  })
})

describe('periodDays', () => {
  it('両端を含む日数。月・年をまたいでよい', () => {
    expect(periodDays('20261109', '20261130')).toBe(22)
    expect(periodDays('20261109', '20261109')).toBe(1)
    expect(periodDays('20261225', '20270105')).toBe(12)
  })
})
