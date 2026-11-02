import type { GtfsFeed } from './load'

/** stops.txt の1行を、数値に変換して扱いやすくしたもの */
export interface Stop {
  /** 前後の空白を取った stop_id(照合に使うキー) */
  id: string
  /** stop_name。表示用なので元のまま(空なら '') */
  name: string
  lat: number
  lon: number
  /** location_type。空なら 0 */
  locationType: number
  /** 前後の空白を取った parent_station(空なら '') */
  parentStation: string
}

// 10進の小数だけを通す。Number() に任せると、''・'  ' が 0、'0x10' が 16、'1e2' が 100 になってしまう
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/
const NON_NEGATIVE_INTEGER = /^\d+$/

/** 緯度経度の値を数にする。数でない・範囲外なら null */
function parseCoordinate(raw: string | undefined, limit: number): number | null {
  const s = raw?.trim() ?? ''
  if (!DECIMAL.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null
}

/** location_type を数にする。空は 0。数でない値も 0 とする(形式の誤りは検証器が報告する) */
function parseLocationType(raw: string | undefined): number {
  const s = raw?.trim() ?? ''
  return NON_NEGATIVE_INTEGER.test(s) ? Number(s) : 0
}

/**
 * stops.txt を、停留所の一覧にする。
 * stop_lat・stop_lon が数でない(空を含む)行、または緯度が ±90、経度が ±180 の範囲外の行は
 * 一覧に入れず、その数を invalid として返す。stop_id が空の行は除かない(id は '' になる。指摘は検証器の役目)。
 * stops.txt が無いフィードは、停留所 0 件として返す(必須ファイルの有無は検証器が確かめる)。
 * 同じ stop_id の行が複数あっても、そのまま全部返す(重複の指摘は検証器の役目)。
 */
export function toStops(feed: GtfsFeed): { stops: Stop[]; invalid: number } {
  const stops: Stop[] = []
  let invalid = 0
  for (const row of feed.tables.get('stops')?.rows ?? []) {
    const id = row.stop_id?.trim() ?? ''
    const lat = parseCoordinate(row.stop_lat, 90)
    const lon = parseCoordinate(row.stop_lon, 180)
    if (lat === null || lon === null) {
      invalid++
      continue
    }
    stops.push({
      id,
      name: row.stop_name ?? '',
      lat,
      lon,
      locationType: parseLocationType(row.location_type),
      parentStation: row.parent_station?.trim() ?? '',
    })
  }
  return { stops, invalid }
}
