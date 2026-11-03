import { isValidGtfsDate } from '../calendar'
import type { GtfsFeed, GtfsRow, GtfsTable } from '../load'
import { checkPolicy, formatDate, type Form2Plan } from './ops'
import { describeServices, feedValidity, indexServiceDays, policyValidity, runsAnyDay } from './services'
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
    rule: 'replace-service-part' | 'append-service'
    /** service_id の部分の位置(0 始まり)。'append-service' なら null */
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
  }
  calendarDates: { kept: number; dropped: { service_id: string; date: string; exception_type: string }[] }
  /** 新しい有効期間のどの日にも走らなくなり、便ごと出力から除いた service(§5.6) */
  droppedServices: { serviceId: string; trips: number }[]
  rowOrder: { trips: 'service_id,trip_id' | 'trip_id' | 'input'; stop_times: 'trips' | 'input' }
  feedVersion: { before: string; after: string }
  warnings: { code: string; message: string }[]
}

const GENERATED_AT = /^\d{12}$/
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

/** 写した便の trip_id の候補(重なりを調べる前) */
function candidateTripId(from: string, servicePart: number | null, replacement: string, weekday: string): string {
  if (servicePart !== null) {
    const parts = from.split('_')
    // 位置 k が写す元の service_id でない便(起きない想定)は、後ろに付ける規則と同じにする
    if (parts[servicePart] === replacement) {
      parts[servicePart] = weekday
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
 * 足し戻しの分類(§5.3)、写した便の trip_id(§5.4)、行の並び(§5.5)、有効期間と calendar・calendar_dates(§5.6)、
 * feed_info(§5.7)の規則は取り決めのとおり
 */
export function applyForm2(base: GtfsFeed, plan: Form2Plan, opts: Form2Options): Form2Outcome {
  if (!GENERATED_AT.test(opts.generatedAt)) {
    return { ok: false, message: `作成日時の形が正しくありません(${opts.generatedAt})。YYYYMMDDhhmm の12桁にしてください。` }
  }
  const errors = checkPolicy(base, plan).filter((p) => p.severity === 'error')
  if (errors.length > 0) return { ok: false, message: errors.map((e) => e.message).join('\n') }

  const tripsTable = base.tables.get('trips')
  const inputValidity = feedValidity(base)
  const validity = inputValidity ? policyValidity(inputValidity, plan.period) : null
  // checkPolicy が通れば起きない(便が無い、有効期間が決まらない・空ならエラーになる)
  if (!tripsTable || !inputValidity || !validity) return { ok: false, message: '方針を適用できません(trips.txt か有効期間がありません)。' }

  const warnings: { code: string; message: string }[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })

  const wk = plan.weekdayService.trim()
  const rp = plan.replacementService.trim()
  const excluded = new Set(plan.excludedRoutes.map((r) => r.trim()))

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
  const replacementRows: GtfsRow[] = []
  for (const row of tripRows) {
    const id = trimmed(row.trip_id)
    if (!tripById.has(id)) tripById.set(id, row)
    const sid = trimmed(row.service_id)
    if (sid === wk) weekdayRows.push(row)
    else if (sid === rp) replacementRows.push(row)
  }
  const keptRows = weekdayRows.filter((r) => excluded.has(trimmed(r.route_id)))
  const sources = replacementRows.filter((r) => !excluded.has(trimmed(r.route_id)))

  // 写す便の署名 → 同じ署名の写す元の便のうち、基準の trips の並びで最初のもの
  const derivedSignatures = new Map<string, string>()
  for (const row of sources) {
    const s = signatureOf(row)
    if (!derivedSignatures.has(s)) derivedSignatures.set(s, trimmed(row.trip_id))
  }

  // ---- §5.3 足し戻しの分類(前から順に、最初に当てはまったもの) ----
  const addBack: Form2Report['addBack'] = {
    requested: plan.addBackTripIds.length,
    accepted: [],
    ignoredExcludedRoute: [],
    ignoredAlreadyPresent: [],
    notWeekday: [],
    notFound: [],
    duplicate: [],
  }
  const seen = new Set<string>()
  const acceptedSignatures = new Map<string, string>()
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
    if (trimmed(row.service_id) !== wk) {
      addBack.notWeekday.push(id)
      continue
    }
    if (excluded.has(trimmed(row.route_id))) {
      addBack.ignoredExcludedRoute.push(id)
      continue
    }
    const sig = signatureOf(row)
    const sameAs = derivedSignatures.get(sig) ?? acceptedSignatures.get(sig)
    if (sameAs !== undefined) {
      addBack.ignoredAlreadyPresent.push({ tripId: id, sameAs })
      continue
    }
    acceptedSignatures.set(sig, id)
    acceptedIds.push(id)
  }
  addBack.accepted = sortedIds(acceptedIds)
  addBack.ignoredExcludedRoute.sort(compareStrings)
  addBack.ignoredAlreadyPresent.sort((a, b) => compareStrings(a.tripId, b.tripId))
  addBack.notWeekday.sort(compareStrings)
  addBack.notFound.sort(compareStrings)
  addBack.duplicate.sort(compareStrings)

  const keptIds = keptRows.map((r) => trimmed(r.trip_id))
  const keepIds = new Set([...keptIds, ...acceptedIds])
  const removedIds = weekdayRows.map((r) => trimmed(r.trip_id)).filter((id) => !keepIds.has(id))

  // ---- §5.4 写した便の trip_id ----
  const servicePartIndex = findServicePart([...weekdayRows, ...replacementRows])
  const reserved = new Set<string>()
  for (const row of tripRows) if (trimmed(row.service_id) !== wk) reserved.add(trimmed(row.trip_id))
  for (const id of keepIds) reserved.add(id)
  const assigned = new Set<string>()
  const derived: { from: string; to: string }[] = []
  const collisions: Form2Report['tripIds']['collisions'] = []
  const derivedRows: GtfsRow[] = []
  const sourceOf = new Map<GtfsRow, GtfsRow>()
  const orderedSources = sources
    .map((row) => ({ row, from: trimmed(row.trip_id) }))
    .sort((a, b) => compareStrings(a.from, b.from))
  for (const { row: src, from } of orderedSources) {
    const candidate = candidateTripId(from, servicePartIndex, rp, wk)
    let to = candidate
    for (let n = 2; reserved.has(to) || assigned.has(to); n++) to = `${candidate}_${n}`
    if (to !== candidate) {
      const other = tripById.get(candidate)
      collisions.push({ from, candidate, assigned: to, collidedWithService: other ? trimmed(other.service_id) : null })
    }
    assigned.add(to)
    derived.push({ from, to })
    const row: GtfsRow = { ...src, trip_id: to, service_id: wk }
    derivedRows.push(row)
    sourceOf.set(row, src)
  }

  // ---- §5.6 有効期間、calendar、calendar_dates ----
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

  // ---- trips ----
  const keptBase: GtfsRow[] = []
  for (const row of tripRows) {
    if (trimmed(row.service_id) === wk && !keepIds.has(trimmed(row.trip_id))) continue
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
  // 孤立した行(基準の trips に無い trip_id の行)は、どちらの並びでも出力から除く。残すと、その trip_id が
  // 写した便の新しい trip_id と同じとき、写した便の停車に混ざる。孤立した行があると並びは 'input' になる
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
      `stop_times の行のうち、trips.txt に無い trip_id の ${orphanRows} 行を除きました(trip_id:${shown}${rest})。入力からある問題で、残すと同じ trip_id の便の停車に混ざるため除いています。`,
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
    if (!droppedServiceIds.has(wk)) for (const row of derivedRows) copyRows(row, sourceOf.get(row) as GtfsRow, outStopTimes)
  }

  // ---- calendar・calendar_dates の残り ----
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

  // ---- §5.7 feed_info ----
  const feedInfo = feedInfoOf(base, validity, opts.generatedAt, warn)

  // ---- ほかの警告 ----
  const routeIds = new Set((base.tables.get('routes')?.rows ?? []).map((r) => trimmed(r.route_id)))
  const unknownRoutes = plan.excludedRoutes.map((r) => r.trim()).filter((r) => !routeIds.has(r))
  if (unknownRoutes.length > 0) {
    warn('unknownExcludedRoute', `除外する系統のうち、routes.txt に無い route_id があります(${unknownRoutes.join('、')})。`)
  }
  // 便があり、新しい有効期間に走るものだけ(期間に走らない夏の平日などは入れ替えなくても差し支えない)
  const otherWeekdays = describeServices(base, null).filter(
    (s) => s.role === 'weekday' && s.serviceId !== wk && s.tripCount > 0 && !droppedServiceIds.has(s.serviceId),
  )
  if (otherWeekdays.length > 0) {
    warn(
      'otherWeekdayServices',
      `平日(月〜金)のダイヤの service がほかにもあります(${otherWeekdays.map((s) => s.serviceId).join('、')})。選んだ ${wk} 以外は入れ替えていません。`,
    )
  }
  const withBlock = derivedRows.filter((r) => trimmed(r.block_id) !== '').length
  if (withBlock > 0) {
    warn(
      'blockIdCopied',
      `写した便のうち ${withBlock} 便に block_id があり、そのまま写しました。足し戻した便や残した便と運用が重ならないかは確かめていません。`,
    )
  }

  // ---- 編集後のフィード(変えない表は同じ参照) ----
  const tables = new Map(base.tables)
  tables.set('trips', { ...tripsTable, rows: outTrips })
  if (stopTimesTable) tables.set('stop_times', { ...stopTimesTable, rows: outStopTimes })
  if (calendarTable) tables.set('calendar', { ...calendarTable, rows: outCalendar })
  if (calendarDatesTable) tables.set('calendar_dates', { ...calendarDatesTable, rows: outCalendarDates })
  tables.set('feed_info', feedInfo.table)

  const report: Form2Report = {
    inputValidity: { start: inputValidity.start, end: inputValidity.end },
    validity: { start: validity.start, end: validity.end, days: validity.days },
    tripIds: {
      rule: servicePartIndex === null ? 'append-service' : 'replace-service-part',
      servicePartIndex,
      derived,
      kept: sortedIds(keptIds),
      addedBack: sortedIds(acceptedIds),
      removed: sortedIds(removedIds),
      collisions,
    },
    addBack,
    calendarDates: { kept: outCalendarDates.length, dropped: droppedDates },
    droppedServices,
    rowOrder: { trips: tripOrder, stop_times: stopTimesOrder },
    feedVersion: feedInfo.version,
    warnings,
  }
  return { ok: true, result: { feed: { tables, warnings: [] }, plan, report } }
}

const FEED_INFO_DATE_FIELDS = ['feed_start_date', 'feed_end_date', 'feed_version'] as const
const FEED_INFO_FIELDS = ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', ...FEED_INFO_DATE_FIELDS]
const TWELVE_DIGITS = /^\d{12}$/

/**
 * feed_info(§5.7)。1行目の feed_start_date・feed_end_date を新しい有効期間に、feed_version を規則で書き換える。
 * 2行目以降とほかの列は変えない。列が無ければ後ろに足し、表が無ければ agency の1行目から作る(どちらも警告)
 */
function feedInfoOf(
  base: GtfsFeed,
  validity: { start: string; end: string },
  generatedAt: string,
  warn: (code: string, message: string) => void,
): { table: GtfsTable; version: { before: string; after: string } } {
  const table = base.tables.get('feed_info')
  const first = table?.rows[0]
  const before = trimmed(first?.feed_version)
  const after = before === '' || TWELVE_DIGITS.test(before) ? generatedAt : `${before}_dispatcher_${generatedAt}`
  if (TWELVE_DIGITS.test(before) && after <= before) {
    warn('feedVersionNotIncreasing', `新しい feed_version(${after})が入力の feed_version(${before})以下です。公開先が新しい版と見なさないことがあります。`)
  }
  const version = { before, after }

  if (table && first) {
    const missing = FEED_INFO_DATE_FIELDS.filter((f) => !table.fields.includes(f))
    if (missing.length > 0) {
      warn('feedInfoColumnsAdded', `feed_info.txt に ${missing.join('・')} の列が無いため、後ろに足しました(GTFS-JP 第4.0版で必須)。`)
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
  warn('feedInfoCreated', 'feed_info.txt が無いため、agency.txt の1行目から作りました(GTFS-JP 第4.0版で必須)。事業者名・URL・言語を確かめてください。')
  if (table) {
    const fields = [...table.fields, ...FEED_INFO_FIELDS.filter((f) => !table.fields.includes(f))]
    return { table: { ...table, fields, rows: [row] }, version }
  }
  return { table: { fileName: 'feed_info.txt', fields: [...FEED_INFO_FIELDS], rows: [row] }, version }
}
