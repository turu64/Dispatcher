/**
 * 手順2「日付と時間帯」で使う、運行日の説明と既定の日付の選び方。
 * 判定の本体は gtfs/calendar.ts(activeServiceIds・servicesFor)に任せる。
 */
import { activeServiceIds, addDays, isValidGtfsDate, weekdayIndex } from '@/gtfs/calendar'
import type { GtfsFeed } from '@/gtfs/load'

/** 選んだ日の運行の説明 */
export interface ServiceDay {
  date: string
  /** 0=月曜 … 6=日曜 */
  weekday: number
  /** その日に走る service_id(空白を取った値。並べ替え済み) */
  serviceIds: string[]
  /** calendar.txt だけで決まる service_id(calendar_dates.txt を当てる前) */
  calendarServiceIds: string[]
  /** calendar_dates.txt で、その日に追加された service_id(calendar.txt だけなら走らないもの) */
  added: string[]
  /** calendar_dates.txt で、その日に運休になった service_id(calendar.txt だけなら走るもの) */
  removed: string[]
  /** calendar_dates.txt がその日の運行を変えているか(祝日の特別ダイヤなど) */
  exceptionApplied: boolean
}

function sorted(set: Iterable<string>): string[] {
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** calendar_dates.txt を除いたフィード(表は同じものを指すので写しは作らない) */
function withoutCalendarDates(feed: GtfsFeed): GtfsFeed {
  return { tables: new Map([...feed.tables].filter(([name]) => name !== 'calendar_dates')), warnings: [] }
}

/**
 * その日の運行の説明。走る service_id と、calendar_dates.txt が運行を変えているか(追加・運休)。
 * 追加・運休は、calendar.txt だけで決まる集合との差で求める(calendar_dates に行があっても、結果が変わらなければ数えない)。
 * date が不正な日付ならエラーにする(activeServiceIds と同じ)。
 */
export function describeServiceDay(feed: GtfsFeed, date: string): ServiceDay {
  const today = activeServiceIds(feed, date)
  const calendarOnly = activeServiceIds(withoutCalendarDates(feed), date)
  const added = sorted([...today].filter((id) => !calendarOnly.has(id)))
  const removed = sorted([...calendarOnly].filter((id) => !today.has(id)))
  return {
    date,
    weekday: weekdayIndex(date),
    serviceIds: sorted(today),
    calendarServiceIds: sorted(calendarOnly),
    added,
    removed,
    exceptionApplied: added.length > 0 || removed.length > 0,
  }
}

/** 既定の日付を探す日数の上限(運行期間が何年もあるフィードで、探しすぎないように) */
const SEARCH_DAYS = 400

/**
 * 手順2の既定の日付。
 *
 * 1. 探し始める日:今日が運行期間の中なら今日、そうでなければ運行期間の最初の日
 * 2. そこから、最初の「平日の運行になる日」を選ぶ。月〜金で、その日に走る service_id があり、
 *    calendar_dates.txt が運行を変えていない日(祝日の特別ダイヤなどではない日)
 * 3. 見つからなければ(calendar_dates.txt だけのフィードなど)、月〜金で走る便がある最初の日、
 *    それも無ければ走る便がある最初の日、それも無ければ探し始めた日
 *
 * 運行期間が無い(null)ときは null。today は 'YYYYMMDD'(日本時間の今日)。
 */
export function defaultServiceDate(
  feed: GtfsFeed,
  period: { start: string; end: string } | null,
  today: string,
): string | null {
  if (!period || !isValidGtfsDate(period.start) || !isValidGtfsDate(period.end) || period.start > period.end) return null
  const from = isValidGtfsDate(today) && period.start <= today && today <= period.end ? today : period.start

  let firstWeekdayWithService: string | null = null
  let firstWithService: string | null = null
  let date = from
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = describeServiceDay(feed, date)
    if (day.serviceIds.length > 0) {
      firstWithService ??= date
      if (day.weekday <= 4) {
        firstWeekdayWithService ??= date
        if (!day.exceptionApplied) return date
      }
    }
    if (date >= period.end) break
    date = addDays(date, 1)
  }
  return firstWeekdayWithService ?? firstWithService ?? from
}
