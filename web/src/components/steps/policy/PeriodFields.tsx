import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { holidaysBetween, uncoveredRanges } from '@/gtfs/holidays'
import { formatDateJa, toInputDate } from '@/lib/dates'
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

/** 期間(開始日・終了日・当面の間)と、出力の有効期間、期間の中の祝日 */
export function PeriodFields({
  input,
  startText,
  onStartChange,
  endText,
  onEndChange,
  indefinite,
  onIndefiniteChange,
  validity,
  periodMessage,
  holidayState,
}: {
  /** 入力の GTFS の有効期間 */
  input: { start: string; end: string }
  startText: string
  onStartChange: (v: string) => void
  endText: string
  onEndChange: (v: string) => void
  indefinite: boolean
  onIndefiniteChange: (v: boolean) => void
  validity: { start: string; end: string; days: number } | null
  periodMessage: string | null
  holidayState: HolidayState
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">期間</legend>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="policy-start" className="text-xs">
            開始日
          </Label>
          <Input
            id="policy-start"
            type="date"
            min={toInputDate(input.start)}
            max={toInputDate(input.end)}
            value={startText}
            onChange={(e) => onStartChange(e.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="policy-end" className="text-xs">
            終了日
          </Label>
          <Input
            id="policy-end"
            type="date"
            min={toInputDate(input.start)}
            max={toInputDate(input.end)}
            value={indefinite ? '' : endText}
            disabled={indefinite}
            onChange={(e) => onEndChange(e.target.value)}
          />
        </div>
      </div>
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
