import type { GtfsFeed } from '../load'
import { formatClock } from './diff'
import { distanceM } from './notice'
import type { TripLeg } from './serviceHours'
import { compareStrings } from './signature'

/**
 * その日に要る勤務の数の下限の目安(指摘 24、docs/tasks-1105.md の D02)。便の区間(serviceHours.ts の tripLegs)を
 * 時刻順に勤務へつなぎ、改善基準告示の上限と点呼・回送の仮定で区切った勤務の数を出す純粋な計算。
 * 実際の仕業・交番(休息期間・36協定・予備の要員・交代の場所)は再現しない。数は下限の目安で、事業者の判断の材料にとどめる。
 *
 * つなぎ方(何度動かしても同じ結果):
 * - 便を出発の秒の昇順(同じなら trip_id の昇順)に並べ、1便ずつ、つなげる勤務のうち最後の便の到着が最も遅い勤務に足す
 *   (同じなら先に作った勤務)。つなげる勤務が無ければ新しい勤務を作る。block_id は使わない(公開データでは空のことが多い)
 * - 同じ停留所(停留所名を NFKC にして空白を除いて同じ、または params.sameStopM 以内)なら、折り返し params.turnaroundMin 分以上で
 *   つなぐ。別の停留所なら、折り返しに回送(直線距離 × params.deadheadFactor を params.deadheadKmh で走る時間)を足した時間が要る。
 *   座標の無い停留所は、名前が同じときだけつなぐ(回送の時間を出せないため)
 * - 回送は運転時間と連続運転に入れる。前の便の到着から次の便の出発までのうち回送を除いた時間を「すき間」とし、
 *   すき間 → 回送 → 次の便の順に過ごすとみなす
 *
 * 法令の条件(既定値。params で変えられる。改善基準告示 第5条、docs/research/dia-planning.md 4.5・4.6):
 * - 拘束時間:出庫前の点呼(30 分)から入庫後の点呼(15 分)まで 13 時間以内(延長の上限の 15 時間に切り替えられる)。
 *   places に営業所があれば、最初の停留所・最後の停留所と最寄りの営業所の間の回送を足す(運転時間と連続運転にも入れる)
 * - 運転時間:9 時間以内(2日平均で1日9時間の基準を、その日だけに当てはめた目安)
 * - 連続運転:4 時間以内。10 分以上のすき間を合わせて 30 分になったら、連続運転を数え直す。すき間はどの停留所でも休憩
 *   (運転の中断)に数える(終点での折り返しの待ちで中断を取る形。改善基準告示は中断の場所を決めていない)
 * - 営業所があるとき(2026-11-06 に作り直した。前は営業所の近くのすき間だけを休憩に数え、勤務が細切れになっていた):
 *   - 待つ場所:営業所の params.placeRadiusM 以内でない停留所(前の便の終着も次の便の始発も遠い)で待つのは
 *     params.maxRemoteWaitMin 分までとする。それより長いすき間(中休)は、営業所へ回送して休み、また回送して次の便に乗る
 *     (往復の合計が最も短い営業所。往復の回送は運転時間と連続運転に入れ、すき間から往復の回送を除いた残りが
 *     params.minBreakMin 分以上のときだけつなぐ。残りは休憩に数える)。待つ時間の上限の中でも、営業所で休むほうが連続運転が
 *     短くなる(数え直せる)なら営業所で休む
 *   - 入庫できるか:その便で終えると入庫の回送で上限を超える便(営業所から遠い終点へ行く便。道北バスの旭川駅前 → 留萌十字街など)も
 *     勤務の始まりにでき、入庫まで含めて条件を満たす便(営業所の近くへ戻る便)をつなげば上限の中に収まる。便を足すのは、
 *     足した後に入庫まで含めて条件を満たすときだけ
 *   - 出庫・入庫の回送と便を合わせて連続運転の上限を超えるときは、最初の停留所に params.breakResetMin 分早く着いて休むか、
 *     最後の停留所で params.breakResetMin 分休んでから入庫するとみなす(拘束時間に入れる。休んでも回送だけで上限を超えるなら上限超え)
 * - 事業場外の休憩(営業所の外での休憩)の合計の上限(3 時間)は任意の条件で、既定は使わない
 * - 入庫の回送と点呼まで含めて条件の中で終えられなかった勤務(1便だけで入庫を除いた条件を超える便は、その便だけの勤務にする)に
 *   overLimit の印を付ける
 * - 出庫か入庫の回送が片道 LONG_DEPOT_DEADHEAD_MIN 分を超える勤務を数える(longDeadheadDuties)。営業所が路線から遠いと、
 *   回送だけで上限に近づいて勤務が細かく分かれ、数が跳ね上がる。画面で注意に出す
 * - 営業所なしの数は作り直しの前と同じ(営業所が無ければ、どの停留所でも待つ時間の上限なしに休め、入庫の回送は 0)
 *
 * 車両の数の下限の目安:法令の条件を外し、折り返しと回送だけで同じ手順でつないだ数(chained)と、同時に営業運行中の便の
 * 最大(maxConcurrent)。
 */

