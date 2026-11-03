// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ReachSummaryTable } from '@/components/steps/ReachStep'
import { makeBands } from '@/gtfs/departures'
import { cloneParams, type OriginStops } from '@/reach/input'
import { DEFAULT_REACH_PARAMS, type ReachResult } from '@/reach/reach'
import { summarizeReach } from '@/reach/summary'
import { useReachStore, type ReachSnapshot } from '@/store/reach'
import ReachLayers from './ReachLayers'

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

// 地図(MapLibre)は無い(store の map が null)ので、レイヤーは足されない。凡例と操作盤だけを確かめる
const RESULT: ReachResult = {
  cells: ['65420000111', '65420000112'],
  classes: ['urban', 'suburban'],
  reachable: [
    [true, true],
    [true, false],
    [true, true],
    [false, false],
    [true, true],
    [false, false],
  ],
  coverable: [true, true],
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [100, 50],
}

function snapshotOf(stepHours: 1 | 3 = 3): ReachSnapshot {
  const bands = makeBands(stepHours)
  const result = stepHours === 3 ? RESULT : { ...RESULT, reachable: bands.map(() => [true, true]) }
  return {
    date: '20261104',
    stepHours,
    bands,
    departures: { counts: new Map(), skippedBlankTime: 0, skippedInvalidTime: 0, hasFrequencies: false },
    result,
    summary: summarizeReach(result),
    params: cloneParams(DEFAULT_REACH_PARAMS),
    origin: { origins: 1, unused: 0, nonStop: 0, noBoarding: 0 },
  }
}

/** 到達圏の起点(停留所1つ)。操作盤は起点があるときに出す */
const ORIGINS: OriginStops = {
  stops: [{ id: 'S1', name: '駅前', lat: 43.76, lon: 142.36, locationType: 0 } as OriginStops['stops'][number]],
  unused: 0,
  nonStop: 0,
  noBoarding: 0,
}

const PERIOD = { start: '20261001', end: '20261130' }

beforeEach(() => {
  act(() => {
    useReachStore.setState({
      snapshot: snapshotOf(),
      selectedHour: 6,
      origins: ORIGINS,
      // source は日付の範囲と運行日の説明にだけ使う(feed は空。setSource は呼ばない。計算が走らないように)
      source: { feed: { tables: new Map(), warnings: [] }, stops: ORIGINS.stops, period: PERIOD },
      edited: null,
      date: '20261104',
      stepHours: 3,
    })
  })
})

afterEach(() => {
  act(() => useReachStore.setState({ source: null, edited: null, origins: null, date: null, snapshot: null }))
})

function bandRadios(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: '地図に出す時間帯' })).getAllByRole('radio')
}

describe('地図の操作盤(ReachLayers)', () => {
  it('到達圏の起点が無ければ何も出さない', () => {
    act(() => useReachStore.setState({ origins: null, snapshot: null }))
    const { container } = render(<ReachLayers />)
    expect(container.textContent).toBe('')
  })

  it('計算の結果(snapshot)が無くても、起点があれば操作盤を出す(凡例と地図に出す時間帯は出さない)', () => {
    act(() => useReachStore.setState({ snapshot: null }))
    render(<ReachLayers />)
    const panel = screen.getByRole('region', { name: '地図の操作盤' })
    expect(within(panel).getByRole('button', { name: /^比較する日付/ }).textContent).toContain('11月4日(水)')
    expect(within(panel).getByRole('radiogroup', { name: '時間帯の幅' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: '地図に出す時間帯' })).toBeNull()
    expect(screen.queryByRole('region', { name: '凡例' })).toBeNull()
  })

  it('snapshot が無くても、カレンダーで日を選ぶと store の日付が変わる', () => {
    act(() => useReachStore.setState({ snapshot: null }))
    render(<ReachLayers />)
    fireEvent.click(screen.getByRole('button', { name: /^比較する日付/ }))
    const dialog = screen.getByRole('dialog', { name: '比較する日付を選ぶ' })
    const day = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-kind]')).find((b) => b.firstChild?.textContent === '10')!
    fireEvent.click(day)
    expect(useReachStore.getState().date).toBe('20261110')
  })

  it('時間帯の幅を切り替えると、store の幅が変わる', () => {
    render(<ReachLayers />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '時間帯の幅' })).getByRole('radio', { name: '1時間ごと' }))
    expect(useReachStore.getState().stepHours).toBe(1)
  })

  it('運行日が無いときは、操作盤に注意を出す', () => {
    act(() => useReachStore.setState({ snapshot: null, date: null, source: null }))
    render(<ReachLayers />)
    expect(within(screen.getByRole('region', { name: '地図の操作盤' })).getByRole('alert').textContent).toContain('運行日がありません')
  })

  it('計算の結果があれば、凡例と地図に出す時間帯も出す', () => {
    render(<ReachLayers />)
    expect(screen.getByRole('region', { name: '凡例' })).toBeTruthy()
    expect(bandRadios()).toHaveLength(6)
  })

  it('押すと表示する時間帯(store の selectedHour)が変わり、凡例の見出しと表の強調行も付いてくる。計算し直しはしない', () => {
    render(<ReachLayers />)
    const before = useReachStore.getState().snapshot
    expect(within(screen.getByRole('region', { name: '凡例' })).getByText(/6〜9時の到達圏/)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '地図に出す時間帯' })).getByRole('radio', { name: '18〜21時' }))
    expect(useReachStore.getState().selectedHour).toBe(18)
    expect(useReachStore.getState().snapshot).toBe(before)
    expect(within(screen.getByRole('region', { name: '凡例' })).getByText(/18〜21時の到達圏/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: '18〜21時' }).getAttribute('aria-checked')).toBe('true')

    // 影響(到達圏)の表は、同じ selectedHour の行を強調する
    const snapshot = useReachStore.getState().snapshot!
    const html = renderToString(<ReachSummaryTable snapshot={snapshot} selectedHour={useReachStore.getState().selectedHour} invalidStops={0} />)
    expect(html).toMatch(/aria-current="true"[^>]*><td[^>]*>18〜21時/)
  })

  it('1時間ごとの計算なら、18 の帯を出す', () => {
    act(() => useReachStore.setState({ snapshot: snapshotOf(1), selectedHour: 10 }))
    render(<ReachLayers />)
    expect(bandRadios()).toHaveLength(18)
    expect(screen.getByRole('radio', { name: '10〜11時' }).getAttribute('aria-checked')).toBe('true')
  })
})
