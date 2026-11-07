import { useMemo } from 'react'
import { create } from 'zustand'
import { fetchDemoResults, type DemoResult, type ResearchResult, type ResearchTarget } from '@/claude/research'
import { pickNoticeDate, type NoticeDateSource } from '@/gtfs/edit/notice'
import { stopDiff } from '@/gtfs/edit/stopDiff'
import type { Stop } from '@/gtfs/parse'
import { originStops } from '@/reach/input'
import { operatorOverlap, type OperatorOverlap, type OtherStop } from '@/ref/busstops'
import {
  DEFAULT_MAX_TARGETS,
  defaultSelection,
  facilityMeshes,
  fetchFacilities,
  researchCandidates,
  type Facility,
  type FacilityLoadResult,
  type ResearchCandidate,
} from '@/ref/facilities'
import { lastVersion, useEditStore } from './edit'
import { useGtfsStore } from './gtfs'
import { usePriorityStore } from './priority'
import { useReachStore } from './reach'

/** 施設の参照データの読み込みの状態 */
export type FacilityState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | {
      status: 'ready'
      key: string
      facilities: Facility[]
      sources: string[]
      /**
       * 周辺の事業者の停留所(facilities/{mesh1}.json の busstops。ref/busstops.ts)。
       * null・undefined は停留所の参照データが無い(重なりを数えない)
       */
      busstops?: OtherStop[] | null
    }
  | { status: 'error'; key: string; message: string }

/** デモ用の保存済みの結果の読み込みの状態 */
export type DemoState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; count: number } | { status: 'error'; message: string }

interface ResearchState {
  facilities: FacilityState
  /** 利用者が選んだ対象(target_id の並び)。null は「既定の選び方(defaultSelection)のまま」 */
  selected: readonly string[] | null
  /** 調査を始めた(POST が返した)対象。まだ始めていなければ null */
  targets: ResearchTarget[] | null
  /** 対象の上限(サーバーが返した max_targets。返す前は既定の 30) */
  maxTargets: number
  /** 表示する結果(target_id ごと)。調査の結果とデモ用の結果をまとめる */
  results: ReadonlyMap<string, ResearchResult>
  demo: DemoState

  /** 停留所の外接矩形 +2km にかかる1次メッシュの施設を読む。同じ範囲を読み込み済み・読み込み中なら何もしない */
  loadFacilities: (stops: readonly { lat: number; lon: number }[], fetchImpl?: typeof fetchFacilities) => Promise<void>
  setSelected: (ids: readonly string[] | null) => void
  /** 調査を始めた対象を入れる */
  setTargets: (targets: ResearchTarget[], maxTargets: number) => void
  /** 結果を足す(同じ target_id は置き換える) */
  mergeResults: (results: readonly ResearchResult[]) => void
  /**
   * デモ用の保存済みの結果を読み、結果に足す。候補(candidateIds)にある対象だけを使い、その対象を選ぶ。
   * AI は呼ばない。読めた対象の数を返す
   */
  loadDemo: (candidateIds: ReadonlySet<string>, fetchImpl?: () => Promise<DemoResult[]>) => Promise<number>
  /** GTFS を読み込み直したとき・削除したとき(store/reset.ts の resetAll)。施設の読み込み・選択・結果を消す */
  reset: () => void
}

function initial(): Pick<ResearchState, 'facilities' | 'selected' | 'targets' | 'maxTargets' | 'results' | 'demo'> {
  return { facilities: { status: 'idle' }, selected: null, targets: null, maxTargets: DEFAULT_MAX_TARGETS, results: new Map(), demo: { status: 'idle' } }
}

/**
 * 前提情報の手順の store。施設の参照データ、選んだ対象、調査の結果(出典 URL と確認日時つき)を持つ。
 * 調査の開始と結果の読み込み(AI の中継)は store/chat.ts の startResearch・loadResearch が行い、ここには結果だけを入れる
 */
