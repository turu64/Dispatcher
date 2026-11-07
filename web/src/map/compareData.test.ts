import { describe, expect, it } from 'vitest'
import type { Stop } from '@/gtfs/parse'
import type { ReachResult } from '@/reach/reach'
import { cellsWithBaseline, diffCountsOf, stationsNear, zeroStopsToGeoJson } from './compareData'

const BEFORE: ReachResult = {
  cells: ['65420000111', '65420000112', '65420000113', '65420000114'],
  classes: ['urban', 'urban', 'urban', 'urban'],
  // 時間帯 0:前は 1・2 番目に到達、時間帯 1:前は 3 番目だけ
  reachable: [
    [true, true, false, false],
    [false, false, true, false],
  ],
  coverable: [true, true, true, false],
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [1, 2, 3, 4],
}
const AFTER: ReachResult = {
  ...BEFORE,
  // 時間帯 0:後は 1 番目だけ(2 番目は減便で外れた)、3 番目が新たに到達
  reachable: [
    [true, false, true, false],
    [false, false, false, false],
  ],
}

describe('cellsWithBaseline', () => {
  it('基準があれば、見込みのあるセルに基準の可否 m0 を足す(m は表示する側)', () => {
    const fc = cellsWithBaseline(AFTER, BEFORE)
    expect(fc.features.map((f) => [f.properties.code, f.properties.m0, f.properties.m])).toEqual([
      ['65420000111', 1, 1],
      ['65420000112', 1, 0],
      ['65420000113', 2, 1],
    ])
  })

  it('基準が無ければ m0 を入れない', () => {
    expect(cellsWithBaseline(AFTER).features.every((f) => f.properties.m0 === undefined)).toBe(true)
  })
})

describe('diffCountsOf', () => {
  it('見込みのあるセルを、減便で外れた・両方で外れる・新たに到達・両方で到達に数える', () => {
    expect(diffCountsOf(BEFORE, AFTER, 0)).toEqual({ lost: 1, bothUnreachable: 0, bothReachable: 1, gained: 1 })
    expect(diffCountsOf(BEFORE, AFTER, 1)).toEqual({ lost: 1, bothUnreachable: 2, bothReachable: 0, gained: 0 })
    expect(diffCountsOf(BEFORE, AFTER, 5)).toBeNull()
  })
})

describe('stationsNear', () => {
  const origin = { lat: 43.77, lon: 142.36 }
  const stations = [
    { name: '近い駅', line: '函館線', lat: 43.78, lon: 142.36 }, // 約 1.1km
    { name: '少し遠い駅', line: '宗谷線', lat: 43.79, lon: 142.36 }, // 約 2.2km
    { name: '遠い駅', line: '石北線', lat: 43.8, lon: 143.9 }, // 北見のあたり
  ]

  it('起点から「バス停の距離の最大 + 駅の距離の最大」以内の駅だけを出す', () => {
    expect(stationsNear(stations, [origin], 2800).map((s) => s.name)).toEqual(['近い駅', '少し遠い駅'])
    expect(stationsNear(stations, [origin], 1500).map((s) => s.name)).toEqual(['近い駅'])
  })

  it('起点が無ければ(または範囲外の点だけなら)駅を出さない', () => {
    expect(stationsNear(stations, [], 2800)).toEqual([])
    expect(stationsNear(stations, [{ lat: 0, lon: 0 }], 2800)).toEqual([])
  })
})

describe('zeroStopsToGeoJson', () => {
  it('運行がゼロになる停留所を、起点の停留所の位置で点にする(位置の分からないものは出さない)', () => {
    const origins: Stop[] = [
      { id: 'A', name: '駅前', lat: 43.76, lon: 142.36, locationType: 0, parentStation: '' },
      { id: 'Z', name: '範囲外', lat: 0, lon: 0, locationType: 0, parentStation: '' },
    ]
    const fc = zeroStopsToGeoJson(
      [
        { stopId: 'A', name: '駅前', beforeDepartures: 3, scope: 'feed' },
        { stopId: 'Z', name: '範囲外', beforeDepartures: 1, scope: 'day' },
        { stopId: 'X', name: '無い', beforeDepartures: 1, scope: 'day' },
      ],
      origins,
    )
    expect(fc.features).toEqual([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [142.36, 43.76] }, properties: { id: 'A', name: '駅前', scope: 'feed' } },
    ])
  })
})
