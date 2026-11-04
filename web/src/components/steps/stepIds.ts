import { flushSync } from 'react-dom'
import { useSidePanelStore } from '@/store/sidePanel'
import { useStepStore } from '@/store/steps'

/** 手順の欄の id。チャットの下書きの知らせの「編集で確かめる」ボタンが、下書きを確かめる手順へ移るときに使う */
export const STEP_IDS = {
  policy: 'step-policy',
  restore: 'step-restore',
} as const

/** AI の下書きから移れる手順(store/steps.ts の手順の鍵と同じ名前) */
export type JumpStepKey = keyof typeof STEP_IDS

/**
 * 左の欄を「編集」のタブにして該当する手順を開き、その欄へ移る(スクロールして、焦点を置く)。
 * 開く前の手順の欄(と「編集」のタブ)は隠れているので、開いた描画を済ませてから焦点を置く
 */
export function jumpToStep(step: JumpStepKey): void {
  flushSync(() => {
    useSidePanelStore.getState().show('edit')
    useStepStore.getState().go(step)
  })
  const el = document.getElementById(STEP_IDS[step])
  if (!el) return
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}
