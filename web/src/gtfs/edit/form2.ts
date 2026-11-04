import { isValidGtfsDate } from '../calendar'
import type { GtfsFeed, GtfsRow, GtfsTable } from '../load'
import {
  checkPolicy,
  formatDate,
  keptServicesOf,
  pairsOf,
  shortDates,
  skippedReplacementsOf,
  weekdayServicesOf,
  type Form2Plan,
  type PolicySettings,
  type ServicePair,
} from './ops'
import {
  describeServices,
  feedValidity,
  forEachDay,
  indexFeedServiceDays,
  indexServiceDays,
  policyValidity,
  runsAnyDay,
  runsOn,
  type ServiceDays,
} from './services'
import { compareStrings, stopTimesByTrip, tripSignature } from './signature'

/**
 * 形2(便の入れ替え)の適用(取り決め 1104 §5)。
 *
 * 平日の便を写す元(土曜・日祝)の便に入れ替え、有効期間を方針の期間に合わせる。純粋な関数で、時計を読まず、
 * 基準のフィードの Map・表・行は書き換えない(行を変えるときは新しい行を作る)。書き換える表は
 * trips・stop_times・calendar・calendar_dates・feed_info の 5 つだけで、ほかの表は基準と同じ参照のまま返す。
 */

export interface Form2Options {
  /** 作成日時 'YYYYMMDDhhmm'(日本時間)。feed_version に使う */
  generatedAt: string
  /**
   * 利用者が決めた feed_version。省く・空(空白だけを含む)なら既定の規則(defaultFeedVersion)。
   * 書き出しの後で書き換えず、ここで渡す(検証が feed_info の同じ値を見るため)。
   * 入力の feed_version と同じ・以下なら feedVersionNotIncreasing の警告を出す
   */
  feedVersion?: string
}

export type Form2Outcome = { ok: true; result: Form2Result } | { ok: false; message: string }

export interface Form2Result {
  /**
   * 編集後のフィード。trips・stop_times・calendar・calendar_dates・feed_info のうち、基準にある表だけを新しい表にする。
   * 基準に無い表は作らない(calendar.txt が無い GTFS に空の calendar を足さない)。例外は feed_info を作る場合(§5.7)だけ。warnings は []
   */
  feed: GtfsFeed
  plan: Form2Plan
  report: Form2Report
}

export interface Form2Report {
  inputValidity: { start: string; end: string }
  /** days は両端を含む日数 */
  validity: { start: string; end: string; days: number }
  tripIds: {
    /** 主の組(平日の service と、主の入れ替えに使う service)の規則。主の組に入れ替えに使う service が無ければ 'append-service' */
    rule: TripIdRule
    /** service_id(または頭)の部分の位置(0 始まり)。'append-service' なら null */
    servicePartIndex: number | null
    /** from の昇順 */
    derived: { from: string; to: string }[]
    /** 以下すべて昇順 */
    kept: string[]
    addedBack: string[]
    removed: string[]
    collisions: { from: string; candidate: string; assigned: string; collidedWithService: string | null }[]
  }
  addBack: {
    requested: number
    accepted: string[]
    ignoredExcludedRoute: string[]
    /** tripId の昇順 */
    ignoredAlreadyPresent: { tripId: string; sameAs: string }[]
    notWeekday: string[]
    notFound: string[]
    duplicate: string[]
    /** その便の service が残す平日の service(keptWeekdayServices)にある。pairs があるときだけ置く(昇順) */
    alreadyKept?: string[]
    /**
     * その便の service が、新しい有効期間に1日も走らないため組ごと出力から除く平日の service(droppedServices)にある。
     * 出力に入らないので戻さない。pairs があるときだけ置く(昇順)
     */
    notActive?: string[]
  }
  calendarDates: { kept: number; dropped: { service_id: string; date: string; exception_type: string }[] }
  /** 新しい有効期間のどの日にも走らなくなり、便ごと出力から除いた service(§5.6) */
  droppedServices: { serviceId: string; trips: number }[]
  rowOrder: { trips: 'service_id,trip_id' | 'trip_id' | 'input'; stop_times: 'trips' | 'input' }
  feedVersion: { before: string; after: string }
  warnings: { code: string; message: string }[]
  /** 組ごとの結果。plan に pairs があるときだけ置く(plan の pairs の順) */
  pairs?: Form2PairReport[]
}

/**
 * 加わる便の trip_id の規則(§5.4、docs/design-service-groups.md §4.4)。
 * - replace-service-part:service_id と等しい部分を置き換える
 * - replace-family-part:service_id の頭(最初の '_' より前)と等しい部分を、入れ替えに使う service の頭から平日の service の頭にする
 * - append-service:後ろに '_{平日の service_id}' を付ける
 */
export type TripIdRule = 'replace-service-part' | 'replace-family-part' | 'append-service'

export interface Form2PairReport {
  weekday: string
  /** 平日の service が新しい有効期間に走らないため、組ごと除いた(加わる便を作らない) */
  dropped: boolean
  /** なくなる平日の便の数 */
  removed: number
  /**
   * notActive:新しい有効期間に1日も走らないため、この service の便は加えない(added は 0。
   * checkPolicy の replacementNotActiveSkipped。2026-11-04 に利用者が決定)
   */
  replacements: { serviceId: string; rule: TripIdRule; servicePartIndex: number | null; added: number; notActive: boolean }[]
}

/**
 * 前後の比較(diffWeekdayTrips)に渡す平日の service:weekdayServicesOf(plan) から、新しい有効期間に走らないため
 * 組ごと出力から除いた service(report.droppedServices)を引いたもの。除いた service の便は期間に1日も走らないので、
 * 「なくなる便」や平日に戻す候補に数えない
 */
export function activeWeekdayServicesOf(result: Pick<Form2Result, 'plan' | 'report'>): Set<string> {
  const weekdays = weekdayServicesOf(result.plan)
  for (const d of result.report.droppedServices) weekdays.delete(d.serviceId)
  return weekdays
}

const GENERATED_AT = /^\d{12}$/
const TWELVE_DIGITS = /^\d{12}$/
// 改行・制御文字は CSV の1行を壊すので入れない
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}
/** 長すぎる値は経路検索側の取り込みで切られることがある */
export const MAX_FEED_VERSION_LENGTH = 100

/** 既定の feed_version の規則:入力が空か 12 桁なら作成日時、それ以外は '{入力}_dispatcher_{作成日時}' */
export function defaultFeedVersion(before: string, generatedAt: string): string {
  const b = before.trim()
  return b === '' || TWELVE_DIGITS.test(b) ? generatedAt : `${b}_dispatcher_${generatedAt}`
}

