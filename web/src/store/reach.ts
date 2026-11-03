import { create } from 'zustand'
import { isValidGtfsDate, servicesFor } from '../gtfs/calendar'
import { departureCountsByBand, makeBands, type DepartureCounts, type TimeBand } from '../gtfs/departures'
import type { GtfsFeed } from '../gtfs/load'
import type { Stop } from '../gtfs/parse'
import { todayInJapan } from '../lib/dates'
import { defaultServiceDate } from '../lib/serviceDay'
import {
  compareReach,
  zeroServiceRoutes,
  zeroServiceStops,
  type ReachComparison,
  type ZeroServiceRoute,
  type ZeroServiceStop,
} from '../reach/compare'
import { buildReachStops, cloneParams, originStops, refMarginM, REGION_CLASSES, type OriginStops } from '../reach/input'
import { DEFAULT_REACH_PARAMS, type ReachInput, type ReachParams, type ReachResult, type RegionClass } from '../reach/reach'
import { fetchRefData, pointsBounds, refMeshesFor, type RefLoadResult } from '../reach/refData'
import { summarizeReach, type ReachSummary } from '../reach/summary'
import { computeReachInWorker } from '../reach/workerClient'

export type StepHours = 1 | 3

/**
 * 到達圏の基準の GTFS(手順1で読み込んだもの)。起点・調べるセル・coverable・区分は、これから一度だけ決める
 * (docs/interfaces-1103.md の追記3)。編集後の GTFS は setEdited で渡し、ここには渡さない
 */
export interface ReachSource {
  feed: GtfsFeed
  /** stops.txt の停留所すべて(toStops の結果)。起点は store が選ぶ(originStops) */
  stops: Stop[]
  period: { start: string; end: string } | null
}

/** 方針の適用・足し戻しで作った GTFS(docs/interfaces-1104.md §4・§7。store/edit.ts が渡す) */
export interface EditedSource {
  feed: GtfsFeed
  /** 編集後の運行期間(feedServicePeriod(feed))。基準の期間の中に入る */
  period: { start: string; end: string } | null
  /** 下書き(承認前)なら true */
  draft: boolean
}

/** 地図の塗り分け。'before' は基準、'after' は編集後、'diff' は前後の差の4色 */
export type CompareMode = 'before' | 'after' | 'diff'

/** 起点の停留所の数と、起点から除いたものの数(画面の表に出す) */
export interface OriginCounts {
  /** 起点の停留所(stop_times.txt に乗れる行がある、location_type が 0 か空のもの)の数 */
  origins: number
  /** stop_times.txt に一度も出てこないので除いた停留所の数 */
  unused: number
  /** location_type が 0 でも空でもない(駅舎・出入口など)ので除いた行の数 */
  nonStop: number
  /** stop_times.txt に出てくるが、乗れる行が1つも無い(すべて終点か pickup_type が 1)ので除いた停留所の数 */
  noBoarding: number
}

/** 1つの GTFS で数えた出発と、到達圏の結果 */
export interface ReachSide {
  departures: DepartureCounts
  result: ReachResult
  summary: ReachSummary
}

/** 参照データの読み込みの状態。key は読む1次メッシュを「,」でつないだもの */
export type RefState =
  | { status: 'idle' }
  | { status: 'loading'; key: string; mesh1s: string[] }
  | { status: 'done'; key: string; result: RefLoadResult }

/**
 * 1回の計算の結果と、そのときの条件(画面と地図はこれを表示する)。
 * departures・result・summary は表示する側(編集後があれば編集後、無ければ基準)のもの。
 * 編集後があるときだけ、同じ日付の基準(baseline)と、前後の比較を入れる
 */
export interface ReachSnapshot {
  date: string
  stepHours: StepHours
  bands: TimeBand[]
  departures: DepartureCounts
  result: ReachResult
  summary: ReachSummary
  params: ReachParams
  origin: OriginCounts
  /** 同じ日付・同じ条件の基準の結果(編集後があるときだけ) */
  baseline?: ReachSide
  comparison?: ReachComparison
  /** 運行がゼロになる停留所(起点の停留所のうち、基準ではその日に出発があり、編集後は 0 のもの) */
  zeroStops?: ZeroServiceStop[]
  /** 運行がゼロになる系統 */
  zeroRoutes?: ZeroServiceRoute[]
  /** 編集後が下書き(承認前)なら true */
  draft?: boolean
}

export type WalkKind = 'bus' | 'rail'

