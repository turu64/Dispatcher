import { create } from 'zustand'
import { isValidGtfsDate, servicesFor } from '../gtfs/calendar'
import { departureCountsByBand, makeBands, type DepartureCounts, type TimeBand } from '../gtfs/departures'
import type { GtfsFeed } from '../gtfs/load'
import type { Stop } from '../gtfs/parse'
import { todayInJapan } from '../lib/dates'
import { defaultServiceDate } from '../lib/serviceDay'
import { buildReachStops, cloneParams, maxWalkRadiusM, REGION_CLASSES } from '../reach/input'
import { DEFAULT_REACH_PARAMS, type ReachInput, type ReachParams, type ReachResult, type RegionClass } from '../reach/reach'
import { fetchRefData, pointsBounds, refMeshesFor, type RefLoadResult } from '../reach/refData'
import { summarizeReach, type ReachSummary } from '../reach/summary'
import { computeReachInWorker } from '../reach/workerClient'

export type StepHours = 1 | 3

/** 到達圏を計算する GTFS(手順1で読み込んだもの) */
export interface ReachSource {
  feed: GtfsFeed
  stops: Stop[]
  period: { start: string; end: string } | null
}

/** 参照データの読み込みの状態。key は読む1次メッシュを「,」でつないだもの */
export type RefState =
  | { status: 'idle' }
  | { status: 'loading'; key: string; mesh1s: string[] }
  | { status: 'done'; key: string; result: RefLoadResult }

/** 1回の計算の結果と、そのときの条件(画面と地図はこれを表示する) */
export interface ReachSnapshot {
  date: string
  stepHours: StepHours
  bands: TimeBand[]
  departures: DepartureCounts
  result: ReachResult
  summary: ReachSummary
  params: ReachParams
}

export type WalkKind = 'bus' | 'rail'

interface ReachState {
  source: ReachSource | null
  /** 選んだ日付('YYYYMMDD')。運行日が無いフィードでは null */
  date: string | null
  stepHours: StepHours
  /** 表示する時間帯。時刻(時)で持ち、3時間ごと・1時間ごとを切り替えても同じ時刻を含む時間帯を選ぶ */
  selectedHour: number
  params: ReachParams
  /** 参照データが無いときに全セルへ当てる区分 */
  fallbackClass: RegionClass
  ref: RefState
  /** 計算中(または、入力を待ってから計算する予定がある) */
  computing: boolean
  /** 計算できなかった理由 */
  error: string | null
  /** 最新の条件で計算した結果。条件を変えている間は、ひとつ前の結果を出しておく */
  snapshot: ReachSnapshot | null

  /** 読み込んだ GTFS を渡す(null で捨てる)。既定の日付を選び、計算する */
  setSource: (source: ReachSource | null) => void
  /** 日付を選ぶ。運行期間の外や不正な日付なら、変えずに理由を返す */
  setDate: (date: string) => string | null
  setStepHours: (step: StepHours) => void
  /** 表示する時間帯を選ぶ(計算し直さない。地図の色を切り替えるだけ) */
  selectHour: (hour: number) => void
  setDensityThreshold: (value: number) => void
  setWalkMinutes: (cls: RegionClass, kind: WalkKind, value: number) => void
  /** しきい値と分数を既定に戻す */
  resetParams: () => void
  setFallbackClass: (cls: RegionClass) => void
  /** 参照データを読み込み直す(読めなかったものだけサーバーに問い合わせる) */
  retryRef: () => void
  /** 今の条件で計算する。新しい計算が始まったら、古い計算の結果は使わない */
  recompute: () => Promise<void>
}

/** 計算と参照データの取得(テストでは偽物に差し替える) */
export interface ReachStoreDeps {
  compute: (input: ReachInput) => Promise<ReachResult>
  loadRef: (mesh1s: string[]) => Promise<RefLoadResult>
  /** 日本時間の今日('YYYYMMDD') */
  today: () => string
  /** しきい値・分数の入力から計算を始めるまでの待ち時間(ミリ秒)。続けて打つ間は計算しない。0 ならすぐ計算する */
  paramDelayMs: number
}

const NO_STOPS = '位置の分かる停留所がありません。stops.txt の stop_lat・stop_lon を確かめてください。'

function messageOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message || '到達圏を計算できませんでした。'
}

