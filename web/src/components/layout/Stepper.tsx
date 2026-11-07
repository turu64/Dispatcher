import { cn } from 'cn'
import { Check } from 'lucide-react'
import { Fragment, useId } from 'react'
import { STEPS } from '@/components/steps/registry'
import { planOf } from '@/gtfs/edit/ops'
import { useEditStore, type Draft } from '@/store/edit'
import { useDriversStore } from '@/store/drivers'
import { canOpenStep, useStepStore, type StepKey } from '@/store/steps'

const KEYS = STEPS.map((s) => s.key)

/**
 * 手順の名前を、狭い列(左の欄が 320px のとき1列 47px ほど)で2行に折り返すときの区切り。
 * 「の」「を」の後ろと「(」(全角の「(」も)の前で折り返す(「減便の/方針」「平日便を/戻す」「影響/(到達圏)」)。
 * 区切りに <wbr> を挟み、word-break: keep-all でそこでだけ折り返す。<wbr> を挟んだ見える名前は読み上げから隠し、
 * 読み上げ用の名前(「3. 減便の方針」)を別に置く(<wbr> で名前が区切られる読み上げ・テストの道具があるため)
 */
function withBreaks(title: string) {
  const parts = title.split(/(?<=[のを])|(?=[(（])/)
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {p}
    </Fragment>
  ))
}

/**
 * 承認待ちの下書きを確かめる手順。方針の下書きと元に戻す下書きは「減便の方針」(store/chat.ts の STEP_OF_TOOL、
 * policy/ApprovalPanel と同じ)、平日に戻す・取り消す下書きは「平日便を戻す」。
 * 適用できなかった下書き(outcome.ok が false)にも点を出す(承認はできないが、利用者が「やめる」まで残るため。各手順の欄も同じに出す)
 */
function pendingStepOf(draft: Draft | null): StepKey | null {
  if (!draft) return null
  if (draft.kind === 'undo') return 'policy'
  return draft.record.op.type === 'applyPolicy' ? 'policy' : 'restore'
}

/**
 * 済んだ手順。開いたかどうかではなく、データで決める。
 * 読み込み = GTFS を読み込んだ、運行の前提 = 在籍の運転士の数を入れたか、営業所を1つ以上置いた、
 * 減便の方針 = 承認した方針がある、平日便を戻す = 平日に戻した便が1便以上ある(承認済みの履歴から。取り消した便は数えない)。
 * 影響(到達圏)と出力は見るだけの手順なので、済みにしない
 */
function useDoneSteps(): ReadonlySet<StepKey> {
  const loaded = useEditStore((s) => s.base !== null)
  const history = useEditStore((s) => s.history)
  const premised = useDriversStore((s) => s.roster !== null || s.places.length > 0)
  const plan = planOf(history)
  const done = new Set<StepKey>()
  if (loaded) done.add('load')
  if (loaded && premised) done.add('premise')
  if (loaded && plan) done.add('policy')
  if (loaded && plan && plan.addBackTripIds.length > 0) done.add('restore')
  return done
}

/**
 * 左の欄の上の手順のステッパー。番号の丸を横線でつなぎ、丸の下に手順の名前を出す。押すとその手順へ直接移る。
 * GTFS を読み込むまでは、読み込みより先の手順は押せない(読み込んだあとは、どの手順へも移れる)。
 * 丸で状態を見分ける(色だけに頼らない):今の手順は塗る、済んだ手順はチェック、承認待ちの下書きがある手順は右上に点。
 * 横線は進み具合を表す:最後の済んだ手順までを primary 寄りの色にする(影響(到達圏)と出力は済みにならないため、
 * 「済んだ手順の後ろ」で塗ると途中が切れて見える)。押せない手順の丸・名前・横線は薄くする(ボタン全体を半透明にすると、
 * 丸の下の横線が透けて見えるため、部分ごとに薄くする)
 * 読み上げでは、ボタンの名前は「1. 読み込み」のまま、状態(済み・承認待ち)を説明(aria-describedby)で伝える。
 * wide は、地図を隠して左の欄を広げている手順か(幅を抑えて中央にそろえる)
 */
