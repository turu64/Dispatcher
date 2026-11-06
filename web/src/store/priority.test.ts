import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITY_ORDER, movePriorityTo, usePriorityStore } from './priority'

describe('movePriorityTo(ドラッグでの並べ替え)', () => {
  it('指定した位置へ動かし、ほかの並びは保つ', () => {
    const [a, b, c, d] = DEFAULT_PRIORITY_ORDER
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, c, 0).slice(0, 4)).toEqual([c, a, b, d])
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, a, 2).slice(0, 4)).toEqual([b, c, a, d])
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, a, 2)).toHaveLength(DEFAULT_PRIORITY_ORDER.length)
  })

  it('同じ位置・範囲の外は、同じ並びをそのまま返す', () => {
    const [a] = DEFAULT_PRIORITY_ORDER
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, a, 0)).toBe(DEFAULT_PRIORITY_ORDER)
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, a, -1)).toBe(DEFAULT_PRIORITY_ORDER)
    expect(movePriorityTo(DEFAULT_PRIORITY_ORDER, a, DEFAULT_PRIORITY_ORDER.length)).toBe(DEFAULT_PRIORITY_ORDER)
  })

  it('store の moveTo で並びが変わり、reset で戻る', () => {
    const [, , c] = DEFAULT_PRIORITY_ORDER
    usePriorityStore.getState().moveTo(c, 0)
    expect(usePriorityStore.getState().order[0]).toBe(c)
    usePriorityStore.getState().reset()
    expect(usePriorityStore.getState().order).toBe(DEFAULT_PRIORITY_ORDER)
  })
})