/** 改善基準告示 第5条の拘束時間の上限(分)。原則 13 時間、延長して最大 15 時間 */
export const BOUND_LIMIT_MIN = { standard: 13 * 60, extended: 15 * 60 } as const

export interface DutyParams {
  /** 出庫前の点呼(分) */
  preCheckMin: number
  /** 入庫後の点呼(分) */
  postCheckMin: number
  /** 拘束時間の上限(分) */
  maxBoundMin: number
  /** 運転時間の上限(分) */
  maxDrivingMin: number
  /** 連続運転の上限(分) */
  maxContinuousMin: number
  /** 休憩に数える1回のすき間の最小(分) */
  minBreakMin: number
  /** 連続運転を数え直す休憩の合計(分) */
  breakResetMin: number
  /** 折り返しに要る時間(分) */
  turnaroundMin: number
  /** 同じ停留所とみなす距離(m) */
  sameStopM: number
  /** 回送の道のりを直線距離の何倍とみなすか */
  deadheadFactor: number
  /** 回送の速さ(km/h) */
  deadheadKmh: number
  /** 営業所に近い停留所とみなす距離(m) */
  placeRadiusM: number
  /** 事業場外の休憩の合計の上限(分)。null なら使わない */
  offSiteBreakMaxMin: number | null
  /**
   * 営業所が1つでもあるとき、営業所の近くでない停留所で待つすき間の上限(分)。これより長いすき間は営業所へ回送して休む。
   * null なら上限なし。営業所が無ければ使わない
   */
  maxRemoteWaitMin: number | null
}

export const DUTY_DEFAULTS: DutyParams = {
  preCheckMin: 30,
  postCheckMin: 15,
  maxBoundMin: BOUND_LIMIT_MIN.standard,
  maxDrivingMin: 9 * 60,
  maxContinuousMin: 4 * 60,
  minBreakMin: 10,
  breakResetMin: 30,
  turnaroundMin: 5,
  sameStopM: 300,
  deadheadFactor: 1.3,
  deadheadKmh: 30,
  placeRadiusM: 300,
  offSiteBreakMaxMin: null,
  maxRemoteWaitMin: 90,
}

/** 事業場外の休憩の上限の目安(分。通達。任意の条件で使うときの値) */
export const OFF_SITE_BREAK_LIMIT_MIN = 3 * 60

/** 出庫か入庫の回送がこの分を超える勤務を、回送が長すぎる勤務として数える(片道) */
export const LONG_DEPOT_DEADHEAD_MIN = 60

/**
 * 利用者が足す営業所(2026-11-06 に種類を営業所1つにまとめた)。出庫・入庫と点呼の場所で、休憩施設もある。
 * 1つでも置くと、出庫・入庫の回送をその場所との間で数え、営業所から遠い停留所で長く待つすき間は営業所へ戻って休むとみなす
 */
