/**
 * 地図の住所検索。OpenStreetMap の Nominatim(https://nominatim.openstreetmap.org)に、利用者が入れた文字だけを送る
 * (2026-11-06 に利用者が Nominatim を選んだ。送り先は運営情報のページに書く)。GTFS の中身は送らない。
 *
 * Nominatim の利用の決まり(https://operations.osmfoundation.org/policies/nominatim/)に合わせる:
 * - 1 秒に 1 回まで(前の問い合わせから 1 秒たっていなければ、待ってから送る)
 * - 入力の途中の自動の補完はしない(利用者が「検索」を押したときだけ送る)
 * - 結果には © OpenStreetMap contributors を出す(AddressSearch.tsx)
 * ブラウザから送るので、Referer が付く(User-Agent はブラウザが決める)
 */

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search'

/** 1 回の問い合わせの間隔の下限(ミリ秒)。Nominatim の決まり */
export const MIN_INTERVAL_MS = 1000

/** 送る文字の長さの上限(これより長い入力は送らない) */
export const MAX_QUERY_LENGTH = 100

/** 1 回に受け取る結果の数 */
export const RESULT_LIMIT = 5

/** 検索の結果 1 件 */
export interface GeocodeResult {
  /** 画面に出す名前(Nominatim の display_name を短くしたもの) */
  label: string
  lat: number
  lon: number
  /** [西, 南, 東, 北]。無ければ null */
  bbox: [number, number, number, number] | null
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeocodeError'
  }
}

interface NominatimItem {
  display_name?: unknown
  lat?: unknown
  lon?: unknown
  boundingbox?: unknown
}

let lastRequestAt = Number.NEGATIVE_INFINITY

/** テストで、前の問い合わせの時刻を忘れさせる */
export function resetGeocodeThrottle(): void {
  lastRequestAt = Number.NEGATIVE_INFINITY
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 「北海道, 日本」などの後ろの広い地名と郵便番号を落として、短い名前にする。
 * Nominatim の display_name は「宮下通八丁目, 宮下通, 神楽, 旭川市, 上川総合振興局, 北海道, 北海道地方, 070-0030, 日本」の形
 */
export function shortLabel(displayName: string): string {
  const parts = displayName
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '日本' && p !== '北海道地方' && !/^\d{3}-?\d{4}$/.test(p))
  return parts.slice(0, 5).join('、')
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** Nominatim の 1 件を、使う形にする。座標が読めなければ null */
export function parseItem(item: NominatimItem): GeocodeResult | null {
  const lat = toNumber(item.lat)
  const lon = toNumber(item.lon)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const name = typeof item.display_name === 'string' ? item.display_name : ''
  let bbox: GeocodeResult['bbox'] = null
  // boundingbox は [南, 北, 西, 東] の文字列
  if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
    const [s, n, w, e] = item.boundingbox.map(toNumber)
    if (s !== null && n !== null && w !== null && e !== null && s <= n && w <= e) bbox = [w, s, e, n]
  }
  return { label: shortLabel(name) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, bbox }
}

export interface GeocodeOptions {
  signal?: AbortSignal
  /** テストで差し替える */
  fetchImpl?: typeof fetch
  /** テストで差し替える(ミリ秒の時刻) */
  now?: () => number
}

/**
 * 住所・地名で検索する。日本の中だけ、日本語の名前で、最大 RESULT_LIMIT 件。
 * 空の入力は送らずに空の配列を返す。長すぎる入力・通信の失敗・形の合わない応答は GeocodeError
 */
export async function searchAddress(query: string, options: GeocodeOptions = {}): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (q === '') return []
  if (q.length > MAX_QUERY_LENGTH) throw new GeocodeError(`検索する文字は ${MAX_QUERY_LENGTH} 文字までにしてください。`)
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetchImpl ?? fetch

  const remaining = lastRequestAt + MIN_INTERVAL_MS - now()
  if (remaining > 0) await wait(remaining, options.signal)
  lastRequestAt = now()

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    countrycodes: 'jp',
    'accept-language': 'ja',
    limit: String(RESULT_LIMIT),
  })
  let res: Response
  try {
    res = await fetchImpl(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
      signal: options.signal,
      headers: { Accept: 'application/json' },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new GeocodeError('住所検索のサービスにつながりませんでした。ネットワークを確かめてください。')
  }
  if (res.status === 429) throw new GeocodeError('住所検索が混み合っています。少し待ってからもう一度押してください。')
  if (!res.ok) throw new GeocodeError(`住所検索に失敗しました(${res.status})。`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new GeocodeError('住所検索の結果を読めませんでした。')
  }
  if (!Array.isArray(body)) throw new GeocodeError('住所検索の結果を読めませんでした。')
  return body
    .map((item) => (item && typeof item === 'object' ? parseItem(item as NominatimItem) : null))
    .filter((r): r is GeocodeResult => r !== null)
}
