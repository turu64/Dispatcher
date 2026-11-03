// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReachSummaryTable } from '@/components/steps/ReachStep'
import { makeBands } from '@/gtfs/departures'
import { cloneParams } from '@/reach/input'
import { DEFAULT_REACH_PARAMS, type ReachResult } from '@/reach/reach'
import { summarizeReach } from '@/reach/summary'
import { useReachStore, type ReachSnapshot } from '@/store/reach'
import ReachLayers from './ReachLayers'

afterEach(cleanup)

// 地図(MapLibre)は無い(store の map が null)ので、レイヤーは足されない。凡例と時間帯の切り替えだけを確かめる
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

beforeEach(() => {
  act(() => {
    useReachStore.setState({ snapshot: snapshotOf(), selectedHour: 6, origins: null })
  })
})

describe('地図の上の時間帯の切り替え(ReachLayers)', () => {
  it('計算の結果があるときだけ、凡例とともに時間帯のボタンを出す', () => {
    act(() => useReachStore.setState({ snapshot: null }))
    const { container } = render(<ReachLayers />)
    expect(container.textContent).toBe('')
    cleanup()
    act(() => useReachStore.setState({ snapshot: snapshotOf() }))
    render(<ReachLayers />)
    expect(screen.getByRole('region', { name: '凡例' })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(6)
  })

  it('押すと表示する時間帯(store の selectedHour)が変わり、凡例の見出しと表の強調行も付いてくる。計算し直しはしない', () => {
    render(<ReachLayers />)
    const before = useReachStore.getState().snapshot
    expect(within(screen.getByRole('region', { name: '凡例' })).getByText(/6〜9時の徒歩圏/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '18〜21時' }))
    expect(useReachStore.getState().selectedHour).toBe(18)
    expect(useReachStore.getState().snapshot).toBe(before)
    expect(within(screen.getByRole('region', { name: '凡例' })).getByText(/18〜21時の徒歩圏/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: '18〜21時' }).getAttribute('aria-checked')).toBe('true')

    // 影響(到達圏)の表は、同じ selectedHour の行を強調する
    const snapshot = useReachStore.getState().snapshot!
    const html = renderToString(<ReachSummaryTable snapshot={snapshot} selectedHour={useReachStore.getState().selectedHour} invalidStops={0} />)
    expect(html).toMatch(/aria-current="true"[^>]*><td[^>]*>18〜21時/)
  })

  it('1時間ごとの計算なら、18 の帯を出す', () => {
    act(() => useReachStore.setState({ snapshot: snapshotOf(1), selectedHour: 10 }))
    render(<ReachLayers />)
    expect(screen.getAllByRole('radio')).toHaveLength(18)
    expect(screen.getByRole('radio', { name: '10〜11時' }).getAttribute('aria-checked')).toBe('true')
  })
})
