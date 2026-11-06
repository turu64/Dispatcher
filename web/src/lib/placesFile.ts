/**
 * 利用者が置く営業所(指摘 24、docs/tasks-1105.md の D05)の種類と、JSON の書き出し・読み込み。
 * 場所はメモリだけに持ち(store/drivers.ts)、サーバーにもブラウザの保存にも入れない。GTFS を読み込み直すと消えるので、
 * 残したいときは利用者がこの形の JSON に書き出し、次に読み込む。
 *
 * ファイルの形(版 1):
 *   { "format": "dispatcher-places", "version": 1, "places": [{ "type": "office", "name": "旭川営業所", "lat": 43.77, "lon": 142.36 }] }
 * 読み込みでは、形の合わないファイルは丸ごと断り、places の壊れた行(種類・名前・緯度経度が読めない、範囲の外)は読み飛ばして数える。
 *
 * 場所の種類は 2026-11-06 に「営業所」1つにまとめた(利用者の指示)。書き出すのは type 'office' だけ。前の版で書き出した
 * 'site'(営業所・車庫・休憩施設)・'garage'(車庫)・'rest'(休憩施設)の行も、捨てずに営業所として読み込む
 */

/** 場所の種類。営業所は出庫・入庫と点呼の場所で、休憩も取れる(休憩施設もある) */
export type PlaceType = 'office'

export const PLACE_TYPES: readonly PlaceType[] = ['office']

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
  office: '営業所',
}

/** 前の版の種類(読み込みでは営業所にする) */
const LEGACY_PLACE_TYPES: readonly string[] = ['site', 'garage', 'rest']

/** 場所1つ(書き出す値) */
export interface PlaceInput {
  type: PlaceType
  name: string
  lat: number
  lon: number
}

export const PLACES_FILE_FORMAT = 'dispatcher-places'
export const PLACES_FILE_VERSION = 1
/** 置ける場所の数の上限(読み込みでは、これを超えた分を読まない) */
export const MAX_PLACES = 50
/** 名前の長さの上限(文字) */
export const MAX_PLACE_NAME = 60
/** 読み込むファイルの大きさの上限(バイト) */
export const MAX_PLACES_FILE_BYTES = 1_000_000

/** 緯度経度を丸める桁(小数 6 桁で約 0.1m) */
const COORD_DIGITS = 6

export function roundCoord(value: number): number {
  const f = 10 ** COORD_DIGITS
  return Math.round(value * f) / f
}

/** 読み込む行の種類を、今の種類にする。読めない種類なら null */
function placeTypeOf(v: unknown): PlaceType | null {
  if (typeof v !== 'string') return null
  if ((PLACE_TYPES as readonly string[]).includes(v)) return v as PlaceType
  return LEGACY_PLACE_TYPES.includes(v) ? 'office' : null
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

/** 1行を場所にする。読めなければ null。前の版の種類(営業所・車庫・休憩施設、車庫、休憩施設)は営業所にする */
export function placeOf(raw: unknown): PlaceInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const type = placeTypeOf(r.type)
  if (type === null) return null
  const name = normalizePlaceName(r.name)
  if (name === null || !validCoords(r.lat, r.lon)) return null
  return { type, name, lat: roundCoord(r.lat as number), lon: roundCoord(r.lon as number) }
}

/** 場所の一覧を JSON の文字列にする(読み込みで同じ一覧に戻る) */
export function serializePlaces(places: readonly PlaceInput[]): string {
  const body = {
    format: PLACES_FILE_FORMAT,
    version: PLACES_FILE_VERSION,
    places: places.map((p) => ({ type: 'office', name: p.name, lat: roundCoord(p.lat), lon: roundCoord(p.lon) })),
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export type ParsePlacesResult =
  | {
      ok: true
      places: PlaceInput[]
      /** 読み飛ばした壊れた行の数 */
      skipped: number
      /** 上限(MAX_PLACES)を超えたため読まなかった行の数 */
      overLimit: number
    }
  | { ok: false; message: string }

/** JSON の文字列を読む。形が合わなければ理由を返し、壊れた行は読み飛ばして数える */
export function parsePlacesFile(text: string): ParsePlacesResult {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false, message: 'JSON として読めません。書き出した JSON のファイルを選んでください。' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || (data as Record<string, unknown>).format !== PLACES_FILE_FORMAT) {
    return { ok: false, message: '営業所の JSON ではありません。この画面で書き出した JSON を選んでください。' }
  }
  const body = data as Record<string, unknown>
  if (body.version !== PLACES_FILE_VERSION) {
    return { ok: false, message: `JSON の版(${String(body.version)})が違います。版 ${PLACES_FILE_VERSION} の JSON を選んでください。` }
  }
  if (!Array.isArray(body.places)) {
    return { ok: false, message: 'JSON に places の一覧がありません。この画面で書き出した JSON を選んでください。' }
  }
  const places: PlaceInput[] = []
  let skipped = 0
  let overLimit = 0
  for (const row of body.places) {
    const place = placeOf(row)
    if (!place) {
      skipped++
      continue
    }
    if (places.length >= MAX_PLACES) {
      overLimit++
      continue
    }
    places.push(place)
  }
  return { ok: true, places, skipped, overLimit }
}

/** 書き出すファイルの名前('dispatcher_places_202611051230.json') */
export function placesFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
  return `dispatcher_places_${stamp}.json`
}

/** 読み込んだ結果の文(画面の状態の行) */
export function importResultText(result: Extract<ParsePlacesResult, { ok: true }>): string {
  const parts = [`${result.places.length} か所を読み込みました。`]
  if (result.skipped > 0) parts.push(`読めない行 ${result.skipped} 行を読み飛ばしました。`)
  if (result.overLimit > 0) parts.push(`上限の ${MAX_PLACES} か所を超えた ${result.overLimit} 行は読み込んでいません。`)
  return parts.join('')
}
