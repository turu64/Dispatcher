import { flushSync } from 'react-dom'
import { useSidePanelStore } from '@/store/sidePanel'
import { useStepStore, type StepKey } from '@/store/steps'

/** 手順の欄の id。チャットの下書きの知らせの「編集で確かめる」ボタンが、下書きを確かめる手順へ移るときに使う */
export const STEP_IDS = {
  policy: 'step-policy',
  restore: 'step-restore',
} as const

/** AI の下書きから移れる手順(store/steps.ts の手順の鍵と同じ名前) */
export type JumpStepKey = keyof typeof STEP_IDS

/**
 * 運行の前提の手順の「運行の前提」の欄(research/OperationPremise.tsx)の id。
 * 影響(到達圏)の手順の「要る運転士の数(目安)」の欄の「運行の前提で設定する」ボタンが移る先
 */
export const PREMISE_SECTION_ID = 'operation-premise'

/**
 * 減便の方針の手順の欠員の欄(policy/ShortageSection.tsx)の id。
 * 影響(到達圏)の手順の「要る運転士の数(目安)」の欄の「欠員を入れる(減便の方針)」ボタンが移る先(入力欄の id「driver-shortage」とは別)
 */
export const SHORTAGE_SECTION_ID = 'driver-shortage-section'

/**
 * 左の欄を「編集」のタブにして手順を開き、その中の要素へ移る(スクロールして、焦点を置く)。
 * 開く前の手順の欄(と「編集」のタブ)は隠れているので、開いた描画を済ませてから焦点を置く
 */
export function jumpToElement(step: StepKey, elementId: string): void {
  flushSync(() => {
    useSidePanelStore.getState().show('edit')
    useStepStore.getState().go(step)
  })
  const el = document.getElementById(elementId)
  if (!el) return
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

/** 左の欄を「編集」のタブにして該当する手順を開き、その欄へ移る */
export function jumpToStep(step: JumpStepKey): void {
  jumpToElement(step, STEP_IDS[step])
}

/** 運行の前提の手順を開き、「運行の前提」の欄へ移る */
export function jumpToPremise(): void {
  jumpToElement('premise', PREMISE_SECTION_ID)
}

/** 減便の方針の手順を開き、欠員の欄へ移る */
export function jumpToShortage(): void {
  jumpToElement('policy', SHORTAGE_SECTION_ID)
}