/** 利用者が入れた feed_version の問題。問題が無ければ null(空は既定にするので問題としない) */
export function feedVersionProblem(value: string): string | null {
  const v = value.trim()
  if (hasControlChar(v)) return 'feed_version に改行や制御文字は使えません。'
  if (v.length > MAX_FEED_VERSION_LENGTH) return `feed_version は ${MAX_FEED_VERSION_LENGTH} 文字以内にしてください。`
  return null
}
/** 警告の文に並べる例の数 */
const MAX_EXAMPLES = 5

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/**
 * 入力の trip_id の付け方から、service_id の部分の位置を見つける(§5.4)。
 * 平日の便と写す元の便のすべてについて trip_id を '_' で分け、部分の数がすべて同じで、
 * ある位置の部分がどの便でも自分の service_id と等しければ、その位置(複数なら最も右)。見つからなければ null
 */
function findServicePart(rows: readonly GtfsRow[]): number | null {
  if (rows.length === 0) return null
  const parts = rows.map((r) => trimmed(r.trip_id).split('_'))
  const n = parts[0].length
  if (n < 2 || !parts.every((p) => p.length === n)) return null
  const services = rows.map((r) => trimmed(r.service_id))
  for (let k = n - 1; k >= 0; k--) {
    if (parts.every((p, i) => p[k] === services[i])) return k
  }
  return null
}

/** service_id の頭(最初の '_' より前。'_' が無ければ全体) */
function headOf(serviceId: string): string {
  const i = serviceId.indexOf('_')
  return i < 0 ? serviceId : serviceId.slice(0, i)
}

/**
 * 規則 2(replace-family-part)の位置:すべての便の trip_id を '_' で分け、左から k 番目の部分が自分の service_id の頭と
 * 等しい k のうち、すべての便に共通で最も右のもの。部分の数はそろっていなくてよいが、k+1 個に足りない便が1つでもあれば
 * その k は使わない。部分が1つしかない便(trip_id 全体を置き換えることになる)があれば決めない
 */
function findFamilyPart(rows: readonly GtfsRow[]): number | null {
  if (rows.length === 0) return null
  const parts = rows.map((r) => trimmed(r.trip_id).split('_'))
  if (parts.some((p) => p.length < 2)) return null
  const heads = rows.map((r) => headOf(trimmed(r.service_id)))
  const shortest = Math.min(...parts.map((p) => p.length))
  for (let k = shortest - 1; k >= 0; k--) {
    if (parts.every((p, i) => p[k] === heads[i])) return k
  }
  return null
}

/**
 * 平日の service weekday と入れ替えに使う service replacement の組み合わせの trip_id の規則(§5.4)。
 * rows はその2つの service のすべての便(除外した系統の便も含む)。規則 1 → 規則 2 → 後ろに付ける、の順。
 * 規則 2 は2つの頭が同じなら使わない(置き換えても trip_id が変わらないため)
 */
export function tripIdRuleFor(
  rows: readonly GtfsRow[],
  weekday: string,
  replacement: string,
): { rule: TripIdRule; index: number | null } {
  const servicePart = findServicePart(rows)
  if (servicePart !== null) return { rule: 'replace-service-part', index: servicePart }
  if (headOf(weekday) !== headOf(replacement)) {
    const familyPart = findFamilyPart(rows)
    if (familyPart !== null) return { rule: 'replace-family-part', index: familyPart }
  }
  return { rule: 'append-service', index: null }
}

/** 加わる便の trip_id の候補(重なりを調べる前) */
function candidateTripId(from: string, rule: { rule: TripIdRule; index: number | null }, replacement: string, weekday: string): string {
  if (rule.index !== null) {
    const parts = from.split('_')
    const [was, to] = rule.rule === 'replace-family-part' ? [headOf(replacement), headOf(weekday)] : [replacement, weekday]
    // 位置 k が入れ替えに使う service_id(頭)でない便(起きない想定)は、後ろに付ける規則と同じにする
    if (parts[rule.index] === was) {
      parts[rule.index] = to
      return parts.join('_')
    }
  }
  return `${from}_${weekday}`
}

/** trips の並び:(service_id, trip_id) の昇順か、trip_id の昇順か、どちらでもないか(空白を取ったキーで判定) */
function tripOrderOf(rows: readonly GtfsRow[]): Form2Report['rowOrder']['trips'] {
  let bySidTid = true
  let byTid = true
  for (let i = 1; i < rows.length && (bySidTid || byTid); i++) {
    const s = compareStrings(trimmed(rows[i - 1].service_id), trimmed(rows[i].service_id))
    const t = compareStrings(trimmed(rows[i - 1].trip_id), trimmed(rows[i].trip_id))
    if (s > 0 || (s === 0 && t > 0)) bySidTid = false
    if (t > 0) byTid = false
  }
  return bySidTid ? 'service_id,trip_id' : byTid ? 'trip_id' : 'input'
}

/**
 * stop_times の並び:便ごとにまとまり、その便の並びが trips の並び(stop_times に出てくる便だけを見た順)と同じなら 'trips'
 */
function stopTimesOrderOf(stopTimes: readonly GtfsRow[], trips: readonly GtfsRow[]): Form2Report['rowOrder']['stop_times'] {
  const sequence: string[] = []
  const seen = new Set<string>()
  let prev: string | null = null
  for (const row of stopTimes) {
    const id = trimmed(row.trip_id)
    if (id === prev) continue
    if (seen.has(id)) return 'input'
    seen.add(id)
    sequence.push(id)
    prev = id
  }
  const tripSequence = trips.map((t) => trimmed(t.trip_id)).filter((id) => seen.has(id))
  if (tripSequence.length !== sequence.length) return 'input'
  return tripSequence.every((id, i) => id === sequence[i]) ? 'trips' : 'input'
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort(compareStrings)
}

/**
 * 形2を適用する。checkPolicy に error があれば ok: false(理由は error の文をつないだもの)。
 * 平日に戻す便の分類(§5.3)、加わる便の trip_id(§5.4)、行の並び(§5.5)、有効期間と calendar・calendar_dates(§5.6)、
 * feed_info(§5.7)の規則は取り決めのとおり。
 *
 * plan に pairs があるときは、組ごとに平日の service の便をなくし、入れ替えに使う service の便を加える
 * (docs/design-service-groups.md §4.3〜§4.5)。新しい有効期間に1日も走らない入れ替えに使う service(skippedReplacementsOf)の
 * 便は加えない(replacementNotActiveSkipped)。pairs が無いときは pairsOf の1組で同じ処理を通り、出力と report は今と同じ
 */
