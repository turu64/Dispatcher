import { forEachDay, indexFeedServiceDays, runsOn, dayNumber } from './services'
import { addDays, isValidGtfsDate } from '../calendar'
import type { GtfsFeed } from '../load'
import { stopDiff, type StopChange, type StopDeparture } from './stopDiff'
import { addBackReasons, type EditRecord, type Form2Plan } from './ops'
import { compareStrings } from './signature'
import { isOwnOperator, operatorMovementFacts } from '@/ref/facilities'
import { nearOtherStops, operatorNameOf, OTHER_STOP_RADIUS_M, type OtherStop } from '@/ref/busstops'

/**
 * 周知文の計算(純粋な関数)。停留所ごとの掲示(系統ごとの期間中の発車時刻)と、代替手段の案内の材料、
 * 公示日と実施日の関係、運輸規則第17条の5項目を雛形にした告知文の文面を作る。
 *
 * - 停留所は stop_id で照合する(名前では照合しない)。近くの停留所は stops.txt の座標で探す
 * - 発車時刻は stopDiff.ts(停留所の一覧・到達圏の出発の数と同じ規則)の編集後の側。
 *   形2では平日ダイヤの便が入れ替わるので、期間の中の平日ダイヤが走る日 1 日で数える(pickNoticeDate)
 * - 数字(本数・時刻・距離)はこのファイルが出す。文面の自由記入の部分は、画面で利用者が書く
 * - 他事業者の便は扱わない(国土数値情報の停留所には時刻が無い)。代替手段は、同じ停留所と近くの停留所に期間中も残る自社の便と、
 *   近くにある他事業者の停留所・系統名(位置は参照データの P11。引数で受ける)と、自由記入で出す
 * - 他事業者の減便の動きは、前提情報で調べた結果の事実を引用するだけ(要約や推測はしない)。確認日時はいつも添える
 */

/** 頻繁な系統とみなす間隔の上限(分)。隣り合う発車が15分以内なら、1時間に4本以上になる(運輸規則第5条第3項の「頻繁」の目安) */
export const FREQUENT_MAX_GAP_MIN = 15
/** 頻繁な系統とみなす最小の連続本数。15分間隔なら 5 本で 1 時間(1時間に4本以上)を満たす */
export const FREQUENT_MIN_DEPARTURES = 5
/** 代替手段として探す近くの停留所の半径(m) */
export const NEARBY_RADIUS_M = 300
/** 公示から実施までに空ける日数(運輸規則第6条第1項) */
export const NOTICE_LEAD_DAYS = 7

/** 掲示の1行分の中身。個々の時刻か、頻繁な区間の「始発〜終発と間隔」 */
export type NoticeSegment =
  | {
      kind: 'single'
      /** 'HH:MM'(24時を超える値は '25:10') */
      time: string
      seconds: number
      /** 休校日運休(学)の便 */
      school: boolean
    }
  | {
      kind: 'interval'
      first: string
      last: string
      seconds: number
      /** 区間の発車の数 */
      count: number
      /** 隣り合う発車の間隔の最小・最大(分) */
      minGapMin: number
      maxGapMin: number
    }

/** 系統 × 行き先ごとの、期間中の発車 */
export interface LineNotice {
  routeId: string
  routeName: string
  headsign: string
  segments: NoticeSegment[]
  /** 発車の数 */
  count: number
  first: string
  last: string
  /** (学)の発車の数 */
  schoolCount: number
}

/** 無くなる発車(掲示から外す時刻)を系統 × 行き先ごとにまとめたもの */
export interface RemovedLine {
  routeId: string
  routeName: string
  headsign: string
  times: string[]
}

