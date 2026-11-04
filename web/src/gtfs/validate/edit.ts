import { activeServiceIds, addDays, isValidGtfsDate, weekdayIndex } from '../calendar'
import type { Form2Result } from '../edit/form2'
import { formatDate, pairsOf } from '../edit/ops'
import { dayNumber, forEachDay, indexFeedServiceDays, runsOn } from '../edit/services'
import { compareStrings, stopTimesByTrip, tripSignature } from '../edit/signature'
import type { HolidayList } from '../holidays'
import type { GtfsFeed, GtfsRow } from '../load'
import { examplesOf, FEED_ERROR_RULES, feedIssues, MAX_EXAMPLES, type StructuralRule, type ValidationIssue } from './feed'

/**
 * 書き換えのたびの検証(取り決め 1104 §4.5)、祝日・平日・年末年始の確かめ(§5.8)、実施日までの日数による注意と
 * 画面に出す文言(§5.10)。どれも純粋な関数で、今日は引数で受け取る。
 */

export type { ValidationIssue } from './feed'

const INHERITED_PREFIX = '入力からある問題:'
const WEEKDAY_NAMES = ['月', '火', '水', '木', '金', '土', '日']

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function rowsOf(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

function dateWithWeekday(date: string): string {
  return `${formatDate(date)}(${WEEKDAY_NAMES[weekdayIndex(date)]})`
}

// ---- 構造の検査(基準にも当てて、入力からある問題を分ける) ----

/** feed_info の問題の対象。'feed_version_same'(入力と同じ)は基準には当てない */
function feedInfoTargets(feed: GtfsFeed): Set<string> {
  const out = new Set<string>()
  const table = feed.tables.get('feed_info')
  if (!table) return out
  const row = table.rows[0]
  const start = trimmed(row?.feed_start_date)
  const end = trimmed(row?.feed_end_date)
  if (!isValidGtfsDate(start)) out.add('feed_start_date')
  if (!isValidGtfsDate(end)) out.add('feed_end_date')
  if (isValidGtfsDate(start) && isValidGtfsDate(end) && start > end) out.add('順序')
  if (trimmed(row?.feed_version) === '') out.add('feed_version')
  return out
}

const STRUCTURAL_RULES: StructuralRule[] = [
  {
    code: 'duplicateTripId',
    file: 'trips.txt',
    message: (n) => `trips.txt の trip_id が重複しています(${n} 件)。`,
    targets: (feed) => {
      const seen = new Set<string>()
      const dup = new Set<string>()
      for (const t of rowsOf(feed, 'trips')) {
        const id = trimmed(t.trip_id)
        if (seen.has(id)) dup.add(id)
        seen.add(id)
      }
      return dup
    },
  },
  {
    code: 'tripWithoutStopTimes',
    file: 'trips.txt',
    message: (n) => `stop_times.txt に1行もない便があります(${n} 便)。`,
    targets: (feed) => {
      const withRows = new Set(rowsOf(feed, 'stop_times').map((r) => trimmed(r.trip_id)))
      return new Set(rowsOf(feed, 'trips').map((t) => trimmed(t.trip_id)).filter((id) => !withRows.has(id)))
    },
  },
  {
    code: 'stopTimesUnknownTrip',
    file: 'stop_times.txt',
    message: (n) => `stop_times.txt に、trips.txt にない trip_id があります(${n} 件)。`,
    targets: (feed) => {
      const trips = new Set(rowsOf(feed, 'trips').map((t) => trimmed(t.trip_id)))
      return new Set(rowsOf(feed, 'stop_times').map((r) => trimmed(r.trip_id)).filter((id) => !trips.has(id)))
    },
  },
  {
    code: 'unknownService',
    file: 'trips.txt',
    message: (n) => `trips.txt の service_id が calendar.txt にも calendar_dates.txt にもありません(${n} 件)。`,
    targets: (feed) => {
      const defined = new Set([...rowsOf(feed, 'calendar'), ...rowsOf(feed, 'calendar_dates')].map((r) => trimmed(r.service_id)))
      return new Set(rowsOf(feed, 'trips').map((t) => trimmed(t.service_id)).filter((id) => !defined.has(id)))
    },
  },
  {
    code: 'unknownRoute',
    file: 'trips.txt',
    message: (n) => `trips.txt の route_id が routes.txt にありません(${n} 件)。`,
    targets: (feed) => {
      const routes = new Set(rowsOf(feed, 'routes').map((r) => trimmed(r.route_id)))
      return new Set(rowsOf(feed, 'trips').map((t) => trimmed(t.route_id)).filter((id) => !routes.has(id)))
    },
  },
  {
    code: 'unknownStop',
    file: 'stop_times.txt',
    message: (n) => `stop_times.txt の stop_id が stops.txt にありません(${n} 件)。`,
    targets: (feed) => {
      const stops = new Set(rowsOf(feed, 'stops').map((s) => trimmed(s.stop_id)))
      const out = new Set<string>()
      for (const r of rowsOf(feed, 'stop_times')) {
        const id = trimmed(r.stop_id)
        if (!stops.has(id)) out.add(id)
      }
      return out
    },
  },
  {
    code: 'badCalendar',
    file: 'calendar.txt',
    message: (n) => `calendar.txt に、日付が正しくないか start_date が end_date より後の行があります(${n} 件)。`,
    targets: (feed) => {
      const out = new Set<string>()
      for (const r of rowsOf(feed, 'calendar')) {
        const s = trimmed(r.start_date)
        const e = trimmed(r.end_date)
        if (!isValidGtfsDate(s) || !isValidGtfsDate(e) || s > e) out.add(trimmed(r.service_id))
      }
      return out
    },
  },
  {
    code: 'duplicateCalendarDate',
    file: 'calendar_dates.txt',
    message: (n) => `calendar_dates.txt に、同じ service_id・date の行が2つ以上あります(${n} 件)。`,
    targets: (feed) => {
      const seen = new Set<string>()
      const dup = new Set<string>()
      for (const r of rowsOf(feed, 'calendar_dates')) {
        const key = `${trimmed(r.service_id)} ${trimmed(r.date)}`
        if (seen.has(key)) dup.add(key)
        seen.add(key)
      }
      return dup
    },
  },
  {
    code: 'badFeedInfo',
    file: 'feed_info.txt',
    message: (n) => `feed_info.txt の feed_start_date・feed_end_date・feed_version に問題があります(${n} 件)。`,
    targets: feedInfoTargets,
  },
]

function structuralIssues(base: GtfsFeed, result: Form2Result): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const sourceOf = new Map(result.report.tripIds.derived.map((d) => [d.to, d.from]))
  for (const rule of [...STRUCTURAL_RULES, ...FEED_ERROR_RULES]) {
    const edited = rule.targets(result.feed)
    if (rule.code === 'badFeedInfo' && result.report.feedVersion.after === result.report.feedVersion.before) {
      edited.add('feed_version が入力と同じ')
    }
    if (edited.size === 0) continue
    const inBase = rule.targets(base)
    // 写した便は新しい trip_id になるので、便の規則は写す元の trip_id で入力の問題を探す
    const inInput = (t: string) => inBase.has(rule.tripTargets ? (sourceOf.get(t) ?? t) : t)
    const fresh = [...edited].filter((t) => !inInput(t))
    const inherited = [...edited].filter(inInput)
    if (fresh.length > 0) {
      issues.push({ severity: 'error', code: rule.code, file: rule.file, message: rule.message(fresh.length), count: fresh.length, examples: examplesOf(fresh) })
    }
    if (inherited.length > 0) {
      issues.push({
        severity: 'warning',
        code: rule.code,
        file: rule.file,
        message: INHERITED_PREFIX + rule.message(inherited.length),
        count: inherited.length,
        examples: examplesOf(inherited),
        inherited: true,
      })
    }
  }
  return issues
}

