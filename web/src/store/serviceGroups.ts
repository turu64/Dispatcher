import { create } from 'zustand'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { editGroups, resetToProposal } from '@/gtfs/groups/edit'
import { computeServiceFeatures } from '@/gtfs/groups/features'
import { fetchJevStatus, judgeServices } from '@/gtfs/groups/jevClient'
import { buildJevRequest } from '@/gtfs/groups/jevRequest'
import { dropJevAnswers, mergeJevAnswers } from '@/gtfs/groups/merge'
import { buildByKind, editsOf, proposeGroups } from '@/gtfs/groups/rules'
import {
  type GroupEdit,
  type JevFailureKind,
  type JevJudgeRequest,
  type JevJudgeResponse,
  type JevOutcome,
  type JevStatus,
  type ServiceGroups,
} from '@/gtfs/groups/types'
import type { HolidayList } from '@/gtfs/holidays'
import type { GtfsFeed } from '@/gtfs/load'
import { useGtfsStore } from './gtfs'
import { useHolidayStore, type HolidayState } from './holidays'

/**
 * Jev の問い合わせの状態(docs/design-service-groups.md §3.6・§5.5)。
 * - idle:GTFS を読み込んでいない、またはグループ分けをまだ計算していない
 * - notNeeded:単純な GTFS、または問う service が無い(呼ばない)
 * - awaitingConsent:規則で決まらない service がある。Jev に送るかを利用者に聞いている(JevConsentDialog。答えるまで送らない)
 * - off:利用者が送らないと答えた(規則だけで分けた)
 * - checking:Jev を使えるかをサーバーに確かめている。sending:判断材料を送り、答えを待っている
 * - done:全部の答えを得た。partial:一部の答えだけを得た(残りは failures)
 * - unavailable:Jev を使えない(キーが無い・1日の上限・接続できない)。failed:送ったが答えを得られなかった
 * - stopped:送っている間に利用者が中断した(届いた分は捨てた)。dropped:答えを得たあとで、利用者が捨てた
 */
export type JevState =
  | 'idle'
  | 'notNeeded'
  | 'awaitingConsent'
  | 'off'
  | 'checking'
  | 'sending'
  | 'done'
  | 'partial'
  | 'unavailable'
  | 'failed'
  | 'stopped'
  | 'dropped'

export interface JevInfo {
  state: JevState
  /** GET /api/service-groups の答え。確かめる前・確かめなかったときは null */
  status: JevStatus | null
  /**
   * サーバーの答え(results・failures と、サーバーが実際に送った本文 sent)。
   * 答えを捨てた(dropped)あとも残す(「送った情報を見る」で、外に出た判断材料を見せるため)
   */
  response: JevJudgeResponse | null
  /** 上限のために問わなかった service_id(buildJevRequest の omitted) */
  omitted: string[]
  /** 問い合わせる service の数(buildJevRequest の targets の service_id の数。同じ service をほかの役割でも問うときは1つに数える) */
  asking: number
  /** 画面に出す1行の知らせ。無ければ null */
  message: string | null
  /**
   * 判断材料をサーバーに送った(sending まで進んだ)。checking で止めた・使えなかったときは false。
   * 運営情報のページの「データの送り先」は、これが true のときだけ出す(サーバーが入口で断ったときも、送ったかもしれない側に倒して出す)
   */
  sent: boolean
}

/**
 * Jev の答えを待っているか(送るかを聞いている・使えるかを確かめている・答えを待っている)。
 * 待っている間は、グループ分けが変わりうるので、減便の方針の手順と AI はダイヤ単位で選ばない(groupedPolicyServices の ready が false)
 */
export function jevPending(state: JevState): boolean {
  return state === 'awaitingConsent' || state === 'checking' || state === 'sending'
}

export type GroupsStatus = 'idle' | 'waitingHolidays' | 'ready'

export interface ServiceGroupsState {
  /** idle:GTFS が無い。waitingHolidays:祝日一覧の読み込みを待っている。ready:グループ分けを計算した */
  status: GroupsStatus
  /**
   * 判断材料・規則の案・Jev の答え・利用者の直し(A の proposeGroups・mergeJevAnswers・editGroups の結果)。
   * 確定のしくみは持たない(指摘19。docs/tasks-1105.md の U04)。読み込みの手順は結果を見せるだけで、直しは減便の方針の手順の
   * 詳しい設定(GroupReplaceFields の手動の欄)から edit で入れる。最後の確かめは減便の方針の「対象便を確かめる」
   */
  groups: ServiceGroups | null
  jev: JevInfo

