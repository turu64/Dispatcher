/**
 * 到達圏の計算。125m の格子(8分の1地域メッシュ)のセルごとに、時間帯ごとに
 * 「その時間帯に出発がある停留所、または鉄道駅が、徒歩圏にあるか」を判定する。
 *
 * - 起点:渡された停留所(input.stops)をすべて起点とみなす。どの停留所を渡すか(stop_times に出てくる、
 *   location_type が 0 か空のもの)は呼び出し側が選ぶ。駅は起点にしない(到達できるかの判定にだけ使う)
 * - 調べるセル:起点の停留所から、バス停の距離(分 × 分速)以内に中心があるセル。参照データがあれば、距離は
 *   3区分のバス停の距離の最大(既定 15分 × 80m = 1,200m)で、そのうち親の 250m セルの人口が 1 人以上のものだけ。
 *   参照データが無ければ、fallbackClass のバス停の距離(既定の郊外なら 800m)
 * - 区分:DID(did125)の中は都市部。外なら、親の 250m セルの人口 ÷ 面積がしきい値以上で郊外、未満で中山間・地方。
 *   参照データが無ければ、すべて fallbackClass
 * - 到達できる見込みがある(coverable):区分のバス停の距離以内に起点の停留所がある(その日の出発の有無は問わない)か、
 *   区分の駅の距離以内に駅がある。見込みが無いセルは、ダイヤと関係なく外れる
 * - 到達できる:時間帯 b に出発がある(bandCounts[b] > 0)停留所が、セルの中心から区分のバス停の距離以内にある。
 *   または、駅が区分の駅の距離以内にある(駅は時刻表が無いので、すべての時間帯で使えるとみなす)。
 *   到達できるセルは、必ず到達できる見込みもある
 * - 距離は mesh.ts の distanceM(meshCenter(セル), 点) で判定し、ちょうどの距離は届くとする(cellsWithinRadius と同じ計算)
 *
 * 計算はコードで行う。結果の解釈と説明は画面や Claude の役目。
 */
import KDBush from 'kdbush'
import { cellAreaKm2, cellsWithinRadius, distanceM, meshCenter, meshCode, parentCode, type LatLon } from './mesh'

/** 都市部・郊外・中山間・地方 */
export type RegionClass = 'urban' | 'suburban' | 'rural'

const REGION_CLASSES: readonly RegionClass[] = ['urban', 'suburban', 'rural']

export interface ReachParams {
  /** 郊外と中山間・地方を分ける人口密度(人/km²)。既定 1000 */
  densityThreshold: number
  /** 区分ごとの徒歩の分数。既定は都市部 5/10、郊外 10/15、中山間・地方 15/20(バス停/鉄道駅) */
  walkMinutes: Record<RegionClass, { bus: number; rail: number }>
  /** 徒歩の分速(m/分)。既定 80 */
  speedMPerMin: number
}

/** CLAUDE.md の「到達圏の計算条件」の既定値 */
export const DEFAULT_REACH_PARAMS: ReachParams = {
  densityThreshold: 1000,
  walkMinutes: {
    urban: { bus: 5, rail: 10 },
    suburban: { bus: 10, rail: 15 },
    rural: { bus: 15, rail: 20 },
  },
  speedMPerMin: 80,
}

/** 参照データ(data/out/ref/*.json をまとめたもの) */
export interface RefData {
  /** 4分の1地域メッシュ(10 桁)ごとの人口。入っていないセルは 0 人 */
  pop250: Map<string, number>
  /** 中心が人口集中地区の中にある 8分の1地域メッシュ(11 桁) */
  did125: Set<string>
  /** 鉄道駅の代表点 */
  stations: LatLon[]
}

export interface ReachInput {
  /**
   * 起点の停留所(呼び出し側が選んだもの。すべて起点とみなす)。
   * bandCounts は時間帯ごとの出発の数(足りない時間帯は 0 とみなす)
   */
  stops: { lat: number; lon: number; bandCounts: number[] }[]
  /** 参照データ。無ければ null(すべてのセルを fallbackClass にし、駅は無いものとする) */
  ref: RefData | null
  /** 参照データが無いときに全セルへ当てる区分(既定 'suburban') */
  fallbackClass: RegionClass
  params: ReachParams
  /** 時間帯の数(3時間ごとなら 6、1時間ごとなら 18) */
  bandCount: number
}