// ---- 有効期間 ----

/** 有効期間が 7 日以下のときの文言(§5.10) */
export function shortValidityMessage(days: number): string {
  return `有効期間が ${days} 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、出力できません。期間の開始日か終了日を変えてください。`
}

/** 有効期間が 30 日未満のときの文言(§5.10) */
export function under30Message(days: number): string {
  return `有効期間が ${days} 日です。GTFS-JP は、可能であれば 30 日以上を望ましいとしています。`
}

function validityIssues(result: Form2Result): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { validity, inputValidity } = result.report
  if (validity.days <= 7) {
    issues.push({ severity: 'error', code: 'shortValidity', file: 'feed_info.txt', message: shortValidityMessage(validity.days), count: 1, examples: [], exportOnly: true })
  } else if (validity.days < 30) {
    issues.push({ severity: 'warning', code: 'validityUnder30', file: 'feed_info.txt', message: under30Message(validity.days), count: 1, examples: [] })
  }
  if (inputValidity.start < validity.start) {
    const last = addDays(validity.start, -1)
    issues.push({
      severity: 'info',
      code: 'validityGapBefore',
      file: '',
      message: `入力の有効期間のうち ${formatDate(inputValidity.start)}〜${formatDate(last)} は、出力に含まれません(形2では期間の外の日を元のダイヤで残せないため)。`,
      count: dayNumber(last) - dayNumber(inputValidity.start) + 1,
      examples: [inputValidity.start, last],
    })
  }
  if (validity.end < inputValidity.end) {
    const first = addDays(validity.end, 1)
    issues.push({
      severity: 'info',
      code: 'validityGapAfter',
      file: '',
      message: `入力の有効期間のうち ${formatDate(first)}〜${formatDate(inputValidity.end)} は、出力に含まれません(形2では期間の外の日を元のダイヤで残せないため)。`,
      count: dayNumber(inputValidity.end) - dayNumber(first) + 1,
      examples: [first, inputValidity.end],
    })
  }
  return issues
}

