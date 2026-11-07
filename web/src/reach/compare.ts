/**
 * 到達圏の前後の比較(docs/interfaces-1104.md §7)。数はコードが出す(解釈と説明は画面や Claude の役目)。
 *
 * - 前後は、同じ日付の「基準の GTFS」(利用者が読み込んだもの)と「編集後の GTFS」(方針の適用・足し戻しで作ったもの)
 * - どちらの到達圏も、基準の起点・調べるセル・coverable・区分で計算する(docs/interfaces-1103.md の追記3)。
 *   時間帯ごとの出発の数だけが違うので、比べる分母は基準の coverable のセル(と推計人口)
 * - 運行がゼロになる停留所・系統は、その日だけ 0 になる('day')か、編集後のフィードのどの日にも便が来ない('feed')かを分ける。
 *   路線の休止の届出に当たるかなどは判定しない(画面が運輸支局への確認を促す)
 */
import { activeServiceIds } from '@/gtfs/calendar'
import type { DepartureCounts } from '@/gtfs/departures'
import type { GtfsFeed } from '@/gtfs/load'
import type { Stop } from '@/gtfs/parse'
import { boardingStopIds } from './input'
import type { ReachResult } from './reach'

export interface BandComparison {
  /** coverable のセルのうち、基準では到達でき、編集後は外れるセル */
  lostCells: number
  lostPopulation: number
  /** coverable のセルのうち、基準では外れ、編集後は到達できるセル(土曜の便が平日に無い時刻に走る場合など) */
  gainedCells: number
  gainedPopulation: number
}

export interface ReachComparison {
  /** 時間帯ごと(結果の reachable と同じ並び) */
  bands: BandComparison[]
  /** 基準ではどれかの時間帯で到達でき、編集後はどの時間帯でも到達できない coverable のセル(運行がゼロになる場所) */
  dayLostCells: number
  dayLostPopulation: number
}

/** 2つの配列が、長さと各要素(===)まで同じか */
function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const MISMATCH =
  '減便の前後で、到達圏を調べた区画が一致しません。前後とも減便前の GTFS の起点と同じ条件で計算してください(docs/interfaces-1103.md の追記3)。'

/**
 * 基準(before)と編集後(after)の到達圏を比べる。
 * 2つの結果の cells・classes・coverable・cellPopulation と時間帯の数が等しくなければエラーにする
 * (基準の起点と同じ条件で計算していれば、出発の数に関係しないので必ず等しい)。
 * セルは coverable のものだけを数える(到達できるセルは必ず coverable なので、見込みの無いセルは前後で変わらない)。
 */
export function compareReach(before: ReachResult, after: ReachResult): ReachComparison {
  if (
    !sameArray(before.cells, after.cells) ||
    !sameArray(before.classes, after.classes) ||
    !sameArray(before.coverable, after.coverable) ||
    !sameArray(before.cellPopulation, after.cellPopulation)
  ) {
    throw new Error(MISMATCH)
  }
  if (before.reachable.length !== after.reachable.length) {
    throw new Error(`減便の前後で、時間帯の数が一致しません(前 ${before.reachable.length}、後 ${after.reachable.length})。`)
  }

  const n = before.cells.length
  const bands = before.reachable.map((row, b): BandComparison => {
    const afterRow = after.reachable[b]
    let lostCells = 0
    let lostPopulation = 0
    let gainedCells = 0
    let gainedPopulation = 0
    for (let i = 0; i < n; i++) {
      if (!before.coverable[i]) continue
      const was = row[i] === true
      const now = afterRow[i] === true
      if (was === now) continue
      const pop = before.cellPopulation[i] ?? 0
      if (was) {
        lostCells++
        lostPopulation += pop
      } else {
        gainedCells++
        gainedPopulation += pop
      }
    }
    return { lostCells, lostPopulation, gainedCells, gainedPopulation }
  })

  let dayLostCells = 0
  let dayLostPopulation = 0
  for (let i = 0; i < n; i++) {
    if (!before.coverable[i]) continue
    if (!before.reachable.some((row) => row[i] === true)) continue
    if (after.reachable.some((row) => row[i] === true)) continue
    dayLostCells++
    dayLostPopulation += before.cellPopulation[i] ?? 0
  }
  return { bands, dayLostCells, dayLostPopulation }
}

export interface ZeroServiceStop {
  stopId: string
  name: string
  /** 基準のその日の 6〜24時の出発の数(時間帯の合計) */
  beforeDepartures: number
  /**
   * 'day':その日の出発が 0 になる。
   * 'feed':編集後のフィードの全 service の stop_times に、この停留所の乗れる行(§7 の起点の定義)が無い
   * (出力のどの日にも便が来ない。stops.txt には残る)
   */
  scope: 'day' | 'feed'
}

