import { StepTitleContext, stripStepNumber } from '@/components/layout/stepTitle'
import { STEPS } from '@/components/steps/registry'
import { useStepStore } from '@/store/steps'

/** 手順ごとの見出しの付け替え(「2. 減便の方針」→ 一覧の並びの番号)。描くたびに作り直さないよう、先に作っておく */
const RETITLE = STEPS.map((_, i) => (title: string) => `${i + 1}. ${stripStepNumber(title)}`)

/**
 * 手順の一覧(steps/registry.ts)の手順を描き、開いている手順だけを見せる。
 * ほかの手順は消さずに隠す(入力中の値や下書きの確かめ、AI のツールが読む手順の状態を残すため)
 */
export default function StepPanels() {
  const current = useStepStore((s) => s.current)
  return (
    <>
      {STEPS.map((s, i) => (
        <div key={s.key} data-step={s.key} hidden={s.key !== current} className="flex flex-col gap-4">
          <StepTitleContext.Provider value={RETITLE[i]}>
            <s.component />
          </StepTitleContext.Provider>
        </div>
      ))}
    </>
  )
}
