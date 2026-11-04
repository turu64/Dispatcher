import { isValidGtfsDate } from '../calendar'
import type { GtfsFeed, GtfsRow } from '../load'
import {
  feedValidity,
  forEachDay,
  indexFeedServiceDays,
  policyValidity,
  runsAnyDay,
  runsOn,
  type ServiceDays,
} from './services'

/**
 * 方針と編集の操作(取り決め 1104 §3・§4)。
 * 編集後のフィードは、基準と「操作の列から作った計画(planOf)」から毎回作り直す(form2.ts の applyForm2)。
 */

export type PolicyKind = 'weekdayToSaturday' | 'weekdayToSundayHoliday'

export interface Period {
  /** 'YYYYMMDD' */
  start: string
  /** null は「当面の間」(終わりを決めない) */
  end: string | null
}

/**
 * 平日だけの service と、その便の代わりに加える入れ替えに使う service の組(docs/design-service-groups.md §4.1)。
 * replacements が空なら「なくす」(期間の間、平日の便をなくすだけ)
 */
export interface ServicePair {
  /** 入れ替え元のダイヤ(平日)の service_id。期間の間、この service の便はなくなる(平日に戻した便・除外した系統の便を除く) */
  weekday: string
  /** 入れ替えに使うダイヤ(土曜/日祝)の service_id。この順に便を加える。空なら便をなくすだけ */
  replacements: string[]
}

export interface PolicySettings {
  kind: PolicyKind
  /** 入れ替える平日の service_id(空白を取った値)。pairs があるときは主の組の平日の service(pairs[0].weekday) */
  weekdayService: string
  /**
   * 入れ替えに使う service。kind が weekdayToSaturday なら土曜、weekdayToSundayHoliday なら日祝の service_id。
   * pairs があるときは主の組の入れ替えに使う service(pairs[0].replacements[0]。無ければ '')
   */
  replacementService: string
  period: Period
  /** 入れ替えから外す route_id(空白を取った値。利用者が選んだ順) */
  excludedRoutes: string[]
  /**
   * 組の表(主の組が先頭、あとは weekday の昇順)。省くと [{ weekday: weekdayService, replacements: [replacementService] }]
   * として扱う(1組の処理。出力は pairs を入れないときと同じ)
   */
  pairs?: ServicePair[]
  /** グループ分けで「残す」と決めた平日の service。便は変えず、警告で知らせるだけ。pairs があるときだけ使う */
  keptWeekdayServices?: string[]
}

/** 組の表(空白を取った値)。pairs が無ければ weekdayService と replacementService の1組 */
export function pairsOf(settings: Pick<PolicySettings, 'weekdayService' | 'replacementService' | 'pairs'>): ServicePair[] {
  if (settings.pairs === undefined) {
    return [{ weekday: settings.weekdayService.trim(), replacements: [settings.replacementService.trim()] }]
  }
  return settings.pairs.map((p) => ({ weekday: p.weekday.trim(), replacements: p.replacements.map((r) => r.trim()) }))
}

/** 便をなくす平日の service の集合(pairsOf の weekday)。keptWeekdayServices は入らない */
export function weekdayServicesOf(settings: Pick<PolicySettings, 'weekdayService' | 'replacementService' | 'pairs'>): Set<string> {
  return new Set(pairsOf(settings).map((p) => p.weekday))
}

/** 残す平日の service(空白を取った値)。pairs が無いときは使わないので空 */
export function keptServicesOf(settings: Pick<PolicySettings, 'pairs' | 'keptWeekdayServices'>): string[] {
  if (settings.pairs === undefined) return []
  return (settings.keptWeekdayServices ?? []).map((s) => s.trim())
}

/** 減便の理由。Dispatcher は判定せず、利用者(または Claude の下書きを承認した利用者)の入力だけを残す。変更指示書に使う */
export interface PolicyReason {
  /** 運転士の一時的な欠員/慢性的な不足/需要の減少。選ばなければ null */
  category: 'temporaryShortage' | 'chronicShortage' | 'demandDecline' | null
  note: string
}

export interface PolicyProblem {
  severity: 'error' | 'warning'
  code: string
  message: string
}

