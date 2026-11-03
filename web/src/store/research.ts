import { useMemo } from 'react'
import { create } from 'zustand'
import { fetchDemoResults, type DemoResult, type ResearchResult, type ResearchTarget } from '@/claude/research'
import { originStops } from '@/reach/input'
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
import { useGtfsStore } from './gtfs'
import { usePriorityStore } from './priority'
import { useReachStore } from './reach'

/** 施設の参照データの読み込みの状態 */
export type FacilityState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; facilities: Facility[]; sources: string[] }
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
  /** GTFS を読み込み直したとき。施設の読み込み・選択・結果を消す */
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
        ? { status: 'ready', key, facilities: result.facilities, sources: result.sources }
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
    set({ demo: { status: 'loading' } })
    let list: DemoResult[]
    try {
      list = await fetchImpl()
    } catch (e) {
      set({ demo: { status: 'error', message: e instanceof Error ? e.message : String(e) } })
      return 0
    }
    const usable = list.filter((r) => candidateIds.has(r.targetId))
    get().mergeResults(usable)
    if (usable.length > 0) set({ selected: usable.map((r) => r.targetId).slice(0, get().maxTargets) })
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

const NO_STOPS: readonly { lat: number; lon: number }[] = []
const NO_FACILITIES: readonly Facility[] = []

/** 調査の対象を探す起点の停留所(到達圏の起点と同じ。到達圏の store が求めていればそれを使う) */
export function useResearchStops(): readonly { lat: number; lon: number }[] {
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

/** 候補と、選んでいる対象(既定の選び方のままなら、その結果) */
export interface ResearchView {
  candidates: ResearchCandidate[]
  selectedIds: readonly string[]
  /** 既定の選び方のままか */
  isDefault: boolean
  maxTargets: number
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
  const candidates = useMemo(() => researchCandidates(list, stops, agencyNames), [list, stops, agencyNames])
  const defaults = useMemo(() => defaultSelection(candidates, order, maxTargets), [candidates, order, maxTargets])
  return { candidates, selectedIds: selected ?? defaults, isDefault: selected === null, maxTargets }
}
