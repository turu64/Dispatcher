/**
 * 周辺の施設の調査の対象になる施設・事業者の参照データ(国土数値情報の学校 P29・医療機関 P04・バス停留所 P11 の事業者)。
 *
 * - サーバーの GET /api/ref/facilities/{mesh1}(data/ の facilities.py が書き出す1次メッシュごとの JSON)から読む
 * - 範囲は、停留所の分布の外接矩形に 2km を足したもの(docs/tasks-1103.md の T06 の決定。凸包より簡単で、対象の数は上限で抑える)
 * - 事業者(P11)は、停留所のある1次メッシュすべてのファイルに同じ target_id で入る。ここで1つにまとめる
 *   (位置は最初のファイルの停留所の重心、範囲(bbox)は全部の和)
 * - 既定で選ぶ対象は、重要拠点の優先順位の高い種類から1件ずつ巡回して取り(最後に周辺の事業者)、上限まで(defaultSelection)。
 *   並びは決まった順(同じ参照データ・停留所・優先順位なら、いつも同じ対象を選ぶ。デモ用の結果を作るときと見る人の選び方をそろえるため)
 *
 * 施設の名前・位置はブラウザで表示と選択に使うだけ。サーバーに送るのは target_id だけ(名前と位置はサーバーが自分のデータで入れる)
 */
import { distanceM, type Bounds } from '@/reach/mesh'
import { mergeBusstopFiles, type OperatorOverlap, type OtherStop } from './busstops'
import { expandBounds, pointsBounds, refMeshesFor } from '@/reach/refData'
import { priorityCategory, type PriorityKey } from '@/store/priority'

/** 停留所の外接矩形に足す余白(m) */
export const FACILITY_MARGIN_M = 2000

/** 1回の調査の対象(周辺のバス事業者を除く)の上限(サーバーの DISPATCHER_RESEARCH_MAX_TARGETS の既定と同じ。サーバーが返す値があればそちらを使う) */
export const DEFAULT_MAX_TARGETS = 30

export type FacilityKind = 'operator' | 'school' | 'hospital' | 'clinic'

export const FACILITY_KIND_LABELS: Record<FacilityKind, string> = {
  operator: 'バス事業者',
  school: '学校',
  hospital: '病院',
  clinic: '診療所',
}

export interface Facility {
  targetId: string
  kind: FacilityKind
  name: string
  municipality: string | null
  lat: number
  lon: number
  /** 学校の種別(高等学校・大学など) */
  schoolType?: string
  /** 学校の休校区分(開校中・休校中・不明・調査なし) */
  openStatus?: string
  /** 病院・診療所の病床数 */
  beds?: number
  /** 救急告示病院か */
  emergency?: boolean
  /** 事業者の停留所の範囲(全部の1次メッシュの和) */
  operatorBounds?: Bounds
  /** 事業者の停留所の数(北海道全体) */
  operatorStops?: number
}

const TARGET_ID = /^P(?:29|04|11):\P{Cc}{1,200}$/u
const KINDS: readonly string[] = ['operator', 'school', 'hospital', 'clinic']

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** facilities.py の detail.bbox([南, 西, 北, 東])を Bounds にする */
function bboxOf(v: unknown): Bounds | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined
  const [south, west, north, east] = v.map(finite)
  if (south === null || west === null || north === null || east === null || south > north || west > east) return undefined
  return { south, west, north, east }
}

/**
 * 周辺の施設の調査の対象外の学校(幼稚園・幼保連携型認定こども園・小学校・中学校・義務教育学校)。読み込みで外す
 * (2026-11-06 に利用者が決定。中等教育学校は高校の課程を含むので残す)。
 * 参照データの作り直し(data/src/dispatcher_data/facilities.py の EXCLUDED_SCHOOL_CODES)でも外しているが、作り直す前のデータでも外れるようにここでも外す
 */