export interface DutyPlace {
  name: string
  lat: number
  lon: number
}

/** 停留所の名前と座標(座標が読めなければ point は null) */
export interface StopPoint {
  name: string
  point: { lat: number; lon: number } | null
}

/** 勤務1つ */
export interface Duty {
  /** 拘束時間(分。点呼と出庫・入庫の回送を含む) */
  boundMin: number
  /** 運転時間(分。営業運行と回送) */
  drivingMin: number
  /** そのうち回送(分) */
  deadheadMin: number
  /** そのうち出庫の回送(営業所から最初の停留所。分) */
  pullOutMin: number
  /** そのうち入庫の回送(最後の停留所から営業所。分) */
  pullInMin: number
  /** 連続運転の最大(分) */
  maxContinuousMin: number
  trips: number
  /** 拘束の始まりと終わり('HH:MM'。24時を超える値は '25:10' のまま) */
  start: string
  end: string
  /** 最初の便の始発・最後の便の終着 */
  firstStopId: string
  firstStopName: string
  lastStopId: string
  lastStopName: string
  /** つないだ便(出発の順) */
  tripIds: string[]
  /** 入庫の回送と点呼まで含めて条件の中で終えられなかった勤務。便を足すのは条件を満たすときだけなので、いつも1便だけの勤務 */
  overLimit: boolean
}

export interface DutyEstimate {
  /** 勤務の数(下限の目安) */
  dutyCount: number
  /** 勤務(最初の便の出発の順) */
  duties: Duty[]
  /** 入庫の回送と点呼まで含めて条件の中で終えられなかった勤務の数 */
  overLimitDuties: number
  /** 出庫か入庫の回送が片道 LONG_DEPOT_DEADHEAD_MIN 分を超える勤務の数 */
  longDeadheadDuties: number
  /** 車両の数の下限の目安 */
  vehicles: {
    /** 法令の条件を外し、折り返しと回送だけでつないだ数 */
    chained: number
    /** 同時に営業運行中の便の最大 */
    maxConcurrent: number
  }
  /** 使った仮定(画面と変更指示書にそのまま出せる文) */
  assumptions: string[]
  /** 推定に使った値 */
  params: DutyParams
  /** 区間の stop_id のうち、座標が無いか stops.txt に無い停留所の数 */
  stopsWithoutPoint: number
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 停留所名を照らすための形(NFKC にして空白を除く。roundTrip.ts と同じ) */
function nameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '')
}

/** stops.txt の名前と座標(stop_id ごと。同じ stop_id の2行目以降は読まない) */
export function stopPointsOf(feed: GtfsFeed): Map<string, StopPoint> {
  const points = new Map<string, StopPoint>()
  for (const row of feed.tables.get('stops')?.rows ?? []) {
    const id = trimmed(row.stop_id)
    if (id === '' || points.has(id)) continue
    const latText = trimmed(row.stop_lat)
    const lonText = trimmed(row.stop_lon)
    const lat = Number(latText)
    const lon = Number(lonText)
    const ok =
      latText !== '' && lonText !== '' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    points.set(id, { name: trimmed(row.stop_name), point: ok ? { lat, lon } : null })
  }
  return points
}

/**
 * 入力の運用番号の数(参考)。trip_id がすべて `_` で5つに分かれ、4つ目がその便の service_id と同じ形
 * (docs/interfaces-1104.md §5.4。道北バスは `{運用}_{順番}_{01}_{service_id}_{始発の時刻}`)のときだけ、
 * その service の便の先頭の部分の種類の数を返す。形が違う便が1つでもあるか、その service の便が無ければ null。
 * 減便後の GTFS では運用番号の意味が保てないので、減便前の入力にだけ使う
 */
