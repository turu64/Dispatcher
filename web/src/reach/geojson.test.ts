import { describe, expect, it } from 'vitest'
import { bandProperty, cellsToGeoJson, emptyCollection, stationsToGeoJson, stopsToGeoJson } from './geojson'
import { meshBounds } from './mesh'
import type { ReachResult } from './reach'

describe('bandProperty', () => {
  it('b と時間帯の番号', () => {
    expect(bandProperty(0)).toBe('b0')
    expect(bandProperty(17)).toBe('b17')
  })
})

describe('cellsToGeoJson', () => {
  const result: ReachResult = {
    cells: ['65423700111', '65423700112'],
    classes: ['urban', 'rural'],
    reachable: [
      [true, false],
      [false, false],
      [true, true],
    ],
    usedFallback: false,
    excludedStops: 0,
    cellPopulation: [12.5, 0.25],
  }
  const fc = cellsToGeoJson(result)

  it('セルごとに面を1つ作る', () => {
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(2)
  })

  it('面はセルの四隅を南西から反時計回りに結び、閉じている', () => {
    const { south, west, north, east } = meshBounds('65423700111')
    expect(fc.features[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    })
  })

  it('時間帯ごとの到達の可否を b0, b1, … に 1/0 で入れる', () => {
    expect(fc.features[0].properties).toEqual({ code: '65423700111', cls: 'urban', pop: 12.5, b0: 1, b1: 0, b2: 1 })
    expect(fc.features[1].properties).toEqual({ code: '65423700112', cls: 'rural', pop: 0.25, b0: 0, b1: 0, b2: 1 })
  })

  it('セルが無ければ空', () => {
    expect(cellsToGeoJson({ ...result, cells: [], classes: [], reachable: [[], [], []], cellPopulation: [] }).features).toEqual([])
  })
})

describe('stopsToGeoJson', () => {
  const stops = [
    { id: 'A', name: '旭川駅前', lat: 43.7647, lon: 142.3579 },
    { id: 'B', name: '永山', lat: 43.81, lon: 142.44 },
    { id: 'C', name: '位置不明', lat: 0, lon: 0 },
  ]
  const fc = stopsToGeoJson(stops, new Map([['A', [3, 0]]]), 2)

  it('停留所を点にする(経度、緯度の順)。範囲外の停留所は出さない', () => {
    expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
      [142.3579, 43.7647],
      [142.44, 43.81],
    ])
  })

  it('時間帯ごとの出発の数を b0, b1, … に入れ、counts に無ければ 0', () => {
    expect(fc.features[0].properties).toEqual({ id: 'A', name: '旭川駅前', b0: 3, b1: 0 })
    expect(fc.features[1].properties).toEqual({ id: 'B', name: '永山', b0: 0, b1: 0 })
  })
})

describe('stationsToGeoJson', () => {
  it('駅を点にし、名前と路線を持たせる', () => {
    expect(stationsToGeoJson([{ name: '旭川', line: '函館線・宗谷線', lat: 43.76, lon: 142.36 }])).toEqual({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [142.36, 43.76] }, properties: { name: '旭川', line: '函館線・宗谷線' } },
      ],
    })
  })
})

describe('emptyCollection', () => {
  it('地物の無い FeatureCollection', () => {
    expect(emptyCollection()).toEqual({ type: 'FeatureCollection', features: [] })
  })
})