export interface AddBackItem {
  /** 基準の平日便の trip_id(空白を取った値) */
  tripId: string
  /** 便ごとの理由(変更指示書の「保護する便、理由」に使う)。空でもよい */
  reason: string
  /** 休校日運休の便(「(学)」)。GTFS には入れず、変更指示書と周知文にだけ使う(§8) */
  schoolDaysOnly: boolean
}

export type EditOp =
  | { type: 'applyPolicy'; settings: PolicySettings; reason: PolicyReason }
  | { type: 'addBack'; items: AddBackItem[] }
  /** 足し戻しを取り消す */
  | { type: 'withdrawAddBack'; tripIds: string[] }

export type EditActor = 'user' | 'claude'

export interface EditRecord {
  op: EditOp
  by: EditActor
  /** 承認した日時(ISO 8601、日本時間 '2026-11-04T09:30:00+09:00')。変更指示書に使う */
  at: string
}

/** 形2の適用に渡す計画。参照実装の方針の JSON と同じ名前(理由は持たない) */
export interface Form2Plan extends PolicySettings {
  /** 足し戻す便。重複なし、足した順 */
  addBackTripIds: string[]
}

/**
 * 操作の列を前から畳んで、形2の計画にする。
 * - 空の列(または applyPolicy が1つも無い列)は null(編集なし。編集後のフィードは基準そのもの)
 * - applyPolicy:方針を置き換える。足し戻しの一覧は残す
 * - addBack:一覧に無い trip_id だけを、items の順に後ろへ足す
 * - withdrawAddBack:一覧から除く
 * - 最初の applyPolicy より前の addBack・withdrawAddBack は数えない(store が断るので、本来は履歴に無い)
 */
export function planOf(history: readonly EditRecord[]): Form2Plan | null {
  let settings: PolicySettings | null = null
  let addBack: string[] = []
  for (const record of history) {
    const op = record.op
    if (op.type === 'applyPolicy') {
      settings = op.settings
    } else if (settings === null) {
      continue
    } else if (op.type === 'addBack') {
      for (const item of op.items) {
        const id = item.tripId.trim()
        if (!addBack.includes(id)) addBack = [...addBack, id]
      }
    } else {
      const withdrawn = new Set(op.tripIds.map((t) => t.trim()))
      addBack = addBack.filter((t) => !withdrawn.has(t))
    }
  }
  if (settings === null) return null
  // pairs・keptWeekdayServices は入っているときだけ書く(undefined の項目を作らない。1組の計画を今と同じにするため)
  return {
    kind: settings.kind,
    weekdayService: settings.weekdayService,
    replacementService: settings.replacementService,
    period: { start: settings.period.start, end: settings.period.end },
    excludedRoutes: [...settings.excludedRoutes],
    ...(settings.pairs !== undefined
      ? { pairs: settings.pairs.map((p) => ({ weekday: p.weekday, replacements: [...p.replacements] })) }
      : {}),
    ...(settings.keptWeekdayServices !== undefined ? { keptWeekdayServices: [...settings.keptWeekdayServices] } : {}),
    addBackTripIds: addBack,
  }
}

/**
 * 足し戻した便ごとの理由。同じ便を2回足したときは最初の理由(planOf で2回目は無視されるため)。
 * 取り消したあとに足し直したときは、足し直したときの理由。最初の applyPolicy より前の操作は数えない
 */
export function addBackReasons(
  history: readonly EditRecord[],
): Map<string, { reason: string; schoolDaysOnly: boolean; by: EditActor; at: string }> {
  const reasons = new Map<string, { reason: string; schoolDaysOnly: boolean; by: EditActor; at: string }>()
  let applied = false
  for (const record of history) {
    const op = record.op
    if (op.type === 'applyPolicy') {
      applied = true
    } else if (!applied) {
      continue
    } else if (op.type === 'addBack') {
      for (const item of op.items) {
        const id = item.tripId.trim()
        if (!reasons.has(id)) reasons.set(id, { reason: item.reason, schoolDaysOnly: item.schoolDaysOnly, by: record.by, at: record.at })
      }
    } else {
      for (const id of op.tripIds) reasons.delete(id.trim())
    }
  }
  return reasons
}