export interface StopNotice {
  stopId: string
  stopName: string
  /** stops.txt の座標。読めなければ null */
  lat: number | null
  lon: number | null
  lines: LineNotice[]
  /** 期間中の発車の数 */
  count: number
  /** 減便前(基準)の発車の数 */
  beforeCount: number
  removedLines: RemovedLine[]
  /** 掲示の差し替えが要る */
  needsRepost: boolean
  /** 基準では発車があり、期間中は発車が無くなる */
  losesAll: boolean
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

function lineKey(routeId: string, headsign: string): string {
  return `${routeId}\u0000${headsign}`
}

/** 秒を分(四捨五入)にする */
function minutes(seconds: number): number {
  return Math.round(seconds / 60)
}

/**
 * 1つの系統 × 行き先の発車(時刻の順)を、掲示の行にする。
 * 休校日運休(学)でない発車のうち、隣り合う発車が FREQUENT_MAX_GAP_MIN 分以内で FREQUENT_MIN_DEPARTURES 本以上続く区間は、
 * 「始発〜終発と間隔」の1つにまとめる。それ以外(間隔が開く所、本数が少ない区間、(学)の発車)は1本ずつ載せる。
 * 区間の中は 1時間に4本以上なので、「始発・終発と間隔」で代えても利用者を誤らせない。
 * 1日の中に混む時間と空く時間がある系統は、混む区間だけを間隔で表す
 */
export function segmentsOf(departures: readonly StopDeparture[], schoolTripIds: ReadonlySet<string>): NoticeSegment[] {
  const sorted = [...departures].sort((a, b) => a.seconds - b.seconds || compareStrings(a.tripId, b.tripId))
  const segments: NoticeSegment[] = []
  const regular: StopDeparture[] = []
  for (const d of sorted) {
    if (schoolTripIds.has(d.tripId)) segments.push({ kind: 'single', time: d.time, seconds: d.seconds, school: true })
    else regular.push(d)
  }
  const flush = (run: StopDeparture[]) => {
    if (run.length >= FREQUENT_MIN_DEPARTURES) {
      const gaps: number[] = []
      for (let i = 1; i < run.length; i++) gaps.push(minutes(run[i].seconds - run[i - 1].seconds))
      segments.push({
        kind: 'interval',
        first: run[0].time,
        last: run[run.length - 1].time,
        seconds: run[0].seconds,
        count: run.length,
        minGapMin: Math.min(...gaps),
        maxGapMin: Math.max(...gaps),
      })
    } else {
      for (const d of run) segments.push({ kind: 'single', time: d.time, seconds: d.seconds, school: false })
    }
  }
  let run: StopDeparture[] = []
  for (const d of regular) {
    if (run.length > 0 && d.seconds - run[run.length - 1].seconds > FREQUENT_MAX_GAP_MIN * 60) {
      flush(run)
      run = []
    }
    run.push(d)
  }
  if (run.length > 0) flush(run)
  return segments.sort((a, b) => a.seconds - b.seconds)
}

/** 発車を系統 × 行き先ごとにまとめる(系統は渡された順、行き先は出てきた順) */
function groupLines(
  byRoute: readonly { routeId: string; routeName: string; departures: readonly StopDeparture[] }[],
): { routeId: string; routeName: string; headsign: string; departures: StopDeparture[] }[] {
  const groups = new Map<string, { routeId: string; routeName: string; headsign: string; departures: StopDeparture[] }>()
  for (const route of byRoute) {
    for (const d of route.departures) {
      const key = lineKey(route.routeId, d.headsign)
      const g = groups.get(key)
      if (g) g.departures.push(d)
      else groups.set(key, { routeId: route.routeId, routeName: route.routeName, headsign: d.headsign, departures: [d] })
    }
  }
  return [...groups.values()]
}

/** 停留所 1 件分の掲示の材料。schoolTripIds は休校日運休(学)の便の trip_id(編集後のフィードの trip_id) */
export function buildStopNotice(
  stop: StopChange,
  schoolTripIds: ReadonlySet<string>,
  coord: { lat: number; lon: number } | null = null,
): StopNotice {
  const lines: LineNotice[] = groupLines(stop.after.byRoute).map((g) => {
    const segments = segmentsOf(g.departures, schoolTripIds)
    const sorted = [...g.departures].sort((a, b) => a.seconds - b.seconds)
    return {
      routeId: g.routeId,
      routeName: g.routeName,
      headsign: g.headsign,
      segments,
      count: g.departures.length,
      first: sorted[0].time,
      last: sorted[sorted.length - 1].time,
      schoolCount: g.departures.filter((d) => schoolTripIds.has(d.tripId)).length,
    }
  })
  const removedLines: RemovedLine[] = []
  const removedRoutes = new Map<string, { routeId: string; routeName: string; departures: StopDeparture[] }>()
  for (const d of stop.removed) {
    const r = removedRoutes.get(d.routeId)
    if (r) r.departures.push(d)
    else removedRoutes.set(d.routeId, { routeId: d.routeId, routeName: nameOfRoute(stop, d.routeId), departures: [d] })
  }
  for (const g of groupLines([...removedRoutes.values()].sort((a, b) => compareStrings(a.routeId, b.routeId)))) {
    removedLines.push({ routeId: g.routeId, routeName: g.routeName, headsign: g.headsign, times: g.departures.map((d) => d.time) })
  }
  return {
    stopId: stop.stopId,
    stopName: stop.stopName,
    lat: coord ? coord.lat : null,
    lon: coord ? coord.lon : null,
    lines,
    count: stop.after.count,
    beforeCount: stop.before.count,
    removedLines,
    needsRepost: stop.needsRepost,
    losesAll: stop.before.count > 0 && stop.after.count === 0,
  }
}

function nameOfRoute(stop: StopChange, routeId: string): string {
  for (const side of [stop.before, stop.after]) {
    const found = side.byRoute.find((r) => r.routeId === routeId)
    if (found) return found.routeName
  }
  return routeId
}

/** stops.txt の座標(stop_id ごと。読めない行・緯度経度の範囲外は入れない) */
export function stopCoordinates(feed: GtfsFeed): Map<string, { lat: number; lon: number }> {
  const coords = new Map<string, { lat: number; lon: number }>()
  for (const row of feed.tables.get('stops')?.rows ?? []) {
    const id = trimmed(row.stop_id)
    if (id === '' || coords.has(id)) continue
    const latText = trimmed(row.stop_lat)
    const lonText = trimmed(row.stop_lon)
    if (latText === '' || lonText === '') continue
    const lat = Number(latText)
    const lon = Number(lonText)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    coords.set(id, { lat, lon })
  }
  return coords
}

/** 2点の距離(m。大圏距離) */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface StopNotices {
  /** 数えた日('YYYYMMDD') */
  date: string
  stops: StopNotice[]
}

/**
 * 基準と編集後の、ある日(date。期間の中の平日ダイヤが走る日)の停留所ごとの掲示の材料(stop_id の順)。
 * 基準か編集後のどちらかにその日の発車がある停留所をすべて含む
 */
export function buildStopNotices(base: GtfsFeed, edited: GtfsFeed, date: string, schoolTripIds: ReadonlySet<string>): StopNotices {
  const diff = stopDiff(base, edited, date)
  const coords = stopCoordinates(base)
  const editedCoords = stopCoordinates(edited)
  return {
    date,
    stops: diff.stops.map((s) => buildStopNotice(s, schoolTripIds, coords.get(s.stopId) ?? editedCoords.get(s.stopId) ?? null)),
  }
}

/**
 * 休校日運休(学)の便の trip_id。足し戻しで印を付けた便のうち、実際に足し戻された便(report.addBack.accepted)だけ。
 * 足し戻した便は基準の平日便の trip_id のまま編集後に入る(形2。写した便はこの id を避けて付け直す)ので、
 * 編集後のフィードの発車と trip_id で照合できる
 */
export function schoolTripIdsOf(history: readonly EditRecord[], acceptedAddBack: readonly string[]): Set<string> {
  const accepted = new Set(acceptedAddBack.map((t) => t.trim()))
  const school = new Set<string>()
  for (const [tripId, info] of addBackReasons(history)) {
    if (info.schoolDaysOnly && accepted.has(tripId)) school.add(tripId)
  }
  return school
}

/**
 * 掲示の時刻を数える日。方針の期間(新しい有効期間の中)のうち、基準の平日の service が走る最初の日。
 * 形2では、その日は編集後の平日ダイヤ(土曜・日祝の便に入れ替えた便と、足し戻した便)で走る。
 * 見つからなければ null(期間に平日ダイヤが走る日が無い)
 */
export function pickNoticeDate(
  base: GtfsFeed,
  plan: Pick<Form2Plan, 'weekdayService'>,
  validity: { start: string; end: string },
): string | null {
  const days = indexFeedServiceDays(base).get(plan.weekdayService.trim())
  if (!days) return null
  let found: string | null = null
  forEachDay(validity.start, validity.end, (date, weekday) => {
    if (runsOn(days, date, weekday)) {
      found = date
      return true
    }
  })
  return found
}

// ---- 代替手段 ----

/** 停留所に残る系統 × 行き先のまとめ */
export interface RemainingLine {
  routeId: string
  routeName: string
  headsign: string
  count: number
  first: string
  last: string
}

export interface NearbyStop {
  stopId: string
  stopName: string
  /** 距離(m。10 m 単位に四捨五入) */
  distanceM: number
  lines: RemainingLine[]
}

/** 近くにある1つの他事業者の停留所と系統(時刻は P11 に無いので持たない) */
export interface OtherOperatorNear {
  /** 事業者の target_id(P11:…) */
  targetId: string
  /** 事業者名(P11: を除いたもの) */
  name: string
  /** 半径内のこの事業者の停留所(近い順。同じ停留所名は近いほう1件。距離は 10 m 単位に四捨五入) */
  stops: { name: string; distanceM: number }[]
  /** これらの停留所の系統名(重複なし、順に並べたもの) */
  routes: string[]
}

export interface Alternatives {
  /** 同じ停留所に期間中も残る自社の便(系統 × 行き先) */
  sameStop: RemainingLine[]
  /** 半径内の別の停留所で、期間中も発車がある所(近い順) */
  nearby: NearbyStop[]
  /** 座標が分からず、近くの停留所を探せなかった */
  noCoordinates: boolean
  /**
   * 半径内にある他事業者の停留所と系統(事業者ごと。最も近い停留所が近い順)。
   * 停留所の参照データを渡していないときは null(無い、とは言えない)。座標が無いときは空
   */
  otherOperators: OtherOperatorNear[] | null
}

function remainingOf(stop: StopNotice): RemainingLine[] {
  return stop.lines.map((l) => ({
    routeId: l.routeId,
    routeName: l.routeName,
    headsign: l.headsign,
    count: l.count,
    first: l.first,
    last: l.last,
  }))
}

/**
 * 半径 radiusM 以内の他事業者の停留所を、事業者ごとにまとめる(ref/busstops.ts の nearOtherStops)。
 * otherStops は、読み込んだ GTFS の事業者を excludeOwnOperators で除いたものを渡す(自社の停留所を「他社」と数えないため)
 */
export function otherOperatorsNear(
  lat: number,
  lon: number,
  otherStops: readonly OtherStop[],
  radiusM: number = OTHER_STOP_RADIUS_M,
): OtherOperatorNear[] {
  const near = nearOtherStops(lat, lon, otherStops, radiusM)
  const byOperator = new Map<string, { stops: Map<string, number>; routes: Set<string>; nearest: number }>()
  for (const { stop, distanceM: d } of near.stops) {
    for (const op of stop.operators) {
      let e = byOperator.get(op)
      if (!e) {
        e = { stops: new Map(), routes: new Set(), nearest: d }
        byOperator.set(op, e)
      }
      const rounded = Math.round(d / 10) * 10
      // 上り・下りなど同じ名前の停留所は、近いほう(先に出たほう)だけを載せる
      if (!e.stops.has(stop.name)) e.stops.set(stop.name, rounded)
      for (const r of stop.routes) e.routes.add(r)
    }
  }
  return [...byOperator.entries()]
    .sort(([ia, a], [ib, b]) => a.nearest - b.nearest || compareStrings(ia, ib))
    .map(([targetId, e]) => ({
      targetId,
      name: operatorNameOf(targetId),
      stops: [...e.stops.entries()].map(([name, distanceM]) => ({ name, distanceM })),
      routes: [...e.routes].sort(compareStrings),
    }))
}

/**
 * 代替手段の案内の材料:同じ停留所と、半径 radiusM(既定 300 m)以内の別の停留所に、期間中も残る自社の便。
 * otherStops(自社を除いた他事業者の停留所)を渡すと、半径内の他事業者の停留所と系統名も数える。
 * 他事業者の便の本数・時刻は持たない(P11 に時刻が無い)
 */
export function alternativesFor(
  target: StopNotice,
  all: readonly StopNotice[],
  radiusM: number = NEARBY_RADIUS_M,
  otherStops: readonly OtherStop[] | null = null,
): Alternatives {
  const sameStop = remainingOf(target)
  if (target.lat === null || target.lon === null) {
    return { sameStop, nearby: [], noCoordinates: true, otherOperators: otherStops ? [] : null }
  }
  const here = { lat: target.lat, lon: target.lon }
  const nearby: NearbyStop[] = []
  for (const other of all) {
    if (other.stopId === target.stopId || other.count === 0 || other.lat === null || other.lon === null) continue
    const d = distanceM(here, { lat: other.lat, lon: other.lon })
    if (d > radiusM) continue
    nearby.push({ stopId: other.stopId, stopName: other.stopName, distanceM: Math.round(d / 10) * 10, lines: remainingOf(other) })
  }
  nearby.sort((a, b) => a.distanceM - b.distanceM || compareStrings(a.stopId, b.stopId))
  const otherOperators = otherStops ? otherOperatorsNear(target.lat, target.lon, otherStops, radiusM) : null
  return { sameStop, nearby, noCoordinates: false, otherOperators }
}

// ---- 周辺の事業者の減便の動き(前提情報で調べた結果の引用) ----

/** 調べた結果の確認日時が古いとみなす日数。これを超えたら、出典で確かめるよう添える */
export const STALE_CHECK_DAYS = 30

/** 確認日時(ISO 8601)が now(ミリ秒)の STALE_CHECK_DAYS 日より前か。日時を読めなければ false(古いとは決めつけない) */
export function isStaleCheck(checkedAt: string, now: number): boolean {
  const t = Date.parse(checkedAt)
  return Number.isFinite(t) && now - t > STALE_CHECK_DAYS * 86_400_000
}

/** 調べた結果の1件(前提情報の ResearchResult のうち、引用に使う項目) */
export interface ResearchedOperator {
  targetId: string
  name: string
  facts: readonly { label: string; value: string; source: number }[]
  sources: readonly { url: string; title: string }[]
  checkedAt: string
  origin: 'web' | 'demo'
}

/** 引用する出典(番号は調べた結果の出典の番号) */
export interface QuotedSource {
  no: number
  title: string
  url: string
}

/** 事業者について調べた減便の動きの引用。要約や推測は足さず、調べた事実をそのまま写す */
export interface MovementQuote {
  targetId: string
  operatorName: string
  facts: { label: string; value: string; sourceNo: number | null }[]
  /** facts が引いている出典(番号の順) */
  sources: QuotedSource[]
  /** 確認日時(ISO 8601) */
  checkedAt: string
  origin: 'web' | 'demo'
  /** 確認日時が STALE_CHECK_DAYS 日より前 */
  stale: boolean
}

/**
 * 調べた結果から、減便・ダイヤ改正・運休・特別ダイヤの事実(operatorMovementFacts)だけを引用にする。
 * 該当する事実が無ければ null。now は古さの判定に使う時刻(ミリ秒)
 */
export function movementQuoteOf(result: ResearchedOperator, now: number): MovementQuote | null {
  const found = operatorMovementFacts(result.facts)
  if (found.length === 0) return null
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= result.sources.length
  const nos = [...new Set(found.map((f) => f.source).filter(valid))].sort((a, b) => a - b)
  return {
    targetId: result.targetId,
    operatorName: result.name.trim() || operatorNameOf(result.targetId),
    facts: found.map((f) => ({ label: f.label, value: f.value, sourceNo: valid(f.source) ? f.source : null })),
    sources: nos.map((no) => ({ no, title: result.sources[no - 1].title, url: result.sources[no - 1].url })),
    checkedAt: result.checkedAt,
    origin: result.origin,
    stale: isStaleCheck(result.checkedAt, now),
  }
}

/** 変更指示書の「周辺の事業者の動き」の材料 */
export interface MovementSummary {
  /** 調べた事業者(自社を除く)の数。0 なら「調べていません」 */
  researched: number
  /** 減便の動きの事実がある事業者の引用(事業者名の順) */
  quotes: MovementQuote[]
  /** 調べた事業者の確認日時のうち、最も新しいもの(ISO 8601)。無ければ null */
  latestCheckedAt: string | null
}

/**
 * 調べた結果(事業者のものだけ。自社は agencyNames で除く)から、変更指示書に載せる周辺の事業者の動きを作る。
 * 学校・病院の結果は使わない
 */
export function movementSummary(
  results: Iterable<ResearchedOperator & { kind: string }>,
  agencyNames: readonly string[],
  now: number,
): MovementSummary {
  const operators: ResearchedOperator[] = []
  for (const r of results) {
    if (r.kind !== 'operator') continue
    if (isOwnOperator(operatorNameOf(r.targetId), agencyNames)) continue
    operators.push(r)
  }
  const quotes = operators
    .map((r) => movementQuoteOf(r, now))
    .filter((q): q is MovementQuote => q !== null)
    .sort((a, b) => compareStrings(a.operatorName, b.operatorName) || compareStrings(a.targetId, b.targetId))
  let latest: string | null = null
  for (const r of operators) {
    const t = Date.parse(r.checkedAt)
    if (Number.isFinite(t) && (latest === null || t > Date.parse(latest))) latest = r.checkedAt
  }
  return { researched: operators.length, quotes, latestCheckedAt: latest }
}

// ---- 公示日と実施日 ----

/**
 * 公示日から実施日まで 7 日を切るか(運輸規則第6条第1項。切るときは緊急やむを得ない理由を書く)。
 * どちらかが空・不正な日付なら null(判定できない)。実施日が公示日と同じか前なら、切るとする
 */
export function underLeadTime(announceDate: string, effectiveDate: string): boolean | null {
  if (!isValidGtfsDate(announceDate) || !isValidGtfsDate(effectiveDate)) return null
  return dayNumber(effectiveDate) - dayNumber(announceDate) < NOTICE_LEAD_DAYS
}

// ---- 方針で除外した系統(平日ダイヤのまま走る) ----

/** 停留所の掲示で、除外した系統をどう書くか */
export interface ExcludedAtStop {
  /** この停留所の系統(期間中の発車と運休する発車の系統)が、すべて除外した系統 */
  all: boolean
  /** この停留所に止まる、除外した系統の名前(系統の id の順) */
  names: string[]
}

/** 停留所に止まる系統のうち、方針で除外した系統(excludedRouteIds。前後の空白は無視する) */
export function excludedAtStop(stop: Pick<StopNotice, 'lines' | 'removedLines'>, excludedRouteIds: readonly string[]): ExcludedAtStop {
  const excluded = new Set(excludedRouteIds.map((id) => id.trim()))
  const routes = new Map<string, string>()
  for (const l of [...stop.lines, ...stop.removedLines]) if (!routes.has(l.routeId)) routes.set(l.routeId, l.routeName)
  const ids = [...routes.keys()].filter((id) => excluded.has(id.trim())).sort(compareStrings)
  return { all: routes.size > 0 && ids.length === routes.size, names: ids.map((id) => routes.get(id) ?? id) }
}

// ---- 告知文(運輸規則第17条の5項目の雛形) ----

export const NOTICE_DISCLAIMER =
  '法定の様式ではありません。運輸規則第17条の公示事項(事故の日時・場所、概要、復旧の見込み、臨時の計画の概要、代わりに使える運行系統や他の運送事業)を雛形にした文案です。公示の要否と方法は運輸支局に確認してください。'

export interface AnnouncementInput {
  agencyName: string
  /** 実施日('YYYYMMDD') */
  effectiveDate: string
  /** 期間の終わり('YYYYMMDD')。null は当面の間 */
  periodEnd: string | null
  /** 写す元のダイヤの呼び方('土曜'・'日祝') */
  replacementLabel: string
  /** 減便の理由の区分の文言(選ばなければ空) */
  reasonLabel: string
  reasonNote: string
  /** 平日の便数 前→後(diff.ts の removed・same・added から数える) */
  weekdayBefore: number
  weekdayAfter: number
  /** 平日ダイヤから消える便の数(diff.removed。時刻が同じ便が後に無い便) */
  removedTrips: number
  /** 平日ダイヤに入る、写す元のダイヤの時刻の便の数(diff.added。時刻が同じ便が前に無い便) */
  addedTrips: number
  /** 足し戻した便の数と、うち休校日運休(学)の数 */
  addedBackTrips: number
  schoolTrips: number
  /** 全曜日で便がなくなる系統の名前 */
  vanishingRoutes: string[]
  /** 方針で除外した系統(平日ダイヤのまま走る)の名前 */
  excludedRouteNames: string[]
  /** 場所(画面で記入) */
  place: string
  /** 代わりに使える運行系統・他の運送事業の自由記入 */
  alternativesNote: string
}

export interface AnnouncementItem {
  /** 1〜5 */
  no: number
  /** 項目の見出し(利用者が読む文に載せる。第17条の項目名を、利用者に誤解されない言い方にしたもの) */
  label: string
  /**
   * 第17条の項目名が見出しと違うときだけ、その項目名(画面で運行管理者が法令と照らすため。印刷には出さない)。
   * 欠員は「事故」と言い切れない(docs/research/dia-planning.md)ので、掲げる見出しは「変更の日時・場所」にする
   */
  legalLabel?: string
  text: string
}

export const BLANK = '(ここに記入してください)'

function dateJa(date: string): string {
  if (!isValidGtfsDate(date)) return ''
  return `${Number(date.slice(0, 4))}年${Number(date.slice(4, 6))}月${Number(date.slice(6, 8))}日`
}

/** 第17条の5項目を雛形にした告知文。数字は入力(コードが数えた値)をそのまま使い、自由記入の欄は空なら記入を促す */
export function buildAnnouncement(input: AnnouncementInput): AnnouncementItem[] {
  const start = dateJa(input.effectiveDate) || BLANK
  const agency = input.agencyName.trim() || '当社'
  const label = input.reasonLabel.trim()
  const note = input.reasonNote.trim()
  const reason = label !== '' && note !== '' ? `${label}(${note})` : label || note

  const net = input.weekdayBefore - input.weekdayAfter
  const netText = net > 0 ? `(${net} 便減)` : net < 0 ? `(${-net} 便増)` : '(便数は変わりません)'
  // 消える便(removed)は、時刻がずれただけの便や写す元のダイヤの別の時刻の便に置き換わった便も含むので、正味の差と分けて書く
  const removedText = `平日ダイヤの時刻の ${input.removedTrips} 便は運休`
  const addedText = `${input.replacementLabel}ダイヤの時刻の ${input.addedTrips} 便を運行します`
  const swapText =
    input.removedTrips > 0 && input.addedTrips > 0
      ? `内訳は、${removedText}し、${addedText}。`
      : input.removedTrips > 0
        ? `${removedText}します。`
        : input.addedTrips > 0
          ? `${addedText}。`
          : ''
  const summary = [
    `${agency}は、${reason !== '' ? `${reason}のため、` : ''}${start}から、平日ダイヤで運行する日を${input.replacementLabel}ダイヤで運行します。`,
    `平日の運行は ${input.weekdayBefore} 便から ${input.weekdayAfter} 便${netText}になります。`,
    swapText,
  ].join('')

  const planParts = [`平日ダイヤで運行する日(祝日など平日ダイヤが走らない日を除く)は、${input.replacementLabel}ダイヤの時刻で運行します。停留所ごとの時刻は、各停留所の掲示をご覧ください。`]
  if (input.addedBackTrips > 0) {
    planParts.push(
      `通勤・通学・通院などのため、${input.addedBackTrips} 便は平日の時刻のまま運行します。${input.schoolTrips > 0 ? `うち ${input.schoolTrips} 便は学校の休業日は運休します。時刻表では(学)の印を付けています。` : ''}`,
    )
  }
  if (input.excludedRouteNames.length > 0) {
    planParts.push(`次の系統は平日ダイヤのまま運行します:${input.excludedRouteNames.join('、')}。`)
  }
  if (input.vanishingRoutes.length > 0) {
    planParts.push(`運行がなくなる系統:${input.vanishingRoutes.join('、')}。`)
  }

  const recovery =
    input.periodEnd === null
      ? '当面の間の運行です。復旧の見込みは決まり次第お知らせします。'
      : `${dateJa(input.periodEnd)}までの予定です。${dateJa(addDays(input.periodEnd, 1))}から元のダイヤに戻す予定ですが、変更するときは改めてお知らせします。`

  return [
    {
      no: 1,
      label: '変更の日時・場所',
      legalLabel: '事故の日時・場所',
      text: `日時:${start}から。場所:${input.place.trim() || BLANK}`,
    },
    { no: 2, label: '概要', text: summary },
    { no: 3, label: '復旧の見込み', text: recovery },
    { no: 4, label: '臨時の計画で運行するときの概要', text: planParts.join('') },
    {
      no: 5,
      label: '代わりに使える運行系統・他の運送事業',
      text:
        input.alternativesNote.trim() ||
        `${BLANK}\n同じ停留所と近くの停留所に残る自社の便は、停留所ごとの掲示に載せています。他事業者の運行系統や他の運送事業は、事業者が確かめて記入してください。`,
    },
  ]
}
