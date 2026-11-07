import type { ComponentType } from 'react'
import OutputStep from '@/components/output/OutputStep'
import MapOverlays from '@/map/FacilityLayer'
import { useStepStore, type StepKey } from '@/store/steps'
import LoadStep from './LoadStep'
import PolicyStep from './PolicyStep'
import PremiseStep from './PremiseStep'
import ReachStep from './ReachStep'
import RestoreStep from './RestoreStep'

/** 手順の一覧の1項目 */
export interface StepDef {
  key: StepKey
  /** 上のステッパーに出す短い名前(各手順の欄の見出しは、部品が持つ) */
  title: string
  /** 左の欄に描く部品(props は取らない) */
  component: ComponentType
  /** 右に地図を出すか。出さない手順(表と文が中心の方針・出力)では、左の欄を広げる */
  showMap: boolean
  /**
   * 地図に重ねる部品。同じ部品を続けて使う手順の間では作り直さない(地図の位置合わせをやり直さないため)。
   * 地図を出さない手順では、直前の重ねを残しておく。
   * 地図を出す手順はすべて MapOverlays(到達圏と、平日便を戻す手順でだけ見せる施設の記号と、利用者が置いた場所)を使う
   */
  mapOverlay?: ComponentType
}

/**
 * 左の欄の手順の一覧。App.tsx はこの一覧を描くだけなので、手順を足す・外す・並べ替えるときはここだけを直す。
 * 並びは docs/tasks-1103.md の指摘3・7(読み込み → 前提情報 → 減便の方針 → 影響(到達圏。日付と時間帯を含む)→ 足し戻し → 出力)。
 * 2026-11-07 に利用者の指示で、前提情報を「運行の前提」(営業所・在籍の運転士の数など)に変え、欠員は減便の方針へ、
 * 周辺の施設の調査は平日便を戻す手順へ移した
 */
export const STEPS: readonly StepDef[] = [
  { key: 'load', title: '読み込み', component: LoadStep, showMap: true, mapOverlay: MapOverlays },
  { key: 'premise', title: '運行の前提', component: PremiseStep, showMap: true, mapOverlay: MapOverlays },
  { key: 'policy', title: '減便の方針', component: PolicyStep, showMap: false },
  { key: 'reach', title: '影響(到達圏)', component: ReachStep, showMap: true, mapOverlay: MapOverlays },
  { key: 'restore', title: '平日便を戻す', component: RestoreStep, showMap: true, mapOverlay: MapOverlays },
  { key: 'output', title: '出力', component: OutputStep, showMap: false },
]

/** 手順の項目と番号(1 から)。一覧に無い鍵なら null */
export function stepOf(key: StepKey): { def: StepDef; number: number } | null {
  const i = STEPS.findIndex((s) => s.key === key)
  return i < 0 ? null : { def: STEPS[i], number: i + 1 }
}

// 手順の切り替え(store/steps.ts)に、この一覧の並びを渡す
useStepStore.getState().setOrder(STEPS.map((s) => s.key))
