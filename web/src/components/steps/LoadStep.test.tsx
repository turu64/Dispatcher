// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { GtfsFeed } from '@/gtfs/load'
import { useGtfsStore } from '@/store/gtfs'
import LoadStep from './LoadStep'

// 読み込みの手順は、サンプルの有無をサーバーに聞く。ここではサーバーに届かないものとする
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
}))
vi.mock('@/gtfs/workerClient', () => ({ loadGtfsInWorker: () => new Promise(() => {}) }))

afterEach(() => {
  cleanup()
  act(() => useGtfsStore.getState().clear())
})

function show(feed: GtfsFeed) {
  act(() => useGtfsStore.getState().setLoaded({ label: 'dohoku.zip', feed }))
  render(<LoadStep />)
}

describe('LoadStep の版と期間', () => {
  it('feed_version・有効期間・service_id ごとの便数を出す', () => {
    show(smallFeed())
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:202609171038')
    expect(text).toContain('有効期間:2026年10月1日(木)〜2026年11月30日(月)')
    expect(text).not.toContain('求めました')
    expect(text).toContain('WK(平日):')
    expect(text).toContain('SA(土曜):')
    expect(text).toContain('SU(日曜):')
    // 平日の便は R1 が 2 便、R2 と R3 が 1 便ずつ
    expect(text).toContain('WK(平日):4 便')
  })

  it('feed_info が無ければ calendar から求めたと添え、feed_version は (空)', () => {
    const feed = smallFeed()
    const tables = new Map(feed.tables)
    tables.delete('feed_info')
    show({ ...feed, tables })
    const text = screen.getByLabelText('読み込んだ GTFS の版と期間').textContent ?? ''
    expect(text).toContain('feed_version:(空)')
    expect(text).toContain('2026年10月1日(木)〜2026年11月30日(月)(feed_info に無いため、calendar・calendar_dates から求めました)')
  })
})