  /**
   * GTFS を読み込んだとき。祝日一覧の状態が決まってから1回だけ計算する。
   * 規則で決まらない service があれば、Jev に送るかを利用者に聞く(awaitingConsent。自動では送らない)
   */
  start: (feed: GtfsFeed) => void
  /** 祝日一覧の状態が変わったとき。待っていれば計算する */
  holidaysChanged: () => void
  /** 聞いている(awaitingConsent)ときに「Jev に送る」と答えた。送る */
  acceptJev: () => Promise<void>
  /** 聞いている(awaitingConsent)ときに「送らずに規則だけで進める」と答えた。送らずに off にする */
  declineJev: () => void
  /** Jev に問い合わせる(送らないと答えた・中断した・失敗したあとに、利用者がボタンで頼んだとき。聞いている間も受け付ける) */
  askJev: () => Promise<void>
  /** 送っている間に中断する。届いた答えは捨て、規則の案のままにする */
  stopJev: () => void
  /** 得た答えを捨て、規則の案にする(利用者が直した行は残す) */
  dropJev: () => void
  /**
   * 割り当て・扱いを直す。複数の直しは順に当てて、1回で反映する(手動の欄の1つの操作が、割り当ての付け替えと扱いの両方を変えるため)
   */
  edit: (edit: GroupEdit | readonly GroupEdit[]) => void
  /**
   * その service の直しを捨てて、規則と Jev の案に戻す。kind を渡せば、その方針の種類の直しだけを捨てる
   * (手動の欄の「案に戻す」。いま見ている種類だけを戻し、ほかの種類の直しは残す)。省けば、すべての種類で捨てる
   */
  resetRow: (serviceId: string, kind?: PolicyKind) => void
  /** その方針の種類の直しをすべて捨てて、規則と Jev の案に戻す(減便の方針の詳しい設定で「自動」に戻したとき) */
  resetKind: (kind: PolicyKind) => void
  /** GTFS を読み込み直したとき・削除したとき(store/reset.ts の resetAll)。送っている問い合わせも、利用者の答えを待っている状態も捨てる */
  reset: () => void
}

export interface ServiceGroupsDeps {
  /** 祝日一覧の状態 */
  holidays: () => HolidayState
  /** 判断材料と規則の案を作る(テストで差し替える) */
  compute?: (feed: GtfsFeed, holidays: HolidayList | null) => ServiceGroups
  fetchStatus: (signal: AbortSignal) => Promise<JevStatus>
  judge: (request: JevJudgeRequest, signal: AbortSignal) => Promise<JevOutcome>
}

const IDLE_JEV: JevInfo = { state: 'idle', status: null, response: null, omitted: [], asking: 0, message: null, sent: false }

function initial(): Pick<ServiceGroupsState, 'status' | 'groups' | 'jev'> {
  return { status: 'idle', groups: null, jev: { ...IDLE_JEV, omitted: [] } }
}

function defaultCompute(feed: GtfsFeed, holidays: HolidayList | null): ServiceGroups {
  return proposeGroups(computeServiceFeatures(feed, holidays))
}

/** 祝日一覧の状態が決まったか(読めた・読めなかった)。決まったら祝日一覧(読めなければ null)を返す */
function settledHolidays(h: HolidayState): { list: HolidayList | null } | null {
  if (h.status === 'ready') return { list: h.list }
  if (h.status === 'missing' || h.status === 'error') return { list: null }
  return null
}

const STATUS_MESSAGES: Record<NonNullable<JevStatus['reason']>, string> = {
  noKey: 'サーバーに Jev のキーが設定されていないため、規則だけで分けました。',
  badUrl: 'サーバーの Jev の送り先の設定が正しくないため、規則だけで分けました。',
  dailyLimit: 'Jev への問い合わせが今日の上限に達したため、規則だけで分けました。',
  unavailable: 'この環境では Jev を使えないため、規則だけで分けました。',
}

const FAILURE_LABELS: Record<JevFailureKind, string> = {
  timeout: '時間切れ',
  rate_limited: '回数の上限',
  upstream: 'Jev の誤り',
  invalid_answer: '答えの形の誤り',
  budget: '1日の上限',
}

