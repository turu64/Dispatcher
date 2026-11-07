import type { StopChange } from '@/gtfs/edit/stopDiff'

/** 停留所の一覧の並べ替え・絞り込み(画面の部品とは別に、単体でテストする) */

export type StopSort = 'change' | 'gap' | 'name'

/** 本数の増減(絶対値) */
function countDelta(s: StopChange): number {
  return Math.abs(s.after.count - s.before.count)
}

/** 発車がすべて無くなる停留所 */
export function losesAll(s: StopChange): boolean {
  return s.before.count > 0 && s.after.count === 0
}

/**
 * 最大間隔の広がりで並べるときの組。小さいほど先に出す。
 * 0:前は間隔があり、後は発車がすべて無くなる。1:前は間隔があり、後は1本だけ残る(間隔が出ない)。
 * 2:前後とも間隔がある(広がりの大きい順)。3:前に間隔が無い(前の発車が2本未満)
 */
function gapRank(s: StopChange): { group: number; growth: number } {
  const b = s.before.maxGapMin
  const a = s.after.maxGapMin
  if (b === null) return { group: 3, growth: 0 }
  if (a === null) return { group: s.after.count === 0 ? 0 : 1, growth: 0 }
  return { group: 2, growth: a - b }
}

/** 停留所名の文字コード順(読みの情報が無いので五十音順にはならないが、環境によらず同じ並びになる)、同じ名前なら stop_id の順 */
function compareName(a: StopChange, b: StopChange): number {
  if (a.stopName !== b.stopName) return a.stopName < b.stopName ? -1 : 1
  return a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0
}

/**
 * 停留所の並べ替え(元の配列は変えない)。
 * 'change':発車がすべて無くなる停留所を先頭に、次に本数の増減の大きい順、次に入れ替わる発車時刻の多い順
 * 'gap':最大間隔の広がりが大きい順。間隔のあった停留所で発車がすべて無くなるもの、1本だけ残るものは、間隔が出なくなるので先頭に置く。前に間隔が無い停留所は後ろ
 * 'name':停留所名の順
 */
export function sortStops(stops: readonly StopChange[], sort: StopSort): StopChange[] {
  const list = [...stops]
  if (sort === 'name') return list.sort(compareName)
  if (sort === 'gap') {
    return list.sort((a, b) => {
      const ra = gapRank(a)
      const rb = gapRank(b)
      return ra.group - rb.group || rb.growth - ra.growth || compareName(a, b)
    })
  }
  return list.sort(
    (a, b) =>
      Number(losesAll(b)) - Number(losesAll(a)) ||
      countDelta(b) - countDelta(a) ||
      b.added.length + b.removed.length - (a.added.length + a.removed.length) ||
      compareName(a, b),
  )
}

/** 停留所名の絞り込み(大文字小文字と前後の空白を無視した部分一致。空なら全部) */
export function filterStops(stops: readonly StopChange[], query: string): StopChange[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...stops]
  return stops.filter((s) => s.stopName.toLowerCase().includes(q))
}
