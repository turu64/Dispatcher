// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { RouteDiff, WeekdayDiff } from '@/gtfs/edit/diff'
import type { EditOp } from '@/gtfs/edit/ops'
import { useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import PolicyStep, { Notice47Table } from './PolicyStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: 'temporaryShortage', note: '欠員 2 名' } }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PolicyStep', () => {
  it('祝日一覧が無ければ、祝日の確認をしていないと出し、読み込み直すボタンで読み直す', () => {
    const load = vi.fn(async () => {})
    useHolidayStore.setState({ load })
    render(<PolicyStep />)
    expect(screen.getByText(/祝日一覧を読めないため、祝日の確認をしていません/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '祝日一覧を読み込み直す' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('写す元の便が無い系統を、除外の表の先頭にまとめて注意を出す(除外は推定しない)', () => {
    render(<PolicyStep />)
    const boxes = screen.getAllByRole('checkbox', { name: /を入れ替えから外す/ })
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      '3(R3)を入れ替えから外す',
      '1(R1)を入れ替えから外す',
      '2(R2)を入れ替えから外す',
    ])
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByText(/入れ替えると全曜日で便がなくなります/)).toBeTruthy()
  })

  it('系統を外して確かめると、除外した系統の数と印を出す', () => {
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('checkbox', { name: '3(R3)を入れ替えから外す' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const review = screen.getByRole('region', { name: '対象便の確かめ' })
    const counts = within(review).getByLabelText('平日便の件数').textContent ?? ''
    expect(counts).toContain('除外した系統:1 系統')
    expect(counts).toContain('全曜日で便がなくなる系統:0 系統')
    // 全曜日で便がなくなる系統が無ければ、確かめのチェックなしで進める
    expect(within(review).queryByLabelText('全曜日で便がなくなる系統があることを確かめました')).toBeNull()
    expect(within(review).getByRole('button', { name: 'この内容で進める' })).toHaveProperty('disabled', false)
    expect(review.querySelector('[data-route="R3"]')?.textContent).toContain('除')
  })

  it('承認したあとは方針と理由を出し、「方針を変える」で今の方針を入れた入力に戻る', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
    })
    render(<PolicyStep />)
    const summary = screen.getByRole('region', { name: '適用した方針' })
    expect(summary.textContent).toContain('運転士の一時的な欠員(欠員 2 名)')
    fireEvent.click(within(summary).getByRole('button', { name: '方針を変える' }))
    expect(screen.getByLabelText('開始日')).toHaveProperty('value', '2026-11-01')
    expect(screen.getByLabelText('理由のメモ')).toHaveProperty('value', '欠員 2 名')
    fireEvent.click(screen.getByRole('button', { name: '変えずに戻る' }))
    expect(screen.getByRole('region', { name: '適用した方針' })).toBeTruthy()
  })

  it('Claude の下書きがあるときに方針を確かめると、捨ててよいかを先に確かめる', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => false)
    render(<PolicyStep />)
    fireEvent.click(screen.getByRole('button', { name: '方針を変える' }))
    fireEvent.click(screen.getByRole('button', { name: '対象便を確かめる' }))
    const draftId = useEditStore.getState().draft!.id
    expect(confirm).toHaveBeenCalledWith(`Claude の下書き ${draftId} を捨てて、この操作をしますか。`)
    // 「キャンセル」なら Claude の下書きは残る
    expect(useEditStore.getState().draft?.id).toBe(draftId)
  })
})

describe('Notice47Table(公示第47号の時間帯ごとの便数)', () => {
  function route(routeId: string, before: number, after: number): RouteDiff {
    return {
      routeId,
      routeName: `系統${routeId}`,
      before,
      after,
      removed: before - after,
      added: 0,
      same: after,
      excluded: false,
      firstDepartureBefore: null,
      firstDepartureAfter: null,
      lastDepartureBefore: null,
      lastDepartureAfter: null,
      vanishes: after === 0,
    }
  }
  const diff: WeekdayDiff = {
    removed: [],
    added: [],
    same: [],
    byRoute: [route('0031', 11, 4), route('0040', 16, 9), route('0050', 12, 11)],
    byStartBand: [],
    byNotice47Band: [
      { routeId: '0031', routeName: '系統0031', band: '6〜9時台', before: 3, after: 0 },
      { routeId: '0031', routeName: '系統0031', band: '10〜14時台', before: 8, after: 4 },
      { routeId: '0040', routeName: '系統0040', band: '6〜9時台', before: 16, after: 9 },
      { routeId: '0050', routeName: '系統0050', band: '6〜9時台', before: 12, after: 11 },
    ],
    vanishingRoutes: 0,
  }

  it('11〜15 回の系統が 10 回以下になるとき(系統の回数で判定)、公示第46号の表の下限を下回ると出す', () => {
    const html = renderToString(<Notice47Table diff={diff} />)
    const text = html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '')
    expect(text).toContain('系統0031:11 → 4 回。公示第46号の表の下限を下回ります。')
    // 16 回からの系統と、10 回より多く残る系統は当てはまらない
    expect(text).not.toContain('系統0040:')
    expect(text).not.toContain('系統0050:')
    expect(html.match(/data-below-notice46="true"/g)).toHaveLength(1)
  })

  it('0 回になる系統 × 帯に印を付け、数を見出しに出す', () => {
    const html = renderToString(<Notice47Table diff={diff} />)
    expect(html.match(/data-zero="true"/g)).toHaveLength(1)
    expect(html.replace(/<!-- -->/g, '')).toContain('(0 回になる系統 × 帯 1)')
  })
})
