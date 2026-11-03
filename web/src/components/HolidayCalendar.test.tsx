// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HolidayList } from '@/gtfs/holidays'
import HolidayCalendar from './HolidayCalendar'

afterEach(cleanup)

// 2026年11月:3日(火)=文化の日、7日(土)、8日(日)、23日(月)=勤労感謝の日。1日(日)は祝日ではない
const holidays: HolidayList = {
  names: new Map([
    ['20261103', '文化の日'],
    ['20261123', '勤労感謝の日'],
  ]),
  first: '19550101',
  coveredUntil: '20271231',
  source: 'test',
}

function cell(container: HTMLElement, date: string): HTMLButtonElement {
  // 祝日・土曜・日曜のセルは、印(祝・土・日)の span の testid で探す
  const button = container.querySelector(`[data-testid="mark-${date}"]`)?.closest('button')
  if (!button) throw new Error(`${date} の印つきのセルが見つかりません`)
  return button
}

/** 日付の数字(月内の何日か)でセルを探す(印の有無によらない) */
function plainCell(container: HTMLElement, day: number): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]'))
  const found = buttons.find((b) => b.firstChild?.textContent === String(day))
  if (!found) throw new Error(`${day} 日のセルが見つかりません`)
  return found
}

describe('日付の種類', () => {
  it('祝日と重なる土曜・日曜は祝日(赤、「祝」)にする', () => {
    const overlap: HolidayList = { ...holidays, names: new Map([['20261107', '仮の祝日'], ['20261108', '仮の祝日']]) }
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={overlap} />)
    expect(cell(container, '20261107').dataset.kind).toBe('holiday')
    expect(cell(container, '20261107').textContent).toContain('祝')
    expect(cell(container, '20261108').dataset.kind).toBe('holiday')
  })
})

describe('HolidayCalendar', () => {
  it('祝日のセルは赤の印(data-kind=holiday と赤の色)と「祝」の文字、祝日名の title が付く', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const button = cell(container, '20261103')
    expect(button.dataset.kind).toBe('holiday')
    expect(button.title).toBe('文化の日')
    expect(button.className).toContain('text-red-700')
    expect(button.textContent).toContain('祝')
    expect(button.getAttribute('aria-label')).toContain('文化の日')
  })

  it('土曜は青と「土」、日曜は赤と「日」。平日には印が無い', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const sat = cell(container, '20261107')
    expect(sat.dataset.kind).toBe('saturday')
    expect(sat.className).toContain('text-blue-700')
    expect(sat.textContent).toContain('土')
    const sun = cell(container, '20261108')
    expect(sun.dataset.kind).toBe('sunday')
    expect(sun.className).toContain('text-red-700')
    expect(sun.textContent).toContain('日')
    const weekday = plainCell(container, 4)
    expect(weekday.dataset.kind).toBe('weekday')
    expect(weekday.textContent).toBe('4')
    expect(weekday.className).not.toContain('text-red-700')
    expect(weekday.className).not.toContain('text-blue-700')
  })

  it('min・max の外の日は選べず(disabled)、中の日は選べる', () => {
    const onChange = vi.fn()
    const { container } = render(
      <HolidayCalendar value="20261104" onChange={onChange} min="20261102" max="20261120" holidays={holidays} />,
    )
    // 1日(日)は min の前、23日(月)は max の後
    expect(plainCell(container, 1).disabled).toBe(true)
    expect(cell(container, '20261123').disabled).toBe(true)
    expect(plainCell(container, 2).disabled).toBe(false)
    expect(plainCell(container, 20).disabled).toBe(false)
    expect(plainCell(container, 21).disabled).toBe(true)
    fireEvent.click(cell(container, '20261123'))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(plainCell(container, 10))
    expect(onChange).toHaveBeenCalledWith('20261110')
  })

  it('選んだ日の下に「11月3日(火・文化の日)」のように出る', () => {
    render(<HolidayCalendar value="20261103" onChange={() => {}} holidays={holidays} />)
    expect(screen.getByTestId('selected-date').textContent).toBe('11月3日(火・文化の日)')
  })

  it('祝日でない日は祝日名なしで出る。選んでいないときは案内を出す', () => {
    const { rerender } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    expect(screen.getByTestId('selected-date').textContent).toBe('11月4日(水)')
    rerender(<HolidayCalendar value={null} onChange={() => {}} min="20261102" holidays={holidays} />)
    expect(screen.getByTestId('selected-date').textContent).toBe('日付を選んでください')
  })

  it('祝日一覧が null のときは祝日の印を出さず、その旨を添える', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={null} />)
    expect(cell(container, '20261108').dataset.kind).toBe('sunday')
    expect(plainCell(container, 3).dataset.kind).toBe('weekday')
    expect(plainCell(container, 3).title).toBe('')
    expect(screen.getByText(/祝日一覧を読めないため/)).toBeTruthy()
    cleanup()
    render(<HolidayCalendar value="20261103" onChange={() => {}} holidays={null} />)
    expect(screen.getByTestId('selected-date').textContent).toBe('11月3日(火)')
  })

  it('範囲を決めると、範囲の外の月へは移れない(前へ・次への案内は日本語)', () => {
    render(<HolidayCalendar value="20261104" onChange={() => {}} min="20261102" max="20261120" holidays={holidays} />)
    const prev = screen.getByRole('button', { name: '前の月へ' }) as HTMLButtonElement
    const next = screen.getByRole('button', { name: '次の月へ' }) as HTMLButtonElement
    expect(prev.disabled || prev.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(next.disabled || next.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(screen.getByText('2026年11月')).toBeTruthy()
  })
})