/** 到達圏の条件と結果を持つ store を作る */
export function createReachStore(deps: ReachStoreDeps) {
  return create<ReachState>()((set, get) => {
    // 計算の番号。新しい計算(または予定)のたびに増やし、await のあとで最新でなければ結果を捨てる
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    // 読み込み中の参照データ(同じ1次メッシュの組を続けて頼まれたら、同じ読み込みを待つ)
    let refInflight: { key: string; promise: Promise<RefLoadResult> } | null = null

    function cancelTimer(): void {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    function loadRef(mesh1s: string[], key: string): Promise<RefLoadResult> {
      if (refInflight?.key === key) return refInflight.promise
      const promise = deps.loadRef(mesh1s).catch(
        (e: unknown): RefLoadResult => ({ ok: false, mesh1s, missing: mesh1s, message: messageOf(e) }),
      )
      refInflight = { key, promise }
      void promise.then(() => {
        if (refInflight?.promise === promise) refInflight = null
      })
      return promise
    }

    /** 条件を変えたあと。分数などの入力は少し待ってから、それ以外はすぐ計算する */
    function schedule(delayMs: number): void {
      cancelTimer()
      if (delayMs <= 0) {
        void get().recompute()
        return
      }
      // 待っている間に前の計算が終わっても、その結果は使わない(古い条件の結果のため)
      seq++
      set({ computing: get().source !== null })
      timer = setTimeout(() => {
        timer = null
        void get().recompute()
      }, delayMs)
    }

    function updateParams(change: (p: ReachParams) => void): void {
      const params = cloneParams(get().params)
      change(params)
      set({ params })
      schedule(deps.paramDelayMs)
    }

    return {
      source: null,
      date: null,
      stepHours: 3,
      selectedHour: 6,
      params: cloneParams(DEFAULT_REACH_PARAMS),
      fallbackClass: 'suburban',
      ref: { status: 'idle' },
      computing: false,
      error: null,
      snapshot: null,

      setSource(source) {
        cancelTimer()
        seq++
        if (!source) {
          set({ source: null, date: null, snapshot: null, error: null, computing: false })
          return
        }
        const date = defaultServiceDate(source.feed, source.period, deps.today())
        set({ source, date, snapshot: null, error: null })
        void get().recompute()
      },

      setDate(date) {
        const period = get().source?.period
        if (!period) return 'GTFS に運行日がありません。'
        if (!isValidGtfsDate(date) || date < period.start || date > period.end) {
          return '運行期間の中の日付を選んでください。'
        }
        if (date !== get().date) {
          set({ date })
          schedule(0)
        }
        return null
      },

      setStepHours(step) {
        if (step === get().stepHours) return
        set({ stepHours: step })
        schedule(0)
      },

      selectHour(hour) {
        set({ selectedHour: hour })
      },

      setDensityThreshold(value) {
        updateParams((p) => {
          p.densityThreshold = value
        })
      },

      setWalkMinutes(cls, kind, value) {
        if (!REGION_CLASSES.includes(cls)) return
        updateParams((p) => {
          p.walkMinutes[cls][kind] = value
        })
      },

      resetParams() {
        set({ params: cloneParams(DEFAULT_REACH_PARAMS) })
        schedule(0)
      },

      setFallbackClass(cls) {
        if (cls === get().fallbackClass) return
        set({ fallbackClass: cls })
        // 参照データがあるときは区分を使わないので、計算し直さない
        const ref = get().ref
        if (ref.status === 'done' && ref.result.ok) return
        schedule(0)
      },

      retryRef() {
        set({ ref: { status: 'idle' } })
        schedule(0)
      },

      async recompute() {
        cancelTimer()
        const id = ++seq
        const { source, date, stepHours, params, fallbackClass } = get()
        if (!source || !date) {
          set({ computing: false })
          return
        }
        if (!pointsBounds(source.stops)) {
          set({ computing: false, snapshot: null, error: NO_STOPS })
          return
        }
        set({ computing: true, error: null })
        try {
          // 1. 参照データ(読む1次メッシュは、分数が変われば変わることがある)
          const mesh1s = refMeshesFor(source.stops, maxWalkRadiusM(params))
          const key = mesh1s.join(',')
          let refResult: RefLoadResult
          const current = get().ref
          if (current.status === 'done' && current.key === key) {
            refResult = current.result
          } else {
            set({ ref: { status: 'loading', key, mesh1s } })
            refResult = await loadRef(mesh1s, key)
            if (id !== seq) return
            set({ ref: { status: 'done', key, result: refResult } })
          }

          // 2. 時間帯ごとの出発(画面の GTFS はメインスレッドにあるので、ここで数える)
          const bands = makeBands(stepHours)
          const departures = departureCountsByBand(source.feed, servicesFor(source.feed, date), bands)

          // 3. 到達圏(Web Worker)
          const usedParams = cloneParams(params)
          const result = await deps.compute({
            stops: buildReachStops(source.stops, departures.counts, bands.length),
            ref: refResult.ok ? refResult.ref : null,
            fallbackClass,
            params: usedParams,
            bandCount: bands.length,
          })
          if (id !== seq) return
          set({
            computing: false,
            snapshot: { date, stepHours, bands, departures, result, summary: summarizeReach(result), params: usedParams },
          })
        } catch (e) {
          if (id !== seq) return
          set({ computing: false, error: messageOf(e) })
        }
      },
    }
  })
}

/**
 * 到達圏の条件(日付・時間帯・しきい値・分数)と、計算の結果を持つ。
 * 計算は reach/ と gtfs/ の純粋な関数と Web Worker で行い、画面の部品は結果を表示するだけにする。
 */
export const useReachStore = createReachStore({
  compute: computeReachInWorker,
  loadRef: (mesh1s) => fetchRefData(mesh1s),
  today: () => todayInJapan(new Date()),
  paramDelayMs: 300,
})
