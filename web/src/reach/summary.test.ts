import { describe, expect, it } from 'vitest'
import type { ReachResult } from './reach'
import { formatCount, formatPercent, summarizeReach } from './summary'

const RESULT: ReachResult = {
  cells: ['65420000111', '65420000112', '65420000113', '65420000114'],
  classes: ['urban', 'suburban', 'rural', 'rural'],
  reachable: [
    [true, true, false, false],
    [true, false, false, true],
  ],
  // 3つ目のセルは、どの時間帯でも届かない(ダイヤと関係なく外れる)
  coverable: [true, true, false, true],
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [10, 2.5, 7.25, 0.5],
}

describe('summarizeReach', () => {
  it('調べたセルの内訳、到達できる見込みのあるセル、時間帯ごとの外れるセル(見込みのあるセルの中)を数える', () => {
    expect(summarizeReach(RESULT)).toEqual({
      totalCells: 4,
      totalPopulation: 20.25,
      cellsByClass: { urban: 1, suburban: 1, rural: 2 },
      coverableCells: 3,
      coverablePopulation: 13,
      nonCoverableCells: 1,
      nonCoverablePopulation: 7.25,
      bands: [
        { unreachableCells: 1, unreachablePopulation: 0.5 },
        { unreachableCells: 1, unreachablePopulation: 2.5 },
      ],
    })
  })

  it('見込みの無いセルは、時間帯ごとの外れるセルに入れない(分子と分母の両方から除く)', () => {
    const r = summarizeReach(RESULT)
    for (const b of r.bands) expect(b.unreachableCells).toBeLessThanOrEqual(r.coverableCells)
    expect(r.coverableCells + r.nonCoverableCells).toBe(r.totalCells)
    expect(r.coverablePopulation + r.nonCoverablePopulation).toBe(r.totalPopulation)
  })

  it('すべてのセルが見込み無しなら、時間帯ごとの外れるセルは 0、分母も 0', () => {
    const r = summarizeReach({ ...RESULT, coverable: [false, false, false, false] })
    expect(r.coverableCells).toBe(0)
    expect(r.nonCoverableCells).toBe(4)
    expect(r.nonCoverablePopulation).toBe(20.25)
    expect(r.bands.map((b) => b.unreachableCells)).toEqual([0, 0])
    expect(formatPercent(r.bands[0].unreachableCells, r.coverableCells)).toBe('—')
  })

  it('セルが無ければすべて 0、時間帯の数はそのまま', () => {
    const r = summarizeReach({ ...RESULT, cells: [], classes: [], reachable: [[], []], coverable: [], cellPopulation: [] })
    expect(r.totalCells).toBe(0)
    expect(r.coverableCells).toBe(0)
    expect(r.nonCoverableCells).toBe(0)
    expect(r.bands).toEqual([
      { unreachableCells: 0, unreachablePopulation: 0 },
      { unreachableCells: 0, unreachablePopulation: 0 },
    ])
  })
})

describe('formatPercent', () => {
  it('小数1桁の割合', () => {
    expect(formatPercent(2431, 17200)).toBe('14.1%')
    expect(formatPercent(0, 10)).toBe('0.0%')
    expect(formatPercent(10, 10)).toBe('100.0%')
  })

  it('分母が 0 なら —', () => {
    expect(formatPercent(0, 0)).toBe('—')
  })
})

describe('formatCount', () => {
  it('3桁区切りで、整数に丸める', () => {
    expect(formatCount(211744.75)).toBe('211,745')
    expect(formatCount(0)).toBe('0')
  })
})
