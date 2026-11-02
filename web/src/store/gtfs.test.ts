import { beforeEach, describe, expect, it } from 'vitest'
import type { GtfsFeed } from '../gtfs/load'
import { useGtfsStore } from './gtfs'

const feed: GtfsFeed = { tables: new Map(), warnings: [] }

describe('useGtfsStore', () => {
  beforeEach(() => useGtfsStore.getState().clear())

  it('最初は何も読み込んでいない', () => {
    const s = useGtfsStore.getState()
    expect(s.feed).toBeNull()
    expect(s.label).toBeNull()
    expect(s.sample).toBeNull()
  })

  it('読み込んだ GTFS とファイル名を持つ', () => {
    useGtfsStore.getState().setLoaded({ label: 'gtfs.zip', feed })
    const s = useGtfsStore.getState()
    expect(s.feed).toBe(feed)
    expect(s.label).toBe('gtfs.zip')
    expect(s.sample).toBeNull()
  })

  it('サンプルの出典も持つ', () => {
    const sample = { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム', license: 'CC BY 4.0' }
    useGtfsStore.getState().setLoaded({ label: sample.name, feed, sample })
    expect(useGtfsStore.getState().sample).toEqual(sample)
  })

  it('clear で捨てる', () => {
    useGtfsStore.getState().setLoaded({ label: 'gtfs.zip', feed })
    useGtfsStore.getState().clear()
    expect(useGtfsStore.getState().feed).toBeNull()
    expect(useGtfsStore.getState().label).toBeNull()
  })
})
