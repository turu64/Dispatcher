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

/** 日付の数字(月内の何日か)でセルを探す。セルには日付の数字だけが入る */
function cell(container: HTMLElement, day: number): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]'))
  const found = buttons.find((b) => b.textContent === String(day))
  if (!found) throw new Error(`${day} 日のセルが見つかりません`)
  return found
}

describe('日付の種類', () => {
  it('祝日と重なる土曜・日曜は祝日(赤)にする', () => {
    const overlap: HolidayList = { ...holidays, names: new Map([['20261107', '仮の祝日'], ['20261108', '仮の祝日']]) }
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={overlap} />)
    expect(cell(container, 7).dataset.kind).toBe('holiday')
    expect(cell(container, 7).className).toContain('text-red-700')
    expect(cell(container, 7).getAttribute('aria-label')).toBe('2026年11月7日 土曜日、祝日 仮の祝日')
    expect(cell(container, 8).dataset.kind).toBe('holiday')
  })
})

describe('HolidayCalendar', () => {
  it('祝日のセルは赤(data-kind=holiday)で、祝日名が title と読み上げの名前に入る', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const button = cell(container, 3)
    expect(button.dataset.kind).toBe('holiday')
    expect(button.title).toBe('文化の日')
    expect(button.className).toContain('text-red-700')
    expect(button.getAttribute('aria-label')).toBe('2026年11月3日 火曜日、祝日 文化の日')
  })

  it('土曜は青、日曜は赤で、読み上げの名前に「土曜」「日曜」が入る。平日は色も種類の語も付かない', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const sat = cell(container, 7)
    expect(sat.dataset.kind).toBe('saturday')
    expect(sat.className).toContain('text-blue-700')
    expect(sat.getAttribute('aria-label')).toBe('2026年11月7日 土曜日、土曜')
    const sun = cell(container, 8)
    expect(sun.dataset.kind).toBe('sunday')
    expect(sun.className).toContain('text-red-700')
    expect(sun.getAttribute('aria-label')).toBe('2026年11月8日 日曜日、日曜')
    const weekday = cell(container, 5)
    expect(weekday.dataset.kind).toBe('weekday')
    expect(weekday.getAttribute('aria-label')).toBe('2026年11月5日 木曜日')
    expect(weekday.title).toBe('')
    expect(weekday.className).not.toContain('text-red-700')
    expect(weekday.className).not.toContain('text-blue-700')
  })

  it('セルに「祝」「土」「日」の文字は出さない(日付の数字だけ)', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const cells = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]'))
    expect(cells.length).toBe(30)
    for (const b of cells) expect(b.textContent).toMatch(/^\d+$/)
    expect(container.querySelector('[data-testid^="mark-"]')).toBeNull()
  })

  it('選んだ日は赤・青の文字色を使わない(主色の上の文字色で読ませる)', () => {
    const { container, rerender } = render(<HolidayCalendar value="20261103" onChange={() => {}} holidays={holidays} />)
    expect(cell(container, 3).dataset.kind).toBe('holiday')
    expect(cell(container, 3).className).not.toContain('text-red-700')
    expect(cell(container, 3).className).toContain('data-[selected-single=true]:text-primary-foreground')
    rerender(<HolidayCalendar value="20261107" onChange={() => {}} holidays={holidays} />)
    expect(cell(container, 7).className).not.toContain('text-blue-700')
    expect(cell(container, 3).className).toContain('text-red-700')
  })

  it('曜日の列は、日曜(左端)が赤、土曜(右端)が青', () => {
    const { container } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
    const heads = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    expect(heads[0]).toBe('日')
    expect(heads[6]).toBe('土')
    expect(container.querySelector('th')?.className).toContain('first:text-red-700')
    expect(container.querySelector('th')?.className).toContain('last:text-blue-700')
  })

it('min・max の外の日は選べず(disabled)、中の日は選べる', () => {
    const onChange = vi.fn()
    const { container } = render(
      <HolidayCalendar value="20261104" onChange={onChange} min="20261102" max="20261120" holidays={holidays} />,
    )
    // 1日(日)は min の前、23日(月)は max の後
    expect(cell(container, 1).disabled).toBe(true)
    expect(cell(container, 23).disabled).toBe(true)
    expect(cell(container, 2).disabled).toBe(false)
    expect(cell(container, 20).disabled).toBe(false)
    expect(cell(container, 21).disabled).toBe(true)
    fireEvent.click(cell(container, 23))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(cell(container, 10))
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
    expect(cell(container, 8).dataset.kind).toBe('sunday')
    expect(cell(container, 3).dataset.kind).toBe('weekday')
    expect(cell(container, 3).title).toBe('')
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