export const EXCLUDED_SCHOOL_TYPES: ReadonlySet<string> = new Set(['幼稚園', '幼保連携型認定こども園', '小学校', '中学校', '義務教育学校'])

/**
 * 周辺の施設の調査の対象から一旦外す施設の種類。読み込みで外す(2026-11-07 に利用者の指示で診療所を外した。
 * 参照データには残っているので、戻すときはここから消し、重要拠点の優先順位(store/priority.ts)に戻す)
 */
export const EXCLUDED_KINDS: ReadonlySet<string> = new Set(['clinic'])

/** 施設の1件。形が合わなければ null(読み飛ばす)。調査の対象外の学校(EXCLUDED_SCHOOL_TYPES)と種類(EXCLUDED_KINDS)も null */
export function parseFacility(v: unknown): Facility | null {
  if (!isObj(v)) return null
  const { target_id: targetId, kind, name, municipality } = v
  const lat = finite(v.lat)
  const lon = finite(v.lon)
  if (typeof targetId !== 'string' || !TARGET_ID.test(targetId)) return null
  if (typeof kind !== 'string' || !KINDS.includes(kind) || EXCLUDED_KINDS.has(kind)) return null
  if (typeof name !== 'string' || name.trim() === '') return null
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const f: Facility = {
    targetId,
    kind: kind as FacilityKind,
    name: name.trim(),
    municipality: typeof municipality === 'string' && municipality !== '' ? municipality : null,
    lat,
    lon,
  }
  const detail = isObj(v.detail) ? v.detail : {}
  if (f.kind === 'school') {
    if (typeof detail.school_type === 'string') f.schoolType = detail.school_type
    if (f.schoolType && EXCLUDED_SCHOOL_TYPES.has(f.schoolType)) return null
    if (typeof detail.open_status === 'string') f.openStatus = detail.open_status
  } else if (f.kind === 'hospital' || f.kind === 'clinic') {
    const beds = finite(detail.beds)
    if (beds !== null) f.beds = beds
    if (detail.emergency === true) f.emergency = true
  } else {
    f.operatorBounds = bboxOf(detail.bbox)
    const stops = finite(detail.stops)
    if (stops !== null) f.operatorStops = stops
  }
  return f
}

function unionBounds(a: Bounds | undefined, b: Bounds | undefined): Bounds | undefined {
  if (!a) return b
  if (!b) return a
  return { south: Math.min(a.south, b.south), west: Math.min(a.west, b.west), north: Math.max(a.north, b.north), east: Math.max(a.east, b.east) }
}

/**
 * 1次メッシュのファイルの JSON を、target_id ごとに1件にまとめる。files は1次メッシュの順に並べて渡す
 * (事業者の位置は最初のファイルのもの。サーバーの research.py が先に読んだものを使うのと同じ考え方)
 */
export function mergeFacilityFiles(files: readonly unknown[]): { facilities: Facility[]; sources: string[]; skipped: number } {
  const byId = new Map<string, Facility>()
  const sources = new Set<string>()
  let skipped = 0
  for (const file of files) {
    if (!isObj(file)) continue
    if (Array.isArray(file.sources)) for (const s of file.sources) if (typeof s === 'string') sources.add(s)
    if (!Array.isArray(file.facilities)) continue
    for (const item of file.facilities) {
      const f = parseFacility(item)
      if (!f) {
        skipped++
        continue
      }
      const prev = byId.get(f.targetId)
      if (!prev) byId.set(f.targetId, f)
      else if (prev.kind === 'operator' && f.kind === 'operator') prev.operatorBounds = unionBounds(prev.operatorBounds, f.operatorBounds)
    }
  }
  return { facilities: [...byId.values()], sources: [...sources], skipped }
}

/** 停留所の外接矩形 +2km の範囲。範囲の中の停留所が無ければ null */
export function researchBounds(stops: readonly { lat: number; lon: number }[]): Bounds | null {
  const b = pointsBounds(stops)
  return b ? expandBounds(b, FACILITY_MARGIN_M) : null
}

