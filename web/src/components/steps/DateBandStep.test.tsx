// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HolidayList } from '@/gtfs/holidays'
import type { ServiceDay } from '@/lib/serviceDay'
import { DateBandPanel, ServiceDayInfo } from './DateBandStep'

afterEach(cleanup)

function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|')
}

describe('ServiceDayInfo', () => {
  it('平日:日付と曜日、走る service_id、calendar_dates.txt による変更が無いこと', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261104', weekday: 2, serviceIds: ['01'], calendarServiceIds: ['01'], added: [], removed: [], exceptionApplied: false }}
        />,
      ),
    )
    expect(text).toContain('2026年11月4日(水)')
    expect(text).toContain('走る service_id:|01')
    expect(text).toContain('calendar_dates.txt による変更はありません')
  })

  it('祝日:calendar_dates.txt が効いていることと、追加・運休の service_id', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261103', weekday: 1, serviceIds: ['06'], calendarServiceIds: ['01'], added: ['06'], removed: ['01'], exceptionApplied: true }}
        />,
      ),
    )
    expect(text).toContain('2026年11月3日(火)')
    expect(text).toContain('calendar_dates.txt が効いています')
    expect(text).toContain('追加:|06|。運休:|01|。')
  })

  it('走る便が無い日', () => {
    const text = textOf(
      renderToString(
        <ServiceDayInfo
          day={{ date: '20261201', weekday: 1, serviceIds: [], calendarServiceIds: [], added: [], removed: [], exceptionApplied: false }}
        />,
      ),
    )
    expect(text).toContain('この日に走る便はありません')
  })
})

const HOLIDAYS: HolidayList = {
  names: new Map([['20261103', '文化の日']]),
  first: '19550101',
  coveredUntil: '20271231',
  source: 'test',
}

const WEDNESDAY: ServiceDay = {
  date: '20261104',
  weekday: 2,
  serviceIds: ['01'],
  calendarServiceIds: ['01'],
  added: [],
  removed: [],
  exceptionApplied: false,
}

function panel(over: Partial<Parameters<typeof DateBandPanel>[0]> = {}) {
  const props = {
    period: { start: '20261001', end: '20261130' },
    comparing: false,
    date: '20261104',
    day: WEDNESDAY,
    holidays: HOLIDAYS,
    stepHours: 3 as const,
    onDate: vi.fn(() => null as string | null),
    onStepHours: vi.fn(),
    ...over,
  }
  return { props, ...render(<DateBandPanel {...props} />) }
}

describe('DateBandPanel(影響(到達圏)の手順の上部)', () => {
  it('比べる日は HolidayCalendar で選び、祝日は赤で出し、読み上げの名前に祝日と書く', () => {
    const { container } = panel({ date: '20261104' })
    const holiday = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.textContent === '3')
    expect(holiday?.dataset.kind).toBe('holiday')
    expect(holiday?.className).toContain('text-red-700')
    expect(holiday?.getAttribute('aria-label')).toContain('祝日')
    expect(screen.getByTestId('selected-date').textContent).toBe('11月4日(水)')
  })

  it('日を選ぶと、その日を GTFS の日付(YYYYMMDD)で渡す', () => {
    const { container, props } = panel()
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.firstChild?.textContent === '10')!
    fireEvent.click(button)
    expect(props.onDate).toHaveBeenCalledWith('20261110')
  })

  it('運行期間の外の日は選べない(クリックしても渡さない)', () => {
    const { container, props } = panel({ period: { start: '20261103', end: '20261120' }, date: '20261104' })
    const cellOf = (n: number) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.firstChild?.textContent === String(n))!
    expect(cellOf(2).disabled).toBe(true)
    expect(cellOf(3).disabled).toBe(false)
    expect(cellOf(21).disabled).toBe(true)
    fireEvent.click(cellOf(21))
    expect(props.onDate).not.toHaveBeenCalled()
    const prev = screen.getByRole('button', { name: '前の月へ' }) as HTMLButtonElement
    expect(prev.disabled || prev.getAttribute('aria-disabled') === 'true').toBe(true)
  })

  it('選べない日だと store が返した理由を出す', () => {
    const { container } = panel({ onDate: () => '運行期間の中の日付を選んでください。' })
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.firstChild?.textContent === '10')!
    fireEvent.click(button)
    expect(screen.getByText('運行期間の中の日付を選んでください。')).toBeTruthy()
  })

  it('範囲の説明:ふだんは運行期間、減便後と比べているときは出力の有効期間', () => {
    const plain = textOf(renderToString(<DateBandPanel {...panelProps()} />))
    expect(plain).toContain('運行期間:2026年10月1日(木)〜2026年11月30日(月)')
    const compare = textOf(renderToString(<DateBandPanel {...panelProps({ comparing: true, period: { start: '20261101', end: '20261130' } })} />))
    expect(compare).toContain('比べられるのは出力の有効期間(2026年11月1日(日)〜2026年11月30日(月))です')
  })

  it('計算し直すことと、地図の上の切り替えとの違いを添える', () => {
    panel()
    expect(screen.getByText(/表・足し戻しの手がかり・AI の影響の要約も計算し直します/)).toBeTruthy()
    expect(screen.getByText(/地図に出す時間帯は、地図の上のボタンで切り替えます/)).toBeTruthy()
  })

  it('時間帯の幅(3時間/1時間)を切り替える。表示する時間帯のボタンはここに無い', () => {
    const { props } = panel()
    expect(screen.getByRole('radio', { name: '3時間ごと' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: '1時間ごと' }))
    expect(props.onStepHours).toHaveBeenCalledWith(1)
    expect(screen.queryByRole('radio', { name: '9〜12時' })).toBeNull()
  })

  it('選んだ日のダイヤ(走る service_id)を出す', () => {
    panel()
    expect(screen.getByText('01')).toBeTruthy()
  })

  it('運行日が無いときは理由を出し、カレンダーは出さない', () => {
    panel({ period: null, date: null, day: null })
    expect(screen.getByText(/運行日がありません/)).toBeTruthy()
    expect(screen.queryByTestId('selected-date')).toBeNull()
  })

  it('祝日一覧が無いときも日付は選べる(カレンダーが祝日を出せない旨を添える)', () => {
    panel({ holidays: null })
    expect(screen.getByText(/祝日一覧を読めないため/)).toBeTruthy()
  })
})

function panelProps(over: Partial<Parameters<typeof DateBandPanel>[0]> = {}): Parameters<typeof DateBandPanel>[0] {
  return {
    period: { start: '20261001', end: '20261130' },
    comparing: false,
    date: '20261104',
    day: WEDNESDAY,
    holidays: HOLIDAYS,
    stepHours: 3,
    onDate: () => null,
    onStepHours: () => {},
    ...over,
  }
}
