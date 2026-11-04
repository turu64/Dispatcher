/**
 * 減便の期間のカレンダーで日を押したときに、開始日・終了日をどう変えるか。日付は 'YYYYMMDD'(まだ決まっていなければ '')。
 *
 * - 当面の間なら、押した日を開始日にする(終了日は使わない)
 * - 開始日がまだなら、押した日を開始日にする
 * - 開始日だけ決まっていて、押した日が開始日より前なら、それを新しい開始日にする。開始日と同じ日か後なら終了日にする(同じ日も選べる)
 * - 開始日と終了日が決まっていれば、押した日を新しい開始日にして選び直す(終了日は空にする)
 */
export function nextPeriod(
  current: { start: string; end: string; indefinite: boolean },
  clicked: string,
): { start: string; end: string } {
  const { start, end, indefinite } = current
  if (indefinite) return { start: clicked, end }
  if (!start) return { start: clicked, end: '' }
  if (!end) return clicked < start ? { start: clicked, end: '' } : { start, end: clicked }
  return { start: clicked, end: '' }
}

/** 開始日から終了日までの日数(両端を含む)。'20261109'〜'20261130' → 22 */
export function periodDays(start: string, end: string): number {
  const utc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  return Math.round((utc(end) - utc(start)) / 86_400_000) + 1
}
