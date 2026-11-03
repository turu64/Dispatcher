// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import StepPanels from '@/components/layout/StepPanels'
import ReachLayers from '@/map/ReachLayers'
import { TooltipProvider } from '@/components/ui/tooltip'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { STEPS } from '@/components/steps/registry'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { useReachStore } from '@/store/reach'
import { useStepStore } from '@/store/steps'

/**
 * 比較する日付(カレンダー)と時間帯の幅を地図の下の操作盤(map/BandControl.tsx)で選び、影響(到達圏)の手順の表の上には
 * 今の設定を1行で出すことを、画面と同じ左の欄(layout/StepPanels)と地図の重ね(map/ReachLayers.tsx)を並べて確かめる
 * (docs/tasks-1103b.md の T31)。到達圏は Web Worker の代わりにその場で computeReach を呼び、参照データは無い(fallback)ものとする
 */
vi.mock('@/reach/workerClient', async () => {
  const { computeReach } = await import('@/reach/reach')
  return { computeReachInWorker: async (input: Parameters<typeof computeReach>[0]) => computeReach(input) }
})
vi.mock('@/reach/refData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/reach/refData')>()),
  fetchRefData: async (mesh1s: string[]) => ({ ok: false, mesh1s, missing: mesh1s, message: '参照データがありません(テスト)。' }),
}))
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
}))

const REACH = '4. 影響(到達圏)'

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T00:30:00Z') })
  useHolidayStore.setState({
    holidays: {
      status: 'ready',
      list: { names: new Map([['20261103', '文化の日']]), first: '19550101', coveredUntil: '20271231', source: 'test' },
    },
  })
  const feed = smallFeed()
  act(() => {
    useGtfsStore.getState().setLoaded({ label: 'test.zip', feed })
    const { stops, servicePeriod } = useGtfsStore.getState()
    useReachStore.getState().setSource({ feed, stops, period: servicePeriod })
    useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    useEditStore.getState().setBase(null)
    useReachStore.getState().setSource(null)
    useGtfsStore.getState().clear()
  })
  vi.useRealTimers()
})

function openReach(): HTMLElement {
  render(
    <TooltipProvider>
      <StepPanels />
      <ReachLayers />
    </TooltipProvider>,
  )
  act(() => {
    useStepStore.getState().go('reach')
  })
  return screen.getByRole('heading', { name: REACH }).closest('[data-slot="card"]') as HTMLElement
}

describe('手順の一覧', () => {
  it('手順「日付と時間帯」は無く、到達圏の手順が「影響(到達圏)」になる', () => {
    expect(STEPS.map((s) => s.title)).toEqual(['読み込み', '前提情報', '減便の方針', '影響(到達圏)', '平日便を戻す', '出力'])
    expect(useStepStore.getState().order).not.toContain('dateBand')
    expect(STEPS.find((s) => s.key === 'reach')?.showMap).toBe(true)
  })
})

describe('影響(到達圏)の手順と地図の操作盤', () => {
  it('手順には今の比較する日付と時間帯の幅を、結果の表より上に1行で出す。カレンダーと幅の切り替えは手順に無く、地図の操作盤にある', () => {
    const reach = openReach()
    const line = within(reach).getByTestId('reach-setting')
    expect(line.textContent).toMatch(/^比較する日付:\d+年\d+月\d+日\(.\)・3時間ごと/)
    expect(line.textContent).toContain('地図の下の操作盤で変えられます。')
    // 参照データの状態より前(上)にある
    const status = within(reach).getByRole('button', { name: '参照データを読み込み直す' })
    expect(line.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 手順の中にはカレンダー・時間帯の幅・地図に出す時間帯の切り替えが無い
    expect(within(reach).queryByTestId('selected-date')).toBeNull()
    expect(within(reach).queryByRole('radio', { name: '3時間ごと' })).toBeNull()
    expect(within(reach).queryByRole('radio', { name: '9〜12時' })).toBeNull()
    // 地図の操作盤にある
    const panel = screen.getByRole('region', { name: '地図の操作盤' })
    expect(reach.contains(panel)).toBe(false)
    expect(within(panel).getByRole('button', { name: /^比較する日付/ })).toBeTruthy()
    expect(within(panel).getByRole('radio', { name: '3時間ごと' })).toBeTruthy()
  })

  it('操作盤のカレンダーで日を選ぶと比較する日付が変わり、時間帯の幅を変えると帯の数が変わる(どちらも計算し直し、手順の1行も変わる)', async () => {
    const reach = openReach()
    await waitFor(() => expect(useReachStore.getState().snapshot).not.toBeNull())
    const before = useReachStore.getState().snapshot
    const panel = screen.getByRole('region', { name: '地図の操作盤' })
    fireEvent.click(within(panel).getByRole('button', { name: /^比較する日付/ }))
    const dialog = screen.getByRole('dialog', { name: '比較する日付を選ぶ' })
    const day = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-kind="weekday"]')).find(
      (b) => b.firstChild?.textContent === '21',
    )!
    fireEvent.click(day)
    expect(useReachStore.getState().date).toBe('20261021')
    await waitFor(() => expect(useReachStore.getState().snapshot).not.toBe(before))
    expect(useReachStore.getState().snapshot?.date).toBe('20261021')
    expect(within(reach).getByTestId('reach-setting').textContent).toContain('2026年10月21日(水)・3時間ごと')

    fireEvent.click(within(panel).getByRole('radio', { name: '1時間ごと' }))
    expect(useReachStore.getState().stepHours).toBe(1)
    await waitFor(() => expect(useReachStore.getState().snapshot?.bands).toHaveLength(18))
    expect(within(reach).getByTestId('reach-setting').textContent).toContain('2026年10月21日(水)・1時間ごと')
    // 地図に出す時間帯も 18 の帯になる
    expect(within(screen.getByRole('radiogroup', { name: '地図に出す時間帯' })).getAllByRole('radio')).toHaveLength(18)
  })
})