/** 編集後の便の trip_id のうち、基準では別の便(署名が違う便)を指していたもの(§5.4) */
function tripIdReusedIssue(base: GtfsFeed, result: Form2Result): ValidationIssue | null {
  const baseById = new Map<string, GtfsRow>()
  for (const t of rowsOf(base, 'trips')) {
    const id = trimmed(t.trip_id)
    if (!baseById.has(id)) baseById.set(id, t)
  }
  const candidates: { id: string; edited: GtfsRow; base: GtfsRow }[] = []
  for (const t of rowsOf(result.feed, 'trips')) {
    const id = trimmed(t.trip_id)
    const b = baseById.get(id)
    // 同じ行(残した便・足し戻した便・平日以外の便)は同じ便なので比べない
    if (b && b !== t) candidates.push({ id, edited: t, base: b })
  }
  if (candidates.length === 0) return null
  const baseGroups = stopTimesByTrip(rowsOf(base, 'stop_times'))
  const editedGroups = stopTimesByTrip(rowsOf(result.feed, 'stop_times'))
  const reused = candidates
    .filter((c) => {
      const se = tripSignature(trimmed(c.edited.route_id), editedGroups.get(c.id) ?? [])
      const sb = tripSignature(trimmed(c.base.route_id), baseGroups.get(c.id) ?? [])
      return se !== sb
    })
    .map((c) => c.id)
    .sort(compareStrings)
  if (reused.length === 0) return null
  return {
    severity: 'info',
    code: 'tripIdReused',
    file: 'trips.txt',
    message: `減便後の便のうち ${reused.length} 便の trip_id は、読み込んだ GTFS では別の便(停留所か時刻が違う便)を指していました。trip_id だけで前後の便を比べないでください。`,
    count: reused.length,
    examples: reused.slice(0, MAX_EXAMPLES),
  }
}