/** 最後の applyPolicy の理由。無ければ null */
export function policyReasonOf(history: readonly EditRecord[]): PolicyReason | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const op = history[i].op
    if (op.type === 'applyPolicy') return op.reason
  }
  return null
}

// ---- 方針の確かめ ----

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function rowsOf(feed: GtfsFeed, name: string): GtfsRow[] {
  return feed.tables.get(name)?.rows ?? []
}

/** 'YYYYMMDD' を画面の書き方にする('2026年11月1日') */
export function formatDate(date: string): string {
  if (!isValidGtfsDate(date)) return date
  return `${Number(date.slice(0, 4))}年${Number(date.slice(4, 6))}月${Number(date.slice(6, 8))}日`
}

const TRIP_REFERENCES: { table: string; columns: string[]; label: string }[] = [
  { table: 'transfers', columns: ['from_trip_id', 'to_trip_id'], label: 'transfers.txt' },
  { table: 'attributions', columns: ['trip_id'], label: 'attributions.txt' },
]
/** 'YYYYMMDD' を短く書く('11/2') */
export function shortDate(date: string): string {
  return `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))}`
}

/** 日付の一覧を短く書く(limit を超えた分は「ほか N 日」) */
export function shortDates(dates: readonly string[], limit = 5): string {
  const shown = dates.slice(0, limit).map(shortDate).join('・')
  return dates.length > limit ? `${shown} ほか ${dates.length - limit} 日` : shown
}

/**
 * 方針を適用できるかを確かめる(§3)。error が1つでもあれば applyForm2 は ok: false を返す。
 * 有効期間は §5.6 の規則(入力の有効期間と方針の期間)で作る。
 *
 * pairs があるときは、組の表も確かめる(docs/design-service-groups.md §4.2)。pairs が無いときの結果は今と同じ。
 * - badPairs・duplicateService・weekdayServiceRunsOnWeekend・replacementRunsOnWeekday(error)
 * - 組ごとの noWeekdayTrips・noReplacementTrips(主の組に入れ替えに使う service が無いときは見ない)
 * - 主の組の平日の service:weekdayCalendarOutside・weekdayNotActive(今のまま)
 * - 入れ替えに使う service の期間は、主の組と主でない組で同じ規則(checkPairPeriods):pairWeekdayNotActive・
 *   replacementNotActiveAdded・replacementPartial(warning)。主の組の入れ替えに使う service がすべて走らないときだけ
 *   replacementNotActive(error)
 * - tripReferences・excludedRouteWithoutWeekdayTrips は、すべての組の平日の service の便で見る
 */