/** 読む施設のファイル(1次メッシュ4桁)。停留所の外接矩形 +2km にかかるもの */
export function facilityMeshes(stops: readonly { lat: number; lon: number }[]): string[] {
  return refMeshesFor(stops, FACILITY_MARGIN_M)
}

function inBounds(b: Bounds, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west
}

/** 範囲の中の施設。事業者は停留所の範囲(bbox)が重なるもの(位置は停留所の重心なので、範囲の外になることがある) */
export function facilitiesInBounds(facilities: readonly Facility[], b: Bounds): Facility[] {
  return facilities.filter((f) => (f.kind === 'operator' && f.operatorBounds ? intersects(f.operatorBounds, b) : inBounds(b, f.lat, f.lon)))
}

// ---- 取得 ----

/** 施設の参照データの取得の結果 */
export type FacilityLoadResult =
  | {
      ok: true
      mesh1s: string[]
      facilities: Facility[]
      /** 出典(ファイルの sources をまとめたもの) */
      sources: string[]
      /** ファイルの無かった1次メッシュ(その範囲に施設が無いか、海など) */
      missing: string[]
      /**
       * 周辺の事業者の停留所(同じファイルの最上位の鍵 busstops。ref/busstops.ts)。
       * どのファイルにも busstops の鍵が無い(停留所を出す前の加工の)ときは null
       */
      busstops: OtherStop[] | null
    }
  | { ok: false; mesh1s: string[]; message: string }

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** 取得した JSON の置き場所(1次メッシュ → JSON。404 は null)。取れなかったものは入れない */
export type FacilityCache = Map<string, unknown>

const defaultCache: FacilityCache = new Map()

/**
 * 1次メッシュごとのファイルを並行で取り、まとめる。404 は「その1次メッシュに施設が無い」として扱う。
 * 通信の失敗・404 以外のエラー・JSON の誤りが1つでもあれば ok: false。全部が 404 でも ok: false(参照データを作っていない)
 */
export async function fetchFacilities(
  mesh1s: readonly string[],
  fetchFn: FetchLike = (url) => fetch(url),
  cache: FacilityCache = defaultCache,
): Promise<FacilityLoadResult> {
  const list = [...mesh1s].sort()
  if (list.length === 0) return { ok: false, mesh1s: list, message: '停留所の位置が読めないため、施設を探す範囲を決められません。' }
  const settled = await Promise.allSettled(
    list.map(async (mesh1) => {
      if (cache.has(mesh1)) return cache.get(mesh1)
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await fetchFn(`/api/ref/facilities/${mesh1}`)
      } catch {
        throw new Error('サーバーにつながりません')
      }
      if (res.status === 404) {
        cache.set(mesh1, null)
        return null
      }
      if (!res.ok) throw new Error(`サーバーがエラーを返しました(${res.status})`)
      let json: unknown
      try {
        json = await res.json()
      } catch {
        throw new Error('JSON として読めません')
      }
      if (!isObj(json) || !Array.isArray(json.facilities)) throw new Error('施設の一覧がありません')
      cache.set(mesh1, json)
      return json
    }),
  )
  const reasons = new Set<string>()
  const files: unknown[] = []
  const missing: string[] = []
  settled.forEach((s, i) => {
    if (s.status === 'rejected') reasons.add(s.reason instanceof Error ? s.reason.message : String(s.reason))
    else if (s.value === null) missing.push(list[i])
    else files.push(s.value)
  })
  if (reasons.size > 0) {
    return { ok: false, mesh1s: list, message: `施設の参照データを読み込めませんでした。${[...reasons].join('、')}。` }
  }
  if (files.length === 0) {
    return {
      ok: false,
      mesh1s: list,
      message: '停留所の周りの施設の参照データがありません。data/ の加工で data/out/ref/facilities を作ってください。',
    }
  }
  const { facilities, sources } = mergeFacilityFiles(files)
  const hasBusstops = files.some((f) => isObj(f) && Array.isArray(f.busstops))
  const busstops = hasBusstops ? mergeBusstopFiles(files).stops : null
  return { ok: true, mesh1s: list, facilities, sources, missing, busstops }
}