export const useResearchStore = create<ResearchState>()((set, get) => ({
  ...initial(),

  async loadFacilities(stops, fetchImpl = fetchFacilities) {
    const mesh1s = facilityMeshes(stops)
    const key = mesh1s.join(',')
    const cur = get().facilities
    if (cur.status !== 'idle' && cur.status !== 'error' && cur.key === key) return
    set({ facilities: { status: 'loading', key } })
    let result: FacilityLoadResult
    try {
      result = await fetchImpl(mesh1s)
    } catch (e) {
      result = { ok: false, mesh1s, message: e instanceof Error ? e.message : String(e) }
    }
    // 読んでいる間に読み込み直した(GTFS を替えたなど)なら捨てる
    const now = get().facilities
    if (now.status !== 'loading' || now.key !== key) return
    set({
      facilities: result.ok
        ? { status: 'ready', key, facilities: result.facilities, sources: result.sources, busstops: result.busstops }
        : { status: 'error', key, message: result.message },
    })
  },

  setSelected: (ids) => set({ selected: ids === null ? null : [...ids] }),

  setTargets: (targets, maxTargets) => set({ targets, maxTargets }),

  mergeResults(results) {
    if (results.length === 0) return
    const next = new Map(get().results)
    for (const r of results) next.set(r.targetId, r)
    set({ results: next })
  },

  async loadDemo(candidateIds, fetchImpl = () => fetchDemoResults()) {
    const loading: DemoState = { status: 'loading' }
    set({ demo: loading })
    let list: DemoResult[]
    try {
      list = await fetchImpl()
    } catch (e) {
      if (get().demo === loading) set({ demo: { status: 'error', message: e instanceof Error ? e.message : String(e) } })
      return 0
    }
    // 読んでいる間に GTFS を削除した・読み込み直した(reset)なら捨てる
    if (get().demo !== loading) return 0
    const usable = list.filter((r) => candidateIds.has(r.targetId))
    get().mergeResults(usable)
    // 上限(maxTargets)は周辺のバス事業者を除いて数える(事業者は上限なしに選べる)
    const others = usable.filter((r) => r.kind !== 'operator').map((r) => r.targetId).slice(0, get().maxTargets)
    const operators = usable.filter((r) => r.kind === 'operator').map((r) => r.targetId)
    if (usable.length > 0) set({ selected: [...others, ...operators] })
    set({ demo: { status: 'ready', count: usable.length } })
    return usable.length
  },

  reset: () => set(initial()),
}))

// GTFS を読み込み直したら(捨てたときも)、前の GTFS の周りの施設・選択・結果を消す
useGtfsStore.subscribe((s, prev) => {
  if (s.feed !== prev.feed) useResearchStore.getState().reset()
})

/** 施設の参照データを使っているか(画面の「データの出典」に P11・P29・P04 の行を出すか) */
export function facilitiesInUse(s: Pick<ResearchState, 'facilities'>): boolean {
  return s.facilities.status === 'ready' && s.facilities.facilities.length > 0
}

const NO_STOPS: readonly Stop[] = []
const NO_FACILITIES: readonly Facility[] = []

/** 調査の対象を探す起点の停留所(到達圏の起点と同じ。到達圏の store が求めていればそれを使う) */
export function useResearchStops(): readonly Stop[] {
  const feed = useGtfsStore((s) => s.feed)
  const stops = useGtfsStore((s) => s.stops)
  const origins = useReachStore((s) => s.origins)
  return useMemo(() => {
    if (origins) return origins.stops
    return feed ? originStops(feed, stops).stops : NO_STOPS
  }, [feed, stops, origins])
}

/** 読み込んだ GTFS の事業者名(agency.txt の agency_name) */
function useAgencyNames(): string[] {
  const feed = useGtfsStore((s) => s.feed)
  return useMemo(
    () =>
      (feed?.tables.get('agency')?.rows ?? [])
        .map((r) => r.agency_name?.trim() ?? '')
        .filter((n) => n !== ''),
    [feed],
  )
}

// ---- 周辺の事業者の停留所との重なり ----

/** 事業者ごとの重なり(target_id → 重なり)。停留所の参照データが無ければ null */
export type OverlapMap = ReadonlyMap<string, OperatorOverlap>

// 前提情報の手順と地図の両方が同じ入力で求めるので、最後の入力と結果を1つだけ覚えておく(kdbush の索引を作り直さないため)
let overlapMemo: { busstops: readonly OtherStop[]; stops: readonly Stop[]; names: string; result: OverlapMap } | null = null

/**
 * こちらの停留所(stops)の 300m 以内にある他事業者の停留所を、事業者ごとに数える(ref/busstops.ts の operatorOverlap)。
 * 読み込んだ GTFS の事業者(agencyNames)は除く
 */
export function overlapsFor(busstops: readonly OtherStop[], stops: readonly Stop[], agencyNames: readonly string[]): OverlapMap {
  const names = agencyNames.join('\u0000')
  if (overlapMemo && overlapMemo.busstops === busstops && overlapMemo.stops === stops && overlapMemo.names === names) return overlapMemo.result
  const own = stops.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }))
  const result: OverlapMap = new Map(operatorOverlap(own, busstops, agencyNames).map((o) => [o.targetId, o]))
  overlapMemo = { busstops, stops, names, result }
  return result
}

