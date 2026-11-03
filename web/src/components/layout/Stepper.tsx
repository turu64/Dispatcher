import { cn } from 'cn'
import { STEPS } from '@/components/steps/registry'
import { useEditStore } from '@/store/edit'
import { canOpenStep, useStepStore } from '@/store/steps'

const KEYS = STEPS.map((s) => s.key)

/**
 * 左の欄の上の手順の見出し。押すとその手順へ直接移る。
 * GTFS を読み込むまでは、読み込みより先の手順は押せない(読み込んだあとは、どの手順へも移れる)
 */
export default function Stepper() {
  const current = useStepStore((s) => s.current)
  const loaded = useEditStore((s) => s.base !== null)
  return (
    <nav aria-label="手順の切り替え" className="print-hide shrink-0 border-b bg-background px-3 py-2">
      <ol className="flex flex-wrap gap-1">
        {STEPS.map((s, i) => {
          const active = s.key === current
          const enabled = canOpenStep(s.key, KEYS, loaded)
          return (
            <li key={s.key}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                disabled={!enabled}
                title={enabled ? undefined : 'GTFS を読み込むと開けます'}
                onClick={() => useStepStore.getState().go(s.key)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  active ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full text-[10px] tabular-nums',
                    active ? 'bg-primary-foreground text-primary' : 'border border-foreground/30',
                  )}
                >
                  {i + 1}
                </span>
                <span className="sr-only">{i + 1}. </span>
                {s.title}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