export function checkPolicy(base: GtfsFeed, settings: PolicySettings): PolicyProblem[] {
  const problems: PolicyProblem[] = []
  const error = (code: string, message: string) => problems.push({ severity: 'error', code, message })
  const warning = (code: string, message: string) => problems.push({ severity: 'warning', code, message })

  const multi = settings.pairs !== undefined
  const pairs = pairsOf(settings)
  const weekdaySet = new Set(pairs.map((p) => p.weekday))
  const kept = keptServicesOf(settings)
  const wk = settings.weekdayService.trim()
  const rp = settings.replacementService.trim()
  const { start, end } = settings.period

  // 期間の日付
  const startOk = isValidGtfsDate(start)
  const endOk = end === null || isValidGtfsDate(end)
  if (!startOk) error('badPeriod', `期間の開始日(${start})が正しい日付ではありません。`)
  if (!endOk) error('badPeriod', `期間の終了日(${end})が正しい日付ではありません。`)
  if (startOk && endOk && end !== null && end < start) {
    error('badPeriod', `期間の終了日(${formatDate(end)})が開始日(${formatDate(start)})より前です。`)
  }

  // service と便
  const trips = rowsOf(base, 'trips')
  const tripCounts = new Map<string, number>()
  for (const t of trips) {
    const sid = trimmed(t.service_id)
    tripCounts.set(sid, (tripCounts.get(sid) ?? 0) + 1)
  }
  const tripCount = (sid: string) => tripCounts.get(sid) ?? 0
  if (!multi) {
    if (wk === rp) error('sameService', `平日の service と入れ替えに使う service が同じ(${wk})です。`)
    if (tripCount(wk) === 0) error('noWeekdayTrips', `平日の service(${wk})の便がありません。`)
    if (tripCount(rp) === 0) error('noReplacementTrips', `入れ替えに使う service(${rp})の便がありません。`)
  } else {
    checkPairs(base, settings, pairs, kept, tripCount, error)
  }

  const input = feedValidity(base)
  if (input === null) {
    error('noValidity', '入力の有効期間(feed_info の feed_start_date・feed_end_date、calendar の期間)が分かりません。')
  }

  if (input && startOk && endOk && !problems.some((p) => p.code === 'badPeriod')) {
    if (start < input.start) {
      warning('periodStartClamped', `期間の開始日(${formatDate(start)})が入力の開始日より前のため、入力の開始日(${formatDate(input.start)})にそろえます。`)
    }
    if (end !== null && end > input.end) {
      warning('periodEndClamped', `期間の終了日(${formatDate(end)})が入力の末日より後のため、入力の末日(${formatDate(input.end)})にそろえます。`)
    }
    const validity = policyValidity(input, { start, end })
    if (validity === null) {
      error(
        'emptyValidity',
        `期間(${formatDate(start)}〜${end === null ? '' : formatDate(end)})が入力の有効期間(${formatDate(input.start)}〜${formatDate(input.end)})と重なりません。`,
      )
    } else {
      const index = indexFeedServiceDays(base)
      const validityText = `${formatDate(validity.start)}〜${formatDate(validity.end)}`
      // 平日の service の calendar の行のどれも、新しい有効期間と1日も重ならない(行が2つ以上あれば、1つでも重なればよい)。
      // 日付が不正な行は期間を持たないので数えない(運行日も生まないので、走らなければ weekdayNotActive で止まる)
      const weekdayRanges = rowsOf(base, 'calendar')
        .filter((row) => trimmed(row.service_id) === wk)
        .map((row) => ({ start: trimmed(row.start_date), end: trimmed(row.end_date) }))
        .filter((r) => isValidGtfsDate(r.start) && isValidGtfsDate(r.end))
      if (weekdayRanges.length > 0 && weekdayRanges.every((r) => r.end < validity.start || r.start > validity.end)) {
        error(
          'weekdayCalendarOutside',
          `平日の service(${wk})の calendar の期間(${weekdayRanges.map((r) => `${formatDate(r.start)}〜${formatDate(r.end)}`).join('、')})が、新しい有効期間(${validityText})と重なりません。`,
        )
      }
      // 平日の service が新しい有効期間の中で1日も走らない(calendar と calendar_dates の両方で判定。calendar_dates だけの service も)。
      // 止めないと、§5.6 の規則で平日の service が便ごと出力から除かれ、方針が何も変えない出力になる
      if (tripCount(wk) > 0 && !runsAnyDay(index.get(wk), validity.start, validity.end)) {
        error(
          'weekdayNotActive',
          `平日の service(${wk})は、新しい有効期間(${validityText})の中で1日も走りません(calendar と calendar_dates で確かめました)。このままでは平日の便が出力から除かれ、ダイヤも入れ替わらないため、平日の service か減便の期間を選び直してください。`,
        )
      }
      /** 入れ替えに使う service の calendar の期間(無ければ走る日の最初〜最後)が、新しい有効期間の全体を覆わないなら、その期間 */
      const partialRange = (r: string): { start: string; end: string } | null => {
        const rDays = index.get(r)
        if (!rDays) return null
        let range: { start: string; end: string } | null = null
        const firstRow = rowsOf(base, 'calendar').find((row) => trimmed(row.service_id) === r)
        if (firstRow) {
          range = { start: trimmed(firstRow.start_date), end: trimmed(firstRow.end_date) }
        } else {
          const running: string[] = []
          forEachDay(validity.start, validity.end, (d, w) => {
            if (runsOn(rDays, d, w)) running.push(d)
          })
          if (running.length > 0) range = { start: running[0], end: running[running.length - 1] }
        }
        return range && (range.start > validity.start || range.end < validity.end) ? range : null
      }
      if (!multi) {
        for (const r of [rp]) {
          if (tripCount(r) > 0 && !runsAnyDay(index.get(r), validity.start, validity.end)) {
            error(
              'replacementNotActive',
              `入れ替えに使う service(${r})は、新しい有効期間(${formatDate(validity.start)}〜${formatDate(validity.end)})の中で1日も走りません。走らない時刻表を平日の便に入れ替えないよう、入れ替えに使う service か減便の期間を選び直してください。`,
            )
          } else {
            const range = partialRange(r)
            if (range) {
              warning(
                'replacementPartial',
                `入れ替えに使う service(${r})の期間(${formatDate(range.start)}〜${formatDate(range.end)})が、新しい有効期間(${formatDate(validity.start)}〜${formatDate(validity.end)})の全体を覆いません。期間の一部の平日で、加わる便が走らない時刻表になることがあります。`,
              )
            }
          }
        }
      } else {
        checkPairPeriods(settings.kind, pairs, index, validity, validityText, tripCount, error, warning)
      }
      if (validity.days <= 7) {
        warning(
          'shortValidity',
          `新しい有効期間が ${validity.days} 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、このままでは出力できません。期間の開始日か終了日を変えてください。`,
        )
      } else if (validity.days < 30) {
        warning('validityUnder30', `新しい有効期間が ${validity.days} 日です。GTFS-JP は、可能であれば 30 日以上を望ましいとしています。`)
      }
    }
  }

  // frequencies(到達圏も展開しないため、11/4 は扱わない)
  if (rowsOf(base, 'frequencies').length > 0) {
    error('frequencies', 'frequencies.txt に行がある GTFS には、減便の方針を適用できません。運行間隔で表す便は扱っていません。')
  }

  // 平日の便を指すほかの表の行(§5.2)。すべての組の平日の service の便で見る
  const weekdayTrips = trips.filter((t) => weekdaySet.has(trimmed(t.service_id)))
  const weekdayTripIds = new Set(weekdayTrips.map((t) => trimmed(t.trip_id)))
  const referencing: string[] = []
  for (const ref of TRIP_REFERENCES) {
    const n = rowsOf(base, ref.table).filter((r) => ref.columns.some((c) => weekdayTripIds.has(trimmed(r[c])))).length
    if (n > 0) referencing.push(`${ref.label} ${n} 行`)
  }
  const translations = rowsOf(base, 'translations').filter((r) => {
    const table = trimmed(r.table_name)
    return (table === 'trips' || table === 'stop_times') && weekdayTripIds.has(trimmed(r.record_id))
  }).length
  if (translations > 0) referencing.push(`translations.txt ${translations} 行`)
  if (referencing.length > 0) {
    error(
      'tripReferences',
      `平日の service の便を指す行があります(${referencing.join('、')})。消した便を指したまま残らないよう、この GTFS には減便の方針を適用できません。`,
    )
  }

  // 除外する系統
  const routeIds = new Set(rowsOf(base, 'routes').map((r) => trimmed(r.route_id)))
  const weekdayRoutes = new Set(weekdayTrips.map((t) => trimmed(t.route_id)))
  const unknown = settings.excludedRoutes.map((r) => r.trim()).filter((r) => !routeIds.has(r))
  if (unknown.length > 0) warning('unknownExcludedRoute', `除外する系統のうち、routes.txt にない route_id があります(${unknown.join('、')})。`)
  const noWeekday = settings.excludedRoutes.map((r) => r.trim()).filter((r) => routeIds.has(r) && !weekdayRoutes.has(r))
  if (noWeekday.length > 0) {
    warning('excludedRouteWithoutWeekdayTrips', `除外する系統のうち、平日の便がない route_id があります(${noWeekday.join('、')})。`)
  }

  return problems
}

