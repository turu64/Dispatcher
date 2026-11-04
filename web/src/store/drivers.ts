import { useMemo } from 'react'
import { create } from 'zustand'
import {
  DUTY_DEFAULTS,
  estimateDuties,
  operatorRunsOf,
  stopPointsOf,
  type DutyEstimate,
  type DutyParams,
  type DutyPlace,
  type StopPoint,
} from '@/gtfs/edit/duties'
import { activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import {
  compareServiceHours,
  serviceHours,
  tripLegs,
  type ServiceHours,
  type ServiceHoursComparison,
} from '@/gtfs/edit/serviceHours'
import type { GtfsFeed } from '@/gtfs/load'
import { describeServiceDay } from '@/lib/serviceDay'
import { lastVersion, useEditStore, type EditState } from './edit'
import { useGtfsStore } from './gtfs'
import { useReachStore } from './reach'

/**
 * 要る運転士の数(目安)の入力と、減便の前後の比較(指摘 24・18.1、docs/tasks-1105.md の D03)。
 * 画面は影響(到達圏)の手順の components/steps/reach/DriverPanel.tsx。値はメモリだけに持ち、ブラウザにもサーバーにも保存しない。
 *
 * - 欠員:その日に乗務できない運転士の数(0〜999 の整数。空なら null)
 * - 仮定:勤務の数の推定(gtfs/edit/duties.ts の estimateDuties)に渡す値。画面で変えるのは拘束の上限(13/15 時間)・点呼の分・回送の速さ
 * - 営業所・車庫・休憩施設:型と空の配列だけ(D05 で足す)
 *
 * GTFS を読み込み直すと(削除しても)、欠員と施設は消える(store/gtfs の feed を見張る。store/research.ts と同じ)。仮定は残す
 * (到達圏の条件と同じく、利用者の設定として別の GTFS でも使う)。
 */

/** 欠員の人数の上限 */
export const MAX_SHORTAGE = 999

interface DriverState {
  /** 欠員(その日に乗務できない運転士の数)。入れていなければ null */
  shortage: number | null
  /** 勤務の数の推定の仮定(DUTY_DEFAULTS から始める) */
  params: DutyParams
  /** 営業所・車庫・休憩施設(D05。今は空のまま) */
  places: DutyPlace[]
  setShortage: (value: number | null) => void
  setParams: (patch: Partial<DutyParams>) => void
  /** 仮定を既定に戻す */
  resetParams: () => void
  setPlaces: (places: DutyPlace[]) => void
  /** 欠員と施設を消す(GTFS の読み込み直し・削除) */
  reset: () => void
}

export const useDriversStore = create<DriverState>()((set) => ({
  shortage: null,
  params: { ...DUTY_DEFAULTS },
  places: [],
  setShortage: (value) => {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > MAX_SHORTAGE)) return
    set({ shortage: value })
  },
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  resetParams: () => set({ params: { ...DUTY_DEFAULTS } }),
  setPlaces: (places) => set({ places }),
  reset: () => set({ shortage: null, places: [] }),
}))

// GTFS を読み込み直したら(捨てたときも)、前の GTFS の欠員と施設を消す
useGtfsStore.subscribe((s, prev) => {
  if (s.feed !== prev.feed) useDriversStore.getState().reset()
})

/** 1つの GTFS の、比較する日付の便・営業運行時間・勤務の数 */
export interface DriverSide {
  hours: ServiceHours
  duties: DutyEstimate
  /** 時刻が読めず、勤務につながなかった便の数 */
  unknownTrips: number
}

/**
 * 欠員に対する判定。判定は「減便で減る勤務の数(前 − 後)」と欠員の比較だけ
 * - noEdited:減便後の GTFS が無い
 * - notWeekday:比較する日付に、減便前の平日ダイヤ(減便の方針で入れ替える平日の service)が走らない
 * - noShortage:欠員を入れていない
 * - enough:減る勤務の数 ≥ 欠員
 * - short:減る勤務の数 < 欠員。missing は 欠員 − 減る勤務の数
 */
export type DriverVerdict =
  | { kind: 'noEdited' }
  | { kind: 'notWeekday' }
  | { kind: 'noShortage'; reduced: number }
  | { kind: 'enough'; reduced: number; shortage: number }
  | { kind: 'short'; reduced: number; shortage: number; missing: number }

export interface DriverComparison {
  /** 比較する日付('YYYYMMDD') */
  date: string
  before: DriverSide
  /** 減便後の GTFS が無ければ null */
  after: DriverSide | null
  /** 減便後が下書き(承認前)なら true */
  draft: boolean
  /** 便の数と営業運行時間の前後(減便後が無ければ null) */
  hours: ServiceHoursComparison | null
  /** 勤務の数の差(前 − 後。減ったら正)。減便後が無ければ null */
  dutyDiff: number | null
  /** 減便前の入力の運用番号の数(参考)。取れないときは null */
  operatorRuns: number | null
  /**
   * 比較する日付に、減便前の平日ダイヤが走るか。減便の方針が分からないとき(減便後が無い・元に戻す下書きで基準に戻るとき)は null
   */
  weekday: boolean | null
  shortage: number | null
  verdict: DriverVerdict
  /** 使った仮定の文(duties.ts の dutyAssumptions) */
  assumptions: string[]
}

export interface DriverInput {
  /** 減便前の GTFS */
  base: GtfsFeed
  /** 減便後の GTFS(下書きを含む)。無ければ null */
  edited: { feed: GtfsFeed; draft: boolean } | null
  date: string
  /** 減便の方針で入れ替える平日の service(activeWeekdayServicesOf)。分からなければ null */
  weekdayServices: ReadonlySet<string> | null
  params: DutyParams
  places: readonly DutyPlace[]
  shortage: number | null
}

