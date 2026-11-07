import type { ResearchResult } from '../claude/research'
import { facilityWindows, readLongBreaks, type FactLike } from '../gtfs/edit/facilityHours'
import type { FacilityResearchNote, HintFacility, RestoreHintContext } from '../gtfs/edit/restore'
import type { GtfsFeed } from '../gtfs/load'
import type { OriginStops } from '../reach/input'
import { cellAreaKm2, meshCode, parentCode } from '../reach/mesh'
import type { ReachParams, ReachResult, RefData, RegionClass } from '../reach/reach'
import { facilityCategory, HINT_EXCLUDED_SCHOOL_TYPES, type Facility } from '../ref/facilities'
import { priorityCategory, priorityRank, usePriorityStore, type PriorityKey } from './priority'
import type { EditedSource, ReachSnapshot, RefState } from './reach'
import { useResearchStore, type FacilityState } from './research'

/** buildRestoreHintContext が読む、到達圏の store の状態(useReachStore.getState() をそのまま渡せる) */
export interface ReachStateForHints {
  edited: EditedSource | null
  origins: OriginStops | null
  computing: boolean
  error: string | null
  snapshot: ReachSnapshot | null
  /**
   * 到達圏の参照データ(学校・病院の徒歩圏の区分に使う。T19)。渡さなければ、施設のあるセルの区分は到達圏の結果から取り、
   * 取れなければ区分のバス停の距離の最大を使う
   */
  ref?: RefState
}

/** 学校・病院の手がかり(T19)の材料。周辺の施設の調査の store と重要拠点の優先順位の store の今の状態 */
export interface FacilitySourceForHints {
  facilities: FacilityState
  results: ReadonlyMap<string, ResearchResult>
  order: readonly PriorityKey[]
}

/** 周辺の施設の調査の store と優先順位の store から、学校・病院の手がかりの材料を読む */
export function currentFacilitySource(): FacilitySourceForHints {
  const r = useResearchStore.getState()
  return { facilities: r.facilities, results: r.results, order: usePriorityStore.getState().order }
}

interface CacheEntry {
  origins: OriginStops
  facilities: FacilityState
  results: ReadonlyMap<string, ResearchResult>
  order: readonly PriorityKey[]
  ref: RefState | undefined
  ctx: RestoreHintContext
}

// 同じ結果からは同じ ctx を返す(足し戻しの手がかりは、外れたセルの索引と施設の索引を ctx ごとに覚えておくため)
const cache = new WeakMap<ReachSnapshot, CacheEntry>()

/**
 * 到達圏の store の状態から、足し戻しの手がかり(onlyServiceAtStop・restoresLostCells・nearFacility)の ctx を作る
 * (docs/interfaces-1105.md §7、docs/tasks-1103.md の T19)。ctx は、同じ日付・同じ条件の基準と編集後の結果
 * (同じ起点・同じセル・同じ時間帯)から作る。
 *
 * 前後の比較ができていなければ null を返す(画面とツールは、到達圏を使う2つの手がかりと学校・病院の手がかりを出さない)。null になるのは:
 * - 編集後の GTFS が無い、または結果に基準(baseline)と比較(comparison)が無い
 * - 計算中(条件か編集後の GTFS が変わり、出ている結果が古い)、または計算に失敗した(出ている結果が古い)
 * - editedFeed を渡したとき、到達圏の store の編集後のフィードがそれと違う(承認前の下書きの結果など)
 *
 * 足し戻しの候補を、ある編集後のフィード(承認済みの版など)から作るときは、そのフィードを editedFeed に渡す。
 * facilitySource は周辺の施設・調査の結果・重要拠点の優先順位(渡さなければ store の今の状態)。施設を読めていれば
 * ctx.facilities に学校・病院を入れる(hintFacilities)
 */
export function buildRestoreHintContext(
  state: ReachStateForHints,
  editedFeed?: GtfsFeed,
  facilitySource: FacilitySourceForHints = currentFacilitySource(),
): RestoreHintContext | null {
  const { edited, origins, snapshot } = state
  if (!edited || !origins || !snapshot || state.computing || state.error !== null) return null
  if (editedFeed !== undefined && edited.feed !== editedFeed) return null
  const baseline = snapshot.baseline
  if (!baseline || !snapshot.comparison) return null

  const { facilities, results, order } = facilitySource
  const hit = cache.get(snapshot)
  if (hit && hit.origins === origins && hit.facilities === facilities && hit.results === results && hit.order === order && hit.ref === state.ref) {
    return hit.ctx
  }
  const ctx: RestoreHintContext = {
    before: baseline.departures,
    after: snapshot.departures,
    bands: snapshot.bands,
    beforeResult: baseline.result,
    afterResult: snapshot.result,
    date: snapshot.date,
    params: snapshot.params,
    stops: origins.stops,
  }
  if (facilities.status === 'ready') {
    ctx.facilities = hintFacilities(facilities.facilities, { results, order, ref: refDataOf(state.ref), params: snapshot.params, result: baseline.result })
  }
  cache.set(snapshot, { origins, facilities, results, order, ref: state.ref, ctx })
  return ctx
}

function refDataOf(ref: RefState | undefined): RefData | null {
  return ref?.status === 'done' && ref.result.ok ? ref.result.ref : null
}

// ---- 学校・病院の手がかりの施設(T19)----

/** 手がかりに使う重要拠点の種類と、施設の種類(学校・病院)。診療所と種別が分からない学校は使わない */
const HINT_CATEGORIES: ReadonlyMap<PriorityKey, HintFacility['kind']> = new Map([
  ['inpatient_hospital', 'hospital'],
  ['high_school', 'school'],
  ['higher_education', 'school'],
])

