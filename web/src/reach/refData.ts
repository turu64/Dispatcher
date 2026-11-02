/**
 * 参照データ(人口・人口集中地区・鉄道駅)の取得。
 *
 * 停留所の範囲(外接矩形)を最大の徒歩圏だけ広げた範囲に入る1次メッシュを求め、
 * サーバーの GET /api/ref/{mesh1} から並行で取る。1つでも取れなければ「参照データ無し」として扱う
 * (区分は fallbackClass、駅は無いものとして計算する。docs/interfaces-1103.md)。
 */
import { meshCode, meshCodesInBounds, type Bounds } from './mesh'
import { refDataFromJson, type RefData } from './reach'

/**
 * 緯度 1度の長さ(m)の下限より小さい値(reach.ts と同じ)。これで割れば、度に直した距離は実際より大きくなる
 * (範囲を広げすぎることはあっても、足りなくなることはない)。
 */
const MIN_M_PER_DEG_LAT = 110_500
/** 赤道での経度 1度の長さ(m)の下限より小さい値(reach.ts と同じ) */
const MIN_M_PER_DEG_LON_AT_EQUATOR = 111_300
/** 地域メッシュの範囲(緯度 0度以上 66.67度未満、経度 100度以上 200度未満) */
const MESH_SOUTH = 0
const MESH_NORTH = (100 * 640) / 960
const MESH_WEST = 100
const MESH_EAST = 200

/** 緯度経度が地域メッシュの範囲の中か。(0, 0) は範囲外。境界の扱いは mesh.ts の meshCode に任せる */
export function inMeshRange(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  try {
    meshCode(lat, lon, 4)
    return true
  } catch {
    return false
  }
}

/** 地域メッシュの範囲の中にある点の外接矩形。1つも無ければ null(範囲外の停留所は到達圏の計算でも除くので数えない) */
export function pointsBounds(points: readonly { lat: number; lon: number }[]): Bounds | null {
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  for (const p of points) {
    if (!inMeshRange(p.lat, p.lon)) continue
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
  }
  return south === Infinity ? null : { south, west, north, east }
}

/** 範囲を四方に radiusM(m)だけ広げる。地域メッシュの範囲で切る */
export function expandBounds(b: Bounds, radiusM: number): Bounds {
  if (!Number.isFinite(radiusM) || radiusM < 0) throw new RangeError(`広げる距離は 0 以上の数で指定してください:${radiusM}`)
  const dLat = radiusM / MIN_M_PER_DEG_LAT
  // 経度 1度は北ほど短いので、広げたあとの北端(南半球は考えない)の緯度の cos で割る
  const north = Math.min(Math.max(Math.abs(b.north), Math.abs(b.south)) + dLat, 89)
  const dLon = radiusM / (MIN_M_PER_DEG_LON_AT_EQUATOR * Math.cos((north * Math.PI) / 180))
  return {
    south: Math.max(MESH_SOUTH, b.south - dLat),
    west: Math.max(MESH_WEST, b.west - dLon),
    north: Math.min(MESH_NORTH, b.north + dLat),
    east: Math.min(MESH_EAST, b.east + dLon),
  }
}

/**
 * 読む参照データのファイル(1次メッシュ4桁)。停留所の外接矩形を radiusM(最大の徒歩圏)だけ広げた範囲に入るもの。
 * 範囲の中の停留所が無ければ空。
 */
export function refMeshesFor(stops: readonly { lat: number; lon: number }[], radiusM: number): string[] {
  const b = pointsBounds(stops)
  if (!b) return []
  return meshCodesInBounds(expandBounds(b, radiusM), 4)
}

/** 地図に出す駅(参照データの stations) */
export interface StationInfo {
  name: string
  /** 路線名(複数の路線にまたがる駅は「・」でつないだもの) */
  line: string
  lat: number
  lon: number
}

/** 参照データの取得の結果 */
export type RefLoadResult =
  | {
      ok: true
      /** 読んだ1次メッシュ */
      mesh1s: string[]
      ref: RefData
      stations: StationInfo[]
      /** 参照データの出典(ファイルの sources をまとめたもの。重複は除く) */
      sources: string[]
    }
  | {
      ok: false
      mesh1s: string[]
      /** 読めなかった1次メッシュ */
      missing: string[]
      /** 画面に出す理由 */
      message: string
    }

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** 取得した参照データの JSON の置き場所(1次メッシュ → JSON)。取れたものだけを入れる */
export type RefCache = Map<string, unknown>

const defaultCache: RefCache = new Map()

/** 1次メッシュ1つ分を取る。取れなければ理由(日本語)を投げる */
async function fetchOne(mesh1: string, fetchFn: FetchLike): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchFn(`/api/ref/${mesh1}`)
  } catch {
    throw new Error('サーバーにつながりません')
  }
  if (res.status === 404) throw new Error('サーバーにファイルがありません')
  if (!res.ok) throw new Error(`サーバーがエラーを返しました(${res.status})`)
  try {
    return await res.json()
  } catch {
    throw new Error('JSON として読めません')
  }
}

function stationsOf(json: unknown): StationInfo[] {
  const list = (json as { stations?: unknown }).stations
  if (!Array.isArray(list)) return []
  return list.map((s: Record<string, unknown>) => ({
    name: typeof s.name === 'string' ? s.name : '',
    line: typeof s.line === 'string' ? s.line : '',
    lat: s.lat as number,
    lon: s.lon as number,
  }))
}

function sourcesOf(json: unknown): string[] {
  const list = (json as { sources?: unknown }).sources
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
}

/**
 * 参照データを並行で取り、RefData にまとめる。
 * 1つでも取れない(404・通信の失敗・JSON の形の誤り)なら ok: false で、読めなかった1次メッシュを返す。
 * 取れた JSON は cache に入れ、次からはサーバーに問い合わせない(取れなかったものは入れないので、次の呼び出しで取り直す)。
 */
export async function fetchRefData(
  mesh1s: readonly string[],
  fetchFn: FetchLike = (url) => fetch(url),
  cache: RefCache = defaultCache,
): Promise<RefLoadResult> {
  const list = [...mesh1s]
  const settled = await Promise.allSettled(
    list.map(async (mesh1) => {
      if (cache.has(mesh1)) return cache.get(mesh1)
      const json = await fetchOne(mesh1, fetchFn)
      return json
    }),
  )

  const missing: string[] = []
  const reasons = new Set<string>()
  const jsons: unknown[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') jsons.push(s.value)
    else {
      missing.push(list[i])
      reasons.add(s.reason instanceof Error ? s.reason.message : String(s.reason))
    }
  })
  if (missing.length > 0) {
    return {
      ok: false,
      mesh1s: list,
      missing,
      message: `1次メッシュ ${missing.join('・')} の参照データを読み込めませんでした(${[...reasons].join('、')})。`,
    }
  }

  let ref: RefData
  try {
    ref = refDataFromJson(jsons)
  } catch (e) {
    return {
      ok: false,
      mesh1s: list,
      missing: list,
      message: `参照データの形が正しくありません。${e instanceof Error ? e.message : String(e)}`,
    }
  }
  // 形を確かめてから入れる(形の誤ったファイルを使い回さない)
  list.forEach((mesh1, i) => cache.set(mesh1, jsons[i]))
  const sources = [...new Set(jsons.flatMap(sourcesOf))]
  return { ok: true, mesh1s: list, ref, stations: jsons.flatMap(stationsOf), sources }
}
