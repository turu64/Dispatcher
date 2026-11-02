/**
 * 到達圏の結果を、画面の表に出す数にまとめる。数はコードが出す(Claude や画面の部品は数えない)。
 */
import type { ReachResult, RegionClass } from './reach'

export interface BandSummary {
  /** 徒歩圏から外れるセルの数 */
  unreachableCells: number
  /** 徒歩圏から外れるセルの推計人口の合計(参照データが無ければ 0) */
  unreachablePopulation: number
}

export interface ReachSummary {
  /** 調べたセルの数 */
  totalCells: number
  /** 調べたセルの推計人口の合計 */
  totalPopulation: number
  /** 区分ごとのセルの数 */
  cellsByClass: Record<RegionClass, number>
  /** 時間帯ごと(結果の reachable と同じ並び) */
  bands: BandSummary[]
}

export function summarizeReach(result: ReachResult): ReachSummary {
  const cellsByClass: Record<RegionClass, number> = { urban: 0, suburban: 0, rural: 0 }
  let totalPopulation = 0
  for (let i = 0; i < result.cells.length; i++) {
    cellsByClass[result.classes[i]]++
    totalPopulation += result.cellPopulation[i] ?? 0
  }
  const bands = result.reachable.map((row) => {
    let unreachableCells = 0
    let unreachablePopulation = 0
    for (let i = 0; i < row.length; i++) {
      if (row[i]) continue
      unreachableCells++
      unreachablePopulation += result.cellPopulation[i] ?? 0
    }
    return { unreachableCells, unreachablePopulation }
  })
  return { totalCells: result.cells.length, totalPopulation, cellsByClass, bands }
}

/** 割合(%)を小数1桁の文字にする。分母が 0 なら '—' */
export function formatPercent(part: number, total: number): string {
  if (!(total > 0)) return '—'
  return `${((part / total) * 100).toFixed(1)}%`
}

/** 人数・件数を3桁区切りにする。推計人口は 0.25 人単位なので、整数に丸めて出す */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('ja-JP')
}
