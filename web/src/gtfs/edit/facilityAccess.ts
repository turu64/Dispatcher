import { activeServiceIds } from '../calendar'
import { parseGtfsTime } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { NON_NEGATIVE_INTEGER } from '../parse'
import { distanceM } from '../../reach/mesh'
import { formatMinutes, type FacilityHintKind, type FacilityTiming, type FacilityWindow } from './facilityHours'
import type { HintFacility } from './restore'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from './signature'

/**
 * 学校・病院ごとに、始業・受付の窓に着く便と、帰りの窓に出る便を、減便の前後で数える(docs/tasks-1105.md の A05。指摘 18.3)。
 * 画面と AI(summarize_impact の facility_access)の材料にする純粋な関数。数はすべてここで出す。
 *
 * - 施設は平日便を戻す手順の判断材料と同じ HintFacility(store/restoreHintContext.ts が作る)。窓は施設ごとの
 *   facility.windows(調べた受付時間・始業・終業から決めた窓。読めなければ既定の FACILITY_WINDOWS)をそのまま使う
 * - 便は、比較する日付(date)に走る service の便。減便前は base、減便後は edited で、それぞれの calendar・calendar_dates
 *   から決める(activeServiceIds)。frequencies.txt は見ない
 * - 施設の徒歩圏(facility.radiusM。ちょうどの距離は届くとする)の中の停留所のうち、その日に減便前か減便後の便が
 *   乗り降りする停留所を使う。停留所の位置と名前は stops から取る(減便前の stops.txt。toStops(base).stops を渡す。
 *   降車だけの停留所も着く便に数えるので、到達圏の起点の停留所(降車専用を除く)ではなく stops.txt の全部を渡す)
 * - 着く便:徒歩圏の停留所のどれかで降りられ(drop_off_type が 1 でなく、便の最初の行でない)、その到着時刻が着く窓に入る便
 * - 出る便:徒歩圏の停留所のどれかで乗れ(pickup_type が 1 でなく、便の最後の行でない)、その出発時刻が出る窓に入る便
 * - 到着時刻が空なら出発時刻を、出発時刻が空なら到着時刻を使う(restore.ts の判断材料と同じ)。どちらも空の行は数えない
 * - 1つの便は、徒歩圏の停留所を2つ以上通っても、窓ごとに1便と数える
 * - 窓は開始を含み終わりを含まない
 * - 問題は arriveLost(着く便が減便前 1 以上・減便後 0)と departLost(出る便が減便前 1 以上・減便後 0)
 * - 並びは、施設の重要拠点の優先順位(rank。1 が最も高い)、最寄りの停留所までの距離、target_id の順
 *
 * 乗り継ぎ・混み具合・鉄道との接続は見ない(データが無い。docs/tasks-1105.md §7)。駅は施設に入れない。
 */

/** 施設の問題 */
export type FacilityAccessProblem = 'arriveLost' | 'departLost'

/** 片側(減便前か減便後)の数 */
export interface FacilityAccessSide {
  /** 窓の中に着く(出る)便の数 */
  trips: number
  /**
   * 着く窓は、窓の中で最も遅く着く時刻、出る窓は、窓の中で最も早く出る時刻('HH:MM'。24時を超える時刻もそのまま)。
   * 便が無ければ null
   */
  time: string | null
}

/** 施設の1つの窓と、その窓に着く(出る)便の前後の数 */
export interface FacilityAccessWindow {
  timing: FacilityTiming
  /** 窓の始まり('H:MM'。含む) */
  from: string
  /** 窓の終わり('H:MM'。含まない) */
  to: string
  /** research は調べた結果から決めた窓、default は既定の窓(FACILITY_WINDOWS) */
  source: FacilityWindow['source']
  /** research のとき、読んだ時刻(「外来の受付 8:00〜11:30・13:00〜15:15」「始業 8:40」) */
  basis: string | null
  /** research のとき、読んだ事実の出典の URL(読めなければ null) */
  url: string | null
  before: FacilityAccessSide
  after: FacilityAccessSide
}