/** 年末年始(12/29〜1/3)。入力の calendar_dates の扱いをそのまま残すので、入れ替えに使う service が走らなくても数えない(§4.7) */
function isYearEnd(date: string): boolean {
  const md = date.slice(4)
  return md >= '1229' || md <= '0103'
}

/**
 * pairs があるときの、組ごとの期間の確かめ(docs/design-service-groups.md §4.2)。主の組と主でない組で同じ規則を使う。
 * - 主でない組の平日の service が新しい有効期間に走らない:pairWeekdayNotActive(warning。組ごと出力から除く)。
 *   主の組は呼ぶ側の weekdayNotActive(error)が止める
 * - 入れ替えに使う service が新しい有効期間に1日も走らない:replacementNotActiveAdded(warning。便は平日の service の走る日に加える。S4)。
 *   ただし主の組で、便のある入れ替えに使う service がすべて走らないなら replacementNotActive(error。走らない時刻表だけで
 *   主の平日の便を入れ替えないため)
 * - 入れ替えに使う service が、新しい有効期間の X の日(土曜に:土曜、日祝に:日曜。祝日一覧は受け取らないので数えない。
 *   年末年始 12/29〜1/3 は除く)のうち走らない日がある:replacementPartial(warning。組ごとに1つ、service ごとの日数つき)
 */