const FORM2_FILES: Record<string, string> = {
  calendarRowDropped: 'calendar.txt',
  servicesDropped: 'trips.txt',
  feedInfoCreated: 'feed_info.txt',
  feedInfoColumnsAdded: 'feed_info.txt',
  feedVersionNotIncreasing: 'feed_info.txt',
  unknownExcludedRoute: 'routes.txt',
  blockIdCopied: 'trips.txt',
  orphanStopTimesDropped: 'stop_times.txt',
  replacementNotActiveSkipped: 'trips.txt',
}

// ---- 祝日・平日・年末年始(§5.8) ----

/** start〜end のうち、祝日一覧の収録の範囲(first〜coveredUntil)の外の部分 */
function uncovered(list: HolidayList, start: string, end: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = []
  if (start < list.first) out.push({ start, end: end < list.first ? end : addDays(list.first, -1) })
  if (end > list.coveredUntil) out.push({ start: start > list.coveredUntil ? start : addDays(list.coveredUntil, 1), end })
  return out
}

const EXCEPTION_LABELS: Record<string, string> = { '1': '運行', '2': '運休' }

/** 入力の祝日の例外の型(service_id ごとの exception_type。'01=運休、03=運休、06=運行') */
function exceptionPattern(base: GtfsFeed, holidays: readonly string[]): string {
  const dates = new Set(holidays)
  const byService = new Map<string, Set<string>>()
  for (const r of rowsOf(base, 'calendar_dates')) {
    if (!dates.has(trimmed(r.date))) continue
    const sid = trimmed(r.service_id)
    let set = byService.get(sid)
    if (!set) byService.set(sid, (set = new Set()))
    set.add(EXCEPTION_LABELS[trimmed(r.exception_type)] ?? trimmed(r.exception_type))
  }
  return [...byService.keys()]
    .sort(compareStrings)
    .map((sid) => `${sid}=${[...byService.get(sid)!].sort(compareStrings).join('・')}`)
    .join('、')
}

function listDates(dates: readonly string[], limit = 20): string {
  const shown = dates.slice(0, limit).map(dateWithWeekday).join('、')
  return dates.length > limit ? `${shown} ほか ${dates.length - limit} 日` : shown
}

/** 新しい有効期間の中で、編集後のフィードで平日の service が走る日(§5.10 の「平日ダイヤが走る日」) */
export function weekdayServiceDays(result: Form2Result): string[] {
  const sd = indexFeedServiceDays(result.feed).get(result.plan.weekdayService.trim())
  const days: string[] = []
  forEachDay(result.report.validity.start, result.report.validity.end, (d, w) => {
    if (runsOn(sd, d, w)) days.push(d)
  })
  return days
}