// ---- 重要拠点の種類と、既定の選び方 ----

const HIGH_SCHOOL_TYPES = new Set(['高等学校', '特別支援学校', '中等教育学校'])
const HIGHER_EDUCATION_TYPES = new Set(['大学', '短期大学', '高等専門学校', '専修学校', '各種学校'])

/**
 * 施設の重要拠点の種類。優先順位の種類に入らないもの(事業者、種別が分からない学校)は null
 * (事業者は別にまとめる。種別が分からない学校は手で選べるが、既定では選ばない)
 */
export function facilityCategory(f: Facility): PriorityKey | null {
  if (f.kind === 'hospital') return 'inpatient_hospital'
  if (f.kind === 'school' && f.schoolType) {
    if (HIGH_SCHOOL_TYPES.has(f.schoolType)) return 'high_school'
    if (HIGHER_EDUCATION_TYPES.has(f.schoolType)) return 'higher_education'
  }
  return null
}

/** 調査の対象の候補(一覧と地図に出す1件) */
export interface ResearchCandidate {
  facility: Facility
  category: PriorityKey | null
  /** いちばん近い停留所までの直線距離(m) */
  nearestStopM: number
  /** 読み込んだ GTFS の事業者(調べる意味が薄いので既定では選ばない) */
  ownOperator: boolean
  /** 休校中など(既定では選ばない) */
  closed: boolean
  /**
   * 周辺の事業者のとき、こちらの停留所との重なり(ref/busstops.ts の operatorOverlap)。
   * null は「近くに停留所なし」、undefined は停留所の参照データが無い(数えていない)か、事業者でない
   */
  overlap?: OperatorOverlap | null
}

/** 事業者名をそろえる(全角・半角、株式会社・(株)の書き方、空白の違いを除く) */
export function normalizeOperatorName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/株式会社|有限会社|\(株\)|\(有\)|㈱|㈲/g, '')
    .replace(/\s+/g, '')
}

/** 読み込んだ GTFS の事業者か(agency_name と名前をそろえて比べる。どちらかがもう一方を含めば同じとみなす) */
export function isOwnOperator(name: string, agencyNames: readonly string[]): boolean {
  const n = normalizeOperatorName(name)
  if (n === '') return false
  return agencyNames.some((a) => {
    const m = normalizeOperatorName(a)
    return m !== '' && (m === n || m.includes(n) || n.includes(m))
  })
}

const CLOSED_STATUSES = new Set(['休校中', '不明'])

function nearestDistance(f: Facility, stops: readonly { lat: number; lon: number }[]): number {
  let best = Infinity
  // 緯度の差だけで遠いと分かる停留所は、距離を計算しない
  const latLimit = (d: number) => d / 110_000
  for (const s of stops) {
    if (best !== Infinity && Math.abs(s.lat - f.lat) > latLimit(best)) continue
    const d = distanceM(f, s)
    if (d < best) best = d
  }
  return best
}

/**
 * 範囲(停留所の外接矩形 +2km)の中の候補。stops は到達圏の起点と同じ停留所(乗れる行のある停留所)を渡す。
 * 並びは target_id の順(表示の並べ替えは呼ぶ側)
 */
export function researchCandidates(
  facilities: readonly Facility[],
  stops: readonly { lat: number; lon: number }[],
  agencyNames: readonly string[],
): ResearchCandidate[] {
  const b = researchBounds(stops)
  if (!b) return []
  return facilitiesInBounds(facilities, b)
    .map((f) => ({
      facility: f,
      category: facilityCategory(f),
      nearestStopM: nearestDistance(f, stops),
      ownOperator: f.kind === 'operator' && isOwnOperator(f.name, agencyNames),
      closed: f.kind === 'school' && f.openStatus !== undefined && CLOSED_STATUSES.has(f.openStatus),
    }))
    .sort((a, b) => compareId(a, b))
}