export default function Stepper({ wide = false }: { wide?: boolean }) {
  const current = useStepStore((s) => s.current)
  const loaded = useEditStore((s) => s.base !== null)
  const pending = useEditStore((s) => pendingStepOf(s.draft))
  const done = useDoneSteps()
  const idPrefix = useId()
  const enabledAt = STEPS.map((s) => canOpenStep(s.key, KEYS, loaded))
  // 最後の済んだ手順の位置(無ければ -1)。そこまでの横線を塗る
  const lastDone = STEPS.reduce((last, s, i) => (done.has(s.key) ? i : last), -1)
  const line = (lit: boolean, faded: boolean) =>
    lit ? 'bg-primary/60' : faded ? 'bg-muted-foreground/15' : 'bg-muted-foreground/40'
  return (
    <nav aria-label="手順の切り替え" className="print-hide shrink-0 border-b bg-background px-2 pt-2 pb-1.5">
      <ol className={cn('grid grid-cols-6', wide && 'mx-auto w-full max-w-2xl')}>
        {STEPS.map((s, i) => {
          const active = s.key === current
          const enabled = enabledAt[i]
          const isDone = done.has(s.key)
          const isPending = pending === s.key
          const status = [isDone && '済み', isPending && '承認待ちの下書きあり'].filter(Boolean).join('、')
          const statusId = `${idPrefix}-${s.key}-status`
          return (
            <li key={s.key} className="relative min-w-0">
              {/* 前後の手順とつなぐ横線(丸の中心の高さ)。最後の済んだ手順までは primary 寄りの色、押せない手順につながる線は薄く */}
              {i > 0 && (
                <span
                  aria-hidden="true"
                  data-lit={i <= lastDone ? '' : undefined}
                  className={cn('pointer-events-none absolute top-[15px] left-0 h-0.5 w-1/2', line(i <= lastDone, !enabled || !enabledAt[i - 1]))}
                />
              )}
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  data-lit={i < lastDone ? '' : undefined}
                  className={cn('pointer-events-none absolute top-[15px] right-0 h-0.5 w-1/2', line(i < lastDone, !enabled || !enabledAt[i + 1]))}
                />
              )}
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                aria-describedby={status ? statusId : undefined}
                disabled={!enabled}
                title={enabled ? undefined : 'GTFS を読み込むと開けます'}
                onClick={() => useStepStore.getState().go(s.key)}
                className="group relative flex w-full flex-col items-center gap-1 rounded-md px-0.5 pt-1 pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative z-10 flex size-6 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : isDone
                        ? 'border-primary bg-background text-primary group-enabled:group-hover:bg-muted'
                        : enabled
                          ? 'border-muted-foreground/50 bg-background text-muted-foreground group-hover:border-foreground/60 group-hover:text-foreground'
                          : 'border-muted-foreground/20 bg-background text-muted-foreground/50',
                  )}
                >
                  {isDone ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  {isPending && (
                    // 今の手順の塗りと見分けられるよう、注意の色(画面の注意書きと同じ amber)にする
                    <span data-pending-dot="" className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500 ring-2 ring-background" />
                  )}
                </span>
                <span
                  className={cn(
                    'line-clamp-2 w-full text-center text-[11px] leading-tight break-keep [overflow-wrap:anywhere]',
                    active ? 'font-semibold text-foreground' : enabled ? 'text-muted-foreground group-hover:text-foreground' : 'text-muted-foreground/50',
                  )}
                >
                  <span className="sr-only">
                    {i + 1}. {s.title}
                  </span>
                  <span aria-hidden="true">{withBreaks(s.title)}</span>
                </span>
              </button>
              {status && (
                <span id={statusId} hidden>
                  {status}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
