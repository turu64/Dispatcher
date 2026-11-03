import { describe, expect, it } from 'vitest'
import { NEARBY_RADIUS_M } from '@/gtfs/edit/notice'
import { distanceM } from '@/reach/mesh'
import {
  excludeOwnOperators,
  mergeBusstopFiles,
  nearOtherStops,
  operatorNameOf,
  operatorOverlap,
  OTHER_STOP_RADIUS_M,
  parseBusstops,
  type OtherStop,
} from './busstops'

// 旭川の近く(北緯 43.77 度)。緯度 0.001 度 ≒ 111.1m なので、北へ 0.0026 度 ≒ 289m、0.0028 度 ≒ 311m
const BASE = { lat: 43.77, lon: 142.36 }
const IN = BASE.lat + 0.0026
const OUT = BASE.lat + 0.0028

function stop(name: string, lat: number, lon: number, operators: string[], routes: string[] = []): OtherStop {
  return { name, lat, lon, operators, routes }
}

function row(name: string, lat: number, lon: number, operators: unknown, routes: unknown = []) {
  return { name, lat, lon, operators, routes }
}

describe('距離の前提', () => {
  it('テストの点は 300m の内と外にある', () => {
    expect(distanceM(BASE, { lat: IN, lon: BASE.lon })).toBeLessThan(300)
    expect(distanceM(BASE, { lat: OUT, lon: BASE.lon })).toBeGreaterThan(300)
  })

  it('重なりの距離は周知文の代替手段の半径と同じ', () => {
    expect(OTHER_STOP_RADIUS_M).toBe(300)
    expect(OTHER_STOP_RADIUS_M).toBe(NEARBY_RADIUS_M)
  })
})

describe('parseBusstops', () => {
  it('busstops の無い古いファイル・形の違うファイルは空', () => {
    expect(parseBusstops({ mesh1: '6542', facilities: [], sources: [] })).toEqual({ stops: [], skipped: 0 })
    expect(parseBusstops(null)).toEqual({ stops: [], skipped: 0 })
    expect(parseBusstops([])).toEqual({ stops: [], skipped: 0 })
    expect(parseBusstops({ busstops: 'x' })).toEqual({ stops: [], skipped: 0 })
  })

  it('壊れた行は読み飛ばして数える', () => {
    const file = {
      mesh1: '6542',
      facilities: [],
      busstops: [
        row('旭川駅前', 43.76, 142.36, ['P11:旭川電気軌道(株)'], ['1', '2', '1', '', 3]),
        row('系統の無い停留所', 43.761, 142.361, ['P11:旭川電気軌道(株)']),
        { name: '系統が配列でない', lat: 43.762, lon: 142.362, operators: ['P11:x'], routes: 'a' },
        row('', 43.76, 142.36, ['P11:a']), // 名前が空
        row('緯度が無い', Number.NaN, 142.36, ['P11:a']),
        { name: '経度が文字', lat: 43.76, lon: '142.36', operators: ['P11:a'] },
        row('範囲外', 95, 142.36, ['P11:a']),
        row('事業者の形が違う', 43.76, 142.36, ['旭川電気軌道']),
        row('事業者が無い', 43.76, 142.36, []),
        row('事業者が配列でない', 43.76, 142.36, 'P11:a'),
        'x',
        null,
      ],
    }
    const { stops, skipped } = parseBusstops(file)
    expect(skipped).toBe(9)
    expect(stops).toEqual([
      stop('旭川駅前', 43.76, 142.36, ['P11:旭川電気軌道(株)'], ['1', '2']),
      stop('系統の無い停留所', 43.761, 142.361, ['P11:旭川電気軌道(株)'], []),
      stop('系統が配列でない', 43.762, 142.362, ['P11:x'], []),
    ])
  })

  it('1次メッシュのファイルをつなぐ(古いファイルが混じってもよい)', () => {
    const a = { busstops: [row('A', 43.76, 142.36, ['P11:a'])] }
    const b = { facilities: [] }
    const c = { busstops: [row('C', 44.36, 142.46, ['P11:c']), row('', 0, 0, [])] }
    const { stops, skipped } = mergeBusstopFiles([a, b, c])
    expect(stops.map((s) => s.name)).toEqual(['A', 'C'])
    expect(skipped).toBe(1)
  })
})

