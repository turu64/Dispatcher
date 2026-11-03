// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StepPanels from '@/components/layout/StepPanels'
import { TooltipProvider } from '@/components/ui/tooltip'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { STEPS } from '@/components/steps/registry'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { useReachStore } from '@/store/reach'
import { useStepStore } from '@/store/steps'

/**
 * 影響(到達圏)の手順に、比べる日(カレンダー)と時間帯の幅が上部に入ったことを、画面と同じ左の欄(layout/StepPanels)で確かめる。
 * 到達圏は Web Worker の代わりにその場で computeReach を呼び、参照データは無い(fallback)ものとする
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
    </TooltipProvider>,
  )
  act(() => {
    useStepStore.getState().go('reach')
  })
  return screen.getByRole('heading', { name: REACH }).closest('[data-slot="card"]') as HTMLElement
}

describe('手順の一覧', () => {
  it('手順「日付と時間帯」は無く、到達圏の手順が「影響(到達圏)」になる', () => {
    expect(STEPS.map((s) => s.title)).toEqual(['読み込み', '前提情報', '減便の方針', '影響(到達圏)', '足し戻し', '出力'])
    expect(useStepStore.getState().order).not.toContain('dateBand')
    expect(STEPS.find((s) => s.key === 'reach')?.showMap).toBe(true)
  })
})

describe('影響(到達圏)の手順の上部', () => {
  it('比べる日(カレンダー)と時間帯の幅を、結果の表より上に置き、計算し直す旨を添える', () => {
    const reach = openReach()
    const calendar = within(reach).getByTestId('selected-date')
    const note = within(reach).getByText(/表・足し戻しの手がかり・AI の影響の要約も計算し直します/)
    expect(within(reach).getByText('比べる日')).toBeTruthy()
    expect(within(reach).getByRole('radio', { name: '3時間ごと' })).toBeTruthy()
    // 参照データの状態より前(上)にある
    const status = within(reach).getByRole('button', { name: '参照データを読み込み直す' })
    expect(note.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(calendar.textContent).toMatch(/^\d+月\d+日/)
    // 表示する時間帯のボタンは手順の中に無い(地図の上にある)
    expect(within(reach).queryByRole('radio', { name: '9〜12時' })).toBeNull()
  })

  it('日を選ぶと比べる日が変わり、時間帯の幅を変えると帯の数が変わる(どちらも到達圏を計算し直す)', async () => {
    const reach = openReach()
    await waitFor(() => expect(useReachStore.getState().snapshot).not.toBeNull())
    const before = useReachStore.getState().snapshot
    const day = Array.from(reach.querySelectorAll<HTMLButtonElement>('button[data-kind="weekday"]')).find(
      (b) => b.firstChild?.textContent === '21',
    )!
    fireEvent.click(day)
    expect(useReachStore.getState().date).toBe('20261021')
    await waitFor(() => expect(useReachStore.getState().snapshot).not.toBe(before))
    expect(useReachStore.getState().snapshot?.date).toBe('20261021')

    fireEvent.click(within(reach).getByRole('radio', { name: '1時間ごと' }))
    expect(useReachStore.getState().stepHours).toBe(1)
    await waitFor(() => expect(useReachStore.getState().snapshot?.bands).toHaveLength(18))
  })
})