export function applyForm2(base: GtfsFeed, plan: Form2Plan, opts: Form2Options): Form2Outcome {
  if (!GENERATED_AT.test(opts.generatedAt)) {
    return { ok: false, message: `作成日時の形が正しくありません(${opts.generatedAt})。YYYYMMDDhhmm の12桁にしてください。` }
  }
  const versionProblem = opts.feedVersion === undefined ? null : feedVersionProblem(opts.feedVersion)
  if (versionProblem) return { ok: false, message: versionProblem }
  const errors = checkPolicy(base, plan).filter((p) => p.severity === 'error')
  if (errors.length > 0) return { ok: false, message: errors.map((e) => e.message).join('\n') }

  const tripsTable = base.tables.get('trips')
  const inputValidity = feedValidity(base)
  const validity = inputValidity ? policyValidity(inputValidity, plan.period) : null
  // checkPolicy が通れば起きない(便が無い、有効期間が決まらない・空ならエラーになる)
  if (!tripsTable || !inputValidity || !validity) return { ok: false, message: 'trips.txt か有効期間がないため、減便の方針を適用できません。' }

  const warnings: { code: string; message: string }[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })

  const multi = plan.pairs !== undefined
  const pairs = pairsOf(plan)
  const weekdaySet = new Set(pairs.map((p) => p.weekday))
  const keptServices = new Set(keptServicesOf(plan))
  /** 入れ替えに使う service → 便を加える平日の service(checkPolicy が重なりを止めるので1つ) */
  const intoOf = new Map<string, string>()
  for (const p of pairs) for (const r of p.replacements) if (!intoOf.has(r)) intoOf.set(r, p.weekday)
  const wk = plan.weekdayService.trim()
  const excluded = new Set(plan.excludedRoutes.map((r) => r.trim()))

  // ---- §5.6 有効期間、calendar、calendar_dates ----
  // 加わる便を作る前に、走らなくなる service(組ごと除く平日の service)を決める。ここより前と §5.2〜§5.4 は警告を出さないので、
  // 警告の並びは変わらない
  if (plan.period.start < inputValidity.start) {
    warn(
      'periodStartClamped',
      `期間の開始日(${formatDate(plan.period.start)})が入力の開始日より前のため、入力の開始日(${formatDate(inputValidity.start)})にそろえました。`,
    )
  }
  if (plan.period.end !== null && plan.period.end > inputValidity.end) {
    warn(
      'periodEndClamped',
      `期間の終了日(${formatDate(plan.period.end)})が入力の末日より後のため、入力の末日(${formatDate(inputValidity.end)})にそろえました。`,
    )
  }
  if (validity.days <= 7) {
    warn(
      'shortValidity',
      `有効期間が ${validity.days} 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、出力できません。期間の開始日か終了日を変えてください。`,
    )
  }

  const calendars = clampCalendars(base, validity, warn)
  const { droppedServiceIds } = calendars
  /** 平日の service が新しい有効期間に走らないため、組ごと除く(主の組は checkPolicy が weekdayNotActive で止める) */
  const droppedPair = (weekday: string) => droppedServiceIds.has(weekday)

  // 新しい有効期間に1日も走らないため加えない入れ替えに使う service(pairs があるときだけ。checkPolicy と同じ規則)
  let dayIndex: Map<string, ServiceDays> | null = null
  let skipped = new Set<string>()
  if (multi) {
    dayIndex = indexFeedServiceDays(base)
    const counts = new Map<string, number>()
    for (const t of tripsTable.rows) {
      const sid = trimmed(t.service_id)
      counts.set(sid, (counts.get(sid) ?? 0) + 1)
    }
    skipped = skippedReplacementsOf(plan, dayIndex, validity, (sid) => counts.get(sid) ?? 0)
  }

  const stopTimesTable = base.tables.get('stop_times')
  const stopTimeRows = stopTimesTable?.rows ?? []
  const groups = stopTimesByTrip(stopTimeRows)
  const signatures = new Map<GtfsRow, string>()
  const signatureOf = (row: GtfsRow): string => {
    let s = signatures.get(row)
    if (s === undefined) {
      s = tripSignature(trimmed(row.route_id), groups.get(trimmed(row.trip_id)) ?? [])
      signatures.set(row, s)
    }
    return s
  }

  // ---- §5.2 便の分け方 ----
  const tripRows = tripsTable.rows
  const tripById = new Map<string, GtfsRow>()
  const weekdayRows: GtfsRow[] = []
  const rowsByService = new Map<string, GtfsRow[]>()
  /** 加わる便の元(除外した系統を除く)。減便前の trips の並び */
  const sources: GtfsRow[] = []
  for (const row of tripRows) {
    const id = trimmed(row.trip_id)
    if (!tripById.has(id)) tripById.set(id, row)
    const sid = trimmed(row.service_id)
    const into = intoOf.get(sid)
    if (!weekdaySet.has(sid) && into === undefined) continue
    let list = rowsByService.get(sid)
    if (!list) rowsByService.set(sid, (list = []))
    list.push(row)
    if (weekdaySet.has(sid)) weekdayRows.push(row)
    else if (into !== undefined && !droppedPair(into) && !skipped.has(sid) && !excluded.has(trimmed(row.route_id))) sources.push(row)
  }
  // 組ごと除く平日の service の便は、除外した系統でも出力に入らないので「残した便」に数えない
  const keptRows = weekdayRows.filter((r) => excluded.has(trimmed(r.route_id)) && !droppedPair(trimmed(r.service_id)))

  // ---- §5.3 平日に戻す便の分類(前から順に、最初に当てはまったもの) ----
  // 走る日の包含(S2):加わる便(または先に受け付けた便)の service が、戻そうとする便の service の走る日(新しい有効期間の中)を
  // すべて含むときだけ「すでにある」。同じ service なら常に含む(1組の処理は今と同じ)
  const daysCache = new Map<string, string[]>()
  const daysOf = (sid: string): string[] => {
    let days = daysCache.get(sid)
    if (!days) {
      dayIndex ??= indexFeedServiceDays(base)
      const sd = dayIndex.get(sid)
      const list: string[] = []
      forEachDay(validity.start, validity.end, (d, w) => {
        if (runsOn(sd, d, w)) list.push(d)
      })
      days = list
      daysCache.set(sid, days)
    }
    return days
  }
  const covers = (outer: string, inner: string): boolean => {
    if (outer === inner) return true
    const o = new Set(daysOf(outer))
    return daysOf(inner).every((d) => o.has(d))
  }
  /** 署名 → 同じ署名の加わる便(元の trip_id と、加わる先の平日の service)。減便前の trips の並び */
  const derivedSignatures = new Map<string, { tripId: string; service: string }[]>()
  for (const row of sources) {
    const s = signatureOf(row)
    const entry = { tripId: trimmed(row.trip_id), service: intoOf.get(trimmed(row.service_id)) as string }
    const list = derivedSignatures.get(s)
    if (list) list.push(entry)
    else derivedSignatures.set(s, [entry])
  }
  const addBack: Form2Report['addBack'] = {
    requested: plan.addBackTripIds.length,
    accepted: [],
    ignoredExcludedRoute: [],
    ignoredAlreadyPresent: [],
    notWeekday: [],
    notFound: [],
    duplicate: [],
  }
  const alreadyKept: string[] = []
  const notActive: string[] = []
  const seen = new Set<string>()
  const acceptedSignatures = new Map<string, { tripId: string; service: string }[]>()
  const acceptedIds: string[] = []
  for (const raw of plan.addBackTripIds) {
    const id = raw.trim()
    if (seen.has(id)) {
      addBack.duplicate.push(id)
      continue
    }
    seen.add(id)
    const row = tripById.get(id)
    if (!row) {
      addBack.notFound.push(id)
      continue
    }
    const sid = trimmed(row.service_id)
    if (multi && keptServices.has(sid)) {
      alreadyKept.push(id)
      continue
    }
    if (!weekdaySet.has(sid)) {
      addBack.notWeekday.push(id)
      continue
    }
    // 組ごと除く平日の service の便は出力に入らない(受け付けると、GTFS に無い便を「平日に戻した」と報告する)。
    // keepIds・reserved にも入れない。pairs が無いときは平日の service が除かれると checkPolicy が止めるので起きない
    if (multi && droppedPair(sid)) {
      notActive.push(id)
      continue
    }
    if (excluded.has(trimmed(row.route_id))) {
      addBack.ignoredExcludedRoute.push(id)
      continue
    }
    const sig = signatureOf(row)
    const same =
      derivedSignatures.get(sig)?.find((e) => covers(e.service, sid)) ?? acceptedSignatures.get(sig)?.find((e) => covers(e.service, sid))
    if (same !== undefined) {
      addBack.ignoredAlreadyPresent.push({ tripId: id, sameAs: same.tripId })
      continue
    }
    const list = acceptedSignatures.get(sig)
    if (list) list.push({ tripId: id, service: sid })
    else acceptedSignatures.set(sig, [{ tripId: id, service: sid }])
    acceptedIds.push(id)
  }
  addBack.accepted = sortedIds(acceptedIds)
  addBack.ignoredExcludedRoute.sort(compareStrings)
  addBack.ignoredAlreadyPresent.sort((a, b) => compareStrings(a.tripId, b.tripId))
  addBack.notWeekday.sort(compareStrings)
  addBack.notFound.sort(compareStrings)
  addBack.duplicate.sort(compareStrings)
  if (multi) {
    addBack.alreadyKept = sortedIds(alreadyKept)
    addBack.notActive = sortedIds(notActive)
  }

  const keptIds = keptRows.map((r) => trimmed(r.trip_id))
  const keepIds = new Set([...keptIds, ...acceptedIds])
  // 組ごと除く平日の service の便は、なくなる便に数えない(走らなくなった service として servicesDropped に出る)
  const removedRows = weekdayRows.filter((r) => !keepIds.has(trimmed(r.trip_id)) && !droppedPair(trimmed(r.service_id)))
  const removedIds = removedRows.map((r) => trimmed(r.trip_id))

  // ---- §5.4 加わる便の trip_id ----
  // 平日の service に無い service のすべての便、残す便、平日に戻す便の trip_id を押さえる。割り当て済みの trip_id は全部の組で1つの集合。
  // 割り当ての順:組の順、組の中は replacements の順、その中は元の trip_id の昇順
  const reserved = new Set<string>()
  for (const row of tripRows) if (!weekdaySet.has(trimmed(row.service_id))) reserved.add(trimmed(row.trip_id))
  for (const id of keepIds) reserved.add(id)
  const assigned = new Set<string>()
  const derived: { from: string; to: string }[] = []
  const collisions: Form2Report['tripIds']['collisions'] = []
  const derivedRows: GtfsRow[] = []
  const sourceOf = new Map<GtfsRow, GtfsRow>()
  const pairReports: Form2PairReport[] = []
  let mainRule: { rule: TripIdRule; index: number | null } = { rule: 'append-service', index: null }
  pairs.forEach((pair, pairIndex) => {
    const dropped = droppedPair(pair.weekday)
    const weekdayOfPair = rowsByService.get(pair.weekday) ?? []
    const replacements: Form2PairReport['replacements'] = []
    for (const rp of pair.replacements) {
      const rule = tripIdRuleFor([...weekdayOfPair, ...(rowsByService.get(rp) ?? [])], pair.weekday, rp)
      if (pairIndex === 0 && replacements.length === 0) mainRule = rule
      let added = 0
      const notActive = skipped.has(rp)
      if (!dropped && !notActive) {
        const ordered = (rowsByService.get(rp) ?? [])
          .filter((row) => !excluded.has(trimmed(row.route_id)))
          .map((row) => ({ row, from: trimmed(row.trip_id) }))
          .sort((a, b) => compareStrings(a.from, b.from))
        for (const { row: src, from } of ordered) {
          const candidate = candidateTripId(from, rule, rp, pair.weekday)
          let to = candidate
          for (let n = 2; reserved.has(to) || assigned.has(to); n++) to = `${candidate}_${n}`
          if (to !== candidate) {
            const other = tripById.get(candidate)
            collisions.push({ from, candidate, assigned: to, collidedWithService: other ? trimmed(other.service_id) : null })
          }
          assigned.add(to)
          derived.push({ from, to })
          const row: GtfsRow = { ...src, trip_id: to, service_id: pair.weekday }
          derivedRows.push(row)
          sourceOf.set(row, src)
          added++
        }
      }
      replacements.push({ serviceId: rp, rule: rule.rule, servicePartIndex: rule.index, added, notActive })
    }
    const removed = removedRows.filter((r) => trimmed(r.service_id) === pair.weekday).length
    pairReports.push({ weekday: pair.weekday, dropped, removed, replacements })
  })
  derived.sort((a, b) => compareStrings(a.from, b.from))

  // ---- trips ----
  const removedSet = new Set(removedIds)
  const keptBase: GtfsRow[] = []
  for (const row of tripRows) {
    if (weekdaySet.has(trimmed(row.service_id)) && removedSet.has(trimmed(row.trip_id)) && !keepIds.has(trimmed(row.trip_id))) continue
    keptBase.push(row)
  }
  const droppedTripCounts = new Map<string, number>()
  let outTrips: GtfsRow[] = []
  for (const row of [...keptBase, ...derivedRows]) {
    const sid = trimmed(row.service_id)
    if (droppedServiceIds.has(sid)) {
      droppedTripCounts.set(sid, (droppedTripCounts.get(sid) ?? 0) + 1)
      continue
    }
    outTrips.push(row)
  }
  const tripOrder = tripOrderOf(tripRows)
  if (tripOrder !== 'input') {
    const keyed = outTrips.map((row) => ({ row, sid: trimmed(row.service_id), tid: trimmed(row.trip_id) }))
    keyed.sort((a, b) => (tripOrder === 'service_id,trip_id' ? compareStrings(a.sid, b.sid) : 0) || compareStrings(a.tid, b.tid))
    outTrips = keyed.map((k) => k.row)
  }
  const droppedServices = sortedIds(droppedServiceIds).map((serviceId) => ({ serviceId, trips: droppedTripCounts.get(serviceId) ?? 0 }))
  if (droppedServices.length > 0) {
    warn(
      'servicesDropped',
      `新しい有効期間のどの日にも走らない service を、便ごと出力から除きました(${droppedServices.map((d) => `${d.serviceId}:${d.trips} 便`).join('、')})。`,
    )
  }

  // ---- §5.5 stop_times ----
  // 孤立した行(減便前の trips に無い trip_id の行)は、どちらの並びでも出力から除く。残すと、その trip_id が
  // 加わる便の新しい trip_id と同じとき、加わる便の停車に混ざる。孤立した行があると並びは 'input' になる
  // ('trips' の並びは trips の便の行だけを出すので、もともと孤立した行を出さない)
  const orphanIds = new Set<string>()
  let orphanRows = 0
  for (const r of stopTimeRows) {
    const id = trimmed(r.trip_id)
    if (tripById.has(id)) continue
    orphanIds.add(id)
    orphanRows++
  }
  if (orphanRows > 0) {
    const ids = sortedIds(orphanIds).map((id) => (id === '' ? '(空)' : id))
    const shown = ids.slice(0, MAX_EXAMPLES).join('、')
    const rest = ids.length > MAX_EXAMPLES ? ` ほか ${ids.length - MAX_EXAMPLES} 件` : ''
    warn(
      'orphanStopTimesDropped',
      `stop_times の行のうち、trips.txt にない trip_id の ${orphanRows} 行を除きました(trip_id:${shown}${rest})。入力からある問題で、残すと同じ trip_id の便の停車に混ざるため除いています。`,
    )
  }
  const stopTimesOrder = stopTimesOrderOf(stopTimeRows, tripRows)
  const copyRows = (derivedRow: GtfsRow, src: GtfsRow, out: GtfsRow[]) => {
    const to = derivedRow.trip_id
    for (const r of groups.get(trimmed(src.trip_id)) ?? []) out.push({ ...r, trip_id: to })
  }
  const outStopTimes: GtfsRow[] = []
  if (stopTimesOrder === 'trips') {
    for (const row of outTrips) {
      const src = sourceOf.get(row)
      if (src) copyRows(row, src, outStopTimes)
      else for (const r of groups.get(trimmed(row.trip_id)) ?? []) outStopTimes.push(r)
    }
  } else {
    const gone = new Set([...removedIds, ...orphanIds])
    for (const row of keptBase) if (droppedServiceIds.has(trimmed(row.service_id))) gone.add(trimmed(row.trip_id))
    for (const r of stopTimeRows) if (!gone.has(trimmed(r.trip_id))) outStopTimes.push(r)
    for (const row of derivedRows) {
      if (!droppedServiceIds.has(trimmed(row.service_id))) copyRows(row, sourceOf.get(row) as GtfsRow, outStopTimes)
    }
  }

  // ---- §5.7 feed_info ----
  const feedInfo = feedInfoOf(base, validity, opts.generatedAt, opts.feedVersion?.trim() || undefined, warn)

  // ---- ほかの警告 ----
  const routeIds = new Set((base.tables.get('routes')?.rows ?? []).map((r) => trimmed(r.route_id)))
  const unknownRoutes = plan.excludedRoutes.map((r) => r.trim()).filter((r) => !routeIds.has(r))
  if (unknownRoutes.length > 0) {
    warn('unknownExcludedRoute', `除外する系統のうち、routes.txt にない route_id があります(${unknownRoutes.join('、')})。`)
  }
  // 便があり、新しい有効期間に走るものだけ(期間に走らない夏の平日などは入れ替えなくても差し支えない)。残すと決めた service は除く
  const otherWeekdays = describeServices(base, null).filter(
    (s) =>
      s.role === 'weekday' &&
      !weekdaySet.has(s.serviceId) &&
      !keptServices.has(s.serviceId) &&
      s.tripCount > 0 &&
      !droppedServiceIds.has(s.serviceId),
  )
  if (otherWeekdays.length > 0) {
    const chosen = weekdaySet.size === 1 ? wk : pairs.map((p) => p.weekday).join('・')
    warn(
      'otherWeekdayServices',
      `平日(月〜金)のダイヤの service がほかにもあります(${otherWeekdays.map((s) => s.serviceId).join('、')})。選んだ ${chosen} 以外は入れ替えていません。`,
    )
  }
  if (multi) multiPairWarnings(pairs, pairReports, keptServices, rowsByService, base, droppedServiceIds, daysOf, warn)
  const withBlock = derivedRows.filter((r) => trimmed(r.block_id) !== '').length
  if (withBlock > 0) {
    warn(
      'blockIdCopied',
      `入れ替えに使うダイヤから加わる便のうち ${withBlock} 便に block_id があり、そのまま加えました。平日に戻した便や残した便と運用が重ならないかは確かめていません。`,
    )
  }

  // ---- 減便後のフィード(変えない表は同じ参照) ----
  const tables = new Map(base.tables)
  tables.set('trips', { ...tripsTable, rows: outTrips })
  if (stopTimesTable) tables.set('stop_times', { ...stopTimesTable, rows: outStopTimes })
  setCalendarTables(tables, calendars)
  tables.set('feed_info', feedInfo.table)

  const report: Form2Report = {
    inputValidity: { start: inputValidity.start, end: inputValidity.end },
    validity: { start: validity.start, end: validity.end, days: validity.days },
    tripIds: {
      rule: mainRule.rule,
      servicePartIndex: mainRule.index,
      derived,
      kept: sortedIds(keptIds),
      addedBack: sortedIds(acceptedIds),
      removed: sortedIds(removedIds),
      collisions,
    },
    addBack,
    calendarDates: { kept: calendars.outCalendarDates.length, dropped: calendars.droppedDates },
    droppedServices,
    rowOrder: { trips: tripOrder, stop_times: stopTimesOrder },
    feedVersion: feedInfo.version,
    warnings,
    ...(multi ? { pairs: pairReports } : {}),
  }
  return { ok: true, result: { feed: { tables, warnings: [] }, plan, report } }
}