export interface ReachResult {
  /** 調べたセル(11 桁)。南の行から北へ、各行は西から東の順 */
  cells: string[]
  /** セルごとの区分(cells と同じ並び) */
  classes: RegionClass[]
  /** [時間帯][セル] */
  reachable: boolean[][]
  /**
   * セルごとの、到達できる見込みがあるか(cells と同じ並び)。区分のバス停の距離以内に起点の停留所がある
   * (出発の有無は問わない)か、区分の駅の距離以内に駅があれば true。false のセルはダイヤと関係なく外れる
   */
  coverable: boolean[]
  /** 参照データが無く、fallbackClass で計算したら true */
  usedFallback: boolean
  /** 緯度経度が地域メッシュの範囲外((0, 0) を含む)で、計算から除いた停留所の数 */
  excludedStops: number
  /** セルごとの推計人口(親の 250m セルの人口 ÷ 4)。参照データが無ければ 0 */
  cellPopulation: number[]
}

const RAD = Math.PI / 180
/**
 * 緯度 1度の長さ(m)の下限より小さい値。GRS80 の子午線曲率半径は赤道の a(1−e²) = 6,335,439m が最小で、
 * 1度あたり 110,574m。これで割れば、度に直した半径は実際より大きく(候補の箱は広く)なる。
 */
const MIN_M_PER_DEG_LAT = 110_500
/** 赤道での経度 1度の長さ(m)の下限より小さい値。卯酉線曲率半径は a = 6,378,137m 以上で、1度あたり 111,319m 以上 */
const MIN_M_PER_DEG_LON_AT_EQUATOR = 111_300
/** 候補の箱に持たせる余裕(1%) */
const BOX_MARGIN = 1.01

/** 停留所・駅が地域メッシュの範囲(緯度 0〜66.67度、経度 100〜200度)の中にあるか。(0, 0) は範囲外 */
function inMeshRange(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  try {
    // 境界の扱い(浮動小数の誤差の吸収)を mesh.ts とそろえるため、範囲の判定は meshCode に任せる
    meshCode(lat, lon, 4)
    return true
  } catch {
    return false
  }
}

