/**
 * 編集のボタンから store(useEditStore)を呼ぶときの決まった手順(docs/interfaces-1104.md §4)。
 * - Claude の下書きがある間に利用者が編集のボタンを押したら、捨ててよいかを先に画面の中で確かめる
 *   (ブラウザ標準の確認ダイアログは使わない。ページが止まり、ブラウザ操作の自動化や録画でも困るため)。
 *   確かめる部品は editParts.tsx の InlineConfirm。ここは「確かめが要る」ことを返し、利用者が確かめたあとに
 *   `replaceClaudeDraft: true` でもう一度呼ばれる
 * - 足し戻しと取り消しは、ボタンを押したことを承認とみなし、propose のあとすぐ commit する
 */
import type { EditOp } from '@/gtfs/edit/ops'
import { useEditStore, type Draft } from '@/store/edit'

export function draftActor(draft: Draft): 'user' | 'claude' {
  return draft.kind === 'op' ? draft.record.by : draft.by
}

/** 利用者の編集が捨てることになる Claude の下書き。無ければ null */
export function claudeDraftToReplace(): Draft | null {
  const draft = useEditStore.getState().draft
  return draft && draftActor(draft) === 'claude' ? draft : null
}

/** Claude の下書きを捨ててよいかの確かめの文 */
export function replaceClaudeDraftMessage(draft: Pick<Draft, 'id'>): string {
  return `Claude の下書き ${draft.id} を捨てて、この操作をしますか。`
}

/**
 * 利用者の操作の結果。
 * - done:できた
 * - failed:断られた(message は画面に出す理由)
 * - needsConfirm:Claude の下書き(draft)を捨てることになるので、まだ何も変えていない。画面で確かめてから、
 *   replaceClaudeDraft: true で呼び直す
 */
export type UserEditResult =
  | { status: 'done' }
  | { status: 'failed'; message: string }
  | { status: 'needsConfirm'; draft: Draft }

export interface UserEditOptions {
  /** Claude の下書きを捨ててよいと、利用者が確かめた */
  replaceClaudeDraft?: boolean
}

/** 利用者の操作を下書きにする */
export function proposeAsUser(op: EditOp, options: UserEditOptions = {}): UserEditResult {
  const claude = claudeDraftToReplace()
  if (claude && !options.replaceClaudeDraft) return { status: 'needsConfirm', draft: claude }
  const r = useEditStore.getState().propose(op, 'user')
  return r.ok ? { status: 'done' } : { status: 'failed', message: r.message }
}

/**
 * 足し戻し・取り消し:下書きにしてすぐ承認する。承認できなければ下書きを捨て(履歴は変わらない)、理由を返す
 */
export function proposeAndCommit(op: EditOp, options: UserEditOptions = {}): UserEditResult {
  const proposed = proposeAsUser(op, options)
  if (proposed.status !== 'done') return proposed
  const store = useEditStore.getState()
  const committed = store.commit()
  if (committed.ok) return { status: 'done' }
  store.discard()
  return { status: 'failed', message: committed.message }
}