describe('excludeOwnOperators', () => {
  it('読み込んだ GTFS の事業者を、株式会社・(株)の書き方の違いを除いて比べ、除く', () => {
    const stops = [
      stop('自社', 43.76, 142.36, ['P11:道北バス(株)']),
      stop('他社', 43.76, 142.36, ['P11:旭川電気軌道(株)']),
      stop('共同', 43.76, 142.36, ['P11:道北バス(株)', 'P11:旭川電気軌道(株)']),
    ]
    const out = excludeOwnOperators(stops, ['道北バス株式会社'])
    expect(out.map((s) => [s.name, s.operators])).toEqual([
      ['他社', ['P11:旭川電気軌道(株)']],
      ['共同', ['P11:旭川電気軌道(株)']],
    ])
    // 元の配列・停留所は変えない
    expect(stops[2].operators).toHaveLength(2)
    // 事業者名が分からなければ何も除かない
    expect(excludeOwnOperators(stops, [])).toHaveLength(3)
    expect(operatorNameOf('P11:道北バス(株)')).toBe('道北バス(株)')
  })
})

describe('nearOtherStops', () => {
  const others = [
    stop('外', OUT, BASE.lon, ['P11:旭川電気軌道(株)'], ['外の系統']),
    stop('近い', BASE.lat + 0.001, BASE.lon, ['P11:旭川電気軌道(株)'], ['2', '1']),
    stop('もっと近い', BASE.lat + 0.0005, BASE.lon, ['P11:ふらのバス(株)'], ['1']),
    stop('境の内', IN, BASE.lon, ['P11:旭川電気軌道(株)'], ['3']),
  ]

  it('300m 以内の停留所を近い順に返し、事業者と系統名の重複を除く', () => {
    const r = nearOtherStops(BASE.lat, BASE.lon, others)
    expect(r.stops.map((s) => s.stop.name)).toEqual(['もっと近い', '近い', '境の内'])
    expect(r.stops[0].distanceM).toBeCloseTo(distanceM(BASE, others[2]), 6)
    expect(r.operators).toEqual(['P11:ふらのバス(株)', 'P11:旭川電気軌道(株)'])
    expect(r.routes).toEqual(['1', '2', '3'])
  })

  it('半径を変えられる。座標が数でなければ空', () => {
    expect(nearOtherStops(BASE.lat, BASE.lon, others, 100).stops.map((s) => s.stop.name)).toEqual(['もっと近い'])
    expect(nearOtherStops(BASE.lat, BASE.lon, others, 400).stops).toHaveLength(4)
    expect(nearOtherStops(Number.NaN, BASE.lon, others).stops).toEqual([])
    expect(nearOtherStops(BASE.lat, BASE.lon, []).stops).toEqual([])
  })
})

