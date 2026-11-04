import { ChevronLeft, ChevronRight } from 'lucide-react'
import { STEPS } from '@/components/steps/registry'
import { Button } from '@/components/ui/button'
import { useEditStore } from '@/store/edit'
import { canOpenStep, useStepStore } from '@/store/steps'

const KEYS = STEPS.map((s) => s.key)

/**
 * 左の欄の下の「戻る」「次へ」。手順の一覧の並びの順に移る。GTFS を読み込むまでは次へ進めない。
 * 最初の手順では「戻る」を、最後の手順では「次へ」を出さない(押せないボタンを見せないため)
 */
export default function StepNav() {
  const current = useStepStore((s) => s.current)
  const loaded = useEditStore((s) => s.base !== null)
  const i = STEPS.findIndex((s) => s.key === current)
  const prev = i > 0 ? STEPS[i - 1] : null
  const next = i >= 0 && i + 1 < STEPS.length ? STEPS[i + 1] : null
  const nextBlocked = next !== null && !canOpenStep(next.key, KEYS, loaded)

  return (
    <nav aria-label="手順の移動" className="print-hide flex shrink-0 items-center gap-2 border-t bg-background px-4 py-2">
      {prev && (
        <Button type="button" variant="outline" size="sm" onClick={() => useStepStore.getState().back()}>
          <ChevronLeft aria-hidden="true" />
          戻る({prev.title})
        </Button>
      )}
      <span className="min-w-0 flex-1 text-center text-xs text-muted-foreground">{nextBlocked && 'GTFS を読み込むと先へ進めます'}</span>
      {next && (
        <Button type="button" size="sm" disabled={nextBlocked} onClick={() => useStepStore.getState().next()}>
          次へ({next.title})
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </nav>
  )
}
