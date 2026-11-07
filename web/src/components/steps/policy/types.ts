import type { BaseGtfs, Draft } from '@/store/edit'

export type OpDraft = Extract<Draft, { kind: 'op' }>
export type ChoiceRole = 'weekday' | 'saturday' | 'sundayHoliday'

export interface Override {
  value: string
  /** 選んだときの推定(期間を変えて推定が変わったら知らせるため) */
  guessAtPick: string | null
}

// 読み込んだ基準ごとに、方針の入力欄を作り直すための番号
const baseKeys = new WeakMap<BaseGtfs, number>()
let nextBaseKey = 1
export function baseKeyOf(base: BaseGtfs): number {
  let k = baseKeys.get(base)
  if (k === undefined) baseKeys.set(base, (k = nextBaseKey++))
  return k
}