function compareId(a: ResearchCandidate, b: ResearchCandidate): number {
  return a.facility.targetId < b.facility.targetId ? -1 : a.facility.targetId > b.facility.targetId ? 1 : 0
}

/**
 * 同じ種類の中の並び:いちばん近い停留所に近い順(入院設備のある病院も。2026-11-07 に利用者の指示で、病床の多い順をやめた)。
 * 同じなら target_id の順(決まった並びにする)
 */
export function compareWithinCategory(a: ResearchCandidate, b: ResearchCandidate): number {
  if (a.nearestStopM !== b.nearestStopM) return a.nearestStopM - b.nearestStopM
  return compareId(a, b)
}

/**
 * 周辺の事業者の並び:読み込んだ GTFS の事業者をいちばん上に置く(2026-11-07 に利用者の指示)。その後は、こちらの停留所との重なりのある事業者を先に、重なりの数(近くに他社の停留所がある、こちらの停留所の数)の
 * 多い順。同じなら他社の停留所の数の多い順、それも同じなら compareWithinCategory の順(決まった並びにする)。
 * 重なりを数えていない(overlap が undefined)事業者どうしは compareWithinCategory の順(停留所の参照データが無いときの今までの並び)
 */
export function compareOperators(a: ResearchCandidate, b: ResearchCandidate): number {
  const own = (c: ResearchCandidate) => c.overlap?.ownStopIds.length ?? 0
  const other = (c: ResearchCandidate) => c.overlap?.otherStops.length ?? 0
  return Number(b.ownOperator) - Number(a.ownOperator) || own(b) - own(a) || other(b) - other(a) || compareWithinCategory(a, b)
}

/**
 * 既定で選ぶ施設の、いちばん近い停留所までの距離の上限(m)。到達圏の既定でバス停の徒歩圏が最も広い中山間・地方の 15 分(1,200m)。
 * これより遠い施設はバスで行く見込みが薄いので、既定では選ばない(手では選べる)
 */
export const DEFAULT_SELECT_WALK_M = 1200

/**
 * 既定で選ぶ対象(target_id の並び)。周辺のバス事業者以外は、種類ごとの列を重要拠点の優先順位の順に並べ、
 * 列の先頭から1件ずつ順に取る巡回を、max 件になるまで繰り返す
 * (優先順位の高い種類ほど先に、多く選ばれる。病院の多い市街地で上限が病院だけで埋まらないようにするため)。
 * その後ろに、周辺のバス事業者を max とは別に、こちらの停留所の近くに停留所がある事業者(「近くに停留所なし」でないもの。
 * 読み込んだ GTFS の事業者を除く)をすべて、compareOperators の順に足す(2026-11-07 に利用者の指示)。
 * 種類の中は compareWithinCategory の順。休校中などの学校、優先順位の外の施設(種別が分からない学校)、
 * 停留所から DEFAULT_SELECT_WALK_M より遠い施設は選ばない
 */
export function defaultSelection(candidates: readonly ResearchCandidate[], order: readonly PriorityKey[], max: number): string[] {
  const queues: ResearchCandidate[][] = []
  for (const key of order) {
    const group = candidates.filter((c) => c.category === key && !c.closed && c.nearestStopM <= DEFAULT_SELECT_WALK_M).sort(compareWithinCategory)
    if (group.length > 0) queues.push(group)
  }
  const picked: string[] = []
  for (let round = 0; picked.length < max; round++) {
    let any = false
    for (const q of queues) {
      if (round >= q.length) continue
      any = true
      if (picked.length >= max) break
      picked.push(q[round].facility.targetId)
    }
    if (!any) break
  }
  const operators = candidates.filter((c) => c.facility.kind === 'operator' && !c.ownOperator && c.overlap !== null).sort(compareOperators)
  return [...picked, ...operators.map((c) => c.facility.targetId)]
}

