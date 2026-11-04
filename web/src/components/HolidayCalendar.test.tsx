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

/** 期間のカレンダーで、'YYYYMMDD' の日のボタンを探す(2か月を並べても、日付で1つに決まる) */
function dayButton(container: HTMLElement, date: string): HTMLButtonElement {
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  const found = container.querySelector<HTMLButtonElement>(`td[data-day="${iso}"] button`)
  if (!found) throw new Error(`${date} のセルが見つかりません`)
  return found
}

describe('HolidayCalendar(1日の選択は前のまま)', () => {
  it('mode を渡さなければ1か月だけ出し、1日を選ぶ。期間の位置の印・読み上げは付けない', () => {
    const onChange = vi.fn()
    const { container } = render(<HolidayCalendar value="20261104" onChange={onChange} holidays={holidays} />)
    expect(container.querySelectorAll('[role="grid"]')).toHaveLength(1)
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-multiselectable')).toBe('false')
    expect(container.querySelector('[data-range-part]')).toBeNull()
    expect(cell(container, 4).getAttribute('aria-label')).toBe('2026年11月4日 水曜日')
    expect(cell(container, 4).dataset.selectedSingle).toBe('true')
    fireEvent.click(cell(container, 12))
    expect(onChange).toHaveBeenCalledWith('20261112')
  })
})

