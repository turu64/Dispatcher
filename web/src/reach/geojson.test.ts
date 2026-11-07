import { describe, expect, it } from 'vitest'
import { bandProperty, cellsToGeoJson, emptyCollection, MAX_MASK_BANDS, reachMask, stationsToGeoJson, stopsToGeoJson } from './geojson'
import { meshBounds } from './mesh'
import type { ReachResult } from './reach'

describe('bandProperty', () => {
  it('b と時間帯の番号', () => {
    expect(bandProperty(0)).toBe('b0')
    expect(bandProperty(17)).toBe('b17')
  })
})

describe('reachMask', () => {
  it('時間帯 b に到達できれば 2^b を足す', () => {
    const reachable = [
      [true, false, false],
      [false, false, true],
      [true, false, true],
    ]
    expect(reachMask(reachable, 0)).toBe(0b101)
    expect(reachMask(reachable, 1)).toBe(0)
    expect(reachMask(reachable, 2)).toBe(0b110)
  })

  it('32 を超える時間帯も、ビット演算の桁あふれなしにまとめる', () => {
    const reachable = Array.from({ length: MAX_MASK_BANDS }, () => [true])
    expect(reachMask(reachable, 0)).toBe(2 ** MAX_MASK_BANDS - 1)
    expect(Number.isSafeInteger(reachMask(reachable, 0))).toBe(true)
  })
})

describe('cellsToGeoJson', () => {
  const result: ReachResult = {
    cells: ['65423700111', '65423700112', '65423700113'],
    classes: ['urban', 'rural', 'rural'],
    reachable: [
      [true, false, false],
      [false, false, false],
      [true, true, false],
    ],
    // 3つ目のセルは、ダイヤと関係なく外れる(地図に塗らない)
    coverable: [true, true, false],
    usedFallback: false,
    excludedStops: 0,
    cellPopulation: [12.5, 0.25, 3],
  }
  const fc = cellsToGeoJson(result)

  it('到達できる見込みのあるセルごとに面を1つ作る。見込みの無いセルは入れない', () => {
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(2)
    expect(fc.features.map((f) => f.properties.code)).toEqual(['65423700111', '65423700112'])
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

  it('時間帯ごとの到達の可否を整数 m 1つにまとめる(時間帯 b に到達できれば 2^b)', () => {
    expect(fc.features[0].properties).toEqual({ code: '65423700111', cls: 'urban', pop: 12.5, m: 0b101 })
    expect(fc.features[1].properties).toEqual({ code: '65423700112', cls: 'rural', pop: 0.25, m: 0b100 })
  })

  it('m から時間帯 b の可否を取り出せる(地図の式と同じ計算:floor(m / 2^b) % 2)', () => {
    for (const f of fc.features) {
      const i = result.cells.indexOf(f.properties.code)
      for (let b = 0; b < result.reachable.length; b++) {
        expect(Math.floor(f.properties.m / 2 ** b) % 2 === 1).toBe(result.reachable[b][i])
      }
    }
  })

  it('すべてのセルが見込み無しなら空', () => {
    expect(cellsToGeoJson({ ...result, coverable: [false, false, false] }).features).toEqual([])
  })

  it('セルが無ければ空', () => {
    expect(
      cellsToGeoJson({ ...result, cells: [], classes: [], reachable: [[], [], []], coverable: [], cellPopulation: [] }).features,
    ).toEqual([])
  })

  it(`時間帯が ${MAX_MASK_BANDS} 個を超えるとエラー(m を誤差なく扱えない)`, () => {
    const reachable = Array.from({ length: MAX_MASK_BANDS + 1 }, () => [true, true, true])
    expect(() => cellsToGeoJson({ ...result, reachable })).toThrow(`地図に出せる時間帯は ${MAX_MASK_BANDS} 個まで`)
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