/** 調べる対象の上限(maxTargets)に数える対象か(周辺のバス事業者は数えない) */
export function countsTowardLimit(c: Pick<ResearchCandidate, 'facility'>): boolean {
  return c.facility.kind !== 'operator'
}

/**
 * 周辺のバス事業者のまとまりで最初に出す件数。「近くに停留所なし」の事業者(並びの後ろにまとまる)は、選んだものと
 * 調べた結果のあるものを除いて「続きを表示」の後ろに回す
 */
export function operatorShownCount(items: readonly ResearchCandidate[], kept: ReadonlySet<string>): number {
  let last = -1
  items.forEach((c, i) => {
    if (c.overlap !== null || kept.has(c.facility.targetId)) last = i
  })
  return last + 1
}

// ---- 一覧のまとまり ----

export const OPERATOR_GROUP = '周辺のバス事業者'
export const OTHER_GROUP = 'そのほかの学校(優先順位の外。種別が分からないもの)'

/** 候補のまとまり(種類ごと) */
export interface CandidateGroup {
  key: string
  label: string
  items: ResearchCandidate[]
}

/** 候補を、周辺の事業者 → 優先順位の種類の順 → 優先順位の外、にまとめる。まとまりの中は既定の選び方と同じ並び */
export function groupCandidates(candidates: readonly ResearchCandidate[], order: readonly PriorityKey[]): CandidateGroup[] {
  const byNear = compareWithinCategory
  const groups: CandidateGroup[] = []
  const operators = candidates.filter((c) => c.facility.kind === 'operator').sort(compareOperators)
  if (operators.length > 0) groups.push({ key: 'operator', label: OPERATOR_GROUP, items: operators })
  for (const key of order) {
    const items = candidates.filter((c) => c.category === key).sort(byNear)
    if (items.length > 0) groups.push({ key, label: priorityCategory(key).label, items })
  }
  const others = candidates.filter((c) => c.facility.kind !== 'operator' && c.category === null).sort(byNear)
  if (others.length > 0) groups.push({ key: 'other', label: OTHER_GROUP, items: others })
  return groups
}

/** まとまりの中で、選んだ対象が無いときに最初に出す件数 */
export const GROUP_HEAD_COUNT = 5
/** まとまりの中で、選んだ対象のうち最後のものの後ろに出す件数 */
export const GROUP_TAIL_AFTER_SELECTED = 3

/**
 * まとまりの中で最初に出す件数(残りは「続きを表示」で開く)。選んだ対象のうち最後のものの後ろ3件まで。
 * 選んだ対象が無ければ最初の5件まで。まとまりの件数より多くはしない
 */
export function initialShownCount(items: readonly ResearchCandidate[], selected: ReadonlySet<string>): number {
  let last = -1
  items.forEach((c, i) => {
    if (selected.has(c.facility.targetId)) last = i
  })
  const n = last < 0 ? GROUP_HEAD_COUNT : last + 1 + GROUP_TAIL_AFTER_SELECTED
  return Math.min(n, items.length)
}

// ---- 周辺の事業者の減便の動き ----

/**
 * 減便の動きとして事業者の行に出す事実の見出し(調べた結果の label がこれを含むもの)。
 * 廃止・休止も入れる(周知文の代わりの便に、廃止された系統を案内しないよう、その事実を必ず見せるため。11/4 指示役)
 */
export const OPERATOR_MOVEMENT_LABEL = /減便|ダイヤ改正|運休|特別ダイヤ|廃止|休止/

/** 調べた事実のうち、減便・ダイヤ改正・運休・特別ダイヤ・廃止・休止のもの(並びはそのまま) */
export function operatorMovementFacts<T extends { label: string }>(facts: readonly T[]): T[] {
  return facts.filter((f) => OPERATOR_MOVEMENT_LABEL.test(f.label))
}