/**
 * pairs があるときだけの警告(docs/design-service-groups.md §4.3)。
 * - weekdayServicesKept:残す平日の service のうち、便があり期間に走るもの(走る日の数。10 日以下なら日付)
 * - weekdayServicesErased:入れ替えに使う service の無い組(なくす service)と、なくなる便の数
 * - replacementNotActiveSkipped:新しい有効期間に走らないため加えなかった入れ替えに使う service と便の数。組の入れ替えに使う
 *   service がすべて加わらないときは、その組の平日の便が代わりの便なしでなくなることを添える
 * - replacementRunsWithWeekday:入れ替えに使う service と、その組の平日の service が、新しい有効期間の同じ日に走る日(5 つまで)
 */
function multiPairWarnings(
  pairs: readonly ServicePair[],
  pairReports: readonly Form2PairReport[],
  keptServices: ReadonlySet<string>,
  rowsByService: ReadonlyMap<string, GtfsRow[]>,
  base: GtfsFeed,
  droppedServiceIds: ReadonlySet<string>,
  daysOf: (sid: string) => string[],
  warn: (code: string, message: string) => void,
): void {
  const tripCounts = new Map<string, number>()
  for (const t of base.tables.get('trips')?.rows ?? []) {
    const sid = trimmed(t.service_id)
    if (keptServices.has(sid)) tripCounts.set(sid, (tripCounts.get(sid) ?? 0) + 1)
  }
  const kept = sortedIds(keptServices)
    .filter((sid) => (tripCounts.get(sid) ?? 0) > 0 && !droppedServiceIds.has(sid))
    .map((sid) => {
      const days = daysOf(sid)
      return `${sid}:${tripCounts.get(sid)} 便、${days.length <= 10 ? shortDates(days, 10) : `${days.length} 日`}`
    })
  if (kept.length > 0) {
    warn(
      'weekdayServicesKept',
      `平日のまま残す service は、期間の中も平日のダイヤのまま全便走ります(${kept.join('。')})。`,
    )
  }
  const erased = pairReports.filter((p) => !p.dropped && p.replacements.length === 0).map((p) => `${p.weekday} ${p.removed} 便`)
  if (erased.length > 0) {
    warn('weekdayServicesErased', `入れ替えに使うダイヤがないため、期間の間なくす service があります(${erased.join('、')})。`)
  }
  const skipped: string[] = []
  const unreplaced: string[] = []
  for (const p of pairReports) {
    if (p.dropped) continue
    const notActive = p.replacements.filter((r) => r.notActive)
    if (notActive.length === 0) continue
    for (const r of notActive) skipped.push(`${r.serviceId}:${(rowsByService.get(r.serviceId) ?? []).length} 便 → ${p.weekday}`)
    if (p.replacements.every((r) => r.notActive)) unreplaced.push(`${p.weekday} ${p.removed} 便`)
  }
  if (skipped.length > 0) {
    warn(
      'replacementNotActiveSkipped',
      `新しい有効期間に1日も走らない入れ替えに使う service の便は、期間に走らないため加えませんでした(${skipped.join('、')})。${
        unreplaced.length > 0 ? `加わる便がないため、代わりの便なしでなくなる平日の便があります(${unreplaced.join('、')})。` : ''
      }`,
    )
  }
  const overlaps: string[] = []
  pairs.forEach((pair, i) => {
    if (pairReports[i].dropped) return
    const weekdayDays = new Set(daysOf(pair.weekday))
    for (const rp of pair.replacements) {
      if ((rowsByService.get(rp) ?? []).length === 0) continue
      const both = daysOf(rp).filter((d) => weekdayDays.has(d))
      if (both.length > 0) overlaps.push(`${rp} と ${pair.weekday}:${shortDates(both)}`)
    }
  })
  if (overlaps.length > 0) {
    warn(
      'replacementRunsWithWeekday',
      `入れ替えに使う service と、便を加える平日の service が同じ日に走ります(${overlaps.join('、')})。その日は、加わる便と入れ替えに使う service の便が同じ時刻に2回走ります。`,
    )
  }
}

