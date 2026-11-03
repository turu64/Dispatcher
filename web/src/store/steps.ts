import { create } from 'zustand'
import { useEditStore } from './edit'

/**
 * 手順の鍵。画面に出す並びと見出しは components/steps/registry.ts の手順の一覧が決め、
 * ここには「ありうる手順」だけを置く(一覧から外した鍵は、並びに入らないので開かれない)
 */
export const STEP_KEYS = ['load', 'research', 'policy', 'dateBand', 'reach', 'restore', 'output'] as const

export type StepKey = (typeof STEP_KEYS)[number]

interface StepState {
  /** 手順の並び。手順の一覧(registry.ts)が読み込まれたときに setOrder で入れる。先頭は GTFS の読み込み */
  order: readonly StepKey[]
  /** 開いている手順 */
  current: StepKey
  setOrder: (order: readonly StepKey[]) => void
  /** 見出しから移る。開けない手順なら何もせず false */
  go: (key: StepKey) => boolean
  /** 次の手順へ。開けなければ何もせず false */
  next: () => boolean
  /** 前の手順へ。先頭なら何もせず false */
  back: () => boolean
}

/** GTFS を読み込んだか(編集の基準があるか)。読み込む前は、先頭の手順(読み込み)より先へ進めない */
function loaded(): boolean {
  return useEditStore.getState().base !== null
}

/**
 * その手順を開けるか。先頭(読み込み)はいつでも開ける。それ以外は GTFS を読み込んだあとなら、どれでも開ける
 * (各手順は空の状態の案内を持っており、順番を強く縛ると試行錯誤を妨げるため。docs/tasks-1103.md の指摘3)
 */
export function canOpenStep(key: StepKey, order: readonly StepKey[], isLoaded: boolean): boolean {
  if (!order.includes(key)) return false
  return key === order[0] || isLoaded
}

/**
 * 左の欄の手順の切り替え(ステッパー)。開いている手順だけを見せ、ほかの手順は隠す(消さないので、入力中の値は残る)。
 * 移るのは、見出しのボタン(layout/Stepper)、下の「次へ」「戻る」(layout/StepNav)、AI の下書きの「手順へ移る」(steps/stepIds.ts)
 */
export const useStepStore = create<StepState>()((set, get) => ({
  order: STEP_KEYS,
  current: STEP_KEYS[0],
  setOrder: (order) => {
    const { current } = get()
    set({ order, current: order.includes(current) ? current : order[0] })
  },
  go: (key) => {
    const { order, current } = get()
    if (!canOpenStep(key, order, loaded())) return false
    if (key !== current) set({ current: key })
    return true
  },
  next: () => {
    const { order, current } = get()
    const i = order.indexOf(current)
    if (i < 0 || i + 1 >= order.length) return false
    return get().go(order[i + 1])
  },
  back: () => {
    const { order, current } = get()
    const i = order.indexOf(current)
    if (i <= 0) return false
    return get().go(order[i - 1])
  },
}))

/** GTFS を捨てたとき(読み込み直しの始めなど)は、先頭の手順(読み込み)に戻す */
useEditStore.subscribe((s, prev) => {
  if (s.base === null && prev.base !== null) {
    const { order, current } = useStepStore.getState()
    if (current !== order[0]) useStepStore.setState({ current: order[0] })
  }
})
