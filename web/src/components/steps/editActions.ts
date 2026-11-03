/**
 * 編集のボタンから store(useEditStore)を呼ぶときの決まった手順(docs/interfaces-1104.md §4)。
 * - Claude の下書きがある間に利用者が編集のボタンを押したら、捨ててよいかを先に確かめる
 * - 足し戻しと取り消しは、ボタンを押したことを承認とみなし、propose のあとすぐ commit する
 */
import type { EditOp } from '@/gtfs/edit/ops'
import { useEditStore, type Draft } from '@/store/edit'

export function draftActor(draft: Draft): 'user' | 'claude' {
  return draft.kind === 'op' ? draft.record.by : draft.by
}

/** Claude の下書きがあれば、捨ててよいかを確かめる。捨ててよい(または下書きが無い)なら true */
export function confirmReplaceClaudeDraft(): boolean {
  const draft = useEditStore.getState().draft
  if (!draft || draftActor(draft) !== 'claude') return true
  return window.confirm(`Claude の下書き ${draft.id} を捨てて、この操作をしますか。`)
}

/** 利用者の操作を下書きにする。やめた(確かめで「キャンセル」)なら 'cancelled'、断られたら理由、作れたら null */
export function proposeAsUser(op: EditOp): string | 'cancelled' | null {
  if (!confirmReplaceClaudeDraft()) return 'cancelled'
  const r = useEditStore.getState().propose(op, 'user')
  return r.ok ? null : r.message
}

/**
 * 足し戻し・取り消し:下書きにしてすぐ承認する。承認できなければ下書きを捨て(履歴は変わらない)、理由を返す。
 * やめたら 'cancelled'、承認できたら null
 */
export function proposeAndCommit(op: EditOp): string | 'cancelled' | null {
  const proposed = proposeAsUser(op)
  if (proposed !== null) return proposed
  const store = useEditStore.getState()
  const committed = store.commit()
  if (committed.ok) return null
  store.discard()
  return committed.message
}
