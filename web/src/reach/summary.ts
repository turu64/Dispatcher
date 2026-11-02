/**
 * 到達圏の結果を、画面の表に出す数にまとめる。数はコードが出す(Claude や画面の部品は数えない)。
 *
 * 表の割合の分母は、到達できる見込みのあるセル(ReachResult.coverable)にする(docs/interfaces-1103.md の追記2)。
 * 見込みの無いセルは、ダイヤと関係なく(どの時間帯でも)外れるので、時間帯ごとの外れるセルには入れず、別に数える。
 */
import type { ReachResult, RegionClass } from './reach'

export interface BandSummary {
  /** 到達できる見込みのあるセルのうち、その時間帯に徒歩圏から外れるセルの数(表の割合の分子) */
  unreachableCells: number
  /** そのセルの推計人口の合計(参照データが無ければ 0) */
  unreachablePopulation: number
}

export interface ReachSummary {
  /** 調べたセルの数 */
  totalCells: number
  /** 調べたセルの推計人口の合計 */
  totalPopulation: number
  /** 調べたセルの区分ごとの数 */
  cellsByClass: Record<RegionClass, number>
  /** 到達できる見込みのあるセルの数(表の割合の分母) */
  coverableCells: number
  /** 到達できる見込みのあるセルの推計人口の合計(推計人口の割合の分母) */
  coverablePopulation: number
  /** ダイヤと関係なく外れるセル(到達できる見込みの無いセル)の数 */
  nonCoverableCells: number
  /** ダイヤと関係なく外れるセルの推計人口の合計 */
  nonCoverablePopulation: number
  /** 時間帯ごと(結果の reachable と同じ並び) */
  bands: BandSummary[]
}

export function summarizeReach(result: ReachResult): ReachSummary {
  const cellsByClass: Record<RegionClass, number> = { urban: 0, suburban: 0, rural: 0 }
  let totalPopulation = 0
  let coverableCells = 0
  let coverablePopulation = 0
  for (let i = 0; i < result.cells.length; i++) {
    const pop = result.cellPopulation[i] ?? 0
    cellsByClass[result.classes[i]]++
    totalPopulation += pop
    if (result.coverable[i]) {
      coverableCells++
      coverablePopulation += pop
    }
  }
  const bands = result.reachable.map((row) => {
    let unreachableCells = 0
    let unreachablePopulation = 0
    for (let i = 0; i < result.cells.length; i++) {
      // 見込みの無いセルは、ダイヤと関係なく外れるので数えない(別に数える)
      if (row[i] || !result.coverable[i]) continue
      unreachableCells++
      unreachablePopulation += result.cellPopulation[i] ?? 0
    }
    return { unreachableCells, unreachablePopulation }
  })
  return {
    totalCells: result.cells.length,
    totalPopulation,
    cellsByClass,
    coverableCells,
    coverablePopulation,
    nonCoverableCells: result.cells.length - coverableCells,
    nonCoverablePopulation: totalPopulation - coverablePopulation,
    bands,
  }
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