export function operatorRunsOf(feed: GtfsFeed, serviceId: string): number | null {
  const service = serviceId.trim()
  const runs = new Set<string>()
  let trips = 0
  for (const row of feed.tables.get('trips')?.rows ?? []) {
    if (trimmed(row.service_id) !== service) continue
    trips++
    const parts = trimmed(row.trip_id).split('_')
    if (parts.length !== 5 || parts[3] !== service || parts[0] === '') return null
    runs.add(parts[0])
  }
  return trips === 0 ? null : runs.size
}

interface Stop {
  id: string
  name: string
  key: string
  point: { lat: number; lon: number } | null
  /** 最寄りの営業所との回送(秒)。営業所が無いか座標が無ければ 0 */
  depotSec: number
  /** 待つ時間の上限なしに待てる停留所か(営業所の近く。営業所が無ければどこでも) */
  waitOk: boolean
  /** 営業所の近くか(事業場外の休憩の判定) */
  nearDepot: boolean
}

interface State {
  startSec: number
  firstDep: number
  lastArr: number
  firstStop: Stop
  lastStop: Stop
  /** 入庫の回送を除いた運転(秒) */
  driving: number
  deadhead: number
  /** 出庫の回送(秒) */
  pullOut: number
  /** 数え直してからの連続運転(秒) */
  continuous: number
  /** 数え直してからの休憩の合計(秒) */
  breakSum: number
  maxContinuous: number
  offSite: number
  tripIds: string[]
  overLimit: boolean
}

/** 営業所へ戻って休むときの回送(秒) */
interface Via {
  /** 前の便の終着から営業所 */
  to: number
  /** 営業所から次の便の始発 */
  from: number
}

interface ChainOptions {
  /** 法令の条件を確かめるか(false なら折り返しと回送だけ) */
  limits: boolean
}

/** 区間を勤務(または車両)につなぐ */
class Chainer {
  private readonly stops = new Map<string, Stop>()
  private readonly turnSec: number
  private readonly sameStopM: number
  private readonly metersPerSec: number
  /** 出庫・入庫と、長いすき間に休む場所(営業所) */
  private readonly depots: readonly DutyPlace[]
  /** 停留所の組ごとの、営業所へ戻って休むときの回送(viaDepot) */
  private readonly viaCache = new Map<string, Via | null>()
  private readonly stopPoints: ReadonlyMap<string, StopPoint>
  private readonly p: DutyParams
  stopsWithoutPoint = 0

  constructor(stopPoints: ReadonlyMap<string, StopPoint>, p: DutyParams, places: readonly DutyPlace[]) {
    this.stopPoints = stopPoints
    this.p = p
    this.turnSec = p.turnaroundMin * 60
    this.sameStopM = p.sameStopM
    this.metersPerSec = (p.deadheadKmh * 1000) / 3600
    this.depots = places
  }

  stop(id: string): Stop {
    const cached = this.stops.get(id)
    if (cached) return cached
    const sp = this.stopPoints.get(id)
    const point = sp?.point ?? null
    if (!point) this.stopsWithoutPoint++
    const near = (list: readonly DutyPlace[]) => point !== null && list.some((x) => distanceM(point, x) <= this.p.placeRadiusM)
    let depotSec = 0
    if (point && this.depots.length > 0) {
      depotSec = Math.min(...this.depots.map((d) => this.deadheadSec(distanceM(point, d))))
    }
    const stop: Stop = {
      id,
      name: sp?.name ?? '',
      key: nameKey(sp?.name ?? ''),
      point,
      depotSec,
      waitOk: this.depots.length === 0 || near(this.depots),
      nearDepot: near(this.depots),
    }
    this.stops.set(id, stop)
    return stop
  }

  private deadheadSec(straightM: number): number {
    return Math.ceil((straightM * this.p.deadheadFactor) / this.metersPerSec)
  }

