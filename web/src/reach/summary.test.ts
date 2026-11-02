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
  usedFallback: false,
  excludedStops: 0,
  cellPopulation: [10, 2.5, 7.25, 0],
}

describe('summarizeReach', () => {
  it('時間帯ごとの外れるセルの数と推計人口、全体の数を数える', () => {
    expect(summarizeReach(RESULT)).toEqual({
      totalCells: 4,
      totalPopulation: 19.75,
      cellsByClass: { urban: 1, suburban: 1, rural: 2 },
      bands: [
        { unreachableCells: 2, unreachablePopulation: 7.25 },
        { unreachableCells: 2, unreachablePopulation: 9.75 },
      ],
    })
  })

  it('セルが無ければすべて 0、時間帯の数はそのまま', () => {
    const r = summarizeReach({ ...RESULT, cells: [], classes: [], reachable: [[], []], cellPopulation: [] })
    expect(r.totalCells).toBe(0)
    expect(r.bands).toEqual([
      { unreachableCells: 0, unreachablePopulation: 0 },
      { unreachableCells: 0, unreachablePopulation: 0 },
    ])
  })
})

describe('formatPercent', () => {
  it('小数1桁の割合', () => {
    expect(formatPercent(7989, 31108)).toBe('25.7%')
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
