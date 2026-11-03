import { describe, expect, it } from 'vitest'
import { PRINT_COLS, splitParts } from './printColumns'

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('splitParts', () => {
  it('limit 件以下なら分けない', () => {
    expect(splitParts(range(12), 12, 3)).toEqual([range(12)])
    expect(splitParts([], 12, 3)).toEqual([[]])
  })

  it('1つあたり limit 件以下になるよう等分する。並びと件数は変えない', () => {
    const parts = splitParts(range(13), 12, 3)
    expect(parts.map((p) => p.length)).toEqual([7, 6])
    expect(parts.flat()).toEqual(range(13))
    expect(splitParts(range(25), 12, 3).map((p) => p.length)).toEqual([9, 9, 7])
  })

  it('maxParts 個で足りなければ、1つあたりが limit を超える(行は落とさない)', () => {
    const parts = splitParts(range(45), 12, 3)
    expect(parts.map((p) => p.length)).toEqual([15, 15, 15])
    expect(splitParts(range(20), 8, 2).map((p) => p.length)).toEqual([10, 10])
  })

  it('分けた数ごとに、印刷の段組みのクラスがある', () => {
    for (const n of [2, 3]) expect(PRINT_COLS[n]).toBe(`print:grid-cols-${n}`)
    expect(PRINT_COLS[1]).toBe('')
  })
})
