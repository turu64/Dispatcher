import { create } from 'zustand'

/**
 * 重要拠点の種類(CLAUDE.md の「重要拠点の既定の優先順位」)。
 * 前提情報の手順の対象の既定の選び方と、足し戻しの手がかりの並び(T19)に使う
 */
export type PriorityKey =
  | 'inpatient_hospital'
  | 'station_airport'
  | 'high_school'
  | 'higher_education'
  | 'welfare'
  | 'government'
  | 'clinic'
  | 'junior_high'
  | 'commerce_post'
  | 'tourism'

/**
 * その種類の参照データがあるか。
 * - research:前提情報の調査の対象になる(国土数値情報の学校 P29・医療機関 P04)
 * - map:地図には出るが、調査の対象ではない(鉄道駅。国土数値情報の N02。空港のデータは無い)
 * - none:データ未対応(人工透析施設などを手で足す機能とともに見送り。docs/tasks-1103.md の T16)
 */
export type PriorityData = 'research' | 'map' | 'none'

export interface PriorityCategory {
  key: PriorityKey
  label: string
  data: PriorityData
  /** データの扱いの説明(画面に小さく出す) */
  dataNote: string
}

const RESEARCH_NOTE_SCHOOL = '国土数値情報の学校(P29)'
const RESEARCH_NOTE_MEDICAL = '国土数値情報の医療機関(P04)'
const NO_DATA = 'データ未対応'

/** 既定の優先順位(1 が最も高い)。利用者が画面で並べ替えられる */
export const DEFAULT_PRIORITY: readonly PriorityCategory[] = [
  { key: 'inpatient_hospital', label: '入院設備のある病院', data: 'research', dataNote: `${RESEARCH_NOTE_MEDICAL}。病床 20 床以上` },
  { key: 'station_airport', label: '鉄道駅・空港', data: 'map', dataNote: '鉄道駅は到達圏の地図に出す(調査の対象外)。空港はデータ未対応' },
  { key: 'high_school', label: '高校・特別支援学校', data: 'research', dataNote: `${RESEARCH_NOTE_SCHOOL}。中等教育学校を含む` },
  { key: 'higher_education', label: '大学・高専・専修学校', data: 'research', dataNote: `${RESEARCH_NOTE_SCHOOL}。短期大学・各種学校を含む` },
  { key: 'welfare', label: '介護・福祉施設', data: 'none', dataNote: NO_DATA },
  { key: 'government', label: '役所', data: 'none', dataNote: NO_DATA },
  { key: 'clinic', label: '診療所', data: 'research', dataNote: `${RESEARCH_NOTE_MEDICAL}。病床 19 床以下(歯科を除く)` },
  { key: 'junior_high', label: '中学校', data: 'research', dataNote: `${RESEARCH_NOTE_SCHOOL}。義務教育学校を含む` },
  { key: 'commerce_post', label: '商業施設・郵便局', data: 'none', dataNote: NO_DATA },
  { key: 'tourism', label: '観光地', data: 'none', dataNote: NO_DATA },
]

const BY_KEY = new Map(DEFAULT_PRIORITY.map((c) => [c.key, c]))

export function priorityCategory(key: PriorityKey): PriorityCategory {
  return BY_KEY.get(key)!
}

export const DEFAULT_PRIORITY_ORDER: readonly PriorityKey[] = DEFAULT_PRIORITY.map((c) => c.key)

/** 並びの中の順位(1 から)。並びに無ければ並びの後ろ(長さ + 1) */
export function priorityRank(order: readonly PriorityKey[], key: PriorityKey): number {
  const i = order.indexOf(key)
  return i < 0 ? order.length + 1 : i + 1
}

/** order を i 番目と i + delta 番目で入れ替えた新しい並び。範囲の外なら同じ並びを返す */
export function movePriority(order: readonly PriorityKey[], key: PriorityKey, delta: -1 | 1): readonly PriorityKey[] {
  const i = order.indexOf(key)
  const j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return order
  const next = [...order]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

interface PriorityState {
  /** 重要拠点の種類の並び(先頭が最も高い) */
  order: readonly PriorityKey[]
  /** 1つ上(delta -1)か下(+1)へ動かす */
  move: (key: PriorityKey, delta: -1 | 1) => void
  /** 既定の並びに戻す */
  reset: () => void
}

/**
 * 重要拠点の優先順位。画面(前提情報の手順)で並べ替えられる。ページを開いている間だけ持つ
 * (読み込み直すと既定に戻る。保存する機能は見送り:docs/tasks-1103.md の利用者の決定 6)
 */
export const usePriorityStore = create<PriorityState>()((set, get) => ({
  order: DEFAULT_PRIORITY_ORDER,
  move: (key, delta) => {
    const next = movePriority(get().order, key, delta)
    if (next !== get().order) set({ order: next })
  },
  reset: () => set({ order: DEFAULT_PRIORITY_ORDER }),
}))
