/**
 * 利用者が置く営業所(指摘 24、docs/tasks-1105.md の D05)の種類と、名前・緯度経度の整え方。
 * 場所はメモリだけに持ち(store/drivers.ts)、サーバーにもブラウザの保存にも入れない。GTFS を読み込み直すと消える
 * (JSON の書き出し・読み込みは 2026-11-06 に利用者の指示でなくした)。
 *
 * 場所の種類は 2026-11-06 に「営業所」1つにまとめた(利用者の指示)
 */

/** 場所の種類。営業所は出庫・入庫と点呼の場所で、休憩も取れる(休憩施設もある) */
export type PlaceType = 'office'

export const PLACE_TYPES: readonly PlaceType[] = ['office']

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
  office: '営業所',
}

/** 場所1つ(置くときの値) */
export interface PlaceInput {
  type: PlaceType
  name: string
  lat: number
  lon: number
}

/** 置ける場所の数の上限 */
export const MAX_PLACES = 50
/** 名前の長さの上限(文字) */
export const MAX_PLACE_NAME = 60

/** 緯度経度を丸める桁(小数 6 桁で約 0.1m) */
const COORD_DIGITS = 6

export function roundCoord(value: number): number {
  const f = 10 ** COORD_DIGITS
  return Math.round(value * f) / f
}

/** 名前を整える(前後の空白を取り、続く空白を1つにする)。空か長すぎれば null */
export function normalizePlaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name === '' || [...name].length > MAX_PLACE_NAME) return null
  return name
}

/** 緯度経度が数で、範囲(緯度 ±90・経度 ±180)の中か */
export function validCoords(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}
