/** 開始日から終了日までの日数(両端を含む)。'20261109'〜'20261130' → 22 */
export function periodDays(start: string, end: string): number {
  const utc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  return Math.round((utc(end) - utc(start)) / 86_400_000) + 1
}

/** 減便の文のどちらの穴(開始日・終了日)からカレンダーを開いたか */
export type PeriodTarget = 'start' | 'end'

/**
 * 開始日のカレンダーで日を押したときの、開始日・終了日。日付は 'YYYYMMDD'(まだ決まっていなければ '')。
 * 押した日を開始日にする。終了日を決めていて(当面の間でない)、押した日が終了日より後なら、終了日を空にする
 * (選び直してもらう)。当面の間では終了日を使わないので、そのままにする
 */
export function pickStartDate(
  current: { start: string; end: string; indefinite: boolean },
  clicked: string,
): { start: string; end: string } {
  const { end, indefinite } = current
  if (!indefinite && end !== '' && end < clicked) return { start: clicked, end: '' }
  return { start: clicked, end }
}
