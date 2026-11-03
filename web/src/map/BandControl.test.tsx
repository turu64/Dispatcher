// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import type { HolidayList } from '@/gtfs/holidays'
import type { ServiceDay } from '@/lib/serviceDay'
import BandControl, { type BandControlProps } from './BandControl'

// Radix の Popover(Popper)は ResizeObserver を使う。jsdom には無いので、何もしない偽物を置く
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
})

afterEach(cleanup)

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

function props(over: Partial<BandControlProps> = {}): BandControlProps {
  return {
    period: { start: '20261001', end: '20261130' },
    comparing: false,
    date: '20261104',
    day: WEDNESDAY,
    holidays: HOLIDAYS,
    stepHours: 3,
    bands: makeBands(3),
    selectedHour: 10,
    onDate: vi.fn(() => null as string | null),
    onStepHours: vi.fn(),
    onSelect: vi.fn(),
    ...over,
  }
}

function bandRadios(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: '地図に出す時間帯' })).getAllByRole('radio')
}

/** 日付のボタンを押してカレンダーを開き、Popover の中身を返す */
function openCalendar(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^比較する日付/ }))
  return screen.getByRole('dialog', { name: '比較する日付を選ぶ' })
}

function dayCell(root: HTMLElement, n: number): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.firstChild?.textContent === String(n))!
}

describe('BandControl(地図の操作盤)の地図に出す時間帯', () => {
  it('3時間ごとの6つの帯を出し、選んだ時刻を含む帯だけを押された状態にする', () => {
    render(<BandControl {...props()} />)
    const radios = bandRadios()
    expect(radios.map((r) => r.textContent)).toEqual(['6〜9時', '9〜12時', '12〜15時', '15〜18時', '18〜21時', '21〜24時'])
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent)).toEqual(['9〜12時'])
  })

  it('1時間ごとは 18 の帯', () => {
    render(<BandControl {...props({ bands: makeBands(1), stepHours: 1 })} />)
    const radios = bandRadios()
    expect(radios).toHaveLength(18)
    expect(radios.find((r) => r.getAttribute('aria-checked') === 'true')?.textContent).toBe('10〜11時')
  })

  it('選ばれている帯は主色で塗る(うっすらした灰色だけでは見分けにくい)', () => {
    render(<BandControl {...props()} />)
    const on = bandRadios().find((r) => r.getAttribute('aria-checked') === 'true')!
    expect(on.className).toContain('data-[state=on]:bg-primary')
    expect(on.className).toContain('data-[state=on]:text-primary-foreground')
  })

  it('帯を押すと、その帯の開始時刻を渡す。選んでいる帯をもう一度押しても何も渡さない', () => {
    const p = props()
    render(<BandControl {...p} />)
    fireEvent.click(screen.getByRole('radio', { name: '18〜21時' }))
    expect(p.onSelect).toHaveBeenCalledWith(18)
    vi.mocked(p.onSelect).mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '9〜12時' }))
    expect(p.onSelect).not.toHaveBeenCalled()
  })

  it('地図の上の下の端の中央に重ね、中身は折り返す', () => {
    render(<BandControl {...props()} />)
    const region = screen.getByRole('region', { name: '地図の操作盤' })
    expect(region.className).toContain('absolute')
    expect(region.className).toContain('bottom-9')
    expect(region.className).toContain('left-1/2')
    expect(region.className).toContain('max-w-[calc(100%-1.5rem)]')
    expect(screen.getByRole('radiogroup', { name: '地図に出す時間帯' }).className).toContain('flex-wrap')
  })

  it('項目名は折り返さない(狭い地図で1文字ずつ縦に並ばないように)', () => {
    render(<BandControl {...props()} />)
    for (const id of ['map-date-label', 'map-step-label', 'map-band-label']) {
      expect(document.getElementById(id)?.className).toContain('whitespace-nowrap')
    }
  })
})

