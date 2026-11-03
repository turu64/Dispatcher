/**
 * 日付を選ぶカレンダー。日曜と祝日を赤、土曜を青で出し、祝日の名前を出す。範囲(min〜max)の外の日は選べない。
 *
 * - 日付は GTFS と同じ 'YYYYMMDD' の文字列で受け渡す(画面のほかの部分と同じ)
 * - 色だけに頼らない:日付の下に「祝」「土」「日」の文字を付ける。祝日名はマウスを載せたとき(title)と、選んだ日の下の文で出す
 * - 祝日が日曜・土曜と重なる日は祝日として扱う(赤)。日付の判定は gtfs/calendar.ts の weekdayIndex に任せる
 * - 祝日一覧(holidays)が null のときは祝日を出さず、その旨を一行添える
 */
import { useMemo, useState } from 'react'
import { ja } from 'react-day-picker/locale'
import type { DayButton } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { Calendar, CalendarDayButton } from '@/components/ui/calendar'
import { formatDateJa } from '@/lib/dates'
import { addDays, isValidGtfsDate, weekdayIndex } from '@/gtfs/calendar'
import type { HolidayList } from '@/gtfs/holidays'

export interface HolidayCalendarProps {
  /** 選んでいる日('YYYYMMDD')。まだ選んでいないときは null か '' */
  value: string | null
  onChange: (date: string) => void
  /** 選べる最初の日('YYYYMMDD')。無ければ制限なし */
  min?: string
  /** 選べる最後の日('YYYYMMDD')。無ければ制限なし */
  max?: string
  /** 祝日一覧。読めていないときは null */
  holidays: HolidayList | null
  className?: string
}

/** 日付の種類。祝日 > 日曜 > 土曜 の順に決める(祝日と重なる日曜・土曜は祝日) */
type DayKind = 'holiday' | 'sunday' | 'saturday' | 'weekday'

function dayKind(date: string, holidays: HolidayList | null): DayKind {
  if (holidays?.names.has(date)) return 'holiday'
  const w = weekdayIndex(date)
  if (w === 6) return 'sunday'
  if (w === 5) return 'saturday'
  return 'weekday'
}

/** 日付の下に付ける1文字 */
const KIND_MARK: Record<Exclude<DayKind, 'weekday'>, string> = { holiday: '祝', sunday: '日', saturday: '土' }

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

export default function HolidayCalendar({ value, onChange, min, max, holidays, className }: HolidayCalendarProps) {
  const selectedStr = validOrUndefined(value)
  const minStr = validOrUndefined(min)
  const maxStr = validOrUndefined(max)

  // 最初に開く月:選んだ日の月、無ければ min の月、それも無ければ今月
  const [month, setMonth] = useState<Date>(() => gtfsToDate(`${(selectedStr ?? minStr ?? dateToGtfs(new Date())).slice(0, 6)}01`))
  // 外から value が変わって別の月の日になったら、その月を開く(描画中の調整。effect は使わない)
  const [prevSelected, setPrevSelected] = useState(selectedStr)
  if (prevSelected !== selectedStr) {
    setPrevSelected(selectedStr)
    if (selectedStr && selectedStr.slice(0, 6) !== dateToGtfs(month).slice(0, 6)) {
      setMonth(gtfsToDate(`${selectedStr.slice(0, 6)}01`))
    }
  }

  const disabled = useMemo(() => {
    const matchers: ({ before: Date } | { after: Date })[] = []
    if (minStr) matchers.push({ before: gtfsToDate(minStr) })
    if (maxStr) matchers.push({ after: gtfsToDate(maxStr) })
    return matchers
  }, [minStr, maxStr])

  // 祝日の情報が尽きる日(coveredUntil)より後の月を見ているときに、その旨を添える
  const nextMonth = addDays(`${dateToGtfs(month).slice(0, 6)}28`, 4).slice(0, 6) // 28日の4日後は必ず翌月
  const lastOfShownMonth = addDays(`${nextMonth}01`, -1)
  const beyondCoverage = holidays !== null && lastOfShownMonth > holidays.coveredUntil

  const DayButtonWithMark = useMemo(
    () =>
      function DayButtonWithMark(props: React.ComponentProps<typeof DayButton>) {
        const date = dateToGtfs(props.day.date)
        const kind = dayKind(date, holidays)
        const name = holidays?.names.get(date)
        const mark = kind === 'weekday' ? null : KIND_MARK[kind]
        const { children, ...rest } = props
        return (
          <CalendarDayButton
            {...rest}
            data-kind={kind}
            title={name ?? undefined}
            aria-label={name ? `${props['aria-label'] ?? date}、${name}` : props['aria-label']}
            className={KIND_CLASS[kind]}
            locale={ja}
          >
            {children}
            {mark && <span data-testid={`mark-${date}`}>{mark}</span>}
          </CalendarDayButton>
        )
      },
    [holidays],
  )

  return (
    <div className={cn('inline-block', className)}>
      <Calendar
        mode="single"
        required
        locale={ja}
        weekStartsOn={0}
        showOutsideDays={false}
        month={month}
        onMonthChange={setMonth}
        startMonth={minStr ? gtfsToDate(minStr) : undefined}
        endMonth={maxStr ? gtfsToDate(maxStr) : undefined}
        selected={selectedStr ? gtfsToDate(selectedStr) : undefined}
        onSelect={(d) => {
          if (d) onChange(dateToGtfs(d))
        }}
        disabled={disabled}
        formatters={{ formatCaption: (d) => `${d.getFullYear()}年${d.getMonth() + 1}月` }}
        labels={{
          labelPrevious: () => '前の月へ',
          labelNext: () => '次の月へ',
        }}
        classNames={{
          // 日曜(先頭の列)は赤、土曜(最後の列)は青。文字は日付のセルと同じ配色
          weekday:
            'flex-1 text-[0.8rem] font-normal select-none text-muted-foreground first:text-red-700 last:text-blue-700 dark:first:text-red-400 dark:last:text-blue-400',
        }}
        className="[--cell-size:--spacing(9)]"
        components={{ DayButton: DayButtonWithMark }}
      />
      <p data-testid="selected-date" aria-live="polite" className="mt-1 min-h-5 px-2 text-sm">
        {selectedStr ? describeSelected(selectedStr, holidays) : '日付を選んでください'}
      </p>
      {holidays === null && (
        <p className="px-2 text-xs text-muted-foreground">祝日一覧を読めないため、祝日は表示していません。</p>
      )}
      {beyondCoverage && (
        <p className="px-2 text-xs text-muted-foreground">この月は祝日一覧の収録より後のため、祝日を表示できないことがあります。</p>
      )}
    </div>
  )
}