function checkNonNegative(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}は 0 以上の数で指定してください:${String(value)}`)
  }
}

const CLASS_LABEL: Record<RegionClass, string> = { urban: '都市部', suburban: '郊外', rural: '中山間・地方' }

/**
 * 参照データの形を確かめる。null(と、型を外れた undefined)は「参照データが無い」とみなす。
 * JSON のまま(pop250 が Map でないなど)渡すと、計算の途中で英語のエラーになるので、ここで日本語のエラーにする。
 */
function checkRef(ref: unknown): void {
  if (ref === null || ref === undefined) return
  const { pop250, did125, stations } = (typeof ref === 'object' ? ref : {}) as Record<string, unknown>
  if (!(pop250 instanceof Map) || !(did125 instanceof Set) || !Array.isArray(stations)) {
    throw new TypeError(
      '参照データの形が正しくありません(pop250 は Map、did125 は Set、stations は配列にします。JSON は refDataFromJson でまとめてから渡してください)',
    )
  }
}

function checkInput(input: ReachInput): void {
  const { params, bandCount, fallbackClass } = input
  checkRef(input.ref)
  if (!Number.isInteger(bandCount) || bandCount < 0) {
    throw new RangeError(`時間帯の数は 0 以上の整数で指定してください:${String(bandCount)}`)
  }
  if (!REGION_CLASSES.includes(fallbackClass)) {
    throw new RangeError(`参照データが無いときの区分が正しくありません:${String(fallbackClass)}`)
  }
  checkNonNegative(params.densityThreshold, '人口密度のしきい値')
  if (typeof params.speedMPerMin !== 'number' || !Number.isFinite(params.speedMPerMin) || params.speedMPerMin <= 0) {
    throw new RangeError(`徒歩の分速は 0 より大きい数で指定してください:${String(params.speedMPerMin)}`)
  }
  for (const c of REGION_CLASSES) {
    const minutes = params.walkMinutes?.[c]
    if (!minutes) throw new RangeError(`${CLASS_LABEL[c]}の徒歩の分数がありません`)
    checkNonNegative(minutes.bus, `${CLASS_LABEL[c]}のバス停までの徒歩の分数`)
    checkNonNegative(minutes.rail, `${CLASS_LABEL[c]}の鉄道駅までの徒歩の分数`)
  }
}

/**
 * 点(x = 経度、y = 緯度)の索引。kdbush は平面の距離で探すので、緯度・経度の箱で候補を取るだけに使い、
 * 最後は distanceM で判定する。点が 0 個なら null(kdbush は 0 個の索引も作れるが、探す必要が無い)。
 */
function buildIndex(points: LatLon[]): KDBush | null {
  if (points.length === 0) return null
  const index = new KDBush(points.length)
  for (const p of points) index.add(p.lon, p.lat)
  return index.finish()
}

/** center から radiusM 以内の点を取りこぼさない、緯度・経度の箱の候補(索引の番号) */
function candidates(index: KDBush, center: LatLon, radiusM: number): number[] {
  const dLat = (radiusM / MIN_M_PER_DEG_LAT) * BOX_MARGIN
  // distanceM は2点の平均緯度の cos を使う。点がセルより北にあるほど経度 1度が短くなるので、箱の北端の緯度の cos で割る
  const north = Math.min(Math.abs(center.lat) + dLat, 89)
  const dLon = (radiusM / (MIN_M_PER_DEG_LON_AT_EQUATOR * Math.cos(north * RAD))) * BOX_MARGIN
  return index.range(center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat)
}

/**
 * 到達圏を計算する。
 * 停留所のうち、緯度経度が地域メッシュの範囲外のもの((0, 0) を含む)は除き、数を excludedStops に入れる。
 * 出発が1本も無い停留所も起点にする(減便で便が無くなった停留所のまわりは「到達できない」と出て、coverable は true)。
 */
export function computeReach(input: ReachInput): ReachResult {
  checkInput(input)
  const { params, bandCount, fallbackClass } = input
  // 型を外れた undefined も null と同じ「参照データが無い」にそろえる(区分と usedFallback が食い違わないように)
  const ref = input.ref ?? null

  // 1. 停留所を選り分ける
  const stops: { lat: number; lon: number; bandCounts: number[] }[] = []
  let excludedStops = 0
  for (const s of input.stops) {
    if (inMeshRange(s.lat, s.lon)) stops.push(s)
    else excludedStops++
  }
  // 参照データの駅は refDataFromJson で範囲を確かめているが、手で作った RefData にも備えて範囲外は使わない
  const stations = (ref?.stations ?? []).filter((p) => inMeshRange(p.lat, p.lon))

  // 2. 調べるセル。起点は停留所だけ(駅のまわりだけのセルは調べない)。
  // 参照データがあれば区分はセルごとに違うので、3区分のバス停の距離の最大で集める。無ければ fallbackClass のバス停の距離
  const radius = {} as Record<RegionClass, { bus: number; rail: number }>
  let maxBusRadius = 0
  for (const c of REGION_CLASSES) {
    const m = params.walkMinutes[c]
    radius[c] = { bus: m.bus * params.speedMPerMin, rail: m.rail * params.speedMPerMin }
    maxBusRadius = Math.max(maxBusRadius, radius[c].bus)
  }
  const seedRadius = ref ? maxBusRadius : radius[fallbackClass].bus
  const stopPoints: LatLon[] = stops.map((s) => ({ lat: s.lat, lon: s.lon }))
  const candidateCells = cellsWithinRadius(stopPoints, seedRadius)

  // 3. セルの区分と推計人口。人口密度による区分は親の 250m セルで決まるので、親ごとに1回だけ計算する
  const cells: string[] = []
  const classes: RegionClass[] = []
  const cellPopulation: number[] = []
  if (ref) {
    const classOfParent = new Map<string, RegionClass>()
    for (const cell of candidateCells) {
      const parent = parentCode(cell, 10)
      const pop = ref.pop250.get(parent) ?? 0
      if (!(pop >= 1)) continue
      let densityClass = classOfParent.get(parent)
      if (densityClass === undefined) {
        densityClass = pop / cellAreaKm2(parent) >= params.densityThreshold ? 'suburban' : 'rural'
        classOfParent.set(parent, densityClass)
      }
      cells.push(cell)
      classes.push(ref.did125.has(cell) ? 'urban' : densityClass)
      cellPopulation.push(pop / 4)
    }
  } else {
    for (const cell of candidateCells) {
      cells.push(cell)
      classes.push(fallbackClass)
      cellPopulation.push(0)
    }
  }

  // 4. 停留所ごとの「出発がある時間帯」を 32 時間帯ずつのビットにする。
  // 出発が1本も無い停留所も、到達できる見込み(coverable)の判定に使うので索引に入れる(ビットはすべて 0)
  const words = Math.max(1, Math.ceil(bandCount / 32))
  const stopMasks = new Uint32Array(stops.length * words)
  stops.forEach((s, k) => {
    for (let b = 0; b < bandCount; b++) {
      if (s.bandCounts[b] > 0) stopMasks[k * words + (b >>> 5)] |= 1 << (b & 31)
    }
  })
  const full = new Uint32Array(words)
  for (let b = 0; b < bandCount; b++) full[b >>> 5] |= 1 << (b & 31)
  const stopIndex = buildIndex(stopPoints)
  const stationIndex = buildIndex(stations)

  // 5. セルごとに判定する
  const reachable: boolean[][] = Array.from({ length: bandCount }, () => new Array<boolean>(cells.length).fill(false))
  const coverable = new Array<boolean>(cells.length).fill(false)
  const acc = new Uint32Array(words)
  for (let i = 0; i < cells.length; i++) {
    const center = meshCenter(cells[i])
    const r = radius[classes[i]]

    // 駅が徒歩圏にあれば、すべての時間帯で到達できる
    if (stationIndex && reachesAny(stationIndex, stations, center, r.rail)) {
      coverable[i] = true
      for (let b = 0; b < bandCount; b++) reachable[b][i] = true
      continue
    }
    if (!stopIndex) continue

    acc.fill(0)
    for (const k of candidates(stopIndex, center, r.bus)) {
      if (distanceM(center, stopPoints[k]) > r.bus) continue
      // 出発の有無を問わず、区分のバス停の距離以内に起点の停留所があれば、到達できる見込みがある
      coverable[i] = true
      let done = true
      for (let w = 0; w < words; w++) {
        acc[w] |= stopMasks[k * words + w]
        if (acc[w] !== full[w]) done = false
      }
      // すべての時間帯で届いたら、残りの候補は見なくてよい(coverable はもう true)
      if (done) break
    }
    for (let b = 0; b < bandCount; b++) {
      if ((acc[b >>> 5] >>> (b & 31)) & 1) reachable[b][i] = true
    }
  }

  return { cells, classes, reachable, coverable, usedFallback: ref === null, excludedStops, cellPopulation }
}

/** 索引の点のどれかが、center から radiusM 以内にあるか */
function reachesAny(index: KDBush, points: LatLon[], center: LatLon, radiusM: number): boolean {
  for (const k of candidates(index, center, radiusM)) {
    if (distanceM(center, points[k]) <= radiusM) return true
  }
  return false
}

// ---- 参照データの JSON の読み込み ----

const POP_CODE = /^\d{10}$/
const DID_CODE = /^\d{11}$/
const MESH1_CODE = /^\d{4}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 参照データの JSON(data/out/ref/{1次メッシュ}.json を JSON.parse したもの)を、まとめて RefData にする。
 * 複数のファイルの pop250・did125・stations を1つにまとめる。mesh1・sources は使わない。
 * 形が違えば、どのファイルのどの値かを書いた日本語のエラーにする。
 * 1つも無ければ空の RefData を返す(参照データが1つも無いときは、呼び出し側が computeReach に null を渡す)。
 */
export function refDataFromJson(jsons: unknown[]): RefData {
  if (!Array.isArray(jsons)) throw new TypeError('参照データは配列で渡してください')
  const pop250 = new Map<string, number>()
  const did125 = new Set<string>()
  const stations: LatLon[] = []

  jsons.forEach((json, i) => {
    const mesh1 = isObject(json) && typeof json.mesh1 === 'string' && MESH1_CODE.test(json.mesh1) ? json.mesh1 : null
    const label = mesh1 ? `参照データ(${mesh1})` : `参照データ(${i + 1} 件目)`
    if (!isObject(json)) throw new TypeError(`${label}がオブジェクトではありません`)

    const pop = json.pop250
    if (!isObject(pop)) throw new TypeError(`${label}の pop250 がオブジェクトではありません`)
    for (const [code, value] of Object.entries(pop)) {
      if (!POP_CODE.test(code)) throw new TypeError(`${label}の pop250 に 10 桁の地域メッシュコードでないキーがあります:${code}`)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label}の pop250 の ${code} の人口が 0 以上の数ではありません:${String(value)}`)
      }
      pop250.set(code, value)
    }

    const did = json.did125
    if (!Array.isArray(did)) throw new TypeError(`${label}の did125 が配列ではありません`)
    for (const code of did) {
      if (typeof code !== 'string' || !DID_CODE.test(code)) {
        throw new TypeError(`${label}の did125 に 11 桁の地域メッシュコードでない値があります:${String(code)}`)
      }
      did125.add(code)
    }

    const list = json.stations
    if (!Array.isArray(list)) throw new TypeError(`${label}の stations が配列ではありません`)
    list.forEach((station, k) => {
      const which = isObject(station) && typeof station.name === 'string' ? `「${station.name}」` : ` ${k + 1} 番目`
      if (!isObject(station)) throw new TypeError(`${label}の stations の${which}がオブジェクトではありません`)
      const { lat, lon } = station
      if (typeof lat !== 'number' || typeof lon !== 'number' || !inMeshRange(lat, lon)) {
        throw new TypeError(
          `${label}の stations の${which}の緯度経度が、地域メッシュの範囲の数ではありません:${String(lat)}, ${String(lon)}`,
        )
      }
      stations.push({ lat, lon })
    })
  })

  return { pop250, did125, stations }
}