/** 答えを得られなかった target の数と理由の1文 */
export function failureSummary(failures: JevJudgeResponse['failures']): string {
  const kinds = [...new Set(failures.map((f) => FAILURE_LABELS[f.error]))]
  return `${failures.length} 件は答えを得られませんでした(${kinds.join('・')})。`
}

/** グループ分けの store を作る(テストでは問い合わせを差し替える) */
export function createServiceGroupsStore(deps: ServiceGroupsDeps) {
  const compute = deps.compute ?? defaultCompute
  // 問い合わせの番号。読み込み直し・中断で進め、古い問い合わせの答えを捨てる(到達圏の計算と同じ考え)
  let seq = 0
  let controller: AbortController | null = null
  // 祝日一覧を待っている GTFS
  let pending: GtfsFeed | null = null

  function abort() {
    seq += 1
    controller?.abort()
    controller = null
  }

  return create<ServiceGroupsState>()((set, get) => {
    function setJev(patch: Partial<JevInfo>) {
      set({ jev: { ...get().jev, ...patch } })
    }

    /**
     * 送る判断材料を作る。単純な GTFS・問う service が無いときは notNeeded にして null を返す。
     * 送るかを聞く前と、送る直前の両方で作る(送らないと答えたあとに表を直してから頼むこともあるため)
     */
    function buildRequest(): { request: JevJudgeRequest; omitted: string[] } | null {
      const groups = get().groups
      if (!groups) return null
      if (groups.simple) {
        setJev({ state: 'notNeeded', message: null })
        return null
      }
      const built = buildJevRequest(groups.features, groups)
      if (built === null) {
        setJev({ state: 'notNeeded', message: '規則で決まらない service がないため、Jev には問い合わせていません。' })
        return null
      }
      return built
    }

    /** 計算した直後。問う service があれば、送らずに利用者の答えを待つ */
    function requestConsent() {
      const built = buildRequest()
      if (!built) return
      const asking = new Set(built.request.targets.map((t) => t.serviceId)).size
      setJev({ state: 'awaitingConsent', status: null, response: null, omitted: built.omitted, asking, message: null, sent: false })
    }

    /** 送る(利用者が「Jev に送る」と答えた・ボタンで頼んだとき) */
    async function runJev(): Promise<void> {
      const built = buildRequest()
      if (!built) return
      const asking = new Set(built.request.targets.map((t) => t.serviceId)).size
      abort()
      const mine = seq
      const ctrl = new AbortController()
      controller = ctrl
      setJev({ state: 'checking', status: null, response: null, omitted: built.omitted, asking, message: null, sent: false })

      let status: JevStatus
      try {
        status = await deps.fetchStatus(ctrl.signal)
      } catch {
        // 中断(AbortError)のときは stopJev・reset が状態を決めている
        if (mine !== seq) return
        status = { available: false, provider: null, via: null, reason: 'unavailable' }
      }
      if (mine !== seq) return
      if (!status.available) {
        controller = null
        setJev({ state: 'unavailable', status, message: STATUS_MESSAGES[status.reason ?? 'unavailable'] })
        return
      }
      setJev({ state: 'sending', status, sent: true })

      const outcome = await deps.judge(built.request, ctrl.signal)
      if (mine !== seq) return
      controller = null
      if (!outcome.ok) {
        const state: JevState = outcome.error === 'aborted' ? 'stopped' : outcome.error === 'noKey' || outcome.error === 'unavailable' ? 'unavailable' : 'failed'
        setJev({ state, message: outcome.message })
        return
      }
      const { response } = outcome
      const current = get().groups
      if (!current) return
      if (response.results.length === 0) {
        set({
          jev: {
            ...get().jev,
            state: 'failed',
            response,
            message: `Jev から答えを得られなかったため、規則だけで分けました。${response.failures.length > 0 ? failureSummary(response.failures) : ''}`,
          },
        })
        return
      }
      const merged = mergeJevAnswers(current, response)
      set({
        groups: merged,
        jev: {
          ...get().jev,
          state: response.failures.length > 0 ? 'partial' : 'done',
          response,
          message: response.failures.length > 0 ? `${failureSummary(response.failures)}その service は規則で分けています。` : null,
        },
      })
    }

    function computeNow(feed: GtfsFeed, list: HolidayList | null) {
      pending = null
      const groups = compute(feed, list)
      set({ status: 'ready', groups, jev: { ...IDLE_JEV, omitted: [] } })
      requestConsent()
    }

    return {
      ...initial(),

      start: (feed) => {
        abort()
        const settled = settledHolidays(deps.holidays())
        if (settled) {
          computeNow(feed, settled.list)
          return
        }
        pending = feed
        set({ ...initial(), status: 'waitingHolidays' })
      },

      holidaysChanged: () => {
        if (pending === null || get().status !== 'waitingHolidays') return
        const settled = settledHolidays(deps.holidays())
        if (settled) computeNow(pending, settled.list)
      },

      // 答えのボタンは、聞いている間だけ効く。AlertDialogAction は押すと閉じる(onOpenChange(false) → declineJev)ので、
      // 「Jev に送る」で checking に進んだあとの declineJev は何もしない
      acceptJev: async () => {
        if (get().jev.state !== 'awaitingConsent') return
        await runJev()
      },

      declineJev: () => {
        if (get().jev.state !== 'awaitingConsent') return
        setJev({ state: 'off', message: 'Jev に送らず、規則だけで分けました。' })
      },

      askJev: async () => {
        const { groups, jev } = get()
        if (!groups || groups.simple) return
        if (jev.state !== 'awaitingConsent' && jev.state !== 'off' && jev.state !== 'stopped' && jev.state !== 'failed') return
        await runJev()
      },

      stopJev: () => {
        const { state } = get().jev
        if (state !== 'checking' && state !== 'sending') return
        abort()
        setJev({ state: 'stopped', response: null, message: 'Jev への問い合わせをやめました。規則だけで分けています。' })
      },

      dropJev: () => {
        const { groups, jev } = get()
        if (!groups || (jev.state !== 'done' && jev.state !== 'partial')) return
        set({
          groups: dropJevAnswers(groups),
          jev: { ...jev, state: 'dropped', message: 'Jev の判断を使わず、規則だけで分けています。' },
        })
      },

      edit: (e) => {
        const { groups } = get()
        if (!groups) return
        const list: readonly GroupEdit[] = Array.isArray(e) ? e : [e as GroupEdit]
        const next = list.reduce((g, one) => editGroups(g, one), groups)
        if (next !== groups) set({ groups: next })
      },

      resetRow: (serviceId, kind) => {
        const { groups } = get()
        if (!groups) return
        if (kind === undefined) {
          set({ groups: resetToProposal(groups, serviceId) })
          return
        }
        const edits = editsOf(groups)
        const had = edits[kind].into.delete(serviceId)
        const hadTreatment = edits[kind].treatment.delete(serviceId)
        if (!had && !hadTreatment) return
        set({ groups: { ...groups, byKind: buildByKind(groups.features, groups.jev, edits) } })
      },

      resetKind: (kind) => {
        const { groups } = get()
        if (!groups) return
        const edits = editsOf(groups)
        if (edits[kind].into.size === 0 && edits[kind].treatment.size === 0) return
        edits[kind].into.clear()
        edits[kind].treatment.clear()
        set({ groups: { ...groups, byKind: buildByKind(groups.features, groups.jev, edits) } })
      },

      reset: () => {
        abort()
        pending = null
        set(initial())
      },
    }
  })
}

/**
 * グループ分けを持つ。GTFS を読み込んだら(useGtfsStore の feed が変わったら)計算し、規則で決まらない service があれば
 * Jev に送るかを利用者に聞く。祝日一覧がまだなら、読み込み(または失敗)を待ってから1回だけ計算する(祝日一覧が後から届いて2回聞くのを防ぐ)
 */
export const useServiceGroupsStore = createServiceGroupsStore({
  holidays: () => useHolidayStore.getState().holidays,
  fetchStatus: (signal) => fetchJevStatus(signal),
  judge: (request, signal) => judgeServices(request, signal),
})

useGtfsStore.subscribe((s, prev) => {
  if (s.feed === prev.feed) return
  if (s.feed) useServiceGroupsStore.getState().start(s.feed)
  else useServiceGroupsStore.getState().reset()
})

useHolidayStore.subscribe((s, prev) => {
  if (s.holidays !== prev.holidays) useServiceGroupsStore.getState().holidaysChanged()
})

{
  const feed = useGtfsStore.getState().feed
  if (feed) useServiceGroupsStore.getState().start(feed)
}