describe('HolidayCalendar(期間)', () => {
  it('開始日・終了日は濃く、間の日は帯で示し、読み上げの名前に開始日・終了日・期間の中が入る', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261102" end="20261106" onDayClick={() => {}} holidays={holidays} />,
    )
    const start = dayButton(container, '20261102')
    expect(start.dataset.rangeStart).toBe('true')
    expect(start.getAttribute('aria-label')).toBe('2026年11月2日 月曜日、開始日')
    expect(dayButton(container, '20261106').dataset.rangeEnd).toBe('true')
    expect(dayButton(container, '20261106').getAttribute('aria-label')).toBe('2026年11月6日 金曜日、終了日')
    const middle = dayButton(container, '20261104')
    expect(middle.dataset.rangeMiddle).toBe('true')
    expect(middle.className).toContain('data-[range-middle=true]:bg-(--band)')
    expect(middle.getAttribute('aria-label')).toBe('2026年11月4日 水曜日、期間の中')
    // 範囲の外の日は位置を読み上げない
    expect(dayButton(container, '20261110').getAttribute('aria-label')).toBe('2026年11月10日 火曜日')
    // 範囲の日のセル(gridcell)は選択中として読み上げる。グリッドは複数選択
    expect(container.querySelector('td[data-day="2026-11-04"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-multiselectable')).toBe('true')
  })

  it('帯の中の祝日・土日は、文字の色と読み上げの名前(祝日名)を残す。開始日・終了日は主色の上の文字色にする', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261121" end="20261129" onDayClick={() => {}} holidays={holidays} />,
    )
    const holiday = dayButton(container, '20261123')
    expect(holiday.dataset.kind).toBe('holiday')
    expect(holiday.dataset.rangeMiddle).toBe('true')
    expect(holiday.className).toContain('data-[range-middle=true]:text-red-700')
    // ダークの帯の上では対比が足りるよう -300 にする
    expect(holiday.className).toContain('dark:data-[range-middle=true]:text-red-300')
    expect(holiday.className).not.toContain('dark:data-[range-middle=true]:text-red-400')
    expect(holiday.className).not.toContain('data-[range-middle=true]:text-foreground')
    expect(holiday.title).toBe('勤労感謝の日')
    expect(holiday.getAttribute('aria-label')).toBe('2026年11月23日 月曜日、祝日 勤労感謝の日、期間の中')
    const sat = dayButton(container, '20261128')
    expect(sat.className).toContain('data-[range-middle=true]:text-blue-700')
    expect(sat.className).toContain('dark:data-[range-middle=true]:text-blue-300')
    expect(sat.getAttribute('aria-label')).toBe('2026年11月28日 土曜日、土曜、期間の中')
    // 開始日(21日・土曜)・終了日(29日・日曜)は赤・青の文字色を使わない
    expect(dayButton(container, '20261121').className).not.toContain('text-blue-700')
    expect(dayButton(container, '20261129').className).not.toContain('text-red-700')
    expect(dayButton(container, '20261129').getAttribute('aria-label')).toBe('2026年11月29日 日曜日、日曜、終了日')
  })

  it('開始日と終了日が同じ日なら、その日を開始日・終了日として示す', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261110" end="20261110" onDayClick={() => {}} holidays={holidays} />,
    )
    expect(dayButton(container, '20261110').getAttribute('aria-label')).toBe('2026年11月10日 火曜日、開始日・終了日')
    expect(container.querySelectorAll('[data-range-middle="true"]')).toHaveLength(0)
  })

  it('開始日だけのときは開始日だけを濃く示し、帯は出さない', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261110" end={null} onDayClick={() => {}} holidays={holidays} />,
    )
    expect(dayButton(container, '20261110').dataset.selectedSingle).toBe('true')
    expect(dayButton(container, '20261110').getAttribute('aria-label')).toBe('2026年11月10日 火曜日、開始日')
    expect(container.querySelectorAll('[data-range-part="middle"], [data-range-part="open"]')).toHaveLength(0)
  })

  it('当面の間(openEnd)なら終了日を使わず、開始日の翌日から max までを薄い帯で示す', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261110" end="20261112" openEnd onDayClick={() => {}} max="20261125" holidays={holidays} />,
    )
    expect(dayButton(container, '20261110').getAttribute('aria-label')).toBe('2026年11月10日 火曜日、開始日')
    // 終了日(12日)は使わない
    expect(dayButton(container, '20261112').dataset.rangeEnd).not.toBe('true')
    const open = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-range-part="open"]'))
    expect(open[0]?.textContent).toBe('11')
    expect(open.at(-1)?.textContent).toBe('25')
    expect(open).toHaveLength(15)
    expect(container.querySelector('td[data-day="2026-11-25"]')?.className).toContain('bg-(--band-open)')
    expect(container.querySelector('td[data-day="2026-11-26"]')?.className).not.toContain('bg-(--band-open)')
    // 帯の中の祝日は文字の色と祝日名を残す
    expect(dayButton(container, '20261123').className).toContain('text-red-700')
    expect(dayButton(container, '20261123').getAttribute('aria-label')).toBe('2026年11月23日 月曜日、祝日 勤労感謝の日、期間の中(当面の間)')
  })

  it('押した日を onDayClick で返す。min・max の外の日は押せない', () => {
    const onDayClick = vi.fn()
    const { container } = render(
      <HolidayCalendar mode="range" start={null} end={null} onDayClick={onDayClick} min="20261102" max="20261120" holidays={holidays} />,
    )
    expect(dayButton(container, '20261101').disabled).toBe(true)
    fireEvent.click(dayButton(container, '20261101'))
    fireEvent.click(dayButton(container, '20261121'))
    expect(onDayClick).not.toHaveBeenCalled()
    fireEvent.click(dayButton(container, '20261105'))
    expect(onDayClick).toHaveBeenLastCalledWith('20261105')
    // 選んでいる日を押しても返す(開始日と同じ日を終了日にできる)
    cleanup()
    const { container: c2 } = render(
      <HolidayCalendar mode="range" start="20261105" end={null} onDayClick={onDayClick} min="20261102" max="20261120" holidays={holidays} />,
    )
    fireEvent.click(dayButton(c2, '20261105'))
    expect(onDayClick).toHaveBeenLastCalledWith('20261105')
  })

  it('2か月を並べるときは横に並べ、最後の月が max の月を越えないように開く。選んだ日の下の文は出さない', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start="20261124" end={null} onDayClick={() => {}} min="20261001" max="20261130" holidays={holidays} numberOfMonths={2} />,
    )
    const captions = Array.from(container.querySelectorAll('[role="grid"]')).length
    expect(captions).toBe(2)
    expect(screen.getByText('2026年10月')).toBeTruthy()
    expect(screen.getByText('2026年11月')).toBeTruthy()
    expect(screen.queryByTestId('selected-date')).toBeNull()
    expect(screen.getByRole('button', { name: '次の月へ' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('有効期間が1か月に収まるときは、2か月を頼まれても1か月だけ出す(全部押せない月を並べない)', () => {
    const { container } = render(
      <HolidayCalendar mode="range" start={null} end={null} onDayClick={() => {}} min="20261102" max="20261125" holidays={holidays} numberOfMonths={2} />,
    )
    expect(container.querySelectorAll('[role="grid"]')).toHaveLength(1)
    expect(screen.getByText('2026年11月')).toBeTruthy()
    expect(screen.queryByText('2026年12月')).toBeNull()
    expect(screen.getByRole('button', { name: '前の月へ' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: '次の月へ' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('今日は、セルの背景(帯と重なる)ではなく日付の太字と下線で示す。1日の選択のカレンダーは前のまま', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T03:00:00Z') })
    try {
      const { container } = render(
        <HolidayCalendar mode="range" start="20261110" end="20261114" onDayClick={() => {}} holidays={holidays} />,
      )
      const todayCell = container.querySelector('td[data-day="2026-11-12"]')!
      expect(todayCell.hasAttribute('data-today')).toBe(true)
      expect(todayCell.className).not.toContain('bg-muted')
      const today = dayButton(container, '20261112')
      expect(today.className).toContain('font-semibold')
      expect(today.className).toContain('underline')
      expect(today.className).not.toContain('font-normal')
      // 今日でない日には付けない
      expect(dayButton(container, '20261111').className).not.toContain('underline')
      cleanup()
      const { container: single } = render(<HolidayCalendar value="20261104" onChange={() => {}} holidays={holidays} />)
      expect(single.querySelector('td[data-day="2026-11-12"]')!.className).toContain('bg-muted')
      expect(cell(single, 12).className).not.toContain('underline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('キーボード:矢印キーで日を動かし、焦点のある日のボタンを押す(click)と、その日を返す', () => {
    const onDayClick = vi.fn()
    const { container } = render(
      <HolidayCalendar mode="range" start="20261110" end={null} onDayClick={onDayClick} min="20261101" max="20261130" holidays={holidays} />,
    )
    const from = dayButton(container, '20261110')
    from.focus()
    fireEvent.focus(from)
    fireEvent.keyDown(from, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(dayButton(container, '20261111'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(dayButton(container, '20261118'))
    // 日はボタンなので、ブラウザでは Enter・スペースが click になる。jsdom はキーから click を起こさないため、焦点のあるボタンの click で確かめる
    fireEvent.click(document.activeElement!)
    expect(onDayClick).toHaveBeenLastCalledWith('20261118')
  })
})

describe('HolidayCalendar(並べる月の数が変わったとき)', () => {
  it('2か月から1か月に減って開始日の月が見えなくなったら、開始日の月を開く', () => {
    const props = { mode: 'range' as const, start: '20261125', end: null, onDayClick: () => {}, min: '20261001', max: '20261130', holidays }
    const { rerender } = render(<HolidayCalendar {...props} numberOfMonths={2} />)
    expect(screen.getByText('2026年10月')).toBeTruthy()
    rerender(<HolidayCalendar {...props} numberOfMonths={1} />)
    expect(screen.queryByText('2026年10月')).toBeNull()
    expect(screen.getByText('2026年11月')).toBeTruthy()
  })
})