/** 候補と、選んでいる対象(既定の選び方のままなら、その結果) */
export interface ResearchView {
  candidates: ResearchCandidate[]
  selectedIds: readonly string[]
  /** 既定の選び方のままか */
  isDefault: boolean
  maxTargets: number
  /** 事業者ごとの、こちらの停留所との重なり。停留所の参照データが無ければ null */
  overlaps: OverlapMap | null
}

/** 前提情報の手順と地図が共通で使う、候補と選択 */
export function useResearchView(): ResearchView {
  const stops = useResearchStops()
  const agencyNames = useAgencyNames()
  const facilities = useResearchStore((s) => s.facilities)
  const selected = useResearchStore((s) => s.selected)
  const maxTargets = useResearchStore((s) => s.maxTargets)
  const order = usePriorityStore((s) => s.order)
  const list = facilities.status === 'ready' ? facilities.facilities : NO_FACILITIES
  const busstops = facilities.status === 'ready' ? (facilities.busstops ?? null) : null
  const overlaps = useMemo(() => (busstops ? overlapsFor(busstops, stops, agencyNames) : null), [busstops, stops, agencyNames])
  const candidates = useMemo(() => {
    const base = researchCandidates(list, stops, agencyNames)
    if (!overlaps) return base
    // 事業者(自社を除く)に重なりを付ける。重なりの無い事業者は null(「近くに停留所なし」)
    return base.map((c) => (c.facility.kind === 'operator' && !c.ownOperator ? { ...c, overlap: overlaps.get(c.facility.targetId) ?? null } : c))
  }, [list, stops, agencyNames, overlaps])
  const defaults = useMemo(() => defaultSelection(candidates, order, maxTargets), [candidates, order, maxTargets])
  // 読み込んだ GTFS の事業者は調べる対象にしない(一覧のチェックボックスは変更できない。2026-11-07 に利用者の指示)
  const selectedIds = useMemo(() => {
    const own = new Set(candidates.filter((c) => c.ownOperator).map((c) => c.facility.targetId))
    const ids = selected ?? defaults
    return own.size > 0 && ids.some((id) => own.has(id)) ? ids.filter((id) => !own.has(id)) : ids
  }, [candidates, selected, defaults])
  return { candidates, selectedIds, isDefault: selected === null, maxTargets, overlaps }
}

/** 減便の方針を承認した後の、発車が減る・なくなるこちらの停留所 */
export interface ReducedStops {
  /** 数えた日(YYYYMMDD。減便の期間のうち、元の平日ダイヤが走る最初の日。周知文・変更指示書と同じ決め方) */
  date: string
  /** 発車が減る・なくなる停留所の stop_id */
  stopIds: ReadonlySet<string>
}

/** 停留所ごとの前後の発車(stopDiff)から、発車が減る・なくなる停留所を出す。日が決まらなければ null */
export function reducedStopsOf(
  base: Parameters<typeof stopDiff>[0],
  version: NoticeDateSource & { feed: Parameters<typeof stopDiff>[1] },
): ReducedStops | null {
  const date = pickNoticeDate(base, version)
  if (!date) return null
  const ids = new Set<string>()
  for (const s of stopDiff(base, version.feed, date).stops) if (s.after.count < s.before.count) ids.add(s.stopId)
  return { date, stopIds: ids }
}

/** 減便の方針を承認済みか(承認した版があるか)。承認済みでも数える日が決まらず useReducedStops が null のときを分けるのに使う */
export function usePolicyApproved(): boolean {
  return useEditStore((s) => lastVersion(s) !== null)
}

/**
 * 減便の方針を承認済みなら、発車が減る・なくなるこちらの停留所(承認済みの最後の版で数える)。
 * 承認前と、承認済みでも減便の期間に元の平日ダイヤが走る日がない(数える日が決まらない)ときは null。
 * 比べる日は地図の操作盤の日付ではなく、減便の期間の最初の平日ダイヤの日(土日を選んでいても 0 にならないように)
 */
export function useReducedStops(): ReducedStops | null {
  const base = useEditStore((s) => s.base)
  const version = useEditStore(lastVersion)
  return useMemo(() => (base && version ? reducedStopsOf(base.feed, version) : null), [base, version])
}