function calendarIssues(base: GtfsFeed, result: Form2Result, holidays: HolidayList | null): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const wk = result.plan.weekdayService.trim()
  const { validity, inputValidity } = result.report
  const index = indexFeedServiceDays(result.feed)
  // 平日ダイヤが走る日・weekdayNotRunning・yearEnd は主の組で見る(一部の日だけ走る service で警告があふれないため)。
  // 祝日の確かめは、すべての組の平日の service で見る(docs/design-service-groups.md §4.6)
  const sd = index.get(wk)
  // 組が複数のときは、減便後に便が残る平日の service だけを見る(なくした service の calendar の行は残るが、便は走らない)
  const allWeekdays = pairsOf(result.plan).map((p) => p.weekday)
  const withTrips = new Set(rowsOf(result.feed, 'trips').map((t) => trimmed(t.service_id)))
  const weekdays = allWeekdays.length === 1 ? allWeekdays : allWeekdays.filter((s) => withTrips.has(s))

  if (holidays === null) {
    issues.push({ severity: 'info', code: 'holidayListMissing', file: '', message: '祝日一覧を読めないため、祝日の確認をしていません。', count: 0, examples: [] })
  } else {
    for (const range of uncovered(holidays, validity.start, validity.end)) {
      issues.push({
        severity: 'warning',
        code: 'holidayNotCovered',
        file: '',
        message: `${formatDate(range.start)}〜${formatDate(range.end)} の祝日は、内閣府の一覧にまだないため確かめていません。`,
        count: dayNumber(range.end) - dayNumber(range.start) + 1,
        examples: [range.start, range.end],
      })
    }
    // 平日の祝日に、減便後の平日ダイヤが走る日
    const flagged: string[] = []
    const flaggedServices = new Set<string>()
    forEachDay(validity.start, validity.end, (d, w) => {
      if (w >= 5 || !holidays.names.has(d)) return
      const running = weekdays.filter((s) => runsOn(index.get(s), d, w))
      if (running.length === 0) return
      flagged.push(d)
      for (const s of running) flaggedServices.add(s)
    })
    const serviceLabel = allWeekdays.length === 1 ? wk : weekdays.filter((s) => flaggedServices.has(s)).join('・')
    if (flagged.length > 0) {
      const flaggedSet = new Set(flagged)
      const others: string[] = []
      forEachDay(inputValidity.start, inputValidity.end, (d) => {
        if (holidays.names.has(d) && !flaggedSet.has(d)) others.push(d)
      })
      const pattern = exceptionPattern(base, others)
      const names = flagged.map((d) => `${dateWithWeekday(d)} ${holidays.names.get(d)}`).join('、')
      if (pattern !== '') {
        issues.push({
          severity: 'warning',
          code: 'holidayWithoutException',
          file: 'calendar_dates.txt',
          message: `平日の祝日(${names})に、減便後の平日ダイヤ(${serviceLabel})が走ります。入力のほかの祝日には calendar_dates の例外があります(${pattern})。同じ型で例外を足すかを確かめてください。`,
          count: flagged.length,
          examples: flagged.slice(0, MAX_EXAMPLES),
        })
      } else {
        issues.push({
          severity: 'info',
          code: 'holidayWithoutException',
          file: 'calendar_dates.txt',
          message: `この GTFS は祝日も平日のダイヤで走る作りです(入力の祝日に calendar_dates の例外がありません)。平日の祝日(${names})も、減便後の平日ダイヤ(${serviceLabel})で走ります。`,
          count: flagged.length,
          examples: flagged.slice(0, MAX_EXAMPLES),
        })
      }
    }
  }

  // 平日ダイヤが走らない平日
  const notRunning: string[] = []
  const yearEnd: string[] = []
  forEachDay(validity.start, validity.end, (d, w) => {
    if (w >= 5) return
    const runs = runsOn(sd, d, w)
    if (!runs) notRunning.push(d)
    const md = d.slice(4)
    if (runs && (md >= '1228' || md <= '0104')) yearEnd.push(d)
  })
  if (notRunning.length > 0) {
    const detail = notRunning.slice(0, 20).map((d) => {
      const services = [...activeServiceIds(result.feed, d)].sort(compareStrings)
      return `${dateWithWeekday(d)}:${services.length > 0 ? services.join('・') : '走る service なし'}`
    })
    const rest = notRunning.length > 20 ? ` ほか ${notRunning.length - 20} 日` : ''
    issues.push({
      severity: 'info',
      code: 'weekdayNotRunning',
      file: 'calendar_dates.txt',
      message: `新しい有効期間の平日(月〜金)のうち ${notRunning.length} 日は、平日ダイヤ(${wk})が走らないため、減便の対象になりません(${detail.join('、')}${rest})。`,
      count: notRunning.length,
      examples: notRunning.slice(0, MAX_EXAMPLES),
    })
  }
  if (yearEnd.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'yearEnd',
      file: 'calendar_dates.txt',
      message: `${listDates(yearEnd)}は減便後の平日ダイヤで走ります。年末年始の運行を確かめてください。GTFS-JP は年末年始のダイヤがあれば calendar_dates を必須としています。`,
      count: yearEnd.length,
      examples: yearEnd.slice(0, MAX_EXAMPLES),
    })
  }
  return issues
}

