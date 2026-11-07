import { afterEach, describe, expect, it } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { useEditStore } from './edit'
import { canOpenStep, STEP_KEYS, useStepStore } from './steps'

function loadBase() {
  useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
}

afterEach(() => {
  useEditStore.getState().setBase(null)
  useStepStore.setState({ order: STEP_KEYS, current: 'load' })
})

describe('手順の切り替え', () => {
  it('最初は読み込みの手順を開いている', () => {
    expect(useStepStore.getState().current).toBe('load')
  })

  it('GTFS を読み込む前は、読み込みより先へ進めない(見出しからも次へでも)', () => {
    const s = useStepStore.getState()
    expect(s.go('policy')).toBe(false)
    expect(s.next()).toBe(false)
    expect(s.go('output')).toBe(false)
    expect(useStepStore.getState().current).toBe('load')
    expect(s.go('load')).toBe(true)
  })

  it('読み込んだあとは、見出しからどの手順へも移れ、次へ・戻るで並びの順に動く', () => {
    loadBase()
    const s = useStepStore.getState()
    expect(s.go('restore')).toBe(true)
    expect(useStepStore.getState().current).toBe('restore')
    expect(s.next()).toBe(true)
    expect(useStepStore.getState().current).toBe('output')
    // 最後の手順の次は無い
    expect(s.next()).toBe(false)
    expect(useStepStore.getState().current).toBe('output')
    expect(s.back()).toBe(true)
    expect(useStepStore.getState().current).toBe('restore')
    expect(s.go('load')).toBe(true)
    // 先頭の前は無い
    expect(s.back()).toBe(false)
    expect(useStepStore.getState().current).toBe('load')
  })

  it('GTFS を捨てると(読み込み直しの始め)、読み込みの手順に戻る', () => {
    loadBase()
    useStepStore.getState().go('reach')
    useEditStore.getState().setBase(null)
    expect(useStepStore.getState().current).toBe('load')
  })

  it('並びから外した手順へは移れず、並びを替えると開いている手順が無ければ先頭に戻る', () => {
    loadBase()
    useStepStore.getState().go('restore')
    useStepStore.getState().setOrder(['load', 'premise', 'policy', 'reach', 'output'])
    expect(useStepStore.getState().current).toBe('load')
    expect(useStepStore.getState().go('restore')).toBe(false)
    // 次へは、新しい並びの順に動く
    useStepStore.getState().go('policy')
    useStepStore.getState().next()
    expect(useStepStore.getState().current).toBe('reach')
  })
})

describe('canOpenStep', () => {
  it('先頭はいつでも、ほかは読み込んだあとだけ開ける', () => {
    expect(canOpenStep('load', STEP_KEYS, false)).toBe(true)
    expect(canOpenStep('premise', STEP_KEYS, false)).toBe(false)
    expect(canOpenStep('premise', STEP_KEYS, true)).toBe(true)
    expect(canOpenStep('restore', ['load', 'reach'], true)).toBe(false)
  })
})
