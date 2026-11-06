/**
 * 日付を選ぶカレンダー。日曜と祝日を赤、土曜を青で出し、祝日の名前を出す。範囲(min〜max)の外の日は選べない。
 *
 * - 日付は GTFS と同じ 'YYYYMMDD' の文字列で受け渡す(画面のほかの部分と同じ)
 * - セルに「祝」「土」「日」の文字は出さず、色だけで示す。色の見分けがつきにくい人には、読み上げの名前(aria-label に祝日名・土曜・日曜)、
 *   マウスを載せたときの祝日名(title)、選んだ日の下の文、曜日の列の位置(日曜は左端、土曜は右端)で伝える
 * - 祝日が日曜・土曜と重なる日は祝日として扱う(赤)。日付の判定は gtfs/calendar.ts の weekdayIndex に任せる
 * - 祝日一覧(holidays)が null のときは祝日を出さず、その旨を一行添える
 * - mode="range" では期間(開始日〜終了日)を1つのカレンダーで示す。開始日・終了日は濃く、間の日は薄い色の帯で、
 *   帯の上でも祝日・土日の文字の色を残す。openEnd(当面の間)なら開始日から max までを、さらに薄い帯で示す。
 *   どの日を開始日・終了日にするかは呼ぶ側が決める(押した日を onDayClick で返すだけ)。選んだ日の下の文は出さない。
 *   今日はセルの背景ではなく、日付の太字と下線で示す(帯の色と重ならないように)
 */
import { useMemo, useState } from 'react'
import { ja } from 'react-day-picker/locale'
import { getDefaultClassNames, type DayButton } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { Calendar, CalendarDayButton } from '@/components/ui/calendar'
import { appToday, formatDateJa } from '@/lib/dates'
import { addDays, isValidGtfsDate, weekdayIndex } from '@/gtfs/calendar'
import type { HolidayList } from '@/gtfs/holidays'

interface CommonProps {
  /** 選べる最初の日('YYYYMMDD')。無ければ制限なし */
  min?: string
  /** 選べる最後の日('YYYYMMDD')。無ければ制限なし */
  max?: string
  /** 祝日一覧。読めていないときは null */
  holidays: HolidayList | null
  className?: string
  /** 並べる月の数(既定 1) */
  numberOfMonths?: number
}

/** 1日を選ぶ(地図の操作盤の「比較する日付」) */
export interface SingleCalendarProps extends CommonProps {
  mode?: 'single'
  /** 選んでいる日('YYYYMMDD')。まだ選んでいないときは null か '' */
  value: string | null
  onChange: (date: string) => void
}

/** 期間を示す(減便の期間)。開始日・終了日は 'YYYYMMDD'、まだ選んでいなければ null か '' */
export interface RangeCalendarProps extends CommonProps {
  mode: 'range'
  start: string | null
  end: string | null
  /** 終わりを決めない(当面の間)。end を使わず、開始日から max までを薄い帯で示す */
  openEnd?: boolean
  /** 押した日('YYYYMMDD')。開始日・終了日のどちらにするかは呼ぶ側が決める */
  onDayClick: (date: string) => void
}

export type HolidayCalendarProps = SingleCalendarProps | RangeCalendarProps

/** 日付の種類。祝日 > 日曜 > 土曜 の順に決める(祝日と重なる日曜・土曜は祝日) */
type DayKind = 'holiday' | 'sunday' | 'saturday' | 'weekday'

