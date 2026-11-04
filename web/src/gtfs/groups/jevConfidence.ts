/**
 * Jev の答えの確信の高さのしきい値(docs/design-service-groups.md §3.4・§6.1)。ここ1か所で決める。
 * merge.ts が JEV_CONFIDENCE として出す(rules.ts との循環を避けるため、別のファイルに置く)
 */
import type { JevChoice } from './types'

export const JEV_CONFIDENCE = {
  /** providerMetadata.typesafe.confidence がこの値以上 */
  confidence: 0.9,
  /** 選んだ値の確率がこの値以上 */
  probability: 0.8,
  /** is_school_service の確率がこの値以上なら、学校の便とみた文を足す */
  school: 0.7,
} as const

/** 確信が高い:確信度が 0.9 以上で、選んだ値の確率が 0.8 以上。確信度が無ければ低い */
export function isConfident(choice: JevChoice): boolean {
  const p = choice.probabilities[choice.choice]
  return (
    choice.confidence !== null &&
    choice.confidence >= JEV_CONFIDENCE.confidence &&
    p !== undefined &&
    p >= JEV_CONFIDENCE.probability
  )
}
