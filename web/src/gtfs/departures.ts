import type { GtfsFeed, GtfsRow } from './load'

/** 到達圏を数える時間帯。開始の時刻を含み、終了の時刻を含まない */
export interface TimeBand {
  startHour: number
  endHour: number
  /** 画面に出す名前(例:'6〜9時') */
  label: string
}

const FIRST_HOUR = 6
const LAST_HOUR = 24
const SECONDS_PER_DAY = 86400

/** 6時から24時までを、3時間ごと(6個)または1時間ごと(18個)に分ける */
export function makeBands(stepHours: 1 | 3): TimeBand[] {
  if (stepHours !== 1 && stepHours !== 3) {
    throw new Error(`時間帯の幅は1時間か3時間にしてください(${String(stepHours)} が指定されました)`)
  }
  const bands: TimeBand[] = []
  for (let h = FIRST_HOUR; h < LAST_HOUR; h += stepHours) {
    bands.push({ startHour: h, endHour: h + stepHours, label: `${h}〜${h + stepHours}時` })
  }
  return bands
}

// 時は1〜3桁(1桁の '7:05:00' と、24時を超える '25:10:00' を許す)。分と秒は2桁で 00〜59
const TIME_PATTERN = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/

/**
 * GTFS の時刻('HH:MM:SS')を、サービス日の 0:00 からの秒数にする。
 * 24時を超える値('25:10:00' → 90600)と時が1桁の値('7:05:00')を許す。
 * 空・未指定・形式が違う値は null を返す。
 */
export function parseGtfsTime(s: string | undefined): number | null {
  if (s === undefined) return null
  const m = TIME_PATTERN.exec(s.trim())
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

export interface DepartureCounts {
  /**
   * キーは空白を取った stop_id(標柱の単位)。値は時間帯ごとの出発の数で、並びは bands と同じ。
   * どの時間帯にも出発が無い停留所は入らない(すべて 0 とみなす)
   */
  counts: Map<string, number[]>
  /** departure_time が空で数えなかった行の数(運行する便の、本来なら数える行だけ。補間はしない) */
  skippedBlankTime: number
  /** frequencies.txt があれば true(展開はしない) */
  hasFrequencies: boolean
}

/** 便が対象日 D に走るか(today)と、前日 D−1 に走るか(yesterday)。両方のこともある */
const RUNS_TODAY = 1
const RUNS_YESTERDAY = 2

/**
 * 対象日 D に、停留所ごと・時間帯ごとの出発の数を数える。
 *
 * - `services.today`:D に走る service_id。出発時刻 t をそのまま時間帯に当てはめる
 * - `services.yesterday`:D−1 に走る service_id。`t − 86400` を当てはめる(前日の便の '30:10' は D の 6:10)
 * - 数えないもの:pickup_type=1(乗車できない)の行、各便の最後の停留所(stop_sequence を数値として比べて最大のもの)、
 *   departure_time が空の行(数は skippedBlankTime に入れる)
 *
 * stop_times は数万行になるため、便ごとの最後の stop_sequence を先に1回で求め、全体を O(行数) で数える。
 */
export function departureCountsByBand(
  feed: GtfsFeed,
  services: { today: Set<string>; yesterday: Set<string> },
  bands: TimeBand[],
): DepartureCounts {
  const counts = new Map<string, number[]>()
  const hasFrequencies = feed.tables.has('frequencies')
  const tripRows = feed.tables.get('trips')?.rows ?? []
  const stopTimeRows = feed.tables.get('stop_times')?.rows ?? []

  // 1. 対象日に関係する便(D に走る、または D−1 に走る)だけを残す
  const runs = new Map<string, number>()
  for (const trip of tripRows) {
    const tripId = trimmed(trip.trip_id)
    const serviceId = trimmed(trip.service_id)
    if (tripId === '' || serviceId === '') continue
    let flags = 0
    if (services.today.has(serviceId)) flags |= RUNS_TODAY
    if (services.yesterday.has(serviceId)) flags |= RUNS_YESTERDAY
    if (flags !== 0) runs.set(tripId, (runs.get(tripId) ?? 0) | flags)
  }
  if (runs.size === 0 || bands.length === 0) return { counts, skippedBlankTime: 0, hasFrequencies }

  // 2. 便ごとの最後の stop_sequence(数値として比べる。'10' > '9')
  const lastSequence = new Map<string, number>()
  for (const row of stopTimeRows) {
    const tripId = trimmed(row.trip_id)
    if (!runs.has(tripId)) continue
    const seq = sequenceOf(row)
    if (seq === null) continue
    const prev = lastSequence.get(tripId)
    if (prev === undefined || seq > prev) lastSequence.set(tripId, seq)
  }

  // 3. 出発を時間帯に当てはめる(時間帯の端は秒にしておく)
  const starts = bands.map((b) => b.startHour * 3600)
  const ends = bands.map((b) => b.endHour * 3600)
  let skippedBlankTime = 0

  for (const row of stopTimeRows) {
    const tripId = trimmed(row.trip_id)
    const flags = runs.get(tripId)
    if (flags === undefined) continue
    if (isNoPickup(row.pickup_type)) continue
    const seq = sequenceOf(row)
    if (seq !== null && seq === lastSequence.get(tripId)) continue

    const departure = row.departure_time
    if (departure === undefined || departure.trim() === '') {
      skippedBlankTime++
      continue
    }
    const t = parseGtfsTime(departure)
    // 形式が違う時刻は数えない(検証器が別に知らせる)
    if (t === null) continue

    const stopId = trimmed(row.stop_id)
    if (stopId === '') continue
    if (flags & RUNS_TODAY) addToBands(counts, stopId, t, starts, ends)
    if (flags & RUNS_YESTERDAY) addToBands(counts, stopId, t - SECONDS_PER_DAY, starts, ends)
  }

  return { counts, skippedBlankTime, hasFrequencies }
}

function addToBands(counts: Map<string, number[]>, stopId: string, t: number, starts: number[], ends: number[]): void {
  for (let i = 0; i < starts.length; i++) {
    if (t < starts[i] || t >= ends[i]) continue
    let arr = counts.get(stopId)
    if (!arr) {
      arr = new Array<number>(starts.length).fill(0)
      counts.set(stopId, arr)
    }
    arr[i]++
  }
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** stop_sequence を数値にする。空や数でない値は null(最後の停留所の判定に使わない) */
function sequenceOf(row: GtfsRow): number | null {
  const s = trimmed(row.stop_sequence)
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** pickup_type=1(乗車できない)。空は 0(乗車できる)とみなす */
function isNoPickup(v: string | undefined): boolean {
  const s = trimmed(v)
  return s !== '' && Number(s) === 1
}