/** 施設の徒歩圏の停留所 */
export interface FacilityAccessStop {
  stopId: string
  stopName: string
  /** 停留所から施設までの直線距離(m、整数に丸める) */
  distanceM: number
}

/** 施設の要点(結果に入れる分だけ) */
export interface FacilityAccessFacility {
  targetId: string
  name: string
  kind: FacilityHintKind
  /** 重要拠点の種類の名前(「高校・特別支援学校」など) */
  categoryLabel: string
  /** 重要拠点の優先順位(1 が最も高い) */
  rank: number
}

/** 施設ごとの結果 */
export interface FacilityAccessEntry extends FacilityAccessFacility {
  /** 徒歩圏の、その日に乗り降りする停留所(近い順。同じ距離なら stop_id の順) */
  stops: FacilityAccessStop[]
  /** 最寄りの停留所までの距離(m、整数に丸める) */
  distanceM: number
  arrive: FacilityAccessWindow
  depart: FacilityAccessWindow
  /** arriveLost・departLost の順 */
  problems: FacilityAccessProblem[]
}

export interface FacilityAccessResult {
  /** 比較する日付('YYYYMMDD') */
  date: string
  /** 徒歩圏に、その日に乗り降りする停留所がある施設(rank・距離・target_id の順) */
  facilities: FacilityAccessEntry[]
  /** 徒歩圏に、その日に乗り降りする停留所が無い施設(位置か徒歩圏の半径が読めない施設も含む。rank・target_id の順) */
  withoutStops: FacilityAccessFacility[]
  /** 問題ごとの施設の数 */
  counts: Record<FacilityAccessProblem, number>
  /** 比較する日付に、減便前の GTFS で走る便が無いときの理由(あれば facilities・withoutStops は空)。ほかは null */
  reason: string | null
  /** 数え方の注意(窓は目安で、乗り継ぎ・混み具合は見ない) */
  note: string
}

/** 結果に添える注意 */
export const FACILITY_ACCESS_NOTE =
  '窓は、始業・外来の受付などの決めた時刻に間に合う時間帯の目安です。乗り継ぎと混み具合は見ていません。' +
  '着く便は施設の徒歩圏の停留所で降りられる便、出る便は乗れる便を、その日に走る便だけ数えます。'

/** 比較する日付に、減便前の GTFS で走る便が無いときの理由 */
export const FACILITY_ACCESS_NO_TRIPS = '比較する日付に、減便前の GTFS で走る便がありません。別の日付を選んでください。'

/** 位置と名前を読む停留所(toStops(base).stops を渡す) */
export interface FacilityAccessStopInput {
  id: string
  name: string
  lat: number
  lon: number
}

const TIMINGS: readonly FacilityTiming[] = ['arrive', 'depart']
const PROBLEM_OF: Record<FacilityTiming, FacilityAccessProblem> = { arrive: 'arriveLost', depart: 'departLost' }

/** 1つの便の、乗り降りできる行の時刻(秒) */
interface StopEvent {
  tripId: string
  /** 降りられる行の到着時刻(降りられなければ null) */
  arrive: number | null
  /** 乗れる行の出発時刻(乗れなければ null) */
  depart: number | null
}

function trimmed(v: string | undefined): string {
  return (v ?? '').trim()
}

function sequenceOf(row: GtfsRow): string | null {
  const s = trimmed(row.stop_sequence)
  if (!NON_NEGATIVE_INTEGER.test(s)) return null
  return s.replace(/^0+(?=\d)/, '')
}

function isLaterSequence(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b
}

