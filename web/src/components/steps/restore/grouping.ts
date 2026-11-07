import type { TripBrief } from '@/gtfs/edit/diff'
import { bestFacilityRank, hintWeight, type RestoreHintDetail } from '@/gtfs/edit/restore'
import type { RouteDirection } from '@/gtfs/edit/stopDiff'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from '@/gtfs/edit/signature'
import type { GtfsFeed } from '@/gtfs/load'

/**
 * 足し戻しの候補の一覧のまとめ方(docs/tasks-1103.md の指摘5、T12)。画面に依らない純粋な計算。
 *
 * 並べ方は2段に分ける(取り決めの2つの並びが食い違わないようにするため):
 * - 系統のまとまりの並び:全曜日で便がなくなる系統を先頭に、次に系統の中で最も上位の候補の並び(下の compareCandidates)、
 *   同じなら route_id の順
 * - 系統を開いたときの便の並び:方向(始発 → 終着の停留所の組)ごとに、始発の時刻の順(取り決め 1104 §13 の「系統を開いたときの並べ方」)。
 *   compareCandidates は方向の中の順を変えない。「手がかりのある便を先に出し、残りは『ほかの便を見る』で開く」の分け方と、
 *   系統の並びと、AI のおすすめ以外の平らな並びにだけ使う
 */

export interface Candidate {
  trip: TripBrief
  detail: RestoreHintDetail
}

/** 便の始発・終着の停留所(stop_id) */
export interface TripEndpoints {
  firstStopId: string
  lastStopId: string
}

/** 方向のまとまり(基準の便の始発 → 終着の停留所の組) */
export interface DirectionGroup {
  key: string
  firstStopName: string
  lastStopName: string
  /** 始発の時刻の順(時刻の無い便は後ろ、同じなら trip_id の順) */
  trips: Candidate[]
  /** 編集後のフィードで同じ方向の便の並び。比べる日が無ければ undefined、編集後に同じ方向の便が無ければ null */
  edited: RouteDirection | null | undefined
}

/** 系統のまとまり */
export interface RouteGroup {
  routeId: string
  routeName: string
  /** 編集後のフィードのどの service にもこの系統の便が無い(全曜日で便がなくなる) */
  vanishes: boolean
  /** この系統の候補(compareCandidates の順) */
  candidates: Candidate[]
  /** 手がかりのある候補の数 */
  hinted: number
  directions: DirectionGroup[]
}

/** 外れたセルが戻る手がかりの推計人口(無ければ 0) */
function populationOf(c: Candidate): number {
  return c.detail.lostCells?.population ?? 0
}

/** 時刻の昇順(null は後ろ) */
function compareSeconds(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/**
 * 候補の並び:判断材料の重み(restore.ts の hintWeight。2026-11-07 に数の多い順から変えた)の大きい順、次に窓に当たる学校・病院の
 * 優先順位、外れたセルの推計人口の多い順(人口の重みづけは、ここまで)、次に始発の時刻の順(時刻の無い便は後ろ)、同じなら trip_id の順
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const wa = hintWeight(a.detail)
  const wb = hintWeight(b.detail)
  if (wa !== wb) return wb - wa
  // 時間帯の窓に当たる学校・病院の、重要拠点の優先順位の高い便を先に(T19。当たる施設の無い便どうしは同じ扱い)
  const ra = bestFacilityRank(a.detail)
  const rb = bestFacilityRank(b.detail)
  if (ra !== rb) return ra - rb
  const pa = populationOf(a)
  const pb = populationOf(b)
  if (pa !== pb) return pb - pa
  return compareSeconds(a.trip.firstSeconds, b.trip.firstSeconds) || compareStrings(a.trip.tripId, b.trip.tripId)
}

/** 始発の時刻の順(時刻の無い便は後ろ)、同じなら trip_id の順 */
export function compareByTime(a: Candidate, b: Candidate): number {
  return compareSeconds(a.trip.firstSeconds, b.trip.firstSeconds) || compareStrings(a.trip.tripId, b.trip.tripId)
}

/** 便ごとの始発・終着の stop_id(stop_sequence の順で最初と最後の行)。stop_times の無い便は入れない */
export function tripEndpoints(feed: GtfsFeed): Map<string, TripEndpoints> {
  const out = new Map<string, TripEndpoints>()
  for (const [tripId, rows] of stopTimesByTrip(feed.tables.get('stop_times')?.rows ?? [])) {
    const ordered = sortByStopSequence(rows)
    if (ordered.length === 0) continue
    out.set(tripId, {
      firstStopId: ordered[0].stop_id?.trim() ?? '',
      lastStopId: ordered[ordered.length - 1].stop_id?.trim() ?? '',
    })
  }
  return out
}

function directionKey(firstStopId: string, lastStopId: string): string {
  return `${firstStopId}\u0000${lastStopId}`
}

/** 編集後の同じ方向。比べる日が無ければ(edited が null)undefined、同じ方向の便が無ければ null */
function editedDirection(edited: RouteDirection[] | null, ends: TripEndpoints | undefined): RouteDirection | null | undefined {
  if (edited === null) return undefined
  if (!ends) return null
  return edited.find((d) => d.firstStopId === ends.firstStopId && d.lastStopId === ends.lastStopId) ?? null
}

/**
 * 候補を系統 × 方向にまとめる。
 * endpoints は基準のフィードの便の始発・終着(tripEndpoints)。名前ではなく stop_id で方向を分ける(同じ名前の停留所があるため)。
 * vanishing は全曜日で便がなくなる系統の route_id。editedTimeline は編集後のフィードの、比べる日の方向の並び
 * (createRouteDirectionTimeline。比べる日が無ければ null)
 */
export function groupCandidates(
  candidates: readonly Candidate[],
  endpoints: ReadonlyMap<string, TripEndpoints>,
  vanishing: ReadonlySet<string>,
  editedTimeline: ((routeId: string) => RouteDirection[]) | null,
): RouteGroup[] {
  const byRoute = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const list = byRoute.get(c.trip.routeId)
    if (list) list.push(c)
    else byRoute.set(c.trip.routeId, [c])
  }

  const groups: RouteGroup[] = []
  for (const [routeId, list] of byRoute) {
    const edited = editedTimeline ? editedTimeline(routeId) : null
    const directions = new Map<string, DirectionGroup>()
    for (const c of [...list].sort(compareByTime)) {
      const ends = endpoints.get(c.trip.tripId)
      const key = ends ? directionKey(ends.firstStopId, ends.lastStopId) : directionKey('', '')
      let dir = directions.get(key)
      if (!dir) {
        dir = {
          key,
          firstStopName: c.trip.firstStopName,
          lastStopName: c.trip.lastStopName,
          trips: [],
          edited: editedDirection(edited, ends),
        }
        directions.set(key, dir)
      }
      dir.trips.push(c)
    }
    const sorted = [...list].sort(compareCandidates)
    groups.push({
      routeId,
      routeName: list[0].trip.routeName,
      vanishes: vanishing.has(routeId),
      candidates: sorted,
      hinted: list.filter((c) => c.detail.hints.length > 0).length,
      // 方向は、最初の便の始発の時刻の順(trips は時刻の順に入れたので、作った順のまま)
      directions: [...directions.values()],
    })
  }

  return groups.sort((a, b) => {
    if (a.vanishes !== b.vanishes) return a.vanishes ? -1 : 1
    return compareCandidates(a.candidates[0], b.candidates[0]) || compareStrings(a.routeId, b.routeId)
  })
}