  /** 停留所の間の回送(秒)。同じ停留所なら 0、回送の時間を出せなければ null */
  between(a: Stop, b: Stop): number | null {
    if (a.id === b.id || (a.key !== '' && a.key === b.key)) return 0
    if (!a.point || !b.point) return null
    const d = distanceM(a.point, b.point)
    return d <= this.sameStopM ? 0 : this.deadheadSec(d)
  }

  /** 新しい勤務 */
  open(leg: TripLeg, opts: ChainOptions): State {
    const first = this.stop(leg.firstStopId)
    const last = this.stop(leg.lastStopId)
    const out = opts.limits ? first.depotSec : 0
    const run = leg.arr - leg.dep
    // 出庫の回送と便で連続運転の上限を超えるなら、最初の停留所に早めに着いて休む(休憩で連続運転を数え直す)
    const restFirst = out > 0 && out + run > this.p.maxContinuousMin * 60 && out <= this.p.maxContinuousMin * 60
    const state: State = {
      startSec: leg.dep - out - (opts.limits ? this.p.preCheckMin * 60 : 0) - (restFirst ? this.p.breakResetMin * 60 : 0),
      firstDep: leg.dep,
      lastArr: leg.arr,
      firstStop: first,
      lastStop: last,
      driving: out + run,
      deadhead: out,
      pullOut: out,
      continuous: restFirst ? run : out + run,
      breakSum: 0,
      maxContinuous: restFirst ? Math.max(out, run) : out + run,
      offSite: 0,
      tripIds: [leg.tripId],
      overLimit: false,
    }
    // 入庫を除いた条件を1便だけで超える便には、ほかの便を足さない。入庫まで含めた条件は勤務を終えるとき(finish)に確かめる
    if (opts.limits) state.overLimit = !this.running(state)
    return state
  }

  /** 勤務に便を足した状態。つなげなければ null */
  append(s: State, leg: TripLeg, opts: ChainOptions): State | null {
    const first = this.stop(leg.firstStopId)
    const dh = this.between(s.lastStop, first)
    if (dh === null) return null
    const gap = leg.dep - s.lastArr
    const last = this.stop(leg.lastStopId)
    if (!opts.limits) {
      if (gap < this.turnSec + dh) return null
      return { ...s, lastArr: leg.arr, lastStop: last, tripIds: [...s.tripIds, leg.tripId] }
    }
    // 1便だけで条件を超えた勤務には、ほかの便を足さない
    if (s.overLimit) return null
    const run = leg.arr - leg.dep
    const waitOk = s.lastStop.waitOk || first.waitOk
    const direct = gap < this.turnSec + dh ? null : this.waitThere(s, first, last, leg, gap, dh, run, waitOk)
    // 営業所へ戻って休むのは、営業所があり、前の便の終着も次の便の始発も営業所から遠いときだけ
    const depot = waitOk ? null : this.restAtDepot(s, first, last, leg, gap, run)
    if (direct && depot) return depot.continuous < direct.continuous ? depot : direct
    return direct ?? depot
  }

  /** すき間を停留所で待つ(別の停留所なら、すき間 → 回送 → 次の便) */
  private waitThere(s: State, first: Stop, last: Stop, leg: TripLeg, gap: number, dh: number, run: number, waitOk: boolean): State | null {
    const idle = gap - dh
    if (!waitOk && this.p.maxRemoteWaitMin !== null && idle > this.p.maxRemoteWaitMin * 60) return null
    let continuous = s.continuous
    let breakSum = s.breakSum
    let offSite = s.offSite
    if (idle >= this.p.minBreakMin * 60) {
      breakSum += idle
      if (!(s.lastStop.nearDepot || first.nearDepot)) offSite += idle
      if (breakSum >= this.p.breakResetMin * 60) {
        continuous = 0
        breakSum = 0
      }
    }
    continuous += dh + run
    const next: State = {
      ...s,
      lastArr: leg.arr,
      lastStop: last,
      driving: s.driving + dh + run,
      deadhead: s.deadhead + dh,
      continuous,
      breakSum,
      maxContinuous: Math.max(s.maxContinuous, continuous),
      offSite,
      tripIds: [...s.tripIds, leg.tripId],
    }
    return this.accepts(next) ? next : null
  }