function checkPairPeriods(
  kind: PolicyKind,
  pairs: readonly ServicePair[],
  index: Map<string, ServiceDays>,
  validity: { start: string; end: string },
  validityText: string,
  tripCount: (sid: string) => number,
  error: (code: string, message: string) => void,
  warning: (code: string, message: string) => void,
): void {
  const xWeekday = kind === 'weekdayToSaturday' ? 5 : 6
  const xLabel = kind === 'weekdayToSaturday' ? '土曜' : '日曜'
  const xDays: string[] = []
  forEachDay(validity.start, validity.end, (d, w) => {
    if (w === xWeekday && !isYearEnd(d)) xDays.push(d)
  })
  pairs.forEach((pair, i) => {
    const w = pair.weekday
    if (tripCount(w) === 0) return
    const wIndex = index.get(w)
    const wDays: string[] = []
    forEachDay(validity.start, validity.end, (d, wd) => {
      if (runsOn(wIndex, d, wd)) wDays.push(d)
    })
    if (wDays.length === 0) {
      // 主の組は呼ぶ側の weekdayNotActive が止める
      if (i > 0) {
        warning(
          'pairWeekdayNotActive',
          `平日の service(${w})は新しい有効期間(${validityText})の中で1日も走らないため、${pair.replacements.length > 0 ? `入れ替えに使う service(${pair.replacements.join('・')})との組ごと` : '便ごと'}出力から除きます。`,
        )
      }
      return
    }
    const withTrips = pair.replacements.filter((r) => r !== '' && tripCount(r) > 0)
    const inactive = withTrips.filter((r) => !runsAnyDay(index.get(r), validity.start, validity.end))
    if (i === 0 && inactive.length > 0 && inactive.length === withTrips.length) {
      error(
        'replacementNotActive',
        `入れ替えに使う service(${inactive.join('・')})は、新しい有効期間(${validityText})の中で1日も走りません。走らない時刻表を平日の便に入れ替えないよう、入れ替えに使う service か減便の期間を選び直してください。`,
      )
      return
    }
    for (const r of inactive) {
      warning(
        'replacementNotActiveAdded',
        `入れ替えに使う service(${r})は新しい有効期間(${validityText})の中で1日も走りませんが、その便を ${w} の走る日(${shortDates(wDays)})に加えます。`,
      )
    }
    const missing: string[] = []
    for (const r of withTrips) {
      if (inactive.includes(r)) continue
      const rIndex = index.get(r)
      const notRunning = xDays.filter((d) => !runsOn(rIndex, d, xWeekday))
      if (notRunning.length > 0) missing.push(`${r}:${notRunning.length} 日(${shortDates(notRunning)})`)
    }
    if (missing.length > 0) {
      warning(
        'replacementPartial',
        `${w} に便を加える入れ替えに使う service のうち、新しい有効期間の${xLabel}(年末年始を除く)に走らない日があるものがあります(${missing.join('、')})。その service の時刻表は期間の一部では使われていないことがありますが、加わる便は ${w} の走るすべての日に走ります。`,
      )
    }
  })
}