/** 秒を 'HH:MM' にする(24時を超える時刻もそのまま) */
function clockOf(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * その日に走る便の、停留所ごとの乗り降りの時刻。最初の行では降りられず、最後の行では乗れないとする。
 * 乗ることも降りることもできない行と、時刻の読めない行は入れない
 */
function eventsByStop(feed: GtfsFeed, date: string): { byStop: Map<string, StopEvent[]>; trips: number } {
  const active = activeServiceIds(feed, date)
  const tripIds = new Set<string>()
  for (const t of feed.tables.get('trips')?.rows ?? []) {
    if (active.has(trimmed(t.service_id))) tripIds.add(trimmed(t.trip_id))
  }
  const byStop = new Map<string, StopEvent[]>()
  if (tripIds.size === 0) return { byStop, trips: 0 }
  const rows = (feed.tables.get('stop_times')?.rows ?? []).filter((r) => tripIds.has(trimmed(r.trip_id)))
  for (const [tripId, group] of stopTimesByTrip(rows)) {
    let first: string | null = null
    let last: string | null = null
    for (const row of group) {
      const seq = sequenceOf(row)
      if (seq === null) continue
      if (first === null || isLaterSequence(first, seq)) first = seq
      if (last === null || isLaterSequence(seq, last)) last = seq
    }
    for (const row of sortByStopSequence(group)) {
      const stopId = trimmed(row.stop_id)
      if (stopId === '') continue
      const seq = sequenceOf(row)
      const arrival = parseGtfsTime(trimmed(row.arrival_time)) ?? parseGtfsTime(trimmed(row.departure_time))
      const departure = parseGtfsTime(trimmed(row.departure_time)) ?? parseGtfsTime(trimmed(row.arrival_time))
      const canAlight = trimmed(row.drop_off_type) !== '1' && !(seq !== null && seq === first)
      const canBoard = trimmed(row.pickup_type) !== '1' && !(seq !== null && seq === last)
      const event: StopEvent = { tripId, arrive: canAlight ? arrival : null, depart: canBoard ? departure : null }
      if (event.arrive === null && event.depart === null) continue
      let list = byStop.get(stopId)
      if (!list) {
        list = []
        byStop.set(stopId, list)
      }
      list.push(event)
    }
  }
  return { byStop, trips: tripIds.size }
}

/** 窓(分。開始を含み終わりを含まない)に入るか */
function inWindow(seconds: number, w: FacilityWindow): boolean {
  return seconds >= w.from * 60 && seconds < w.to * 60
}

/** 徒歩圏の停留所で、窓に着く(出る)便の数と、最も遅く着く(最も早く出る)時刻 */
function countSide(byStop: Map<string, StopEvent[]>, stopIds: readonly string[], timing: FacilityTiming, w: FacilityWindow): FacilityAccessSide {
  const trips = new Set<string>()
  let best: number | null = null
  for (const stopId of stopIds) {
    for (const e of byStop.get(stopId) ?? []) {
      const seconds = e[timing]
      if (seconds === null || !inWindow(seconds, w)) continue
      trips.add(e.tripId)
      if (best === null || (timing === 'arrive' ? seconds > best : seconds < best)) best = seconds
    }
  }
  return { trips: trips.size, time: best === null ? null : clockOf(best) }
}

function summaryOf(f: HintFacility): FacilityAccessFacility {
  return { targetId: f.targetId, name: f.name, kind: f.kind, categoryLabel: f.categoryLabel, rank: f.rank }
}

function compareFacilities(a: FacilityAccessFacility, b: FacilityAccessFacility): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  return compareStrings(a.targetId, b.targetId)
}

const M_PER_DEG_LAT = 110_000
const RAD = Math.PI / 180
/** 緯度・経度の箱で先に絞るときの余白(箱は少し広めにとり、距離は distanceM で確かめる) */
const BOX_MARGIN = 1.05

/**
 * 学校・病院ごとに、窓に着く便と窓に出る便を、減便前(base)と減便後(edited)で数える。
 * date は比較する日付('YYYYMMDD')、facilities は前提情報の施設(HintFacility)、stops は停留所の位置と名前
 * (減便前の stops.txt。toStops(base).stops)
 */
