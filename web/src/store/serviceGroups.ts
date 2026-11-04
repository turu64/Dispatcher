import { create } from 'zustand'
import { canConfirm, editGroups, resetToProposal } from '@/gtfs/groups/edit'
import { computeServiceFeatures } from '@/gtfs/groups/features'
import { fetchJevStatus, judgeServices } from '@/gtfs/groups/jevClient'
import { buildJevRequest } from '@/gtfs/groups/jevRequest'
import { dropJevAnswers, mergeJevAnswers } from '@/gtfs/groups/merge'
import { proposeGroups } from '@/gtfs/groups/rules'
import {
  POLICY_KINDS,
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
 * - off:スイッチが切れていたため送らなかった
 * - checking:Jev を使えるかをサーバーに確かめている。sending:判断材料を送り、答えを待っている
 * - done:全部の答えを得た。partial:一部の答えだけを得た(残りは failures)
 * - unavailable:Jev を使えない(キーが無い・1日の上限・接続できない)。failed:送ったが答えを得られなかった
 * - stopped:送っている間に利用者が中断した(届いた分は捨てた)。dropped:答えを得たあとで、利用者が捨てた
 */
export type JevState =
  | 'idle'
  | 'notNeeded'
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
  /** 画面に出す1行の知らせ。無ければ null */
  message: string | null
  /**
   * 判断材料をサーバーに送った(sending まで進んだ)。checking で止めた・使えなかったときは false。
   * 運営情報のページの「データの送り先」は、これが true のときだけ出す(サーバーが入口で断ったときも、送ったかもしれない側に倒して出す)
   */
  sent: boolean
}

export type GroupsStatus = 'idle' | 'waitingHolidays' | 'ready'

export interface ServiceGroupsState {
  /** idle:GTFS が無い。waitingHolidays:祝日一覧の読み込みを待っている。ready:グループ分けを計算した */
  status: GroupsStatus
  /** 判断材料・規則の案・Jev の答え・利用者の直し(A の proposeGroups・mergeJevAnswers・editGroups の結果) */
  groups: ServiceGroups | null
  /** 「このグループ分けで進める」を押した(単純な GTFS は読み込んだ時点で確定) */
  confirmed: boolean
  /**
   * 「単純でない GTFS では、service ごとの集計を Jev に送る」のスイッチ(既定はオン)。
   * ブラウザに保存しない。読み込み直し・削除でも戻さない(送るのを止めた利用者の選択を、黙って戻さないため)
   */
  jevEnabled: boolean
  jev: JevInfo

  /** GTFS を読み込んだとき。祝日一覧の状態が決まってから1回だけ計算し、そのあとで Jev を呼ぶ */
  start: (feed: GtfsFeed) => void
  /** 祝日一覧の状態が変わったとき。待っていれば計算する */
  holidaysChanged: () => void
  /** スイッチ。送っている間に切ったら、問い合わせをやめる */
  setJevEnabled: (on: boolean) => void
  /** Jev に問い合わせる(スイッチを切っていた・中断した・失敗したあとに、利用者がボタンで頼んだとき) */
  askJev: () => Promise<void>
  /** 送っている間に中断する。届いた答えは捨て、規則の案のままにする */
  stopJev: () => void
  /** 得た答えを捨て、規則の案にする(利用者が直した行は残す) */
  dropJev: () => void
  /** 区分・割り当て・扱いを直す */
  edit: (edit: GroupEdit) => void
  /** その service の直しを捨てて、規則と Jev の案に戻す */
  resetRow: (serviceId: string) => void
  /** 「このグループ分けで進める」。決まらない行が残っている間・Jev を待っている間はできない(false を返す) */
  confirm: () => boolean
  /** GTFS を読み込み直したとき・削除したとき(store/reset.ts の resetAll)。送っている問い合わせも捨てる。スイッチは残す */
  reset: () => void
  /**
   * 表を開く頼みの番号。減便の方針の手順の「読み込みの手順の表で直す」が進め、読み込みの手順の表(ServiceGroupsCard)が
   * 変わったのを見て表を開く。reset では戻さない(番号が変わったかだけを見るため)
   */
  tableRequest: number
  /** 読み込みの手順の表を開くよう頼む */
  showTable: () => void
}

export interface ServiceGroupsDeps {
  /** 祝日一覧の状態 */
  holidays: () => HolidayState
  /** 判断材料と規則の案を作る(テストで差し替える) */
  compute?: (feed: GtfsFeed, holidays: HolidayList | null) => ServiceGroups
  fetchStatus: (signal: AbortSignal) => Promise<JevStatus>
  judge: (request: JevJudgeRequest, signal: AbortSignal) => Promise<JevOutcome>
}

const IDLE_JEV: JevInfo = { state: 'idle', status: null, response: null, omitted: [], message: null, sent: false }