/** pairs があるときの組の表の確かめ(badPairs・duplicateService・便の有無・weekdayServiceRunsOnWeekend) */
function checkPairs(
  base: GtfsFeed,
  settings: PolicySettings,
  pairs: readonly ServicePair[],
  kept: readonly string[],
  tripCount: (sid: string) => number,
  error: (code: string, message: string) => void,
): void {
  const wk = settings.weekdayService.trim()
  const rp = settings.replacementService.trim()
  if (pairs.length === 0) {
    error('badPairs', '組の表(pairs)が空です。平日の service と入れ替えに使う service の組を1つ以上選んでください。')
    return
  }
  if (pairs[0].weekday !== wk || rp !== (pairs[0].replacements[0] ?? '')) {
    error(
      'badPairs',
      `組の表の先頭(${pairs[0].weekday} ← ${pairs[0].replacements[0] ?? 'なし'})が、平日の service(${wk})と入れ替えに使う service(${rp === '' ? 'なし' : rp})と合いません。`,
    )
  }
  if (pairs.some((p) => p.weekday === '' || p.replacements.some((r) => r === ''))) {
    error('badPairs', '組の表に、空の service_id があります。')
  }

  // 同じ service が2つの役割・2つの組に出てこない(M2)
  const roles = new Map<string, string[]>()
  const note = (sid: string, role: string) => {
    const list = roles.get(sid)
    if (list) list.push(role)
    else roles.set(sid, [role])
  }
  for (const p of pairs) {
    note(p.weekday, '平日の service')
    for (const r of p.replacements) note(r, `${p.weekday} の入れ替えに使う service`)
  }
  for (const k of kept) note(k, '残す平日の service')
  const duplicated = [...roles.entries()].filter(([sid, list]) => sid !== '' && list.length > 1)
  if (duplicated.length > 0) {
    error(
      'duplicateService',
      `同じ service が組の表に2回以上出てきます(${duplicated.map(([sid, list]) => `${sid}:${list.join('・')}`).join('、')})。1つの service は1つの組の1つの役割にだけ入れてください。`,
    )
  }

  for (const p of pairs) {
    if (p.weekday !== '' && tripCount(p.weekday) === 0) error('noWeekdayTrips', `平日の service(${p.weekday})の便がありません。`)
    for (const r of p.replacements) {
      if (r !== '' && tripCount(r) === 0) error('noReplacementTrips', `入れ替えに使う service(${r})の便がありません。`)
    }
  }

  // 平日の service が土曜・日曜にも走る(calendar の列で確かめる。祝日一覧は使わない。§2.6)
  const weekdaySet = new Set(pairs.map((p) => p.weekday))
  const weekend: string[] = []
  for (const row of rowsOf(base, 'calendar')) {
    const sid = trimmed(row.service_id)
    if (!weekdaySet.has(sid) || weekend.includes(sid)) continue
    if (trimmed(row.saturday) === '1' || trimmed(row.sunday) === '1') weekend.push(sid)
  }
  if (weekend.length > 0) {
    error(
      'weekdayServiceRunsOnWeekend',
      `平日の service のうち、土曜か日曜にも走るものがあります(${weekend.join('、')})。便を入れ替えると土曜・日曜の便も変わるため、この service は組に入れられません。平日のまま残すか、減便の方針の種類を選び直してください。`,
    )
  }

  // 入れ替えに使う service が月〜金にも走る(calendar の列で確かめる。weekdayServiceRunsOnWeekend と対)。
  // 平日の service の走る日に便を加えるので、その日はその便が2回走る。calendar_dates だけの重なりは replacementRunsWithWeekday の警告
  const replacementSet = new Set(pairs.flatMap((p) => p.replacements))
  const onWeekday: string[] = []
  for (const row of rowsOf(base, 'calendar')) {
    const sid = trimmed(row.service_id)
    if (!replacementSet.has(sid) || onWeekday.includes(sid)) continue
    if (WEEKDAY_COLUMNS.some((c) => trimmed(row[c]) === '1')) onWeekday.push(sid)
  }
  if (onWeekday.length > 0) {
    error(
      'replacementRunsOnWeekday',
      `入れ替えに使う service のうち、月〜金にも走るものがあります(${onWeekday.join('、')})。平日の service の走る日に便を加えると、その日は同じ便が2回走るため、この service は入れ替えに使えません。`,
    )
  }
}

const WEEKDAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const
