import { describe, expect, it } from 'vitest'
import type { StopChange, StopSide } from '@/gtfs/edit/stopDiff'
import { filterStops, sortStops } from './stopSort'

describe('sortStops・filterStops', () => {
  const side = (count: number, maxGapMin: number | null): StopSide => ({ count, first: null, last: null, maxGapMin, byRoute: [] })
  const stop = (stopName: string, before: StopSide, after: StopSide, swaps = 0): StopChange => ({
    stopId: stopName,
    stopName,
    before,
    after,
    added: Array.from({ length: swaps }, () => ({ routeId: 'R', tripId: 't', seconds: 0, time: '00:00', headsign: '' })),
    removed: [],
    needsRepost: swaps > 0,
  })
  const a = stop('a', side(10, 30), side(9, 30), 1)
  const b = stop('b', side(10, 30), side(5, 90), 2)
  const c = stop('c', side(4, 60), side(0, null), 1)
  const d = stop('d', side(4, 20), side(4, 40), 1)

  it('変化の大きい順は、発車が無くなる停留所、本数の増減、入れ替わる本数の順', () => {
    expect(sortStops([a, b, c, d], 'change').map((s) => s.stopName)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('最大間隔が広がった順は、発車がすべて無くなる停留所、1本だけ残る停留所、広がりの大きい順、前に間隔が無い停留所の順', () => {
    // c は前に間隔があり発車がすべて無くなるので、広がりが 0 分の a より先に来る
    expect(sortStops([a, b, c, d], 'gap').map((s) => s.stopName)).toEqual(['c', 'b', 'd', 'a'])
    const one = stop('e', side(6, 45), side(1, null), 1) // 1本だけ残る
    const fresh = stop('f', side(1, null), side(3, 30), 1) // 前は1本(間隔が出ない)
    const gone = stop('g', side(1, null), side(0, null), 1) // 前も1本で、発車が無くなる
    expect(sortStops([fresh, a, one, gone, b, c, d], 'gap').map((s) => s.stopName)).toEqual(['c', 'e', 'b', 'd', 'a', 'f', 'g'])
  })

  it('元の配列は変えない。絞り込みは大文字小文字と前後の空白を無視する', () => {
    const list = [d, c, b, a]
    sortStops(list, 'name')
    expect(list.map((s) => s.stopName)).toEqual(['d', 'c', 'b', 'a'])
    expect(filterStops([stop('Aoba 駅', side(1, null), side(1, null))], ' aoba ').length).toBe(1)
    expect(filterStops(list, '')).toHaveLength(4)
  })
})