// 同じ GTFS・日付・仮定なら計算し直さない(手順を移ったり欠員を打ったりするたびに推定し直さないため)
const sideCache = new WeakMap<GtfsFeed, Map<string, DriverSide>>()
const pointCache = new WeakMap<GtfsFeed, Map<string, StopPoint>>()

function stopPoints(feed: GtfsFeed): Map<string, StopPoint> {
  let points = pointCache.get(feed)
  if (!points) {
    points = stopPointsOf(feed)
    pointCache.set(feed, points)
  }
  return points
}

/** その日に走る service(不正な日付なら空) */
function servicesOn(feed: GtfsFeed, date: string): string[] {
  try {
    return describeServiceDay(feed, date).serviceIds
  } catch {
    return []
  }
}

/** 1つの GTFS の、その日の便・営業運行時間・勤務の数 */
export function driverSide(feed: GtfsFeed, date: string, params: DutyParams, places: readonly DutyPlace[] = []): DriverSide {
  const key = JSON.stringify([date, params, places])
  let byKey = sideCache.get(feed)
  const cached = byKey?.get(key)
  if (cached) return cached
  const services = servicesOn(feed, date)
  const { legs, unknownTrips } = tripLegs(feed, services)
  const side: DriverSide = {
    hours: serviceHours(feed, services),
    duties: estimateDuties(legs, stopPoints(feed), params, places),
    unknownTrips,
  }
  if (!byKey) {
    byKey = new Map()
    sideCache.set(feed, byKey)
  }
  byKey.set(key, side)
  return side
}

/**
 * 減便前の入力の運用番号の数(参考)。その日に走る service が1つで、trip_id が運用番号の形(operatorRunsOf)のときだけ。
 * 2つ以上の service が走る日は、運用番号が service をまたいで重なりうるので出さない
 */
function operatorRunsOn(feed: GtfsFeed, date: string): number | null {
  const services = servicesOn(feed, date)
  return services.length === 1 ? operatorRunsOf(feed, services[0]) : null
}

function verdictOf(
  after: DriverSide | null,
  weekday: boolean | null,
  dutyDiff: number | null,
  shortage: number | null,
): DriverVerdict {
  if (!after || dutyDiff === null) return { kind: 'noEdited' }
  if (weekday === false) return { kind: 'notWeekday' }
  if (shortage === null) return { kind: 'noShortage', reduced: dutyDiff }
  if (dutyDiff >= shortage) return { kind: 'enough', reduced: dutyDiff, shortage }
  return { kind: 'short', reduced: dutyDiff, shortage, missing: shortage - dutyDiff }
}

/** 減便の前後の便・営業運行時間・勤務の数を比べ、欠員と照らす */
export function compareDrivers(input: DriverInput): DriverComparison {
  const { base, edited, date, weekdayServices, params, places, shortage } = input
  const before = driverSide(base, date, params, places)
  const after = edited ? driverSide(edited.feed, date, params, places) : null
  const weekday =
    weekdayServices === null ? null : servicesOn(base, date).some((s) => weekdayServices.has(s))
  const dutyDiff = after ? before.duties.dutyCount - after.duties.dutyCount : null
  return {
    date,
    before,
    after,
    draft: edited?.draft ?? false,
    hours: after ? compareServiceHours(before.hours, after.hours) : null,
    dutyDiff,
    operatorRuns: operatorRunsOn(base, date),
    weekday,
    shortage,
    verdict: verdictOf(after, weekday, dutyDiff, shortage),
    assumptions: before.duties.assumptions,
  }
}

/**
 * 減便後の GTFS の元になった版(到達圏の store に渡している編集後と同じ選び方。store/edit.ts の editedSource)。
 * 承認待ちの下書き、元に戻す下書きの戻した後の版、承認済みの最後の版の順。基準に戻るときと編集が無いときは null
 */
function shownResult(state: Pick<EditState, 'draft' | 'versions'>): Form2Result | null {
  const { draft } = state
  if (draft?.kind === 'op' && draft.outcome.ok) return draft.outcome.result
  if (draft?.kind === 'undo') return draft.result
  return lastVersion(state)
}

/** 減便の方針で入れ替える平日の service(期間に走らないため組ごと除いたものを除く)。方針が分からなければ null */
export function weekdayServicesOfEdit(state: Pick<EditState, 'draft' | 'versions'>): Set<string> | null {
  const result = shownResult(state)
  return result ? activeWeekdayServicesOf(result) : null
}

/**
 * 画面の今の状態(減便前の GTFS・減便後の GTFS・比較する日付・欠員・仮定)での比較。
 * GTFS か比較する日付が無ければ null。影響(到達圏)の手順の DriverPanel が使う
 */
export function useDriverComparison(): DriverComparison | null {
  const base = useReachStore((s) => s.source?.feed ?? null)
  const edited = useReachStore((s) => s.edited)
  const date = useReachStore((s) => s.date)
  const draft = useEditStore((s) => s.draft)
  const versions = useEditStore((s) => s.versions)
  const shortage = useDriversStore((s) => s.shortage)
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  const weekdayServices = useMemo(() => weekdayServicesOfEdit({ draft, versions }), [draft, versions])
  return useMemo(() => {
    if (!base || !date) return null
    return compareDrivers({
      base,
      edited: edited ? { feed: edited.feed, draft: edited.draft } : null,
      date,
      weekdayServices,
      params,
      places,
      shortage,
    })
  }, [base, edited, date, weekdayServices, params, places, shortage])
}
