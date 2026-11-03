// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoServiceDaysMessage, ServiceDayInfo, StepPicker } from './DateBandStep'

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

describe('StepPicker(時間帯の幅)', () => {
  it('今の幅を押された状態にし、切り替えると 1 か 3 を渡す。押されている方をもう一度押しても渡さない', () => {
    const onChange = vi.fn()
    render(
      <>
        <span id="step-label">時間帯の幅</span>
        <StepPicker value={3} onChange={onChange} labelId="step-label" />
      </>,
    )
    const group = screen.getByRole('radiogroup', { name: '時間帯の幅' })
    expect(group).toBeTruthy()
    expect(screen.getByRole('radio', { name: '3時間ごと' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: '1時間ごと' }))
    expect(onChange).toHaveBeenCalledWith(1)
    onChange.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '3時間ごと' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('NoServiceDaysMessage(運行日が無いときの注意)', () => {
  it('読み込んだ GTFS と、減便後の GTFS とで、確かめる先を分けて書く(確かめる依頼は括弧に入れない)', () => {
    expect(renderToString(<NoServiceDaysMessage comparing={false} />)).toBe(
      'この GTFS には運行日がありません。calendar.txt・calendar_dates.txt を確かめてください。',
    )
    expect(renderToString(<NoServiceDaysMessage comparing />)).toBe('減便後の GTFS に運行日がありません。減便の期間を確かめてください。')
  })
})