// ---- 減便をやめる版(docs/tasks-1103.md T23、取り決め 1104 §12.1-3 の (a)) ----

export interface RevertOptions extends Form2Options {
  /** 戻す日('YYYYMMDD')。この日から元のダイヤで走る。出力の有効期間は戻す日〜入力の末日 */
  restoreFrom: string
  /**
   * 検証(validateEdit)が「平日ダイヤ」として見る service(祝日・年末年始の確かめに使う)。
   * 承認した方針があればその service、無ければ推定した平日の service、それも無ければ省く。便の中身には使わない。
   * pairs を渡すと、祝日の確かめをすべての組の平日の service で行う(docs/design-service-groups.md §4.3)
   */
  services?: Pick<PolicySettings, 'kind' | 'weekdayService' | 'replacementService'> & Partial<Pick<PolicySettings, 'pairs'>>
}

/**
 * 減便をやめる版を作る。基準のフィードの便は変えず、有効期間を「戻す日〜入力の末日」に切り詰め(§5.6)、
 * feed_info の有効期間と feed_version を書き換える(§5.7)。減便の方針と足し戻しは入れない。
 *
 * - 結果は Form2Result の形で返す(validateEdit と writeGtfsZip をそのまま使うため)。plan は
 *   period = { start: 戻す日, end: null }、除外・足し戻しは空。report の tripIds・addBack は空
 * - trips・stop_times は、新しい有効期間に走らなくなった service が無ければ基準と同じ参照のまま返す
 *   (ZIP には元のバイト列が入る)。そのような service があれば、その便と stop_times の行だけを除く
 * - 戻す日が入力の開始日より前なら開始日にそろえて periodStartClamped、入力の末日より後なら ok: false。
 *   有効期間が 7 日以下なら shortValidity(出力を止めるのは validateEdit)
 */
