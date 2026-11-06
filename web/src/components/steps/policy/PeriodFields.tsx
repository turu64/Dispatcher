import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import HolidayCalendar from '@/components/HolidayCalendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { holidaysBetween, uncoveredRanges } from '@/gtfs/holidays'
import { appToday, formatDateJa } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { pickStartDate, type PeriodTarget } from './periodRange'

/** 入れ替えに使うダイヤの選択肢(値は方針の種類) */
const TARGET_OPTIONS: ReadonlyArray<{ kind: PolicyKind; label: string }> = [
  { kind: 'weekdayToSaturday', label: '土曜' },
  { kind: 'weekdayToSundayHoliday', label: '日祝' },
]

/**
 * 方針の種類(平日を土曜に・平日を日祝に)。減便の文の「[平日] を [土曜] ダイヤに変更する。」の部分で、2つのセレクトで選ぶ。
 * 変更するダイヤは今は平日だけ(方針の種類が平日の入れ替えだけのため)。セレクトの形は、変更後のダイヤとそろえて文として読めるようにする。
 * 文の中に置くので、枠(fieldset)は持たない。土曜と日祝が同じ時刻表の案内は、文の下の確認の結果に出す
 */
export function PolicyKindField({
  kind,
  onChange,
  labels,
}: {
  kind: PolicyKind
  onChange: (k: PolicyKind) => void
  /**
   * ダイヤの語の選択肢(確定したグループ分けがあるとき。docs/design-service-groups.md §5.2)。
   * 「[平日のダイヤ(01001 ほか 8)] を [土曜のダイヤ(03001 ほか 4)] に変更する。」の形にする。省くと「[平日] を [土曜] ダイヤに変更する。」
   */
  labels?: { weekday: string; targets: Record<PolicyKind, string> }
}) {
  // 選択肢が長い(グループの語)ときは、狭い欄で横にはみ出さないよう、枠の幅を欄に収めて文字を省く
  const triggerClass = labels ? 'min-w-18 max-w-full [&>span]:truncate' : 'min-w-18'
  return (
    <>
      <Select value="weekday">
        <SelectTrigger size="sm" aria-label="変更するダイヤ" className={triggerClass}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="weekday">{labels ? labels.weekday : '平日'}</SelectItem>
        </SelectContent>
      </Select>
      <span>を</span>
      <Select value={kind} onValueChange={(v) => onChange(v as PolicyKind)}>
        <SelectTrigger size="sm" aria-label="変更後のダイヤ" className={triggerClass}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TARGET_OPTIONS.map((o) => (
            <SelectItem key={o.kind} value={o.kind}>
              {labels ? labels.targets[o.kind] : o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {labels ? (
        <span>に変更する。</span>
      ) : (
        // 狭い欄で「ダイヤに変更する。」がまとめて次の行に送られて前の行の右が大きく空かないよう、<wbr> で折り返せる所を作る(1つの span にして、間に空きを出さない)
        <span>
          ダイヤに
          <wbr />
          変更する。
        </span>
      )}
    </>
  )
}

/** 期間の欄の下に出す、期間そのものの誤り(badPeriod・emptyValidity) */
export interface PeriodProblem {
  severity: 'error' | 'warning'
  code: string
  message: string
}

/**
 * 期間の欄の下に出す確かめの code(checkPolicy が出す、期間が成り立たない誤り)。service が決まらなくても出す。
 * 入力の端にそろえる警告・有効期間の日数の警告は、同じ確認の結果の箱の中の「減便内容の確認」に出す
 */
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
 * 幅が 0(まだ描いていない・テストの jsdom)のときは決めない
 */
function useWideEnough(minRem: number): [React.RefCallback<HTMLElement>, boolean] {
  const [wide, setWide] = useState(true)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
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
  return [ref, wide]
}

interface PeriodValue {
  /** 入力の GTFS の有効期間 */
  input: { start: string; end: string }
  start: string
  onStartChange: (v: string) => void
  end: string
  onEndChange: (v: string) => void
  indefinite: boolean
  onIndefiniteChange: (v: boolean) => void
  holidayState: HolidayState
}

/**
 * 減便の期間の日付を1つ選ぶカレンダー(文の日付の穴から開く Popover の中身)。中身は祝日の色つきカレンダーだけで、
 * 押した日を onPick で返す。カレンダーには今の期間(開始日〜終了日、当面の間なら開始日から入力の末日まで)を帯で示す。
 * 選べるのは min〜max の日だけ(開始日は入力の有効期間、終了日は開始日から入力の末日まで)。
 * 欄が狭ければ1か月、広ければ2か月を並べる
 */
function PeriodCalendar({
  start,
  end,
  indefinite,
  min,
  max,
  holidayState,
  onPick,
  boxRef: outerBoxRef,
}: {
  start: string
  end: string
  indefinite: boolean
  min: string
  max: string
  holidayState: HolidayState
  onPick: (date: string) => void
  /** カレンダーの箱(開いたときに焦点を日に移すため) */
  boxRef: React.RefObject<HTMLElement | null>
}) {
  const holidays = holidayState.status === 'ready' ? holidayState.list : null
  const [measureRef, wide] = useWideEnough(TWO_MONTHS_MIN_WIDTH_REM)
  const boxRef = useCallback(
    (el: HTMLElement | null) => {
      measureRef(el)
      outerBoxRef.current = el
    },
    [measureRef, outerBoxRef],
  )
  return (
    <div ref={boxRef} data-testid="period-calendar" className="w-full min-w-0">
      <HolidayCalendar
        mode="range"
        start={start || null}
        end={end || null}
        openEnd={indefinite}
        onDayClick={onPick}
        min={min}
        max={max}
        holidays={holidays}
        numberOfMonths={wide ? 2 : 1}
      />
    </div>
  )
}

/** 文の穴に出す日付。今年なら年を省く。'20261109' → '11月9日(月)' */
function holeDate(date: string, thisYear: string): string {
  const text = formatDateJa(date)
  return date.slice(0, 4) === thisYear ? text.replace(/^\d+年/, '') : text
}

/** 文の中の穴(ボタン・セレクト)の見た目。まだ決まっていない穴は破線の枠と薄い文字にする */
export const HOLE_CLASS = 'h-7 px-2 text-sm font-normal'
export const EMPTY_HOLE_CLASS = 'border-dashed border-muted-foreground/60 text-muted-foreground'

/** 終了日のセレクトの値。当面の間か、終了日を決めるか */
type EndMode = 'indefinite' | 'date'

/**
 * 減便の文の「[開始日] から [当面の間▼]、」「[開始日] から [終了日▼] [11月14日(土)] までの間、」の部分。
 *
 * - 開始日の穴を押すと、開始日を選ぶカレンダーを Popover で開く(入力の有効期間の中で選べる)。
 *   終了日より後の日を選ぶと、終了日を空にする(文の下の確認の結果に「終了日を選んでください」と出る)
 * - 終了日の穴はセレクト(当面の間/終了日)。「終了日」を選ぶと右に日付の穴が出て、終了日を選ぶカレンダーをすぐに開く
 *   (開始日より前は選べない)。終了日の値は空から選び直す
 * - カレンダーで日を押すと、その日が穴に入り、Popover を閉じて焦点を穴に戻す。Escape・欄の外の押下でも閉じる
 */
export function PeriodHoles({ input, start, onStartChange, end, onEndChange, indefinite, onIndefiniteChange, holidayState }: PeriodValue) {
  const [open, setOpen] = useState<PeriodTarget | null>(null)
  const [thisYear] = useState(() => appToday().slice(0, 4))
  const boxRef = useRef<HTMLElement | null>(null)
  // 「終了日」を選んだあと、セレクトの選択肢が閉じて焦点を戻すときに、終了日のカレンダーを開く
  const openEndAfterSelect = useRef(false)

  const pick = (target: PeriodTarget, date: string) => {
    if (target === 'start') {
      const next = pickStartDate({ start, end, indefinite }, date)
      if (next.start !== start) onStartChange(next.start)
      if (next.end !== end) onEndChange(next.end)
    } else {
      onEndChange(date)
    }
    // 閉じると、Radix が焦点を押した穴に戻す
    setOpen(null)
  }

  const calendarHole = (target: PeriodTarget) => {
    const name = target === 'start' ? '開始日' : '終了日'
    const value = target === 'start' ? start : end
    const text = value ? holeDate(value, thisYear) : null
    // 終了日は開始日より前を選べない(開始日が入力の開始日より前・空なら入力の開始日から)
    const min = target === 'end' && start > input.start ? start : input.start
    return (
      <Popover open={open === target} onOpenChange={(o) => setOpen(o ? target : null)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={text ? `${name}:${text}` : `${name}(未選択)`}
            className={cn(HOLE_CLASS, !text && EMPTY_HOLE_CLASS)}
          >
            {text ?? (target === 'start' ? '開始日' : '日付')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          // 画面の端に貼りつかないよう余白を取り、低い画面では高さを画面に収めて中を送る
          collisionPadding={8}
          // 2か月を並べられる幅にする(狭い画面では画面の幅に収める)。左の欄より広くてよい(地図の上に重なる)
          className="max-h-(--radix-popover-content-available-height) w-[min(36rem,calc(100vw-2rem))] max-w-(--radix-popover-content-available-width) overflow-y-auto"
          aria-label={`減便の${name}を選ぶ`}
          onOpenAutoFocus={(e) => {
            // 最初の焦点はカレンダーの日に置く。選んでいる日(開始日・終了日)、なければ Tab で入る日
            const box = boxRef.current
            const day =
              box?.querySelector<HTMLButtonElement>(`td[data-day] button[aria-label*="、${name}"]:not([disabled])`) ??
              box?.querySelector<HTMLButtonElement>('td[data-day] button[tabindex="0"]')
            if (day) {
              e.preventDefault()
              day.focus()
            }
          }}
        >
          <PeriodCalendar
            start={start}
            end={end}
            indefinite={indefinite}
            min={min}
            max={input.end}
            holidayState={holidayState}
            onPick={(date) => pick(target, date)}
            boxRef={boxRef}
          />
        </PopoverContent>
      </Popover>
    )
  }

  const chooseEndMode = (mode: EndMode) => {
    if (mode === 'indefinite') {
      onIndefiniteChange(true)
      return
    }
    // 終了日は空から選ぶ(当面の間の間に残っていた値・入力の末日を、選んだ日として出さない)
    onEndChange('')
    onIndefiniteChange(false)
    openEndAfterSelect.current = true
  }

  return (
    <>
      {calendarHole('start')}
      <span>から</span>
      <Select value={indefinite ? 'indefinite' : 'date'} onValueChange={(v) => chooseEndMode(v as EndMode)}>
        <SelectTrigger size="sm" aria-label="減便の期間の終わり" className="min-w-18">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(e) => {
            // 「終了日」を選んだら、焦点をセレクトに戻さず、終了日のカレンダーを開く(開いたカレンダーが焦点を日に移す)
            if (!openEndAfterSelect.current) return
            openEndAfterSelect.current = false
            e.preventDefault()
            setOpen('end')
          }}
        >
          <SelectItem value="indefinite">当面の間</SelectItem>
          <SelectItem value="date">終了日</SelectItem>
        </SelectContent>
      </Select>
      {!indefinite && calendarHole('end')}
      {/* 読点だけのときは、穴との間の空きを詰める(「当面の間 、」と離れて見えないように) */}
      <span className={indefinite ? '-ml-1.5' : undefined}>{indefinite ? '、' : 'までの間、'}</span>
    </>
  )
}

/**
 * 減便の文の下に出す、期間の確認の結果:出力の有効期間、期間の誤り(badPeriod・emptyValidity)、期間の中の祝日
 */
export function PeriodChecks({
  validity,
  periodProblems,
  holidayState,
}: {
  validity: { start: string; end: string; days: number } | null
  periodProblems: PeriodProblem[]
  holidayState: HolidayState
}) {
  return (
    <>
      {validity && (
        <p className="text-xs">
          出力の有効期間は {formatDateJa(validity.start)}〜{formatDateJa(validity.end)}({validity.days}日)になります。
        </p>
      )}
      {periodProblems.length > 0 && (
        <div role="group" aria-label="期間の確認" className="flex flex-col gap-1">
          {periodProblems.map((p, i) => (
            <p
              key={`${p.code}-${i}`}
              data-code={p.code}
              data-severity={p.severity}
              className={p.severity === 'error' ? 'text-sm text-destructive' : 'text-xs text-amber-900 dark:text-amber-300'}
            >
              <span aria-hidden="true">{p.severity === 'error' ? '× ' : '! '}</span>
              {p.message}
            </p>
          ))}
        </div>
      )}
      <HolidaysInPeriod state={holidayState} validity={validity} />
    </>
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
        <p key={r.start} className="text-amber-900 dark:text-amber-300">
          <span aria-hidden="true">! </span>
          {formatDateJa(r.start)}〜{formatDateJa(r.end)} の祝日は内閣府の一覧にまだないため、確かめていません。
        </p>
      ))}
    </div>
  )
}
