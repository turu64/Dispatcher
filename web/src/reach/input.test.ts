import { describe, expect, it } from 'vitest'
import { makeBands } from '@/gtfs/departures'
import {
  bandIndexForHour,
  buildReachStops,
  cloneParams,
  maxWalkRadiusM,
  parseDensityThreshold,
  parseWalkMinutes,
} from './input'
import { DEFAULT_REACH_PARAMS } from './reach'

describe('cloneParams', () => {
  it('入れ子まで写す(写しを変えても既定値は変わらない)', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    expect(p).toEqual(DEFAULT_REACH_PARAMS)
    p.walkMinutes.urban.bus = 7
    p.densityThreshold = 5
    expect(DEFAULT_REACH_PARAMS.walkMinutes.urban.bus).toBe(5)
    expect(DEFAULT_REACH_PARAMS.densityThreshold).toBe(1000)
  })
})

describe('maxWalkRadiusM', () => {
  it('既定では中山間・地方の駅 20分 × 80m = 1,600m', () => {
    expect(maxWalkRadiusM(DEFAULT_REACH_PARAMS)).toBe(1600)
  })

  it('バス停の分数が最大ならそれを使う', () => {
    const p = cloneParams(DEFAULT_REACH_PARAMS)
    p.walkMinutes.urban.bus = 30
    expect(maxWalkRadiusM(p)).toBe(2400)
  })
})

describe('buildReachStops', () => {
  const stops = [
    { id: 'A', lat: 43.7, lon: 142.3 },
    { id: 'B', lat: 43.8, lon: 142.4 },
    { id: 'A', lat: 43.71, lon: 142.31 },
  ]

  it('counts の値を時間帯ごとに並べ、無い停留所は 0 で埋める', () => {
    const counts = new Map([['A', [1, 0, 2]]])
    expect(buildReachStops(stops, counts, 3)).toEqual([
      { lat: 43.7, lon: 142.3, bandCounts: [1, 0, 2] },
      { lat: 43.8, lon: 142.4, bandCounts: [0, 0, 0] },
      { lat: 43.71, lon: 142.31, bandCounts: [1, 0, 2] },
    ])
  })

  it('counts の配列が短ければ、足りない時間帯は 0', () => {
    expect(buildReachStops(stops.slice(0, 1), new Map([['A', [4]]]), 3)[0].bandCounts).toEqual([4, 0, 0])
  })

  it('counts の配列を共有しない(書き換えても counts は変わらない)', () => {
    const counts = new Map([['A', [1, 1, 1]]])
    const r = buildReachStops(stops.slice(0, 1), counts, 3)
    r[0].bandCounts[0] = 9
    expect(counts.get('A')).toEqual([1, 1, 1])
  })
})

describe('bandIndexForHour', () => {
  const three = makeBands(3)
  const one = makeBands(1)

  it('その時刻を含む時間帯', () => {
    expect(bandIndexForHour(three, 6)).toBe(0)
    expect(bandIndexForHour(three, 8)).toBe(0)
    expect(bandIndexForHour(three, 9)).toBe(1)
    expect(bandIndexForHour(three, 23)).toBe(5)
    expect(bandIndexForHour(one, 10)).toBe(4)
    expect(bandIndexForHour(one, 23)).toBe(17)
  })

  it('3時間ごとと1時間ごとを行き来しても、同じ時刻を含む時間帯になる', () => {
    for (let h = 6; h < 24; h++) {
      const b3 = three[bandIndexForHour(three, h)]
      const b1 = one[bandIndexForHour(one, h)]
      expect(b3.startHour <= b1.startHour && b1.endHour <= b3.endHour).toBe(true)
    }
  })

  it('範囲の外は近いほうの端。時間帯が無ければ -1', () => {
    expect(bandIndexForHour(three, 3)).toBe(0)
    expect(bandIndexForHour(three, 24)).toBe(5)
    expect(bandIndexForHour([], 9)).toBe(-1)
  })
})

describe('parseWalkMinutes', () => {
  it('0〜60 の数を読む(小数・全角も読む)', () => {
    expect(parseWalkMinutes('5')).toEqual({ ok: true, value: 5 })
    expect(parseWalkMinutes(' 12.5 ')).toEqual({ ok: true, value: 12.5 })
    expect(parseWalkMinutes('０')).toEqual({ ok: true, value: 0 })
    expect(parseWalkMinutes('１５')).toEqual({ ok: true, value: 15 })
    expect(parseWalkMinutes('60')).toEqual({ ok: true, value: 60 })
  })

  it('空・負・数でない値・上限を超える値は理由を返す', () => {
    expect(parseWalkMinutes('')).toEqual({ ok: false, message: '数を入れてください' })
    expect(parseWalkMinutes('-1')).toEqual({ ok: false, message: '0 以上の数を入れてください' })
    expect(parseWalkMinutes('1e2')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('0x10')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('abc')).toMatchObject({ ok: false })
    expect(parseWalkMinutes('61')).toEqual({ ok: false, message: '60分以下にしてください' })
  })
})

describe('parseDensityThreshold', () => {
  it('0〜100,000 の数を読む', () => {
    expect(parseDensityThreshold('1000')).toEqual({ ok: true, value: 1000 })
    expect(parseDensityThreshold('0')).toEqual({ ok: true, value: 0 })
  })

  it('上限を超えれば理由を返す', () => {
    expect(parseDensityThreshold('100001')).toEqual({ ok: false, message: '100,000人/km²以下にしてください' })
    expect(parseDensityThreshold('1,000')).toMatchObject({ ok: false })
  })
})