export function applyRevert(base: GtfsFeed, opts: RevertOptions): Form2Outcome {
  if (!GENERATED_AT.test(opts.generatedAt)) {
    return { ok: false, message: `作成日時の形が正しくありません(${opts.generatedAt})。YYYYMMDDhhmm の12桁にしてください。` }
  }
  const versionProblem = opts.feedVersion === undefined ? null : feedVersionProblem(opts.feedVersion)
  if (versionProblem) return { ok: false, message: versionProblem }
  const restoreFrom = opts.restoreFrom.trim()
  if (!isValidGtfsDate(restoreFrom)) return { ok: false, message: `元のダイヤに戻す日の形が正しくありません(${opts.restoreFrom})。` }
  const tripsTable = base.tables.get('trips')
  const inputValidity = feedValidity(base)
  if (!tripsTable || !inputValidity) return { ok: false, message: 'trips.txt か入力の有効期間がないため、元のダイヤに戻す版を作れません。' }
  const validity = policyValidity(inputValidity, { start: restoreFrom, end: null })
  if (!validity) {
    return {
      ok: false,
      message: `元のダイヤに戻す日(${formatDate(restoreFrom)})が入力の有効期間の末日(${formatDate(inputValidity.end)})より後です。入力の有効期間の中の日を選んでください。`,
    }
  }

  const warnings: { code: string; message: string }[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })
  if (restoreFrom < inputValidity.start) {
    warn(
      'periodStartClamped',
      `元のダイヤに戻す日(${formatDate(restoreFrom)})が入力の開始日より前のため、入力の開始日(${formatDate(inputValidity.start)})にそろえました。`,
    )
  }
  if (validity.days <= 7) {
    warn(
      'shortValidity',
      `有効期間が ${validity.days} 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、出力できません。元のダイヤに戻す日を変えてください。`,
    )
  }

  const calendars = clampCalendars(base, validity, warn)
  const { droppedServiceIds } = calendars
  const tables = new Map(base.tables)
  const droppedTripCounts = new Map<string, number>()
  if (droppedServiceIds.size > 0) {
    const gone = new Set<string>()
    const outTrips: GtfsRow[] = []
    for (const row of tripsTable.rows) {
      const sid = trimmed(row.service_id)
      if (droppedServiceIds.has(sid)) {
        droppedTripCounts.set(sid, (droppedTripCounts.get(sid) ?? 0) + 1)
        gone.add(trimmed(row.trip_id))
      } else {
        outTrips.push(row)
      }
    }
    // 同じ trip_id の便が残る service にもあれば(入力の重複)、その行は残す
    for (const row of outTrips) gone.delete(trimmed(row.trip_id))
    tables.set('trips', { ...tripsTable, rows: outTrips })
    const stopTimesTable = base.tables.get('stop_times')
    if (stopTimesTable) tables.set('stop_times', { ...stopTimesTable, rows: stopTimesTable.rows.filter((r) => !gone.has(trimmed(r.trip_id))) })
  }
  const droppedServices = sortedIds(droppedServiceIds).map((serviceId) => ({ serviceId, trips: droppedTripCounts.get(serviceId) ?? 0 }))
  if (droppedServices.length > 0) {
    warn(
      'servicesDropped',
      `新しい有効期間のどの日にも走らない service を、便ごと出力から除きました(${droppedServices.map((d) => `${d.serviceId}:${d.trips} 便`).join('、')})。`,
    )
  }
  setCalendarTables(tables, calendars)
  const feedInfo = feedInfoOf(base, validity, opts.generatedAt, opts.feedVersion?.trim() || undefined, warn)
  tables.set('feed_info', feedInfo.table)

  const plan: Form2Plan = {
    kind: opts.services?.kind ?? 'weekdayToSaturday',
    weekdayService: opts.services?.weekdayService.trim() ?? '',
    replacementService: opts.services?.replacementService.trim() ?? '',
    period: { start: restoreFrom, end: null },
    excludedRoutes: [],
    ...(opts.services?.pairs !== undefined ? { pairs: pairsOf({ ...opts.services, pairs: opts.services.pairs }) } : {}),
    addBackTripIds: [],
  }
  const report: Form2Report = {
    inputValidity: { start: inputValidity.start, end: inputValidity.end },
    validity: { start: validity.start, end: validity.end, days: validity.days },
    tripIds: { rule: 'append-service', servicePartIndex: null, derived: [], kept: [], addedBack: [], removed: [], collisions: [] },
    addBack: { requested: 0, accepted: [], ignoredExcludedRoute: [], ignoredAlreadyPresent: [], notWeekday: [], notFound: [], duplicate: [] },
    calendarDates: { kept: calendars.outCalendarDates.length, dropped: calendars.droppedDates },
    droppedServices,
    rowOrder: { trips: 'input', stop_times: 'input' },
    feedVersion: feedInfo.version,
    warnings,
  }
  return { ok: true, result: { feed: { tables, warnings: [] }, plan, report } }
}