/** 休校中の学校は使わない(休校区分が「不明」「調査なし」の学校は使う) */
const CLOSED_SCHOOL = '休校中'

/** 調査の結果の要点に入れる事実の数の上限 */
const MAX_RESEARCH_FACTS = 3

/**
 * 施設の位置の区分(都市部・郊外・中山間・地方)。到達圏の計算(reach.ts の computeReach)と同じ規則で、
 * 施設のある 125m セルが DID の中なら都市部、外なら親の 250m セルの人口密度がしきい値以上なら郊外、未満なら中山間・地方。
 * 到達圏は人口 1 人未満のセルを調べないが、施設は人の住まないセルにもあるので、人口 0 のセルは中山間・地方とする。
 * 参照データが無いときは、到達圏が使った区分(参照データが無く fallbackClass で計算していれば、その区分)。決められなければ null
 */
export function facilityRegionClass(
  lat: number,
  lon: number,
  ref: RefData | null,
  params: ReachParams,
  result: Pick<ReachResult, 'usedFallback' | 'classes'>,
): RegionClass | null {
  let cell: string
  try {
    cell = meshCode(lat, lon, 11)
  } catch {
    return null
  }
  if (ref) {
    if (ref.did125.has(cell)) return 'urban'
    const parent = parentCode(cell, 10)
    const pop = ref.pop250.get(parent) ?? 0
    return pop >= 1 && pop / cellAreaKm2(parent) >= params.densityThreshold ? 'suburban' : 'rural'
  }
  if (result.usedFallback && result.classes.length > 0) return result.classes[0]
  return null
}

/** 区分のバス停の徒歩の距離(m)。区分が決められなければ、3区分の最大 */
function walkRadiusM(cls: RegionClass | null, params: ReachParams): number {
  const of = (c: RegionClass) => params.walkMinutes[c].bus * params.speedMPerMin
  if (cls) return of(cls)
  return Math.max(of('urban'), of('suburban'), of('rural'))
}

/** 調査の結果の事実(全部。出典は sources の番号から URL に直す。読めなければ null) */
function factsOf(r: ResearchResult): { label: string; value: string; url: string | null }[] {
  return r.facts.map((f) => ({ label: f.label, value: f.value, url: r.sources[f.source - 1]?.url ?? null }))
}

/** 調査の結果の要点(事実は先頭から MAX_RESEARCH_FACTS 件、出典は sources の番号から URL に直す) */
export function researchNoteOf(r: ResearchResult): FacilityResearchNote {
  return { status: r.status, checkedAt: r.checkedAt, origin: r.origin, facts: factsOf(r).slice(0, MAX_RESEARCH_FACTS) }
}

/**
 * 時間帯の窓と長期休業を読む材料の事実(T27)。要点(researchNoteOf)のように先頭の数件に絞らず、全部を使う
 * (受付時間・始業・休業の事実が4件目より後にあることがあるため)。見つからなかった(not_found)結果の事実は使わない
 */
function hourFactsOf(r: ResearchResult | undefined): FactLike[] {
  if (!r || r.status === 'not_found') return []
  return factsOf(r)
}

/**
 * 周辺の施設の参照データ(国土数値情報の学校 P29・医療機関 P04)から、学校・病院の手がかりに使う施設を作る。
 * 使うのは重要拠点の優先順位にある学校(高校・大学など)と入院設備のある病院(診療所・種別が分からない学校・事業者と、
 * 専修学校・各種学校(HINT_EXCLUDED_SCHOOL_TYPES。2026-11-07)は使わない)。
 * 徒歩圏は、施設の位置の区分のバス停の分数 × 分速(到達圏と同じ距離)。優先順位は order の順位、調査の結果があれば要点を付ける。
 * 時間帯の窓は、調査の結果の受付時間・始業・終業から施設ごとに決め、読めなければ既定(gtfs/edit/facilityHours.ts。T27)。
 * 学校は、調査の結果から長期休業の期間も読む(減便の期間と重なるかは画面が overlapLongBreaks で出す)
 */
export function hintFacilities(
  facilities: readonly Facility[],
  o: {
    results: ReadonlyMap<string, ResearchResult>
    order: readonly PriorityKey[]
    ref: RefData | null
    params: ReachParams
    result: Pick<ReachResult, 'usedFallback' | 'classes'>
  },
): HintFacility[] {
  const out: HintFacility[] = []
  for (const f of facilities) {
    const category = facilityCategory(f)
    if (category === null) continue
    const kind = HINT_CATEGORIES.get(category)
    if (!kind) continue
    if (f.kind === 'school' && f.openStatus === CLOSED_SCHOOL) continue
    // 専修学校・各種学校は判断材料に使わない(HINT_EXCLUDED_SCHOOL_TYPES。調査の対象には残す)
    if (f.kind === 'school' && f.schoolType !== undefined && HINT_EXCLUDED_SCHOOL_TYPES.has(f.schoolType)) continue
    const research = o.results.get(f.targetId)
    const facts = hourFactsOf(research)
    out.push({
      targetId: f.targetId,
      name: f.name,
      kind,
      categoryLabel: priorityCategory(category).label,
      rank: priorityRank(o.order, category),
      lat: f.lat,
      lon: f.lon,
      radiusM: walkRadiusM(facilityRegionClass(f.lat, f.lon, o.ref, o.params, o.result), o.params),
      ...(research ? { research: researchNoteOf(research) } : {}),
      windows: facilityWindows(kind, facts),
      longBreaks: kind === 'school' ? readLongBreaks(facts) : [],
    })
  }
  return out
}