describe('operatorOverlap', () => {
  const own = [
    { id: 'S1', lat: BASE.lat, lon: BASE.lon },
    // S1 から東へ約 1.6km
    { id: 'S2', lat: BASE.lat, lon: BASE.lon + 0.02 },
    // 座標の読めない停留所は数えない
    { id: 'S3', lat: Number.NaN, lon: Number.NaN },
  ]
  const others = [
    // 旭川電気軌道:S1 の 300m 以内に2つ(同じ系統名を持つ)、S2 の近くに1つ、300m の外に1つ
    stop('一条通', IN, BASE.lon, ['P11:旭川電気軌道(株)'], ['1', '2']),
    stop('二条通', BASE.lat - 0.001, BASE.lon, ['P11:旭川電気軌道(株)'], ['2', '5']),
    stop('東の停留所', BASE.lat, BASE.lon + 0.0201, ['P11:旭川電気軌道(株)'], ['10']),
    stop('外れ', OUT, BASE.lon, ['P11:旭川電気軌道(株)'], ['遠い系統']),
    // 自社(道北バス)は除く
    stop('自社の停留所', BASE.lat, BASE.lon, ['P11:道北バス(株)'], ['自社の系統']),
    // ふらのバス:S1 と S2 の両方から 300m の外
    stop('遠いふらの', BASE.lat + 0.01, BASE.lon, ['P11:ふらのバス(株)'], ['ラベンダー号']),
    // 沿岸バス:S2 の近く(系統名なし)
    stop('沿岸の停留所', BASE.lat + 0.001, BASE.lon + 0.02, ['P11:沿岸バス(株)']),
  ]

  it('事業者ごとに、近くの自社の停留所・他社の停留所・系統名(重複なし)を返す', () => {
    const r = operatorOverlap(own, others, ['道北バス株式会社'])
    expect(r.map((o) => o.targetId)).toEqual(['P11:旭川電気軌道(株)', 'P11:沿岸バス(株)'])
    const [asahikawa, engan] = r
    expect(asahikawa.ownStopIds).toEqual(['S1', 'S2'])
    expect(asahikawa.otherStops.map((s) => s.name)).toEqual(['二条通', '東の停留所', '一条通'])
    expect(asahikawa.routes).toEqual(['1', '10', '2', '5'])
    expect(asahikawa.routes).not.toContain('遠い系統')
    expect(engan).toEqual({
      targetId: 'P11:沿岸バス(株)',
      ownStopIds: ['S2'],
      otherStops: [others[6]],
      routes: [],
    })
  })

  it('自社の事業者は入らない。事業者名が分からなければ自社の停留所も他社として数える', () => {
    expect(operatorOverlap(own, others, ['道北バス(株)']).some((o) => o.targetId === 'P11:道北バス(株)')).toBe(false)
    const unknown = operatorOverlap(own, others, [])
    expect(unknown.find((o) => o.targetId === 'P11:道北バス(株)')?.ownStopIds).toEqual(['S1'])
  })

  it('300m の内外の境と、半径の指定', () => {
    const near = [stop('内', IN, BASE.lon, ['P11:a']), stop('外', OUT, BASE.lon, ['P11:b'])]
    const ownOne = [{ id: 'S1', lat: BASE.lat, lon: BASE.lon }]
    expect(operatorOverlap(ownOne, near, []).map((o) => o.targetId)).toEqual(['P11:a'])
    expect(operatorOverlap(ownOne, near, [], 400).map((o) => o.targetId)).toEqual(['P11:a', 'P11:b'])
    expect(operatorOverlap(ownOne, near, [], 100)).toEqual([])
  })

  it('同じ停留所が複数の自社の停留所の近くにあっても1回だけ数える', () => {
    const twins = [
      { id: 'A', lat: BASE.lat, lon: BASE.lon },
      { id: 'B', lat: BASE.lat + 0.0001, lon: BASE.lon },
      { id: 'A', lat: BASE.lat, lon: BASE.lon }, // 同じ stop_id が2回あっても1回
    ]
    const r = operatorOverlap(twins, [stop('間', BASE.lat + 0.0005, BASE.lon, ['P11:a'], ['x', 'x'])], [])
    expect(r).toHaveLength(1)
    expect(r[0].ownStopIds).toEqual(['A', 'B'])
    expect(r[0].otherStops).toHaveLength(1)
    expect(r[0].routes).toEqual(['x'])
  })

  it('他社の停留所や自社の停留所が無ければ空', () => {
    expect(operatorOverlap([], others, [])).toEqual([])
    expect(operatorOverlap(own, [], [])).toEqual([])
  })
})
