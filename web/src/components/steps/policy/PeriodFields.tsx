import { Button } from '@/components/ui/button'
import HolidayCalendar from '@/components/HolidayCalendar'
import { Label } from '@/components/ui/label'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { holidaysBetween, uncoveredRanges } from '@/gtfs/holidays'
import { formatDateJa } from '@/lib/dates'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { POLICY_KIND_LABELS } from '../editText'

/** 方針の種類(平日を土曜に・平日を日祝に) */
export function PolicyKindField({
  kind,
  onChange,
  sameSatSun,
}: {
  kind: PolicyKind
  onChange: (k: PolicyKind) => void
  /** 土曜と日祝が同じ時刻表か */
  sameSatSun: boolean
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">方針の種類</legend>
      {(['weekdayToSaturday', 'weekdayToSundayHoliday'] as const).map((k) => (
        <label key={k} className="flex items-center gap-2 text-sm">
          <input type="radio" name="policy-kind" value={k} checked={kind === k} onChange={() => onChange(k)} className="size-4 accent-primary" />
          {POLICY_KIND_LABELS[k]}
        </label>
      ))}
      {sameSatSun && (
        <p className="text-xs text-muted-foreground">この GTFS では土曜と日祝が同じ時刻表のため、2つの方針は同じ結果になります。</p>
      )}
    </fieldset>
  )
}

/** 期間の欄の下に出す、期間そのものの誤り(badPeriod・emptyValidity) */
export interface PeriodProblem {
  severity: 'error' | 'warning'
  code: string
  message: string
}

/** 期間の欄の下に出す確かめの code(checkPolicy が出す、期間が成り立たない誤り。入力の端にそろえる警告は「方針の確かめ」に出す) */
export const PERIOD_PROBLEM_CODES: ReadonlySet<string> = new Set(['badPeriod', 'emptyValidity'])

/**
 * 期間(開始日・終了日・当面の間)と、出力の有効期間、期間の中の祝日。
 * 開始日・終了日は祝日の色つきカレンダーで選ぶ。選べるのは入力の GTFS の有効期間の中だけ。
 * 日付は GTFS と同じ 'YYYYMMDD'(まだ決まっていなければ '')
 */
export function PeriodFields({
  input,
  start,
  onStartChange,
  end,
  onEndChange,
  indefinite,
  onIndefiniteChange,
  validity,
  periodMessage,
  periodProblems,
  holidayState,
}: {
  /** 入力の GTFS の有効期間 */
  input: { start: string; end: string }
  start: string
  onStartChange: (v: string) => void
  end: string
  onEndChange: (v: string) => void
  indefinite: boolean
  onIndefiniteChange: (v: boolean) => void
  validity: { start: string; end: string; days: number } | null
  periodMessage: string | null
  periodProblems: PeriodProblem[]
  holidayState: HolidayState
}) {
  const holidays = holidayState.status === 'ready' ? holidayState.list : null
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">期間</legend>
      <div role="group" aria-label="開始日" className="flex flex-col gap-1">
        <Label className="text-xs">開始日</Label>
        <HolidayCalendar value={start || null} onChange={onStartChange} min={input.start} max={input.end} holidays={holidays} />
      </div>
      {indefinite ? (
        <p className="text-sm">終了日:決めません(入力の末日 {formatDateJa(input.end)} まで)。</p>
      ) : (
        <div role="group" aria-label="終了日" className="flex flex-col gap-1">
          <Label className="text-xs">終了日</Label>
          <HolidayCalendar value={end || null} onChange={onEndChange} min={input.start} max={input.end} holidays={holidays} />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={indefinite}
          onChange={(e) => onIndefiniteChange(e.target.checked)}
          className="size-4 accent-primary"
        />
        当面の間(終わりを決めない)
      </label>
      <p className="text-xs text-muted-foreground">
        選べる範囲は入力の GTFS の有効期間({formatDateJa(input.start)}〜{formatDateJa(input.end)})です。
        {validity && <>出力の有効期間は {formatDateJa(validity.start)}〜{formatDateJa(validity.end)}({validity.days}日)になります。</>}
      </p>
      {periodMessage && <p className="text-sm text-destructive">{periodMessage}</p>}
      {periodProblems.length > 0 && (
        <div role="group" aria-label="期間の確かめ" className="flex flex-col gap-1">
          {periodProblems.map((p, i) => (
            <p
              key={`${p.code}-${i}`}
              data-code={p.code}
              data-severity={p.severity}
              className={p.severity === 'error' ? 'text-sm text-destructive' : 'text-xs text-amber-900'}
            >
              <span aria-hidden="true">{p.severity === 'error' ? '× ' : '! '}</span>
              {p.message}
            </p>
          ))}
        </div>
      )}
      <HolidaysInPeriod state={holidayState} validity={validity} />
    </fieldset>
  )
}

/** 期間の中の祝日。祝日一覧が無ければその旨と読み込み直しのボタン */
function HolidaysInPeriod({ state, validity }: { state: HolidayState; validity: { start: string; end: string } | null }) {
  if (state.status === 'idle') return null
  if (state.status === 'loading') return <p className="text-xs text-muted-foreground">祝日一覧を読み込み中…</p>
  if (state.status !== 'ready') {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
        <p>
          <span aria-hidden="true">! </span>祝日一覧を読めないため、祝日の確認をしていません。
          {state.status === 'error' && <>({state.message})</>}
        </p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void useHolidayStore.getState().load()}>
          祝日一覧を読み込み直す
        </Button>
      </div>
    )
  }
  if (!validity) return null
  const list = holidaysBetween(state.list, validity.start, validity.end)
  const uncovered = uncoveredRanges(state.list, validity.start, validity.end)
  return (
    <div className="text-xs">
      <p>
        期間の中の祝日:
        {list.length === 0 ? 'ありません' : list.map((h) => `${formatDateJa(h.date)} ${h.name}`).join('、')}
      </p>
      {uncovered.map((r) => (
        <p key={r.start} className="text-amber-900">
          <span aria-hidden="true">! </span>
          {formatDateJa(r.start)}〜{formatDateJa(r.end)} の祝日は、内閣府の一覧にまだ無いため確かめていません。
        </p>
      ))}
    </div>
  )
}
