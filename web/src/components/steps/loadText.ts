import { draftName, type Draft } from '@/store/edit'

/** 削除の確かめの文。消える編集(承認待ちの下書き・承認済みの編集)があれば数を添える */
export function deleteConfirmMessage({ draft, committed, sample }: { draft: Pick<Draft, 'id'> | null; committed: number; sample: boolean }): string {
  const parts = ['読み込んだ GTFS と、減便の方針・平日に戻した便などの編集、運行の前提(在籍の運転士の数・営業所)と欠員、周辺の施設の調査の結果、AI との会話を消して、最初の状態に戻します。']
  // 「下書き #1」の番号の後ろは空けて続ける(「下書き #1 も」)
  const pending = draft ? `承認待ちの${draftName(draft.id)} ` : null
  const done = committed > 0 ? `承認済みの編集 ${committed} 件` : null
  if (pending && done) parts.push(`${pending}と、${done}も消えます。`)
  else if (pending || done) parts.push(`${pending ?? done}も消えます。`)
  parts.push(sample ? 'サンプルは、もう一度読み込めます。' : 'パソコンの中の元のファイルは消えません。')
  return parts.join('')
}

/** 削除の確かめ(AlertDialog)の見出しとボタン */
export const DELETE_DIALOG_TITLE = '読み込んだ GTFS を削除しますか'
export const DELETE_DIALOG_CONFIRM = '削除する'
export const DELETE_DIALOG_CANCEL = 'やめる'