  /** 営業所へ回送して休み、また回送して次の便に乗る。すき間から往復の回送を除いた残りが休憩の最小に満たなければ null */
  private restAtDepot(s: State, first: Stop, last: Stop, leg: TripLeg, gap: number, run: number): State | null {
    const via = this.viaDepot(s.lastStop, first)
    if (via === null) return null
    const idle = gap - via.to - via.from
    if (idle < Math.max(this.p.minBreakMin * 60, this.turnSec)) return null
    // 営業所に着くまでの連続運転
    const before = s.continuous + via.to
    if (before > this.p.maxContinuousMin * 60) return null
    let continuous = before
    let breakSum = s.breakSum + idle
    if (breakSum >= this.p.breakResetMin * 60) {
      continuous = 0
      breakSum = 0
    }
    continuous += via.from + run
    const next: State = {
      ...s,
      lastArr: leg.arr,
      lastStop: last,
      driving: s.driving + via.to + via.from + run,
      deadhead: s.deadhead + via.to + via.from,
      continuous,
      breakSum,
      maxContinuous: Math.max(s.maxContinuous, before, continuous),
      tripIds: [...s.tripIds, leg.tripId],
    }
    return this.accepts(next) ? next : null
  }

  /** 停留所 a から営業所へ回送し、営業所から停留所 b へ回送する時間。往復の合計が最も短い営業所。座標が無ければ null */
  private viaDepot(a: Stop, b: Stop): Via | null {
    const key = `${a.id}\u0000${b.id}`
    const cached = this.viaCache.get(key)
    if (cached !== undefined) return cached
    let best: Via | null = null
    if (a.point && b.point) {
      for (const d of this.depots) {
        const to = this.deadheadSec(distanceM(a.point, d))
        const from = this.deadheadSec(distanceM(d, b.point))
        if (!best || to + from < best.to + best.from || (to + from === best.to + best.from && to < best.to)) best = { to, from }
      }
    }
    this.viaCache.set(key, best)
    return best
  }

  /**
   * 便を足した状態 next を受け入れるか。入庫の回送と点呼まで含めて条件を満たすときだけ受け入れる。足す前の勤務は満たして
   * いなくてもよい(営業所から遠い終点へ行った便の後に、営業所の近くへ戻る便をつなぐ)
   */
  private accepts(next: State): boolean {
    return this.withinLimits(next)
  }

  /** 入庫の回送を除いて(点呼は含めて)条件を満たすか。営業所が無ければ withinLimits と同じ */
  private running(s: State): boolean {
    return this.satisfies(s, 0)
  }

  /** この便で勤務を終えても(入庫の回送と点呼まで)条件を満たすか */
  private withinLimits(s: State): boolean {
    return this.satisfies(s, s.lastStop.depotSec)
  }

  private satisfies(s: State, back: number): boolean {
    const rest = this.restBeforeIn(s, back)
    if (rest === null) return false
    const end = s.lastArr + rest + back + this.p.postCheckMin * 60
    if (end - s.startSec > this.p.maxBoundMin * 60) return false
    if (s.driving + back > this.p.maxDrivingMin * 60) return false
    if (this.p.offSiteBreakMaxMin !== null && s.offSite + (s.lastStop.nearDepot ? 0 : rest) > this.p.offSiteBreakMaxMin * 60) return false
    return true
  }

  /**
   * 入庫の前に最後の停留所で休む時間(秒)。連続運転に入庫の回送を足して上限を超えるなら、休憩で数え直してから入庫する。
   * 休んでも入庫の回送だけで上限を超えるなら null
   */
  private restBeforeIn(s: State, back: number): number | null {
    const max = this.p.maxContinuousMin * 60
    if (s.continuous > max) return null
    if (s.continuous + back <= max) return 0
    return back <= max ? this.p.breakResetMin * 60 : null
  }

