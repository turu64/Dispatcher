/**
 * 規則の案と Jev の答えの合わせ(docs/design-service-groups.md §3.4)。
 *
 * 合わせ方の表は rules.ts の組み立ての中にある(規則の値が既定。Jev は食い違いの印を付け、規則で決まらないものだけを埋める)。
 * ここでは、答えを差し替えて組み立て直すだけにする。利用者が直した行(edited)はそのまま残る。
 */
import { buildByKind, editsOf } from './rules'
import type { JevJudgeResponse, ServiceGroups } from './types'

export { JEV_CONFIDENCE, isConfident } from './jevConfidence'

/** Jev の答えを合わせる。前の答えは捨てて、この答えだけを使う */
export function mergeJevAnswers(groups: ServiceGroups, response: JevJudgeResponse): ServiceGroups {
  const jev = [...response.results]
  return { ...groups, jev, byKind: buildByKind(groups.features, jev, editsOf(groups)) }
}

/** Jev の答えを捨て、規則の案にする(利用者が直した行は残す) */
export function dropJevAnswers(groups: ServiceGroups): ServiceGroups {
  return { ...groups, jev: null, byKind: buildByKind(groups.features, null, editsOf(groups)) }
}