/** §5.6 の calendar・calendar_dates の切り詰めの結果 */
interface ClampedCalendars {
  calendarTable: GtfsTable | undefined
  calendarDatesTable: GtfsTable | undefined
  outCalendar: GtfsRow[]
  outCalendarDates: GtfsRow[]
  droppedDates: Form2Report['calendarDates']['dropped']
  /** 新しい有効期間のどの日にも走らなくなった service */
  droppedServiceIds: Set<string>
}

/**
 * 有効期間、calendar、calendar_dates(§5.6)。形2の適用(applyForm2)と減便をやめる版(applyRevert)で共通。
 * calendar の各行を新しい有効期間に切り詰め(値が変わらない列は元の値のまま、start_date > end_date になる行は除いて
 * calendarRowDropped の警告)、calendar_dates は有効期間に入る行だけを入力の順で残す。
 * 切り詰めたあと新しい有効期間のどの日にも走らない service は、calendar の行と calendar_dates の残りの行も除く
 * (便と stop_times を除くのは呼ぶ側)。日付が不正な calendar の行は切り詰めず、その service は走るかを判定しない
 */
function clampCalendars(
  base: GtfsFeed,
  validity: { start: string; end: string },
  warn: (code: string, message: string) => void,
): ClampedCalendars {
  const calendarTable = base.tables.get('calendar')
  const calendarDatesTable = base.tables.get('calendar_dates')
  const calendarRows = calendarTable?.rows ?? []
  const calendarDateRows = calendarDatesTable?.rows ?? []

  const clampedCalendar: GtfsRow[] = []
  const droppedCalendarServices: string[] = []
  // 日付が不正な calendar の行は切り詰めず、その service は走るかを判定しない(入力の誤りは validateEdit が出す)
  const undecidable = new Set<string>()
  for (const row of calendarRows) {
    const s = trimmed(row.start_date)
    const e = trimmed(row.end_date)
    if (!isValidGtfsDate(s) || !isValidGtfsDate(e)) {
      undecidable.add(trimmed(row.service_id))
      clampedCalendar.push(row)
      continue
    }
    const ns = s < validity.start ? validity.start : s
    const ne = e > validity.end ? validity.end : e
    if (ns > ne) {
      droppedCalendarServices.push(trimmed(row.service_id))
      continue
    }
    if (ns === s && ne === e) {
      clampedCalendar.push(row)
    } else {
      const next: GtfsRow = { ...row }
      if (ns !== s) next.start_date = ns
      if (ne !== e) next.end_date = ne
      clampedCalendar.push(next)
    }
  }
  if (droppedCalendarServices.length > 0) {
    warn(
      'calendarRowDropped',
      `calendar の行のうち、新しい有効期間(${formatDate(validity.start)}〜${formatDate(validity.end)})と重ならない ${droppedCalendarServices.length} 行を除きました(service_id:${droppedCalendarServices.join('、')})。`,
    )
  }

  const inValidity = (row: GtfsRow) => {
    const d = trimmed(row.date)
    return isValidGtfsDate(d) && validity.start <= d && d <= validity.end
  }
  const index = indexServiceDays(clampedCalendar, calendarDateRows.filter(inValidity))
  const defined = new Set<string>()
  for (const row of calendarRows) defined.add(trimmed(row.service_id))
  for (const row of calendarDateRows) defined.add(trimmed(row.service_id))
  defined.delete('')
  const droppedServiceIds = new Set<string>()
  for (const sid of sortedIds(defined)) {
    if (undecidable.has(sid)) continue
    if (!runsAnyDay(index.get(sid), validity.start, validity.end)) droppedServiceIds.add(sid)
  }

  const outCalendar = clampedCalendar.filter((r) => !droppedServiceIds.has(trimmed(r.service_id)))
  const outCalendarDates: GtfsRow[] = []
  const droppedDates: Form2Report['calendarDates']['dropped'] = []
  for (const row of calendarDateRows) {
    if (inValidity(row) && !droppedServiceIds.has(trimmed(row.service_id))) {
      outCalendarDates.push(row)
    } else {
      droppedDates.push({ service_id: row.service_id ?? '', date: row.date ?? '', exception_type: row.exception_type ?? '' })
    }
  }
  return { calendarTable, calendarDatesTable, outCalendar, outCalendarDates, droppedDates, droppedServiceIds }
}