  /** 区間を出発の順につなぐ(入力の順にはよらない) */
  chain(legs: readonly TripLeg[], opts: ChainOptions): State[] {
    const sorted = [...legs].sort((a, b) => a.dep - b.dep || compareStrings(a.tripId, b.tripId))
    const states: State[] = []
    for (const leg of sorted) {
      let best: { at: number; state: State } | null = null
      for (let i = 0; i < states.length; i++) {
        const cur = states[i]
        // 到着が best 以下の勤務は選ばれない(到着が同じなら先に作った勤務を残す)
        if (best && cur.lastArr <= states[best.at].lastArr) continue
        const next = this.append(cur, leg, opts)
        if (next) best = { at: i, state: next }
      }
      if (best) states[best.at] = best.state
      else states.push(this.open(leg, opts))
    }
    return states
  }

  finish(s: State): Duty {
    const back = s.lastStop.depotSec
    const rest = this.restBeforeIn(s, back) ?? 0
    const end = s.lastArr + rest + back + this.p.postCheckMin * 60
    return {
      boundMin: Math.round((end - s.startSec) / 60),
      drivingMin: Math.round((s.driving + back) / 60),
      deadheadMin: Math.round((s.deadhead + back) / 60),
      pullOutMin: Math.round(s.pullOut / 60),
      pullInMin: Math.round(back / 60),
      maxContinuousMin: Math.round(Math.max(s.maxContinuous, rest > 0 ? back : s.continuous + back) / 60),
      trips: s.tripIds.length,
      start: clock(s.startSec),
      end: clock(end),
      firstStopId: s.firstStop.id,
      firstStopName: s.firstStop.name,
      lastStopId: s.lastStop.id,
      lastStopName: s.lastStop.name,
      tripIds: s.tripIds,
      overLimit: s.overLimit || !this.withinLimits(s),
    }
  }
}

/** 'HH:MM'。0時より前(前日)は 24 時間を足した時刻 */
function clock(sec: number): string {
  return formatClock(sec < 0 ? sec + 24 * 3600 : sec)
}

