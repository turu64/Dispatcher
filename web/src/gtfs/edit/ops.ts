import { isValidGtfsDate } from '../calendar'
import type { GtfsFeed, GtfsRow } from '../load'
import {
  feedValidity,
  forEachDay,
  indexFeedServiceDays,
  policyValidity,
  runsAnyDay,
  runsOn,
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

export interface PolicySettings {
  kind: PolicyKind
  /** 入れ替える平日の service_id(空白を取った値) */
  weekdayService: string
  /** 写す元。kind が weekdayToSaturday なら土曜、weekdayToSundayHoliday なら日祝の service_id */
  replacementService: string
  period: Period
  /** 入れ替えから外す route_id(空白を取った値。利用者が選んだ順) */
  excludedRoutes: string[]
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
  return {
    kind: settings.kind,
    weekdayService: settings.weekdayService,
    replacementService: settings.replacementService,
    period: { start: settings.period.start, end: settings.period.end },
    excludedRoutes: [...settings.excludedRoutes],
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

/**
 * 方針を適用できるかを確かめる(§3)。error が1つでもあれば applyForm2 は ok: false を返す。
 * 有効期間は §5.6 の規則(入力の有効期間と方針の期間)で作る
 */
export function checkPolicy(base: GtfsFeed, settings: PolicySettings): PolicyProblem[] {
  const problems: PolicyProblem[] = []
  const error = (code: string, message: string) => problems.push({ severity: 'error', code, message })
  const warning = (code: string, message: string) => problems.push({ severity: 'warning', code, message })

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
  const tripCount = (sid: string) => trips.filter((t) => trimmed(t.service_id) === sid).length
  if (wk === rp) error('sameService', `平日の service と写す元の service が同じ(${wk})です。`)
  if (tripCount(wk) === 0) error('noWeekdayTrips', `平日の service(${wk})の便がありません。`)
  if (tripCount(rp) === 0) error('noReplacementTrips', `写す元の service(${rp})の便がありません。`)

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
          `平日の service(${wk})は、新しい有効期間(${validityText})の中で1日も走りません(calendar と calendar_dates で確かめました)。このままでは平日の便が出力から除かれ、方針が何も変えないため、平日の service か期間を選び直してください。`,
        )
      }
      const rpDays = index.get(rp)
      if (tripCount(rp) > 0 && !runsAnyDay(rpDays, validity.start, validity.end)) {
        error(
          'replacementNotActive',
          `写す元の service(${rp})は、新しい有効期間(${formatDate(validity.start)}〜${formatDate(validity.end)})の中で1日も走りません。走らない時刻表を平日に写さないよう、写す元の service か期間を選び直してください。`,
        )
      } else if (rpDays) {
        // 写す元の calendar の期間(無ければ走る日の最初〜最後)が、新しい有効期間の全体を覆うか
        let range: { start: string; end: string } | null = null
        const firstRow = rowsOf(base, 'calendar').find((r) => trimmed(r.service_id) === rp)
        if (firstRow) {
          range = { start: trimmed(firstRow.start_date), end: trimmed(firstRow.end_date) }
        } else {
          const running: string[] = []
          forEachDay(validity.start, validity.end, (d, w) => {
            if (runsOn(rpDays, d, w)) running.push(d)
          })
          if (running.length > 0) range = { start: running[0], end: running[running.length - 1] }
        }
        if (range && (range.start > validity.start || range.end < validity.end)) {
          warning(
            'replacementPartial',
            `写す元の service(${rp})の期間(${formatDate(range.start)}〜${formatDate(range.end)})が、新しい有効期間(${formatDate(validity.start)}〜${formatDate(validity.end)})の全体を覆いません。期間の一部の平日で、写した便が走らない時刻表になることがあります。`,
          )
        }
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
    error('frequencies', 'frequencies.txt に行がある GTFS には、方針を適用できません(運行間隔で表す便は扱っていません)。')
  }

  // 平日の便を指すほかの表の行(§5.2)
  const weekdayTripIds = new Set(trips.filter((t) => trimmed(t.service_id) === wk).map((t) => trimmed(t.trip_id)))
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
      `平日の service の便を指す行があります(${referencing.join('、')})。消した便を指したまま残らないよう、この GTFS には方針を適用できません。`,
    )
  }

  // 除外する系統
  const routeIds = new Set(rowsOf(base, 'routes').map((r) => trimmed(r.route_id)))
  const weekdayRoutes = new Set(trips.filter((t) => trimmed(t.service_id) === wk).map((t) => trimmed(t.route_id)))
  const unknown = settings.excludedRoutes.map((r) => r.trim()).filter((r) => !routeIds.has(r))
  if (unknown.length > 0) warning('unknownExcludedRoute', `除外する系統のうち、routes.txt に無い route_id があります(${unknown.join('、')})。`)
  const noWeekday = settings.excludedRoutes.map((r) => r.trim()).filter((r) => routeIds.has(r) && !weekdayRoutes.has(r))
  if (noWeekday.length > 0) {
    warning('excludedRouteWithoutWeekdayTrips', `除外する系統のうち、平日の便が無い route_id があります(${noWeekday.join('、')})。`)
  }

  return problems
}