export function facilityAccess(
  base: GtfsFeed,
  edited: GtfsFeed,
  date: string,
  facilities: readonly HintFacility[],
  stops: readonly FacilityAccessStopInput[],
): FacilityAccessResult {
  const counts: Record<FacilityAccessProblem, number> = { arriveLost: 0, departLost: 0 }
  const before = eventsByStop(base, date)
  if (before.trips === 0) {
    return { date, facilities: [], withoutStops: [], counts, reason: FACILITY_ACCESS_NO_TRIPS, note: FACILITY_ACCESS_NOTE }
  }
  const after = eventsByStop(edited, date)

  // 徒歩圏を探す停留所:その日に減便前か減便後の便が乗り降りする停留所だけ(同じ stop_id は最初の行を使う)
  const places = new Map<string, FacilityAccessStopInput>()
  for (const s of stops) {
    if (places.has(s.id) || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue
    if (before.byStop.has(s.id) || after.byStop.has(s.id)) places.set(s.id, s)
  }
  const served = [...places.values()]

  const entries: FacilityAccessEntry[] = []
  // 並べるときは丸める前の距離を使う
  const rawDistance = new Map<FacilityAccessEntry, number>()
  const withoutStops: FacilityAccessFacility[] = []
  for (const f of facilities) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || !Number.isFinite(f.radiusM) || f.radiusM < 0) {
      withoutStops.push(summaryOf(f))
      continue
    }
    const dLat = (f.radiusM / M_PER_DEG_LAT) * BOX_MARGIN
    const north = Math.min(Math.abs(f.lat) + dLat, 89)
    const dLon = (f.radiusM / (M_PER_DEG_LAT * Math.cos(north * RAD))) * BOX_MARGIN
    const near: { stop: FacilityAccessStopInput; distance: number }[] = []
    for (const s of served) {
      if (Math.abs(s.lat - f.lat) > dLat || Math.abs(s.lon - f.lon) > dLon) continue
      const distance = distanceM(s, f)
      if (distance <= f.radiusM) near.push({ stop: s, distance })
    }
    if (near.length === 0) {
      withoutStops.push(summaryOf(f))
      continue
    }
    near.sort((a, b) => a.distance - b.distance || compareStrings(a.stop.id, b.stop.id))
    const stopIds = near.map((n) => n.stop.id)
    const windows = {} as Record<FacilityTiming, FacilityAccessWindow>
    const problems: FacilityAccessProblem[] = []
    for (const timing of TIMINGS) {
      const w = f.windows[timing]
      const b = countSide(before.byStop, stopIds, timing, w)
      const a = countSide(after.byStop, stopIds, timing, w)
      windows[timing] = {
        timing,
        from: formatMinutes(w.from),
        to: formatMinutes(w.to),
        source: w.source,
        basis: w.basis ?? null,
        url: w.fact?.url ?? null,
        before: b,
        after: a,
      }
      if (b.trips >= 1 && a.trips === 0) {
        problems.push(PROBLEM_OF[timing])
        counts[PROBLEM_OF[timing]]++
      }
    }
    const entry: FacilityAccessEntry = {
      ...summaryOf(f),
      stops: near.map((n) => ({ stopId: n.stop.id, stopName: n.stop.name.trim() || n.stop.id, distanceM: Math.round(n.distance) })),
      distanceM: Math.round(near[0].distance),
      arrive: windows.arrive,
      depart: windows.depart,
      problems,
    }
    entries.push(entry)
    rawDistance.set(entry, near[0].distance)
  }

  entries.sort((a, b) => a.rank - b.rank || rawDistance.get(a)! - rawDistance.get(b)! || compareStrings(a.targetId, b.targetId))
  withoutStops.sort(compareFacilities)
  return { date, facilities: entries, withoutStops, counts, reason: null, note: FACILITY_ACCESS_NOTE }
}