/**
 * 書き換えのたびの検証(propose のたびに呼ぶ)。
 * error の規則(shortValidity と「feed_version が入力と同じ」を除く)は基準にも当て、基準にも同じ対象の問題があれば
 * その分を「入力からある問題」(warning、inherited)に分ける。編集で新しく生じた問題だけを error にする。
 * 基準と編集後を比べる error(stopIdChanged・routeIdChanged)と、フィード全体の warning・info は feed.ts の feedIssues
 */
export function validateEdit(base: GtfsFeed, result: Form2Result, holidays: HolidayList | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [...structuralIssues(base, result), ...validityIssues(result)]
  const reused = tripIdReusedIssue(base, result)
  if (reused) issues.push(reused)
  for (const w of result.report.warnings) {
    if (w.code === 'shortValidity') continue
    issues.push({ severity: 'warning', code: `form2.${w.code}`, file: FORM2_FILES[w.code] ?? '', message: w.message, count: 1, examples: [] })
  }
  issues.push(...feedIssues(base, result))
  issues.push(...calendarIssues(base, result, holidays))
  return issues
}

// ---- 実施日までの日数(§5.10) ----

const PUBLISH_NOTES = [
  'Google には現行の版と将来の版を1つずつしか持たせられず、開始日が過去の版を出すと、提出済みの将来の版(次のダイヤ改正など)を上書きします。',
  '便の削除が大きいと、公開先の審査が長引くことがあります。',
  'Dispatcher は届出・公示の要否を判定しません。計画どおり運行できないときの公示(運輸規則第17条)も含め、運輸支局に確認してください。',
]

/**
 * 今日(today、'YYYYMMDD'、日本時間)に関わる注意。
 * - futureStart(info):開始日が入力の開始日より後で、今日より先
 * - validityEndSoon(warning):新しい有効期間の末日が今日から 30 日以内
 * - 実施日までの日数 d(新しい有効期間の開始日 − 今日)による注意を1つ(warning):
 *   - leadTimePassed:d < 0(実施日を過ぎている)。反映が間に合うかの文は出さず、過ぎた日数と補い方を出す
 *   - leadTimeUnder3・leadTimeUnder7・leadTimeUnder30:0 ≦ d で当てはまるもののうち、いちばん短い日数のもの
 * - publishNotes(info):いつも出す3つ(1つずつ別の issue)
 */
