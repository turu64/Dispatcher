/**
 * 前提情報の調査の結果から、行に出す要点と、欄の先頭に出すまとめを作る(2026-11-07 に利用者の指示で、
 * 事実をすべて並べる形から、判断に使う時刻とバスの案内だけを出す形にした。事実のすべては閉じた開閉の中に残す)。
 *
 * 時刻は、平日便を戻す判断材料(学校・病院に着く便・出る便)と同じ読み方(gtfs/edit/facilityHours.ts の facilityWindows)
 * で読む。ここで読めた時刻が、そのまま判断材料の時間帯の窓になる。読めなければ既定の窓を使うことを書く
 */
import type { ResearchFact, ResearchResult } from '@/claude/research'
import { FACILITY_WINDOWS, facilityWindows, type FacilityWindow } from '@/gtfs/edit/facilityHours'
import { OPERATOR_MOVEMENT_LABEL, operatorMovementFacts } from '@/ref/facilities'

/** 行に出す時刻の1つ(「外来の受付 8:00〜11:30」「始業 8:40」)。source は出典の番号(1 から。分からなければ null) */
export interface HighlightTime {
  text: string
  source: number | null
}

export interface ResultHighlights {
  /** 読めた時刻(同じ文は1つにまとめる)。読めなければ空 */
  times: HighlightTime[]
  /** 時刻が読めなかったときの文(読めたら null) */
  timeMissing: string | null
  /** バス・停留所の案内の事実(無ければ null) */
  access: ResearchFact | null
}

function rangeText([from, to]: readonly [number, number]): string {
  return `${from}〜${to}時`
}

/** 学校で、始業・終業の時刻を読めなかったときの文 */
export const SCHOOL_TIME_MISSING = `始業・終業の時刻は見つかりませんでした。判断材料は既定の時間帯(着く ${rangeText(FACILITY_WINDOWS.school.arrive)}・出る ${rangeText(FACILITY_WINDOWS.school.depart)})で数えます。`
/** 病院・診療所で、外来の受付の時刻を読めなかったときの文 */
export const HOSPITAL_TIME_MISSING = `外来の受付の時刻を読めませんでした。判断材料は既定の時間帯(着く ${rangeText(FACILITY_WINDOWS.hospital.arrive)}・出る ${rangeText(FACILITY_WINDOWS.hospital.depart)})で数えます。`

// バス・停留所の案内の label。最寄りの停留所を先に選ぶ
const ACCESS_FIRST = /最寄|停留所|バス停/
const ACCESS_LABEL = /バス|停留所|バス停|交通|アクセス/

/** 窓を読んだ事実の出典の番号 */
function sourceOf(result: ResearchResult, w: FacilityWindow): number | null {
  if (!w.fact) return null
  const f = result.facts.find((x) => x.label === w.fact!.label && x.value === w.fact!.value)
  return f && f.source >= 1 && f.source <= result.sources.length ? f.source : null
}

/** バス・停留所の案内の事実(減便などの動きの事実は除く) */
function accessFact(facts: readonly ResearchFact[]): ResearchFact | null {
  const usable = facts.filter((f) => ACCESS_LABEL.test(f.label) && !OPERATOR_MOVEMENT_LABEL.test(f.label))
  return usable.find((f) => ACCESS_FIRST.test(f.label)) ?? usable[0] ?? null
}

/** 学校・病院・診療所の結果の要点。事業者の結果は時刻を読まない(times は空、timeMissing は null) */
export function resultHighlights(result: ResearchResult): ResultHighlights {
  if (result.kind === 'operator') return { times: [], timeMissing: null, access: null }
  const windows = facilityWindows(result.kind, result.facts)
  const times: HighlightTime[] = []
  for (const w of [windows.arrive, windows.depart]) {
    if (w.source !== 'research' || !w.basis || times.some((t) => t.text === w.basis)) continue
    times.push({ text: w.basis, source: sourceOf(result, w) })
  }
  const timeMissing = times.length > 0 ? null : result.kind === 'school' ? SCHOOL_TIME_MISSING : HOSPITAL_TIME_MISSING
  return { times, timeMissing, access: accessFact(result.facts) }
}

/** 欄の先頭のまとめの1行 */
export interface SummaryRow {
  key: 'medical' | 'school' | 'operator'
  label: string
  /** 調べた結果のある数 */
  total: number
  /** そのうち、時刻を読めた(事業者は減便などの動きの事実がある)数 */
  hit: number
  /** hit の意味(「外来の受付の時刻を読めた」など) */
  hitLabel: string
}

/** 調べた結果のまとめ。結果の無い種類の行は出さない */
export function researchSummary(results: readonly ResearchResult[]): SummaryRow[] {
  const rows: SummaryRow[] = [
    { key: 'medical', label: '病院・診療所', total: 0, hit: 0, hitLabel: '外来の受付の時刻を読めた' },
    { key: 'school', label: '学校', total: 0, hit: 0, hitLabel: '始業・終業の時刻を読めた' },
    { key: 'operator', label: '周辺の事業者', total: 0, hit: 0, hitLabel: '減便・ダイヤ改正などの動きがある' },
  ]
  for (const r of results) {
    const row = rows.find((x) => x.key === (r.kind === 'operator' ? 'operator' : r.kind === 'school' ? 'school' : 'medical'))!
    row.total += 1
    if (r.kind === 'operator' ? operatorMovementFacts(r.facts).length > 0 : resultHighlights(r).times.length > 0) row.hit += 1
  }
  return rows.filter((x) => x.total > 0)
}