/** 切り詰めた calendar・calendar_dates を、基準にある表だけ新しい表にする(基準に無い表は作らない) */
function setCalendarTables(tables: Map<string, GtfsTable>, c: ClampedCalendars): void {
  if (c.calendarTable) tables.set('calendar', { ...c.calendarTable, rows: c.outCalendar })
  if (c.calendarDatesTable) tables.set('calendar_dates', { ...c.calendarDatesTable, rows: c.outCalendarDates })
}

const FEED_INFO_DATE_FIELDS = ['feed_start_date', 'feed_end_date', 'feed_version'] as const
const FEED_INFO_FIELDS = ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', ...FEED_INFO_DATE_FIELDS]

/**
 * feed_info(§5.7)。1行目の feed_start_date・feed_end_date を新しい有効期間に、feed_version を規則で書き換える。
 * 2行目以降とほかの列は変えない。列が無ければ後ろに足し、表が無ければ agency の1行目から作る(どちらも警告)
 */
function feedInfoOf(
  base: GtfsFeed,
  validity: { start: string; end: string },
  generatedAt: string,
  custom: string | undefined,
  warn: (code: string, message: string) => void,
): { table: GtfsTable; version: { before: string; after: string } } {
  const table = base.tables.get('feed_info')
  const first = table?.rows[0]
  const before = trimmed(first?.feed_version)
  const after = custom ?? defaultFeedVersion(before, generatedAt)
  // 既定の規則では入力が 12 桁のときだけ比べる(それ以外は入力を前に付けるので必ず大きい)。利用者が決めた値は、入力があれば常に比べる
  if ((custom !== undefined ? before !== '' : TWELVE_DIGITS.test(before)) && after <= before) {
    warn('feedVersionNotIncreasing', `新しい feed_version(${after})が入力の feed_version(${before})以下です。公開先が新しい版と見なさないことがあります。`)
  }
  const version = { before, after }

  if (table && first) {
    const missing = FEED_INFO_DATE_FIELDS.filter((f) => !table.fields.includes(f))
    if (missing.length > 0) {
      warn('feedInfoColumnsAdded', `feed_info.txt に ${missing.join('・')} の列がないため、後ろに足しました(GTFS-JP 第4.0版で必須)。`)
    }
    const row: GtfsRow = { ...first, feed_version: after }
    if (trimmed(first.feed_start_date) !== validity.start) row.feed_start_date = validity.start
    if (trimmed(first.feed_end_date) !== validity.end) row.feed_end_date = validity.end
    return {
      table: { ...table, fields: missing.length > 0 ? [...table.fields, ...missing] : table.fields, rows: [row, ...table.rows.slice(1)] },
      version,
    }
  }

  // 表が無い(または行が無い):agency の1行目から作る
  const agency = base.tables.get('agency')?.rows[0]
  const row: GtfsRow = {
    feed_publisher_name: agency?.agency_name ?? '',
    feed_publisher_url: agency?.agency_url ?? '',
    feed_lang: 'ja',
    feed_start_date: validity.start,
    feed_end_date: validity.end,
    feed_version: after,
  }
  warn('feedInfoCreated', 'feed_info.txt がないため、agency.txt の1行目から作りました(GTFS-JP 第4.0版で必須)。事業者名・URL・言語を確かめてください。')
  if (table) {
    const fields = [...table.fields, ...FEED_INFO_FIELDS.filter((f) => !table.fields.includes(f))]
    return { table: { ...table, fields, rows: [row] }, version }
  }
  return { table: { fileName: 'feed_info.txt', fields: [...FEED_INFO_FIELDS], rows: [row] }, version }
}