export function timingNotices(result: Form2Result, today: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { validity, inputValidity } = result.report
  const issue = (severity: ValidationIssue['severity'], code: string, message: string): ValidationIssue => ({
    severity,
    code,
    file: '',
    message,
    count: 1,
    examples: [],
  })

  if (validity.start > inputValidity.start && validity.start > today) {
    // 開始日の前日が今日なら「今日〜(今日の日付)」と同じ日が並ぶので、「今日(日付)」の1つにする
    const lastDay = addDays(validity.start, -1)
    const days = lastDay === today ? `今日(${formatDate(today)})` : `今日〜${formatDate(lastDay)}`
    issues.push(
      issue(
        'info',
        'futureStart',
        `${days} は、この ZIP を公開すると経路検索に便が出ません。公開は開始日の直前にするか、それまでは今の版を公開したままにしてください(Google は現行の版と将来の版を1つずつ持てます)。`,
      ),
    )
  }
  if (dayNumber(validity.end) - dayNumber(today) <= 30) {
    issues.push(
      issue('warning', 'validityEndSoon', `${formatDate(addDays(validity.end, 1))} から経路検索に便が出なくなります。その前に新しい版を公開してください。`),
    )
  }

  const d = dayNumber(validity.start) - dayNumber(today)
  const lead = `実施まで ${d} 日です。`
  if (d < 0) {
    issues.push(
      issue(
        'warning',
        'leadTimePassed',
        `実施日(${formatDate(validity.start)})を ${-d} 日過ぎています。過ぎた日は経路検索に正しく出ていません。周知文などで補ってください。`,
      ),
    )
  } else if (d < 3) {
    issues.push(
      issue(
        'warning',
        'leadTimeUnder3',
        `${lead}静的 GTFS の反映が間に合わない可能性があります(Google は最低 2〜3 日前、calendar_dates の運休の反映に 24〜48 時間)。周知文で補ってください。`,
      ),
    )
  } else if (d < 7) {
    issues.push(
      issue('warning', 'leadTimeUnder7', `${lead}運輸規則第6条の 7 日前の公示に間に合いません。緊急やむを得ない理由の扱いは運輸支局に確認してください。`),
    )
  } else if (d < 30) {
    issues.push(
      issue(
        'warning',
        'leadTimeUnder30',
        `${lead}運行計画の変更の事前届出(実施予定日の 30 日前まで、施行規則第15条の13)に間に合いません。届出の区分(事前・事後)は運輸支局に確認してください。`,
      ),
    )
  }

  for (const note of PUBLISH_NOTES) issues.push(issue('info', 'publishNotes', note))
  return issues
}

// ---- 画面に出す文言(§5.10) ----

export interface Form2Texts {
  /** 有効期間と期間の外。今日に関わる「開始日が今日より先」「末日が 30 日以内」は timingNotices、7 日以下・30 日未満は validateEdit が出す */
  validity: string[]
  /** 何が変わるか */
  changes: string[]
}

/** 方針の画面(§6)と出力の画面(§9)に出す文言 */
export function form2Texts(result: Form2Result, today: string): Form2Texts {
  const { validity, inputValidity } = result.report
  const plan = result.plan
  const texts: string[] = [`出力する GTFS の有効期間は ${formatDate(validity.start)}〜${formatDate(validity.end)}(${validity.days}日)です。`]
  if (validity.start > inputValidity.start && validity.start <= today) {
    texts.push(`${formatDate(inputValidity.start)}〜${formatDate(addDays(validity.start, -1))} は出力に含まれません(過ぎた日です)。`)
  }
  if (plan.period.end !== null) {
    texts.push(
      `${formatDate(addDays(validity.end, 1))} 以降は出力に含まれず、経路検索に便が出なくなります。元のダイヤには自動で戻りません。Dispatcher は期間の後のダイヤを出力しないため、期間が終わる前に、事業者のふだんの手順で元のダイヤの GTFS を公開し直してください。元の ZIP は保存しておいてください。`,
    )
  } else {
    texts.push(`出力の有効期間は ${formatDate(inputValidity.end)}(入力の GTFS の末日)までです。減便が続くときは、次の版でも同じ減便の方針を承認してください。`)
  }

  const label = plan.kind === 'weekdayToSaturday' ? '土曜' : '日祝'
  const n = weekdayServiceDays(result).length
  const changes = [
    `期間の中で平日ダイヤが走る日(${n}日。祝日などの例外の日を除く)は、すべて${label}ダイヤ(平日に戻した便と、除外した系統の便を除く)で走ります。`,
    '出力した GTFS だけでは元に戻せません。元に戻すのは、この画面の編集の履歴と、読み込んだ元の GTFS で行います。',
  ]
  if (result.report.tripIds.addedBack.length > 0) {
    changes.push('平日に戻した便は学校の休業日にも走ります。休校日運休の便は GTFS では表せないため、変更指示書と周知文で補ってください。')
  }
  changes.push(
    '次に運行管理システムや時刻表ソフトから GTFS を出力するときは、システム側のダイヤにも減便を反映してから出力してください。反映しないと、GTFS だけが減便前のダイヤに戻ります。',
  )
  return { validity: texts, changes }
}
