import { stepOf } from '@/components/steps/registry'
import type { JumpStepKey } from '@/components/steps/stepIds'

/** 下書きを確かめる手順の名前(「3. 減便の方針」)。番号は手順の一覧(steps/registry.ts)の並びから出す */
export function stepTitle(step: JumpStepKey): string | null {
  const found = stepOf(step)
  return found ? `「${found.number}. ${found.def.title}」` : null
}

/** 下書きを確かめる手順を文中で指す形(docs/wording.md の 手順「n. 名前」) */
export function stepLabel(step: JumpStepKey): string {
  const title = stepTitle(step)
  return title ? `手順${title}` : '下書きの手順'
}
