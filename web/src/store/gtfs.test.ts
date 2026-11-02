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

  it('停留所と運行期間も求める(緯度経度が読めない停留所は数だけ)', () => {
    const withStops: GtfsFeed = {
      tables: new Map([
        [
          'stops',
          {
            fileName: 'stops.txt',
            fields: ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
            rows: [
              { stop_id: ' A ', stop_name: '旭川駅前', stop_lat: '43.7647', stop_lon: '142.3579' },
              { stop_id: 'B', stop_name: '不明', stop_lat: '', stop_lon: '142' },
            ],
          },
        ],
        [
          'calendar',
          {
            fileName: 'calendar.txt',
            fields: [],
            rows: [
              {
                service_id: '01',
                monday: '1',
                tuesday: '1',
                wednesday: '1',
                thursday: '1',
                friday: '1',
                saturday: '0',
                sunday: '0',
                start_date: '20261001',
                end_date: '20261130',
              },
            ],
          },
        ],
      ]),
      warnings: [],
    }
    useGtfsStore.getState().setLoaded({ label: 'gtfs.zip', feed: withStops })
    const s = useGtfsStore.getState()
    expect(s.stops.map((x) => x.id)).toEqual(['A'])
    expect(s.invalidStops).toBe(1)
    expect(s.servicePeriod).toEqual({ start: '20261001', end: '20261130' })

    useGtfsStore.getState().clear()
    expect(useGtfsStore.getState().stops).toEqual([])
    expect(useGtfsStore.getState().invalidStops).toBe(0)
    expect(useGtfsStore.getState().servicePeriod).toBeNull()
  })
})