interface ReachState {
  /** 基準の GTFS */
  source: ReachSource | null
  /** 編集後の GTFS(履歴が空なら null)。到達圏は基準の起点で計算し、出発の数だけをこのフィードから数える */
  edited: EditedSource | null
  /** 地図の塗り分け(既定 'diff')。edited が null なら使わない */
  compareMode: CompareMode
  /**
   * 到達圏の起点の停留所(docs/interfaces-1103.md の追記2)。source から setSource で選ぶ。
   * 計算(computeReach)に渡すのも、地図に点として出すのも、この停留所だけ
   */
  origins: OriginStops | null
  /** 選んだ日付('YYYYMMDD')。運行日が無いフィードでは null */
  date: string | null
  stepHours: StepHours
  /**
   * 表示する時間帯。時刻(時)で持ち、3時間ごと・1時間ごとを切り替えても同じ時刻を含む時間帯を選ぶ。
   * 方針を承認したあとの最初の比較で、減便で外れたセルが最も多い時間帯に移す(利用者が選んだあとは動かさない)
   */
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

  /**
   * 読み込んだ GTFS(基準)を渡す(null で捨てる)。起点を選び、既定の日付を選び、計算する。編集後は捨てる。
   * 呼ぶのは LoadStep の open() だけ。**編集後のフィードを渡さない**(起点が選び直され、追記3の問題が戻る)
   */
  setSource: (source: ReachSource | null) => void
  /**
   * 編集後の GTFS を渡す(null で基準だけに戻す)。選んでいる日付が編集後の運行期間の外なら、期間の中の日に移して計算する。
   * 起点・調べるセルは基準のまま
   */
  setEdited: (edited: EditedSource | null) => void
  /** 地図の塗り分けを選ぶ(計算し直さない) */
  setCompareMode: (mode: CompareMode) => void
  /** 日付を選ぶ。運行期間(編集後があれば編集後の運行期間)の外や不正な日付なら、変えずに理由を返す */
  setDate: (date: string) => string | null
  setStepHours: (step: StepHours) => void
  /** 表示する時間帯を利用者が選ぶ(計算し直さない。地図の色を切り替えるだけ)。選んだあとは自動では動かさない */
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
const NO_ORIGINS =
  'stop_times.txt に出てくる停留所(location_type が 0 か空で、乗れる行があるもの)に、位置の分かるものがありません。stop_times.txt の stop_id・pickup_type と、stops.txt を確かめてください。'
const NO_SERVICE_DAYS = 'GTFS に運行日がありません。'
const NO_EDITED_SERVICE_DAYS = '減便後の GTFS に運行日がありません。'
const OUT_OF_PERIOD = '運行期間の中の日付を選んでください。'

/**
 * 日付を選べる範囲。編集後があれば編集後の運行期間(編集後に便が無い日は比べられないため)、無ければ基準の運行期間。
 * 影響(到達圏)の手順の上部の日付の入力(カレンダー)は、この範囲を使う
 */
export function selectablePeriod(state: {
  source: ReachSource | null
  edited: EditedSource | null
}): { start: string; end: string } | null {
  if (state.edited) return state.edited.period
  return state.source?.period ?? null
}

/**
 * 帯ごとの減便で外れたセルが最も多い時間帯の番号。どの時間帯も 0 なら -1。
 * 同じ数なら遅い時間帯を選ぶ(§7 の目的は夜の空白を見せること。道北バスで 0051・0151 を除外し足し戻す前は、
 * 6〜9時と 18〜21時が同じ数になる)
 */
function bandWithMostLost(comparison: ReachComparison): number {
  let best = -1
  let max = 0
  comparison.bands.forEach((b, i) => {
    if (b.lostCells > 0 && b.lostCells >= max) {
      max = b.lostCells
      best = i
    }
  })
  return best
}

/** 'YYYYMMDD' を 'YYYY/MM/DD' にする(画面の文言用) */
function slashDate(date: string): string {
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`
}

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
    // 基準の結果(計算中のものを含めて1つだけ持つ)。編集後だけが変わったとき(足し戻しなど)は、基準の側を計算し直さない
    let baseCache: { key: string; origins: OriginStops; ref: RefLoadResult; promise: Promise<ReachSide> } | null = null
    // 利用者が時間帯を選んだか。選んだあとは、比較の結果で時間帯を動かさない
    let hourChosenByUser = false
    // 方針を承認したあとの最初の比較で、時間帯を選んだか(読み込み直すまで1回だけ)
    let autoHourDone = false

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
      edited: null,
      compareMode: 'diff',
      origins: null,
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
        baseCache = null
        hourChosenByUser = false
        autoHourDone = false
        if (!source) {
          set({ source: null, edited: null, origins: null, date: null, snapshot: null, error: null, computing: false })
          return
        }
        const date = defaultServiceDate(source.feed, source.period, deps.today())
        set({ source, edited: null, origins: originStops(source.feed, source.stops), date, snapshot: null, error: null })
        void get().recompute()
      },

      setEdited(edited) {
        const { source, date } = get()
        if (!source) {
          // 基準が無ければ比べられない(読み込み直しの途中など)
          set({ edited: null })
          return
        }
        let nextDate = date
        if (edited?.period && (date === null || date < edited.period.start || date > edited.period.end)) {
          nextDate = defaultServiceDate(edited.feed, edited.period, deps.today())
        }
        set({ edited, date: nextDate })
        schedule(0)
      },

      setCompareMode(mode) {
        set({ compareMode: mode })
      },

      setDate(date) {
        const { edited } = get()
        const period = selectablePeriod(get())
        if (!period) return edited ? NO_EDITED_SERVICE_DAYS : NO_SERVICE_DAYS
        if (!isValidGtfsDate(date) || date < period.start || date > period.end) {
          return edited ? `比べられるのは減便後の GTFS の運行期間(${slashDate(period.start)}〜${slashDate(period.end)})の日付です。` : OUT_OF_PERIOD
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
        hourChosenByUser = true
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
        baseCache = null
        set({ ref: { status: 'idle' } })
        schedule(0)
      },

      async recompute() {
        cancelTimer()
        const id = ++seq
        const { source, edited, origins, date, stepHours, params, fallbackClass } = get()
        if (!source || !origins || !date) {
          set({ computing: false })
          return
        }
        if (!pointsBounds(origins.stops)) {
          set({ computing: false, snapshot: null, error: pointsBounds(source.stops) ? NO_ORIGINS : NO_STOPS })
          return
        }
        set({ computing: true, error: null })
        try {
          // 1. 参照データ。起点の外接矩形を「バス停の距離の最大 + 駅の距離の最大」だけ広げた範囲の1次メッシュを読む
          //    (分数が変われば変わることがある)
          const mesh1s = refMeshesFor(origins.stops, refMarginM(params))
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

          // 2. 時間帯ごとの出発(画面の GTFS はメインスレッドにあるので、ここで数える)と、
          // 3. 到達圏(Web Worker)。基準も編集後も、基準の起点の停留所だけを渡す(computeReach は渡された停留所をすべて起点とみなす)。
          //    起点が同じなので、調べるセル・区分・coverable・推計人口は前後で等しく、出発の数だけが違う
          const bands = makeBands(stepHours)
          const usedParams = cloneParams(params)
          const refData = refResult.ok ? refResult.ref : null
          const sideOf = async (feed: GtfsFeed): Promise<ReachSide> => {
            const departures = departureCountsByBand(feed, servicesFor(feed, date), bands)
            const result = await deps.compute({
              stops: buildReachStops(origins.stops, departures.counts, bands.length),
              ref: refData,
              fallbackClass,
              params: usedParams,
              bandCount: bands.length,
            })
            return { departures, result, summary: summarizeReach(result) }
          }

          // 基準の結果は、日付・時間帯の幅・条件・参照データが同じなら使い回す(計算中なら、その計算を待つ)。
          // 後の計算に追い越されても、同じ基準・同じ条件の結果なので取っておく。失敗したら捨てる
          const baseKey = [date, stepHours, JSON.stringify(usedParams), fallbackClass, key].join('|')
          let basePromise: Promise<ReachSide>
          if (baseCache && baseCache.key === baseKey && baseCache.origins === origins && baseCache.ref === refResult) {
            basePromise = baseCache.promise
          } else {
            basePromise = sideOf(source.feed)
            const entry = { key: baseKey, origins, ref: refResult, promise: basePromise }
            baseCache = entry
            basePromise.catch(() => {
              if (baseCache === entry) baseCache = null
            })
          }
          const [base, after] = await Promise.all([basePromise, edited ? sideOf(edited.feed) : Promise.resolve(null)])
          if (id !== seq) return

          const origin: OriginCounts = {
            origins: origins.stops.length,
            unused: origins.unused,
            nonStop: origins.nonStop,
            noBoarding: origins.noBoarding,
          }
          const common = { date, stepHours, bands, params: usedParams, origin }
          if (!edited || !after) {
            set({ computing: false, snapshot: { ...common, ...base } })
            return
          }

          // 4. 前後の比較。分母は基準の coverable のセル
          const comparison = compareReach(base.result, after.result)
          const snapshot: ReachSnapshot = {
            ...common,
            ...after,
            baseline: base,
            comparison,
            zeroStops: zeroServiceStops(origins.stops, base.departures, after.departures, edited.feed),
            zeroRoutes: zeroServiceRoutes(source.feed, edited.feed, date),
            draft: edited.draft,
          }
          // 方針を承認したあとの最初の比較で、減便で外れたセルが最も多い時間帯を選ぶ(既定の 6時のままだと夜の空白が見えないため)
          const autoHour = !edited.draft && !autoHourDone && !hourChosenByUser
          if (!edited.draft) autoHourDone = true
          const best = autoHour ? bandWithMostLost(comparison) : -1
          set(best >= 0 ? { computing: false, snapshot, selectedHour: bands[best].startHour } : { computing: false, snapshot })
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