/** 同時に営業運行中の便の最大(到着と同じ時刻の出発は重ねない) */
function maxConcurrent(legs: readonly TripLeg[]): number {
  const events: [number, number][] = []
  for (const l of legs) {
    events.push([l.dep, 1], [l.arr, -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0
  let max = 0
  for (const [, d] of events) {
    now += d
    if (now > max) max = now
  }
  return max
}

function hoursText(min: number): string {
  return min % 60 === 0 ? `${min / 60} 時間` : `${Math.floor(min / 60)} 時間 ${min % 60} 分`
}

/** 使った仮定の文(画面と変更指示書にそのまま出す) */
export function dutyAssumptions(p: DutyParams, places: readonly DutyPlace[] = []): string[] {
  const offices = places.length
  const bound =
    p.maxBoundMin === BOUND_LIMIT_MIN.extended
      ? `拘束時間は ${hoursText(p.maxBoundMin)}以内(改善基準告示 第5条の延長の上限)`
      : p.maxBoundMin === BOUND_LIMIT_MIN.standard
        ? `拘束時間は ${hoursText(p.maxBoundMin)}以内(改善基準告示 第5条。延長の上限の 15 時間に切り替えられます)`
        : `拘束時間は ${hoursText(p.maxBoundMin)}以内(改善基準告示 第5条は原則 13 時間、最大 15 時間)`
  const lines = [
    '便を始発時刻の順に、つなげる勤務のうち最後の便の到着が最も遅い勤務へつなぎ、つなげなければ新しい勤務にします(block_id は使いません)',
    `出庫前の点呼 ${p.preCheckMin} 分と入庫後の点呼 ${p.postCheckMin} 分を拘束時間に入れます`,
    offices > 0
      ? `営業所(${offices} か所)と最初・最後の停留所の間の回送を、拘束時間と運転時間に入れます`
      : '営業所の位置がないため、出庫・入庫の回送は数えません',
    `同じ停留所(停留所名が同じか ${p.sameStopM}m 以内)での折り返しは ${p.turnaroundMin} 分以上とします`,
    `別の停留所へは、折り返し ${p.turnaroundMin} 分に回送(直線距離の ${p.deadheadFactor} 倍を時速 ${p.deadheadKmh}km)を足した時間が要るとします。回送は運転時間に入れます`,
    bound,
    `運転時間は ${hoursText(p.maxDrivingMin)}以内(改善基準告示 第5条の「2日平均で1日 9 時間以内」を、この日だけに当てはめた目安)`,
    `連続運転は ${hoursText(p.maxContinuousMin)}以内とし、${p.minBreakMin} 分以上のすき間を合わせて ${p.breakResetMin} 分になったら数え直します(改善基準告示 第5条)`,
    offices > 0
      ? p.maxRemoteWaitMin === null
        ? 'どの停留所でのすき間も休憩に数え、営業所から遠い停留所で待つ時間の上限は使いません'
        : `どの停留所でのすき間も休憩に数えます。ただし営業所の ${p.placeRadiusM}m 以内でない停留所で待つのは ${hoursText(p.maxRemoteWaitMin)}までとし、` +
          `それより長いすき間は、営業所へ回送して休み、また回送して次の便に乗るとみなします(往復の回送は運転時間に入れ、残りが ${p.minBreakMin} 分以上のときだけつなぎます)`
      : '営業所の位置がないため、どの停留所でのすき間も休憩に数えます',
  ]
  if (offices > 0) {
    lines.push(
      'その便で終えると入庫の回送で上限を超える勤務(営業所から遠い終点へ行く便)は、上限の中で入庫できる便までつなぎます。' +
        `出庫・入庫の回送と便を合わせて連続運転の上限を超えるときは、最初の停留所に早めに着くか、最後の停留所で ${p.breakResetMin} 分休んでから入庫するとみなします`,
    )
  }
  if (p.offSiteBreakMaxMin !== null) {
    lines.push(`営業所の外での休憩は、合わせて ${hoursText(p.offSiteBreakMaxMin)}以内とします`)
  }
  lines.push(
    '勤務の数は下限の目安です。実際の仕業・交番、休息期間、36協定、予備の要員、交代の場所は事業者が決めます',
  )
  return lines
}

/**
 * その日に要る勤務の数の下限の目安。legs は serviceHours.ts の tripLegs(feed, serviceIds).legs、stopPoints は stopPointsOf(feed)
 */
export function estimateDuties(
  legs: readonly TripLeg[],
  stopPoints: ReadonlyMap<string, StopPoint>,
  params: Partial<DutyParams> = {},
  places: readonly DutyPlace[] = [],
): DutyEstimate {
  const p: DutyParams = { ...DUTY_DEFAULTS, ...params }
  const chainer = new Chainer(stopPoints, p, places)
  const states = chainer.chain(legs, { limits: true })
  const duties = states.map((s) => chainer.finish(s))
  const vehicles = new Chainer(stopPoints, p, []).chain(legs, { limits: false }).length
  return {
    dutyCount: duties.length,
    duties,
    overLimitDuties: duties.filter((d) => d.overLimit).length,
    longDeadheadDuties: duties.filter((d) => Math.max(d.pullOutMin, d.pullInMin) > LONG_DEPOT_DEADHEAD_MIN).length,
    vehicles: { chained: vehicles, maxConcurrent: maxConcurrent(legs) },
    assumptions: dutyAssumptions(p, places),
    params: p,
    stopsWithoutPoint: chainer.stopsWithoutPoint,
  }
}