/** 'feed' を先に、同じなら数の降順、同じならキーの昇順(UTF-16 のコード単位の順) */
function compareZero(
  a: { scope: 'day' | 'feed'; count: number; key: string },
  b: { scope: 'day' | 'feed'; count: number; key: string },
): number {
  if (a.scope !== b.scope) return a.scope === 'feed' ? -1 : 1
  if (a.count !== b.count) return b.count - a.count
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function totalOf(counts: readonly number[] | undefined): number {
  let total = 0
  for (const n of counts ?? []) total += n
  return total
}

/**
 * 起点の停留所のうち、基準ではその日の 6〜24時に出発があり、編集後は 0 になるもの。
 * before・after は同じ日付・同じ時間帯で数えた departureCountsByBand の結果(基準と編集後)。
 * 並びは 'feed' が先、次に beforeDepartures の降順、同じなら stopId の昇順。
 * 同じ stop_id の停留所が origins に複数あれば、最初の1つだけを使う。
 */
export function zeroServiceStops(
  origins: readonly Stop[],
  before: DepartureCounts,
  after: DepartureCounts,
  edited: GtfsFeed,
): ZeroServiceStop[] {
  let boarding: Set<string> | null = null
  const seen = new Set<string>()
  const out: ZeroServiceStop[] = []
  for (const stop of origins) {
    if (seen.has(stop.id)) continue
    seen.add(stop.id)
    const beforeDepartures = totalOf(before.counts.get(stop.id))
    if (beforeDepartures === 0 || totalOf(after.counts.get(stop.id)) > 0) continue
    // 編集後の全便で乗れる行を探すのは、0 になる停留所が1つでもあるときだけ
    boarding ??= boardingStopIds(edited)
    out.push({ stopId: stop.id, name: stop.name, beforeDepartures, scope: boarding.has(stop.id) ? 'day' : 'feed' })
  }
  return out.sort((a, b) =>
    compareZero(
      { scope: a.scope, count: a.beforeDepartures, key: a.stopId },
      { scope: b.scope, count: b.beforeDepartures, key: b.stopId },
    ),
  )
}

export interface ZeroServiceRoute {
  routeId: string
  /** route_short_name、無ければ route_long_name、無ければ route_id(§6 の TripBrief.routeName と同じ) */
  name: string
  /** 'day' はその日に走る基準の便の数、'feed' は基準の trips の全行のうちこの系統の便の数 */
  beforeTrips: number
  /** 'day':その日の便が 0 になる。'feed':出力のどの service にも便が無くなる(路線の休止の手続きに当たりうる) */
  scope: 'day' | 'feed'
}

/** 系統ごとの便の数。services を渡せば、その service の便だけを数える。route_id・service_id・trip_id は空白を取って照合する */
function tripsByRoute(feed: GtfsFeed, services: ReadonlySet<string> | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const trip of feed.tables.get('trips')?.rows ?? []) {
    const routeId = trip.route_id?.trim() ?? ''
    if (routeId === '' || (trip.trip_id?.trim() ?? '') === '') continue
    if (services && !services.has(trip.service_id?.trim() ?? '')) continue
    counts.set(routeId, (counts.get(routeId) ?? 0) + 1)
  }
  return counts
}

/** routes.txt から系統の名前(route_short_name、無ければ route_long_name、無ければ route_id) */
function routeNames(feed: GtfsFeed): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of feed.tables.get('routes')?.rows ?? []) {
    const id = row.route_id?.trim() ?? ''
    if (id === '' || names.has(id)) continue
    const name = row.route_short_name?.trim() || row.route_long_name?.trim() || id
    names.set(id, name)
  }
  return names
}

/**
 * 運行がゼロになる系統。
 * - 'feed':基準の trips に便があり、編集後の trips の全行に1本も無い系統(日付に関係なく出す)。beforeTrips は基準の全便の数
 * - 'day':date に走る便(activeServiceIds)が基準では1本以上、編集後は 0 本で、編集後のほかの日には便が残る系統。
 *   beforeTrips はその日の基準の便の数
 * 並びは 'feed' が先、次に beforeTrips の降順、同じなら routeId の昇順。名前は基準の routes.txt から取る(無ければ編集後)。
 */
export function zeroServiceRoutes(base: GtfsFeed, edited: GtfsFeed, date: string): ZeroServiceRoute[] {
  const baseAll = tripsByRoute(base, null)
  const editedAll = tripsByRoute(edited, null)
  const baseDay = tripsByRoute(base, activeServiceIds(base, date))
  const editedDay = tripsByRoute(edited, activeServiceIds(edited, date))
  const names = routeNames(base)
  const editedNames = routeNames(edited)

  const out: ZeroServiceRoute[] = []
  for (const [routeId, all] of baseAll) {
    const name = names.get(routeId) ?? editedNames.get(routeId) ?? routeId
    if (!editedAll.has(routeId)) {
      out.push({ routeId, name, beforeTrips: all, scope: 'feed' })
      continue
    }
    const day = baseDay.get(routeId) ?? 0
    if (day > 0 && !editedDay.has(routeId)) out.push({ routeId, name, beforeTrips: day, scope: 'day' })
  }
  return out.sort((a, b) =>
    compareZero(
      { scope: a.scope, count: a.beforeTrips, key: a.routeId },
      { scope: b.scope, count: b.beforeTrips, key: b.routeId },
    ),
  )
}
