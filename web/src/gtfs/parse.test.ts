import { describe, expect, it } from 'vitest'
import type { GtfsFeed, GtfsRow } from './load'
import { toStops } from './parse'

/** 手書きの stops.txt だけを持つフィードを作る */
function feedWithStops(rows: GtfsRow[]): GtfsFeed {
  const fields = ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station']
  return { tables: new Map([['stops', { fileName: 'stops.txt', fields, rows }]]), warnings: [] }
}

describe('toStops', () => {
  it('停留所を数値に変換する', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: '0010_01', stop_name: '旭川駅前', stop_lat: '43.764727', stop_lon: '142.357912', location_type: '0', parent_station: '' },
        { stop_id: '0020_01', stop_name: '市役所', stop_lat: '43.77', stop_lon: '142.37', location_type: '1', parent_station: 'P1' },
      ]),
    )
    expect(invalid).toBe(0)
    expect(stops).toEqual([
      { id: '0010_01', name: '旭川駅前', lat: 43.764727, lon: 142.357912, locationType: 0, parentStation: '' },
      { id: '0020_01', name: '市役所', lat: 43.77, lon: 142.37, locationType: 1, parentStation: 'P1' },
    ])
  })

  it('id と parent_station は前後の空白を取り、名前は元のまま残す', () => {
    const { stops } = toStops(
      feedWithStops([{ stop_id: ' A ', stop_name: '駅前 ', stop_lat: ' 43.5 ', stop_lon: '142.5\t', parent_station: ' P ' }]),
    )
    expect(stops).toEqual([{ id: 'A', name: '駅前 ', lat: 43.5, lon: 142.5, locationType: 0, parentStation: 'P' }])
  })

  it('location_type が空・列なしなら 0、数字なら整数にする', () => {
    const { stops } = toStops(
      feedWithStops([
        { stop_id: 'A', stop_lat: '43', stop_lon: '142', location_type: '' },
        { stop_id: 'B', stop_lat: '43', stop_lon: '142' },
        { stop_id: 'C', stop_lat: '43', stop_lon: '142', location_type: ' 2 ' },
        { stop_id: 'D', stop_lat: '43', stop_lon: '142', location_type: 'x' },
      ]),
    )
    expect(stops.map((s) => s.locationType)).toEqual([0, 0, 2, 0])
  })

  it('stop_name・parent_station が無い行は空文字にする', () => {
    const { stops } = toStops(feedWithStops([{ stop_id: 'A', stop_lat: '43', stop_lon: '142' }]))
    expect(stops).toEqual([{ id: 'A', name: '', lat: 43, lon: 142, locationType: 0, parentStation: '' }])
  })

  it('緯度経度が空・空白・数でない行は除いて数える', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'ok', stop_lat: '43', stop_lon: '142' },
        { stop_id: 'blank-lat', stop_lat: '', stop_lon: '142' },
        { stop_id: 'space-lon', stop_lat: '43', stop_lon: '   ' },
        { stop_id: 'text', stop_lat: 'abc', stop_lon: '142' },
        { stop_id: 'unit', stop_lat: '43度', stop_lon: '142' },
        { stop_id: 'hex', stop_lat: '0x10', stop_lon: '142' },
        { stop_id: 'exp', stop_lat: '4.3e1', stop_lon: '142' },
        { stop_id: 'nan', stop_lat: 'NaN', stop_lon: '142' },
        { stop_id: 'inf', stop_lat: '43', stop_lon: 'Infinity' },
        { stop_id: 'two-dots', stop_lat: '43.1.2', stop_lon: '142' },
        { stop_id: 'comma', stop_lat: '43,5', stop_lon: '142' },
        { stop_id: 'fullwidth', stop_lat: '４３', stop_lon: '142' },
        { stop_id: 'dot-only', stop_lat: '.', stop_lon: '142' },
      ]),
    )
    expect(stops.map((s) => s.id)).toEqual(['ok'])
    expect(invalid).toBe(12)
  })

  it('列そのものが無い(短い行・列なしのファイル)場合も除いて数える', () => {
    const { stops, invalid } = toStops(
      feedWithStops([{ stop_id: 'A' }, { stop_id: 'B', stop_lat: '43' }, { stop_id: 'C', stop_lon: '142' }]),
    )
    expect(stops).toEqual([])
    expect(invalid).toBe(3)
  })

  it('緯度は ±90、経度は ±180 の範囲外を除き、端の値は入れる', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'north-pole', stop_lat: '90', stop_lon: '180' },
        { stop_id: 'south-west', stop_lat: '-90', stop_lon: '-180' },
        { stop_id: 'lat-over', stop_lat: '90.000001', stop_lon: '0' },
        { stop_id: 'lat-91', stop_lat: '91', stop_lon: '142' },
        { stop_id: 'lat-under', stop_lat: '-91', stop_lon: '142' },
        { stop_id: 'lon-181', stop_lat: '43', stop_lon: '181' },
        { stop_id: 'lon-under', stop_lat: '43', stop_lon: '-180.5' },
        // 経度を緯度の列に入れてしまった行(緯度の範囲を超える)
        { stop_id: 'swapped', stop_lat: '142.357912', stop_lon: '43.764727' },
      ]),
    )
    expect(stops.map((s) => s.id)).toEqual(['north-pole', 'south-west'])
    expect(invalid).toBe(6)
  })

  it('+ や - の符号、先頭・末尾の小数点を数として読む', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'plus', stop_lat: '+43.5', stop_lon: '142.' },
        { stop_id: 'minus', stop_lat: '-33.86', stop_lon: '-.5' },
      ]),
    )
    expect(invalid).toBe(0)
    expect(stops.map((s) => [s.lat, s.lon])).toEqual([
      [43.5, 142],
      [-33.86, -0.5],
    ])
  })

  it('stop_id が空の行は除かず、id を空文字にして返す(指摘は検証器の役目)', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: '', stop_lat: '43', stop_lon: '142' },
        { stop_id: '  ', stop_lat: '43', stop_lon: '142' },
        { stop_lat: '43', stop_lon: '142' },
        { stop_id: 'A', stop_lat: '43', stop_lon: '142' },
      ]),
    )
    expect(stops.map((s) => s.id)).toEqual(['', '', '', 'A'])
    expect(invalid).toBe(0)
  })

  it('同じ stop_id の行は、そのまま全部返す', () => {
    const { stops, invalid } = toStops(
      feedWithStops([
        { stop_id: 'A', stop_lat: '43', stop_lon: '142' },
        { stop_id: 'A ', stop_lat: '44', stop_lon: '143' },
      ]),
    )
    expect(invalid).toBe(0)
    expect(stops.map((s) => s.lat)).toEqual([43, 44])
  })

  it('stops.txt が無いフィードや、行が 0 件のフィードは空で返す', () => {
    expect(toStops({ tables: new Map(), warnings: [] })).toEqual({ stops: [], invalid: 0 })
    expect(toStops(feedWithStops([]))).toEqual({ stops: [], invalid: 0 })
  })

  it('入力のフィードを書き換えない', () => {
    const row: GtfsRow = { stop_id: ' A ', stop_name: '駅前', stop_lat: ' 43 ', stop_lon: '142' }
    toStops(feedWithStops([row]))
    expect(row).toEqual({ stop_id: ' A ', stop_name: '駅前', stop_lat: ' 43 ', stop_lon: '142' })
  })
})