function initial(): Pick<ServiceGroupsState, 'status' | 'groups' | 'confirmed' | 'jev'> {
  return { status: 'idle', groups: null, confirmed: false, jev: { ...IDLE_JEV, omitted: [] } }
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

/** 確定を外す理由になる違いがあるか:割り当て・扱い、または確かめが要る行(決まらない・食い違い)の集まりが変わった */
export function groupingChanged(a: ServiceGroups, b: ServiceGroups): boolean {
  for (const kind of POLICY_KINDS) {
    const before = new Map(a.byKind[kind].rows.map((r) => [r.serviceId, r]))
    const rows = b.byKind[kind].rows
    if (rows.length !== before.size) return true
    for (const r of rows) {
      const p = before.get(r.serviceId)
      if (!p || p.into !== r.into || p.treatment !== r.treatment) return true
      const attention = (m: string | null) => m === 'undecided' || m === 'conflict'
      if (attention(p.intoMark) !== attention(r.intoMark) || attention(p.basisMark) !== attention(r.basisMark)) return true
    }
  }
  return false
}

/** 確定のあとで Jev の答えによってグループ分けが変わったときの文 */
export const UNCONFIRMED_BY_JEV = 'Jev の答えでグループ分けが変わったため、確定を外しました。表を確かめて、もう一度「このグループ分けで進める」を押してください。'

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

    async function runJev(): Promise<void> {
      const groups = get().groups
      if (!groups) return
      if (groups.simple) {
        setJev({ state: 'notNeeded', message: null })
        return
      }
      if (!get().jevEnabled) {
        setJev({ state: 'off', message: 'Jev に送らない設定のため、規則だけで分けました。' })
        return
      }
      const built = buildJevRequest(groups.features, groups)
      if (built === null) {
        setJev({ state: 'notNeeded', message: '規則で決まらない service がないため、Jev には問い合わせていません。' })
        return
      }
      abort()
      const mine = seq
      const ctrl = new AbortController()
      controller = ctrl
      setJev({ state: 'checking', status: null, response: null, omitted: built.omitted, message: null, sent: false })

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
      // 確定したあとに問い合わせ直して(askJev)分け方が変わったら、確定を外す(読み込みの手順と減便の方針の手順の言うことをそろえる)
      const unconfirm = get().confirmed && groupingChanged(current, merged)
      const parts = [
        response.failures.length > 0 ? `${failureSummary(response.failures)}その service は規則で分けています。` : '',
        unconfirm ? UNCONFIRMED_BY_JEV : '',
      ].join('')
      set({
        groups: merged,
        confirmed: get().confirmed && !unconfirm,
        // 確定を外したら、閉じていた表を開く(「表を確かめて」と言うため)
        tableRequest: unconfirm ? get().tableRequest + 1 : get().tableRequest,
        jev: {
          ...get().jev,
          state: response.failures.length > 0 ? 'partial' : 'done',
          response,
          message: parts === '' ? null : parts,
        },
      })
    }

    function computeNow(feed: GtfsFeed, list: HolidayList | null) {
      pending = null
      const groups = compute(feed, list)
      set({ status: 'ready', groups, confirmed: groups.simple, jev: { ...IDLE_JEV, omitted: [] } })
      void runJev()
    }

    return {
      ...initial(),
      jevEnabled: true,
      tableRequest: 0,
      showTable: () => set({ tableRequest: get().tableRequest + 1 }),

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

      setJevEnabled: (on) => {
        set({ jevEnabled: on })
        if (!on) {
          const { state } = get().jev
          if (state === 'checking' || state === 'sending') get().stopJev()
        }
      },

      askJev: async () => {
        const { groups, jev, jevEnabled } = get()
        if (!groups || groups.simple || !jevEnabled) return
        if (jev.state !== 'off' && jev.state !== 'stopped' && jev.state !== 'failed') return
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
        const next = dropJevAnswers(groups)
        set({
          groups: next,
          confirmed: get().confirmed && canConfirm(next),
          jev: { ...jev, state: 'dropped', message: 'Jev の判断を使わず、規則だけで分けています。' },
        })
      },

      edit: (e) => {
        const { groups } = get()
        if (!groups) return
        const next = editGroups(groups, e)
        // 決まらない行が戻ったら確定を外す(減便の方針の手順は undecidedReplacement で止まるため、表示をそろえる)
        set({ groups: next, confirmed: get().confirmed && canConfirm(next) })
      },

      resetRow: (serviceId) => {
        const { groups } = get()
        if (!groups) return
        const next = resetToProposal(groups, serviceId)
        set({ groups: next, confirmed: get().confirmed && canConfirm(next) })
      },

      confirm: () => {
        const { groups, jev } = get()
        if (!groups || !canConfirm(groups) || jev.state === 'checking' || jev.state === 'sending') return false
        set({ confirmed: true })
        return true
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
 * グループ分けを持つ。GTFS を読み込んだら(useGtfsStore の feed が変わったら)計算し、単純でない GTFS では Jev に問い合わせる。
 * 祝日一覧がまだなら、読み込み(または失敗)を待ってから1回だけ計算する(祝日一覧が後から届いて Jev に2回送るのを防ぐ)
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
