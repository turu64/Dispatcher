/** 手順の欄の id。チャットの「手順へ移る」ボタンが、下書きを確かめる手順へ移るときに使う */
export const STEP_IDS = {
  policy: 'step-policy',
  restore: 'step-restore',
} as const

export type StepKey = keyof typeof STEP_IDS

/** 該当する手順の欄へ移る(スクロールして、焦点を置く) */
export function jumpToStep(step: StepKey): void {
  const el = document.getElementById(STEP_IDS[step])
  if (!el) return
  el.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}