describe('BandControl の比較する日付と時間帯の幅', () => {
  it('比較する日付・時間帯の幅・地図に出す時間帯を1つの盤に出す', () => {
    render(<BandControl {...props()} />)
    const region = screen.getByRole('region', { name: '地図の操作盤' })
    const dateButton = within(region).getByRole('button', { name: /^比較する日付/ })
    expect(dateButton.getAttribute('aria-haspopup')).toBe('dialog')
    expect(dateButton.textContent).toContain('11月4日(水)')
    expect(within(region).getByRole('radiogroup', { name: '時間帯の幅' })).toBeTruthy()
    expect(within(region).getByRole('radiogroup', { name: '地図に出す時間帯' })).toBeTruthy()
    // カレンダーは閉じている
    expect(screen.queryByTestId('selected-date')).toBeNull()
  })

  it('日付のボタンの読み上げの名前には、年を含む日付を入れる', () => {
    render(<BandControl {...props()} />)
    expect(screen.getByRole('button', { name: /^比較する日付/ }).textContent).toContain('2026年11月4日(水)')
  })

  it('日付のボタンを押すとカレンダーが開き、運行期間と運行日の説明(走る service_id)を出す', () => {
    render(<BandControl {...props()} />)
    const dialog = openCalendar()
    expect(within(dialog).getByTestId('selected-date').textContent).toBe('11月4日(水)')
    expect(within(dialog).getByText('運行期間:2026年10月1日(木)〜2026年11月30日(月)')).toBeTruthy()
    expect(within(dialog).getByText('01')).toBeTruthy()
    expect(within(dialog).getByText(/calendar_dates\.txt による変更はありません/)).toBeTruthy()
    expect(within(dialog).getByText(/到達圏の表・便を平日に戻す判断材料・AI による影響の要約も計算し直します/)).toBeTruthy()
    // 祝日は赤で、読み上げの名前に祝日と書く(HolidayCalendar をそのまま使う)
    const holiday = dayCell(dialog, 3)
    expect(holiday.dataset.kind).toBe('holiday')
    expect(holiday.getAttribute('aria-label')).toContain('祝日 文化の日')
  })

  it('カレンダーは入る高さまでに縮め、中をスクロールできる(低い窓で月の見出しが画面の外に出ないように)', () => {
    render(<BandControl {...props()} />)
    const dialog = openCalendar()
    expect(dialog.className).toContain('max-h-(--radix-popover-content-available-height)')
    expect(dialog.className).toContain('overflow-y-auto')
  })

  it('減便後の GTFS と比べているときは、選べる範囲が減便後の GTFS の運行期間だと書く', () => {
    render(<BandControl {...props({ comparing: true, period: { start: '20261101', end: '20261130' } })} />)
    const dialog = openCalendar()
    expect(within(dialog).getByText('選べるのは減便後の GTFS の運行期間(2026年11月1日(日)〜2026年11月30日(月))です。')).toBeTruthy()
  })

  it('日を選ぶと、その日を GTFS の日付(YYYYMMDD)で渡す。カレンダーは閉じない', () => {
    const p = props()
    render(<BandControl {...p} />)
    const dialog = openCalendar()
    fireEvent.click(dayCell(dialog, 10))
    expect(p.onDate).toHaveBeenCalledWith('20261110')
    expect(screen.getByRole('dialog', { name: '比較する日付を選ぶ' })).toBeTruthy()
  })

  it('範囲の外の日は選べない', () => {
    const p = props({ period: { start: '20261103', end: '20261120' } })
    render(<BandControl {...p} />)
    const dialog = openCalendar()
    expect(dayCell(dialog, 2).disabled).toBe(true)
    expect(dayCell(dialog, 21).disabled).toBe(true)
    fireEvent.click(dayCell(dialog, 21))
    expect(p.onDate).not.toHaveBeenCalled()
  })

  it('選べない日だと返された理由を、カレンダーの下に出す', () => {
    render(<BandControl {...props({ onDate: () => '運行期間の中の日付を選んでください。' })} />)
    const dialog = openCalendar()
    fireEvent.click(dayCell(dialog, 10))
    expect(within(dialog).getByText('運行期間の中の日付を選んでください。')).toBeTruthy()
  })

  it('時間帯の幅を切り替えると setStepHours に渡す', () => {
    const p = props()
    render(<BandControl {...p} />)
    const step = screen.getByRole('radiogroup', { name: '時間帯の幅' })
    expect(within(step).getByRole('radio', { name: '3時間ごと' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(step).getByRole('radio', { name: '1時間ごと' }))
    expect(p.onStepHours).toHaveBeenCalledWith(1)
  })

  it('計算の結果がまだ無い(bands が null)ときも、日付と時間帯の幅は変えられる。地図に出す時間帯は出さない', () => {
    const p = props({ bands: null })
    render(<BandControl {...p} />)
    expect(screen.getByRole('region', { name: '地図の操作盤' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: '地図に出す時間帯' })).toBeNull()
    expect(screen.getByRole('radiogroup', { name: '時間帯の幅' })).toBeTruthy()
    const dialog = openCalendar()
    fireEvent.click(dayCell(dialog, 10))
    expect(p.onDate).toHaveBeenCalledWith('20261110')
  })

  it('運行日が無いときは、日付のボタンの代わりに注意を出す', () => {
    render(<BandControl {...props({ period: null, date: null, day: null, bands: null })} />)
    const region = screen.getByRole('region', { name: '地図の操作盤' })
    expect(within(region).getByRole('alert').textContent).toBe(
      'この GTFS には運行日がありません。calendar.txt・calendar_dates.txt を確かめてください。',
    )
    expect(within(region).queryByRole('button', { name: /^比較する日付/ })).toBeNull()
  })

  it('減便後の GTFS に運行日が無いときは、減便の期間を確かめるよう出す', () => {
    render(<BandControl {...props({ comparing: true, period: null, date: null, day: null })} />)
    expect(screen.getByRole('alert').textContent).toBe('減便後の GTFS に運行日がありません。減便の期間を確かめてください。')
  })
})