function dayKind(date: string, holidays: HolidayList | null): DayKind {
  if (holidays?.names.has(date)) return 'holiday'
  const w = weekdayIndex(date)
  if (w === 6) return 'sunday'
  if (w === 5) return 'saturday'
  return 'weekday'
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土']

/** 読み上げの名前。「2026年11月3日 火曜日、祝日 文化の日」「2026年11月8日 日曜日、日曜」「2026年11月7日 土曜日、土曜」 */
function dayLabel(d: Date, kind: DayKind, holidayName: string | undefined): string {
  const base = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_JA[d.getDay()]}曜日`
  if (kind === 'holiday') return holidayName ? `${base}、祝日 ${holidayName}` : `${base}、祝日`
  if (kind === 'sunday') return `${base}、日曜`
  if (kind === 'saturday') return `${base}、土曜`
  return base
}

/** 期間の中での位置(mode="range" のときだけ)。読み上げの名前の後ろに足す */
type RangePart = 'startEnd' | 'start' | 'end' | 'middle' | 'open' | null

const RANGE_PART_LABEL: Record<Exclude<RangePart, null>, string> = {
  startEnd: '開始日・終了日',
  start: '開始日',
  end: '終了日',
  middle: '期間の中',
  open: '期間の中(当面の間)',
}

/**
 * react-day-picker の modifiers から、期間の中での位置を決める。
 * range_start・range_end は開始日と終了日の両方があるときだけ付く。開始日だけのとき(当面の間・終了日がまだ)は selected だけが付く
 */
function rangePart(m: Record<string, boolean>): RangePart {
  if (m.range_start && m.range_end) return 'startEnd'
  if (m.range_start) return 'start'
  if (m.range_end) return 'end'
  if (m.range_middle) return 'middle'
  if (m.selected) return 'start'
  if (m.open_band) return 'open'
  return null
}

/** Date(パソコンの時刻での年月日)→ 'YYYYMMDD' */
function dateToGtfs(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 'YYYYMMDD' → Date(パソコンの時刻のその日の0時) */
function gtfsToDate(s: string): Date {
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
}

function validOrUndefined(s: string | null | undefined): string | undefined {
  return s && isValidGtfsDate(s) ? s : undefined
}

/** 選んだ日の下の文。「11月3日(火・文化の日)」「11月4日(水)」 */
function describeSelected(date: string, holidays: HolidayList | null): string {
  const name = holidays?.names.get(date)
  // formatDateJa は '2026年11月4日(水)'。年を除き、祝日名があれば曜日の後ろに「・」でつなぐ
  const text = formatDateJa(date).replace(/^\d+年/, '')
  return name ? text.replace(/\)$/, `・${name})`) : text
}

const KIND_CLASS: Record<DayKind, string> = {
  holiday: 'text-red-700 dark:text-red-400',
  sunday: 'text-red-700 dark:text-red-400',
  saturday: 'text-blue-700 dark:text-blue-400',
  weekday: '',
}

/**
 * 期間の間の日(帯の上)の文字の色。CalendarDayButton は間の日を data-[range-middle=true]:text-foreground にするので、
 * 同じ形で上書きする(twMerge が後ろを残す)。背景は帯の色(--band)
 */
const BAND_CLASS = 'data-[range-middle=true]:bg-(--band)'
const KIND_CLASS_IN_BAND: Record<DayKind, string> = {
  // ダークの帯(主色を混ぜた明るめの背景)の上では -400 だと対比が足りないので、-300 にする
  holiday: 'data-[range-middle=true]:text-red-700 dark:data-[range-middle=true]:text-red-300',
  sunday: 'data-[range-middle=true]:text-red-700 dark:data-[range-middle=true]:text-red-300',
  saturday: 'data-[range-middle=true]:text-blue-700 dark:data-[range-middle=true]:text-blue-300',
  weekday: '',
}

/**
 * 帯の色。開始日・終了日のセルの端(after)と重ねても濃くならないよう、背景と混ぜた不透明の色にする。
 * 当面の間の帯(--band-open)は、決めた期間の帯より薄くする
 */
const BAND_VARS = cn(
  '[--band:color-mix(in_oklab,var(--primary)_14%,var(--background))] [--band-open:color-mix(in_oklab,var(--primary)_7%,var(--background))]',
  // ダークでは背景との差が小さく見えるので、混ぜる割合を上げる
  'dark:[--band:color-mix(in_oklab,var(--primary)_24%,var(--background))] dark:[--band-open:color-mix(in_oklab,var(--primary)_13%,var(--background))]',
)

/** 'YYYYMM' の月の数(年×12+月)。月の差を数えるのに使う */
function monthIndex(yyyymm: string): number {
  return Number(yyyymm.slice(0, 4)) * 12 + Number(yyyymm.slice(4, 6)) - 1
}

/** 月の数 → その月の1日の Date */
function monthDate(index: number): Date {
  return new Date(Math.floor(index / 12), index % 12, 1)
}

/**
 * 並べる月の数を、選べる範囲(min〜max)の月の数までに抑える。有効期間が1か月に収まるときに、全部押せない2か月目を出さない
 */
function clampMonthCount(n: number, minStr: string | undefined, maxStr: string | undefined): number {
  if (!minStr || !maxStr) return n
  return Math.max(1, Math.min(n, monthIndex(maxStr) - monthIndex(minStr) + 1))
}

/** 最初に出す月を、選べる範囲(min〜max の月)に収める。n か月を並べるときは、最後の月が max の月を越えないようにする */
function clampMonth(index: number, n: number, minStr: string | undefined, maxStr: string | undefined): number {
  let m = index
  if (maxStr) m = Math.min(m, monthIndex(maxStr) - (n - 1))
  if (minStr) m = Math.max(m, monthIndex(minStr))
  return m
}

export default function HolidayCalendar(props: HolidayCalendarProps) {
  const { min, max, holidays, className } = props
  const isRange = props.mode === 'range'
  const minStr = validOrUndefined(min)
  const maxStr = validOrUndefined(max)
  const n = clampMonthCount(Math.max(1, props.numberOfMonths ?? 1), minStr, maxStr)
  const selectedStr = props.mode === 'range' ? undefined : validOrUndefined(props.value)
  const startStr = props.mode === 'range' ? validOrUndefined(props.start) : undefined
  const openEnd = props.mode === 'range' && props.openEnd === true
  // 当面の間のときは終了日を使わない。終了日が開始日より前(既存の方針など)のときは、帯を描かず開始日だけを示す
  const endRaw = props.mode === 'range' && !openEnd ? validOrUndefined(props.end) : undefined
  const endStr = startStr && endRaw && endRaw >= startStr ? endRaw : undefined
  // 見せる月を決める日:1日を選ぶなら選んだ日、期間なら開始日
  const anchor = selectedStr ?? startStr

  // 最初に開く月:選んだ日(期間なら開始日)の月、無ければ min の月、それも無ければ今月
  const [month, setMonth] = useState<number>(() =>
    clampMonth(monthIndex((anchor ?? minStr ?? appToday()).slice(0, 6)), n, minStr, maxStr),
  )
  const shownMonth = clampMonth(month, n, minStr, maxStr)
  // 外から選んだ日が変わって、または並べる月の数が変わって(欄の幅が変わったとき)、選んだ日が見せている月(n か月)の外に
  // なったら、その月を開く(描画中の調整。effect は使わない)
  const [prev, setPrev] = useState({ anchor, n })
  if (prev.anchor !== anchor || prev.n !== n) {
    setPrev({ anchor, n })
    if (anchor) {
      const a = monthIndex(anchor.slice(0, 6))
      if (a < shownMonth || a > shownMonth + n - 1) setMonth(clampMonth(a, n, minStr, maxStr))
    }
  }

  const disabled = useMemo(() => {
    const matchers: ({ before: Date } | { after: Date })[] = []
    if (minStr) matchers.push({ before: gtfsToDate(minStr) })
    if (maxStr) matchers.push({ after: gtfsToDate(maxStr) })
    return matchers
  }, [minStr, maxStr])

  // 当面の間の帯:開始日の翌日から max まで(max が無ければ開始日より後のすべて)。開始日のセルは帯へつなぐ
  const modifiers = useMemo(() => {
    if (!openEnd || !startStr) return undefined
    const from = gtfsToDate(addDays(startStr, 1))
    return {
      open_band: maxStr ? (maxStr > startStr ? [{ from, to: gtfsToDate(maxStr) }] : []) : [{ after: gtfsToDate(startStr) }],
      open_start: maxStr && maxStr <= startStr ? [] : [gtfsToDate(startStr)],
    }
  }, [openEnd, startStr, maxStr])

  // 祝日の情報が尽きる日(coveredUntil)より後の月を見ているときに、その旨を添える(並べた最後の月で決める)
  const lastOfShownMonth = addDays(dateToGtfs(monthDate(shownMonth + n)), -1)
  const beyondCoverage = holidays !== null && lastOfShownMonth > holidays.coveredUntil

  const KindDayButton = useMemo(
    () =>
      function KindDayButton(buttonProps: React.ComponentProps<typeof DayButton>) {
        const date = dateToGtfs(buttonProps.day.date)
        const kind = dayKind(date, holidays)
        const name = holidays?.names.get(date)
        const m = buttonProps.modifiers
        const part = isRange ? rangePart(m) : null
        const base = dayLabel(buttonProps.day.date, kind, name)
        // 開始日・終了日・1日の選択は主色の背景なので、赤・青の文字色は使わず、主色の上の文字色で読ませる。
        // 期間の間の日は薄い帯なので、帯の上でも赤・青の文字色を残す
        let colorClass: string | undefined
        if (isRange && m.range_middle) colorClass = cn(BAND_CLASS, KIND_CLASS_IN_BAND[kind])
        else if (!m.selected) colorClass = KIND_CLASS[kind]
        // 期間のカレンダーでは、今日をセルの背景(帯と重なる)ではなく、太字と下線で示す
        if (isRange && m.today) colorClass = cn(colorClass, 'font-semibold underline underline-offset-4')
        return (
          <CalendarDayButton
            {...buttonProps}
            data-kind={kind}
            data-range-part={part ?? undefined}
            title={name ?? undefined}
            aria-label={part ? `${base}、${RANGE_PART_LABEL[part]}` : base}
            className={colorClass}
            locale={ja}
          />
        )
      },
    [holidays, isRange],
  )

  const defaults = getDefaultClassNames()
  const common = {
    locale: ja,
    // 今日の印(太字と下線など)は画面の「今日」に合わせる(デモで ?today= を渡したときはその日)
    today: gtfsToDate(appToday()),
    weekStartsOn: 0 as const,
    showOutsideDays: false,
    numberOfMonths: n,
    month: monthDate(shownMonth),
    onMonthChange: (d: Date) => setMonth(d.getFullYear() * 12 + d.getMonth()),
    startMonth: minStr ? gtfsToDate(minStr) : undefined,
    endMonth: maxStr ? gtfsToDate(maxStr) : undefined,
    disabled,
    formatters: { formatCaption: (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月` },
    labels: {
      labelPrevious: () => '前の月へ',
      labelNext: () => '次の月へ',
    },
    classNames: {
      // 並べる月の数はカレンダーを置く欄の幅で呼ぶ側が決めるので、画面の幅(md:)では向きを変えない
      ...(n > 1 ? { months: cn('relative flex flex-row gap-4', defaults.months) } : {}),
      // 日曜(先頭の列)は赤、土曜(最後の列)は青。文字は日付のセルと同じ配色
      weekday:
        'flex-1 text-[0.8rem] font-normal select-none text-muted-foreground first:text-red-700 last:text-blue-700 dark:first:text-red-400 dark:last:text-blue-400',
      ...(isRange
        ? {
            // 今日の背景(bg-muted)は帯と重なって見分けにくいので付けない。今日は日のボタンの太字と下線で示す
            today: cn('rounded-(--cell-radius) text-foreground data-[selected=true]:rounded-none', defaults.today),
            range_start: cn(
              'relative isolate z-0 rounded-l-(--cell-radius) bg-(--band) after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-(--band)',
              defaults.range_start,
            ),
            range_middle: cn('rounded-none bg-(--band)', defaults.range_middle),
            range_end: cn(
              'relative isolate z-0 rounded-r-(--cell-radius) bg-(--band) after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-(--band)',
              defaults.range_end,
            ),
          }
        : {}),
    },
    modifiers,
    modifiersClassNames: {
      // 当面の間の帯。開始日のセルは右半分を帯の色にして、翌日からの帯へつなぐ
      open_band: 'rounded-none bg-(--band-open)',
      open_start: 'relative isolate z-0 after:absolute after:inset-y-0 after:right-0 after:w-1/2 after:bg-(--band-open) after:-z-10',
    },
    className: cn('[--cell-size:--spacing(9)]', BAND_VARS),
    components: { DayButton: KindDayButton },
  }

  return (
    <div className={cn('inline-block', className)}>
      {props.mode === 'range' ? (
        <Calendar
          {...common}
          mode="range"
          selected={startStr ? { from: gtfsToDate(startStr), to: endStr ? gtfsToDate(endStr) : undefined } : undefined}
          // 押した日だけを返す。react-day-picker の範囲の足し方(addToRange)は使わない
          onSelect={(_range, triggerDate) => props.onDayClick(dateToGtfs(triggerDate))}
        />
      ) : (
        <Calendar
          {...common}
          mode="single"
          required
          selected={selectedStr ? gtfsToDate(selectedStr) : undefined}
          onSelect={(d) => {
            if (d) props.onChange(dateToGtfs(d))
          }}
        />
      )}
      {props.mode !== 'range' && (
        <p data-testid="selected-date" aria-live="polite" className="mt-1 min-h-5 px-2 text-sm">
          {selectedStr ? describeSelected(selectedStr, holidays) : '日付を選んでください'}
        </p>
      )}
      {holidays === null && (
        <p className="px-2 text-xs text-muted-foreground">祝日一覧を読めないため、祝日は表示していません。</p>
      )}
      {beyondCoverage && (
        <p className="px-2 text-xs text-muted-foreground">この月は祝日一覧の収録より後のため、祝日を表示できないことがあります。</p>
      )}
    </div>
  )
}
