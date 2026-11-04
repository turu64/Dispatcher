import { useCallback, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import HolidayCalendar from '@/components/HolidayCalendar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { holidaysBetween, uncoveredRanges } from '@/gtfs/holidays'
import { formatDateJa } from '@/lib/dates'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { nextPeriod, periodDays } from './periodRange'

/** 入れ替えに使うダイヤの選択肢(値は方針の種類) */
const TARGET_OPTIONS: ReadonlyArray<{ kind: PolicyKind; label: string }> = [
  { kind: 'weekdayToSaturday', label: '土曜' },
  { kind: 'weekdayToSundayHoliday', label: '日祝' },
]

/**
 * 方針の種類(平日を土曜に・平日を日祝に)。「[平日] を [土曜] ダイヤに変更する」の文の形で、2つのセレクトで選ぶ。
 * 変更するダイヤは今は平日だけ(方針の種類が平日の入れ替えだけのため)。セレクトの形は、変更後のダイヤとそろえて文として読めるようにする
 */
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
      <legend className="mb-1 text-sm font-medium">ダイヤの入れ替え方</legend>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <Select value="weekday">
          <SelectTrigger size="sm" aria-label="変更するダイヤ" className="min-w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="weekday">平日</SelectItem>
          </SelectContent>
        </Select>
        <span>を</span>
        <Select value={kind} onValueChange={(v) => onChange(v as PolicyKind)}>
          <SelectTrigger size="sm" aria-label="変更後のダイヤ" className="min-w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_OPTIONS.map((o) => (
              <SelectItem key={o.kind} value={o.kind}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>ダイヤに変更する</span>
      </div>
      {sameSatSun && (
        <p className="text-xs text-muted-foreground">この GTFS では土曜と日祝が同じ時刻表のため、どちらに変更しても同じ結果になります。</p>
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
 * 2か月を並べるのに要る、カレンダーの欄の幅(rem)。1か月は 7 × 2.25rem で、2か月と間・余白で 33.5rem ほど。
 * カレンダーの大きさは rem で決まるので、ブラウザの既定の文字の大きさを変えても合うよう、rem で比べる
 */
const TWO_MONTHS_MIN_WIDTH_REM = 33.75

/** rem → px(今のルートの文字の大きさで。読めなければ 16px) */
function remToPx(rem: number): number {
  const size = typeof document === 'undefined' ? NaN : Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return rem * (Number.isFinite(size) && size > 0 ? size : 16)
}

/**
 * 要素の幅が minRem 以上か。幅は ResizeObserver で追う(使えない環境では wide のまま)。
 * 幅が 0(まだ描いていない・テストの jsdom)のときは決めない。要素そのもの(焦点を移すため)も返す
 */
function useWideEnough(minRem: number): [React.RefCallback<HTMLElement>, boolean, React.RefObject<HTMLElement | null>] {
  const [wide, setWide] = useState(true)
  const observer = useRef<ResizeObserver | null>(null)
  const element = useRef<HTMLElement | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      element.current = el
      observer.current?.disconnect()
      observer.current = null
      if (!el || typeof ResizeObserver === 'undefined') return
      const measure = (width: number) => {
        if (width > 0) setWide(width >= remToPx(minRem))
      }
      measure(el.getBoundingClientRect().width)
      observer.current = new ResizeObserver((entries) => {
        for (const e of entries) measure(e.contentRect.width)
      })
      observer.current.observe(el)
    },
    [minRem],
  )
  return [ref, wide, element]
}

/**
 * カレンダーの下に出す、選んだ期間の文。「期間:2026年11月9日(月)〜11月30日(月)(22日間)」「期間:2026年11月9日(月)から当面の間」、
 * 1日だけなら「期間:2026年11月9日(月)の1日間」
 */
function describePeriod(start: string, end: string, indefinite: boolean): string {
  if (!start) return '開始日をカレンダーで選んでください。'
  const from = formatDateJa(start)
  if (indefinite) return `期間:${from}から当面の間`
  if (!end) return `開始日:${from}。終了日をカレンダーで選んでください。`
  // 終了日が開始日より前(既存の方針など)。理由は期間の欄の下(badPeriod)に出す
  if (end < start) return `開始日:${from}、終了日:${formatDateJa(end)}`
  if (end === start) return `期間:${from}の1日間`
  // 同じ年なら終了日の年を省く
  const to = end.slice(0, 4) === start.slice(0, 4) ? formatDateJa(end).replace(/^\d+年/, '') : formatDateJa(end)
  return `期間:${from}〜${to}(${periodDays(start, end)}日間)`
}

/**
 * 減便の期間(開始日・終了日・当面の間)と、出力の有効期間、期間の中の祝日。
 * 期間は祝日の色つきカレンダー1つで選ぶ。1回目に押した日が開始日、2回目に押した日が終了日(開始日より前の日なら新しい開始日)。
 * 当面の間なら押した日が開始日になる。選べるのは入力の GTFS の有効期間の中だけ。
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
  periodProblems: PeriodProblem[]
  holidayState: HolidayState
}) {
  const holidays = holidayState.status === 'ready' ? holidayState.list : null
  const [boxRef, wide, boxEl] = useWideEnough(TWO_MONTHS_MIN_WIDTH_REM)
  const hintId = useId()
  const summaryId = useId()
  const pick = (date: string) => {
    const next = nextPeriod({ start, end, indefinite }, date)
    if (next.start !== start) onStartChange(next.start)
    if (next.end !== end) onEndChange(next.end)
  }
  const complete = start !== '' && (indefinite || end !== '')
  const reset = () => {
    // 押したボタンは選び直しで押せなくなり焦点が外れるので、描き直してから焦点をカレンダーの日(Tab で入る日)に移す
    flushSync(() => {
      onStartChange('')
      onEndChange('')
    })
    boxEl.current?.querySelector<HTMLButtonElement>('td[data-day] button[tabindex="0"]')?.focus()
  }
  return (
    // fieldset は既定で中身の幅(min-inline-size: min-content)より狭くならず、欄が狭くても2か月の幅に広がるので、min-w-0 で欄に合わせる
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${hintId} ${summaryId}`}>
      <legend className="mb-1 text-sm font-medium">減便の期間</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={indefinite}
          onChange={(e) => {
            // 外したら終了日を空にして、次に押した日を終了日として選べるようにする
            if (!e.target.checked) onEndChange('')
            onIndefiniteChange(e.target.checked)
          }}
          className="size-4 accent-primary"
        />
        当面の間(終わりを決めない)
      </label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {indefinite
          ? 'カレンダーで開始日を押してください。開始日から入力の末日までを薄い帯で示します。'
          : 'カレンダーで開始日、終了日の順に押してください。開始日と同じ日を押すと1日だけの期間になります。期間を決めたあとに押すと、その日から選び直します。'}
      </p>
      <div ref={boxRef} className="w-full">
        <HolidayCalendar
          mode="range"
          start={start || null}
          end={end || null}
          openEnd={indefinite}
          onDayClick={pick}
          min={input.start}
          max={input.end}
          holidays={holidays}
          numberOfMonths={wide ? 2 : 1}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p id={summaryId} data-testid="period-summary" aria-live="polite" className={complete ? 'text-sm font-medium' : 'text-sm'}>
          {describePeriod(start, end, indefinite)}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // 当面の間では終了日を使わないので、開始日が空なら選び直すものは無い
          disabled={start === '' && (indefinite || end === '')}
          onClick={reset}
        >
          期間を選び直す
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        選べる範囲は入力の GTFS の有効期間({formatDateJa(input.start)}〜{formatDateJa(input.end)})です。
        {validity && <>出力の有効期間は {formatDateJa(validity.start)}〜{formatDateJa(validity.end)}({validity.days}日)になります。</>}
      </p>
      {periodProblems.length > 0 && (
        <div role="group" aria-label="期間の確認" className="flex flex-col gap-1">
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
          {formatDateJa(r.start)}〜{formatDateJa(r.end)} の祝日は内閣府の一覧にまだないため、確かめていません。
        </p>
      ))}
    </div>
  )
}
