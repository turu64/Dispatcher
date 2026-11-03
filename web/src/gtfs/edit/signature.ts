import type { GtfsRow } from '../load'

/**
 * 便の署名(取り決め 1104 §5.1)。便どうしを比べる単位で、trip_id は比べない。
 *
 * `route_id + "\t" + 行ごとの "stop_id,arrival_time,departure_time" を ";" でつないだもの`。
 * 行は stop_sequence の数値の昇順(読めない値の行は入力の順で後ろ)。値は前後の空白を取る。
 * 時刻は文字列のまま比べる('7:05:00' と '07:05:00' は別の便になる)。
 * 乗降の区分・stop_headsign・trip_headsign は含めない。
 */

/** 文字列の並べ替え(UTF-16 のコード単位の順。localeCompare は使わない) */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

const NON_NEGATIVE_INTEGER = /^\d+$/

/** stop_sequence を、先頭の 0 を除いた10進の文字列にする。0 以上の10進の整数でなければ null */
function sequenceKey(row: GtfsRow): string | null {
  const s = trimmed(row.stop_sequence)
  if (!NON_NEGATIVE_INTEGER.test(s)) return null
  return s.replace(/^0+(?=\d)/, '')
}

/** 先頭の 0 が無い10進の文字列どうしを数として比べる(桁数が多いほど大きい) */
function compareSequence(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : compareStrings(a, b)
}

/**
 * 便の stop_times の行を、stop_sequence の数値の昇順に並べた新しい配列にする。
 * 読めない値の行は、入力の順のまま後ろに置く。同じ値の行は入力の順(安定な並べ替え)
 */
export function sortByStopSequence(rows: readonly GtfsRow[]): GtfsRow[] {
  const readable: { row: GtfsRow; key: string }[] = []
  const unreadable: GtfsRow[] = []
  for (const row of rows) {
    const key = sequenceKey(row)
    if (key === null) unreadable.push(row)
    else readable.push({ row, key })
  }
  readable.sort((a, b) => compareSequence(a.key, b.key))
  return [...readable.map((x) => x.row), ...unreadable]
}

/** 便の署名。rows はその便の stop_times の行(並びは問わない) */
export function tripSignature(routeId: string, rows: readonly GtfsRow[]): string {
  const parts = sortByStopSequence(rows).map(
    (r) => `${trimmed(r.stop_id)},${trimmed(r.arrival_time)},${trimmed(r.departure_time)}`,
  )
  return `${routeId.trim()}\t${parts.join(';')}`
}

/**
 * stop_times の行を便ごとにまとめる(キーは空白を取った trip_id、値は入力の順の行)。
 * 署名・前後の比較・検証で、stop_times を1回だけ見て使い回すため
 */
export function stopTimesByTrip(rows: readonly GtfsRow[]): Map<string, GtfsRow[]> {
  const groups = new Map<string, GtfsRow[]>()
  for (const row of rows) {
    const id = trimmed(row.trip_id)
    const list = groups.get(id)
    if (list) list.push(row)
    else groups.set(id, [row])
  }
  return groups
}

/**
 * 正解データの signatureDigest:署名を重複も含めて並べ替え、"\n" でつないだ UTF-8 の SHA-256(16進、末尾に改行を付けない)
 */
export async function signatureDigest(signatures: readonly string[]): Promise<string> {
  const text = [...signatures].sort(compareStrings).join('\n')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
