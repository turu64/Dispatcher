import { create } from 'zustand'
import { feedServicePeriod } from '../gtfs/calendar'
import { diffWeekdayTrips, type WeekdayDiff } from '../gtfs/edit/diff'
import { applyForm2, type Form2Outcome, type Form2Result } from '../gtfs/edit/form2'
import { planOf, type EditActor, type EditOp, type EditRecord } from '../gtfs/edit/ops'
import type { HolidayList } from '../gtfs/holidays'
import type { GtfsFeed } from '../gtfs/load'
import type { SampleGtfsInfo } from '../gtfs/sample'
import { validateEdit, type ValidationIssue } from '../gtfs/validate/edit'
import { useHolidayStore } from './holidays'
import { useReachStore, type EditedSource } from './reach'

/**
 * 編集の履歴・下書き・元に戻す(docs/interfaces-1104.md §4)。
 *
 * - 編集後のフィードは、基準と「承認済みの操作の列(history)」から毎回作り直す(applyForm2(基準, planOf(履歴)))。
 *   版ごとの結果(versions)を持つので、元に戻すときは作り直さない
 * - 操作はまず下書き(draft)になる。利用者が承認(commit)するまで、履歴は変わらない。下書きは1つだけ
 * - Claude の操作は必ず下書きになり、利用者が画面で承認する。下書きの行方は draftNotices で Claude に伝える(§10)
 */

/** 利用者が読み込んだ GTFS(基準) */
export interface BaseGtfs {
  feed: GtfsFeed
  /** 元の ZIP のバイト列(§9 の書き出しで、変えない表をそのまま写すため) */
  zip: ArrayBuffer
  label: string
  sample: SampleGtfsInfo | null
}

export type Draft =
  | {
      kind: 'op'
      /** 'd1'、'd2' … (store の中で増やす。Claude のツールの結果の draft_id) */
      id: string
      /** at は承認したときに入れ直す */
      record: EditRecord
      outcome: Form2Outcome
      /** outcome が失敗なら null */
      diff: WeekdayDiff | null
      /** outcome が失敗なら [] */
      issues: ValidationIssue[]
    }
  | {
      /** 元に戻す下書き(Claude の undo_edit)。承認すると undo() と同じことをする */
      kind: 'undo'
      id: string
      by: EditActor
      /** 戻したあとの版(history が1つなら null = 基準) */
      result: Form2Result | null
      diff: WeekdayDiff | null
    }

export type ProposeOutcome = { ok: true; draft: Draft } | { ok: false; message: string }
export type CommitOutcome = { ok: true } | { ok: false; message: string }

/** 下書きの行方。Claude に次の発言で伝える(§10) */
export interface DraftNotice {
  draftId: string
  by: EditActor
  result: 'committed' | 'discarded' | 'replaced'
  at: string
}

export interface EditState {
  base: BaseGtfs | null
  history: EditRecord[]
  /** versions[i] は history[0..i] を適用した結果 */
  versions: Form2Result[]
  draft: Draft | null
  /**
   * 利用者が出力の画面で入れた feed_version。空なら既定の規則(defaultFeedVersion)。
   * 手順を移っても残すために store に置く。読み込み直すと空に戻す
   */
  feedVersion: string
  setFeedVersion: (value: string) => void
  /** Claude にまだ伝えていない下書きの行方(Claude が出した下書きの分だけ) */
  draftNotices: DraftNotice[]
  /**
   * 下書きを作る(履歴は変えない)。
   * 下書きがあるとき:by が 'claude' なら ok: false(「下書き {id} が承認待ちです」)。
   * by が 'user' なら前の下書きを捨てて作る(Claude の下書きを捨てるときは、画面が先に確かめる。捨てた下書きは draftNotices に 'replaced')。
   * 方針(applyPolicy)を承認する前の足し戻し・取り消しは ok: false。
   * 方針を適用できない(applyForm2 が ok: false)ときも下書きは作り、承認(commit)で理由を返す
   */
  propose: (op: EditOp, by: EditActor) => ProposeOutcome
  /** 元に戻す下書きを作る。履歴が空なら ok: false。下書きがあるときの扱いは propose と同じ */
  proposeUndo: (by: EditActor) => ProposeOutcome
  /**
   * 下書きを承認して履歴に足す。下書きが無い、outcome.ok が false、または error の issue(exportOnly でないもの)があれば、
   * 何もせず ok: false と理由を返す
   */
  commit: () => CommitOutcome
  /** 下書きを捨てる(承認済みの最後の版に戻る) */
  discard: () => void
  /** 承認済みの最後の操作を1つ除く。下書きがあれば捨てる(下書きは今の履歴の上で作ったものなので) */
  undo: () => void
  /** 履歴を空にする(編集後のフィード = 基準)。下書きがあれば捨てる */
  undoAll: () => void
  /** Claude に伝えた分を消す(§10 のチャットが送るときに呼ぶ) */
  takeDraftNotices: () => DraftNotice[]
  /** 読み込み直しで呼ぶ。履歴と下書きを捨てる */
  setBase: (base: BaseGtfs | null) => void
  /**
   * 下書きの検証の結果(issues)を、今の祝日一覧で作り直す。祝日一覧は下書きを作った(propose)あとに読めることがあり、
   * 下書きの issues は propose のときに固定されるため。祝日の確かめ(holiday*)は warning・info なので、承認を止める判定は変わらない。
   * 下書きが無い、方針を適用できない下書き、元に戻す下書きでは何もしない。祝日一覧が変わったときに、store が自分で呼ぶ(watchHolidays)
   */
  refreshIssues: () => void
}

export interface EditStoreDeps {
  now: () => Date
  /** 編集後のフィードが変わったときに呼ぶ(到達圏の store の setEdited につなぐ) */
  onEdited: (edited: EditedSource | null) => void
  /**
   * 書き換えのたびの検証(validateEdit)に渡す祝日一覧。無ければ null(祝日の確かめを省く)。
   * 取り決めの EditStoreDeps に足したもの。省けば常に null
   */
  holidays?: () => HolidayList | null
  /**
   * 祝日一覧が変わったとき(あとから読めた、読み込み直した、読めなくなった)に onChange を呼ぶように、祝日の store を見張る。
   * 下書きの issues を作り直すため(refreshIssues)。省けば見張らない
   */
  watchHolidays?: (onChange: () => void) => void
}

/** 日本時間(UTC+9)の年・月・日・時・分・秒(2桁に詰めた文字列) */
function japanParts(now: Date): { y: string; mo: string; d: string; h: string; mi: string; s: string } {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    y: String(jst.getUTCFullYear()).padStart(4, '0'),
    mo: p(jst.getUTCMonth() + 1),
    d: p(jst.getUTCDate()),
    h: p(jst.getUTCHours()),
    mi: p(jst.getUTCMinutes()),
    s: p(jst.getUTCSeconds()),
  }
}

/** 作成日時 'YYYYMMDDhhmm'(日本時間)。パソコンの時計の時刻帯の設定に左右されない */
export function generatedAtOf(now: Date): string {
  const t = japanParts(now)
  return `${t.y}${t.mo}${t.d}${t.h}${t.mi}`
}

/** 承認した日時。ISO 8601 の日本時間('2026-11-04T09:30:00+09:00') */
export function japanIso(now: Date): string {
  const t = japanParts(now)
  return `${t.y}-${t.mo}-${t.d}T${t.h}:${t.mi}:${t.s}+09:00`
}

/** 承認を止める issue(error のうち、出力だけを止めるもの以外) */
export function blockingIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error' && !i.exportOnly)
}

/** 承認済みの最後の版(履歴が空なら null) */
export function lastVersion(state: Pick<EditState, 'versions'>): Form2Result | null {
  return state.versions.length > 0 ? state.versions[state.versions.length - 1] : null
}

function sourceOf(feed: GtfsFeed, draft: boolean): EditedSource {
  return { feed, period: feedServicePeriod(feed), draft }
}

// 版ごとの平日便の差(方針・足し戻し・出力の画面が同じ版の差を使うので、1回だけ計算する)
const diffCache = new WeakMap<Form2Result, { base: GtfsFeed; diff: WeekdayDiff }>()

/** 基準と版の平日便の差(diffWeekdayTrips)。同じ版なら計算し直さない */
export function diffOf(base: GtfsFeed, result: Form2Result): WeekdayDiff {
  const cached = diffCache.get(result)
  if (cached && cached.base === base) return cached.diff
  const diff = diffWeekdayTrips(base, result.feed, result.plan.weekdayService, result.plan.excludedRoutes)
  diffCache.set(result, { base, diff })
  return diff
}

const NO_BASE = 'GTFS を読み込んでから編集してください。'
const NO_POLICY = '減便の方針を承認してから、便を足し戻せます。'
const NO_HISTORY = '元に戻す編集がありません。'
const NO_DRAFT = '承認する下書きがありません。'

/** 編集の store を作る(テストでは時計と到達圏へのつなぎを差し替える) */
export function createEditStore(deps: EditStoreDeps) {
  const store = create<EditState>()((set, get) => {
    // 下書きの番号。読み込み直しても戻さない(Claude との会話で番号が重ならないように)
    let nextDraft = 1
    // 到達圏の store に最後に渡した値(同じものを続けて渡して、計算し直させないため)
    let published: { feed: GtfsFeed; draft: boolean } | null = null
    // 今の下書きの issues を作ったときの祝日一覧(refreshIssues で、一覧が変わっていなければ作り直さないため)
    let issuesBasis: HolidayList | null = null

    /** 下書きの検証(validateEdit)。そのときの祝日一覧で作り、どの一覧で作ったかを覚える */
    function issuesOf(base: BaseGtfs, result: Form2Result): ValidationIssue[] {
      issuesBasis = deps.holidays?.() ?? null
      return validateEdit(base.feed, result, issuesBasis)
    }

    /** 今の状態の編集後のフィード。下書きがあれば下書きの結果、無ければ最後の版、履歴が空なら null */
    function editedNow(): EditedSource | null {
      const { base, versions, draft } = get()
      if (!base) return null
      if (draft?.kind === 'op' && draft.outcome.ok) return sourceOf(draft.outcome.result.feed, true)
      // 元に戻す下書き:戻したあとの版(基準に戻るなら基準)を下書きとして比べる
      if (draft?.kind === 'undo') return sourceOf(draft.result ? draft.result.feed : base.feed, true)
      const last = lastVersion({ versions })
      return last ? sourceOf(last.feed, false) : null
    }

    function publish(): void {
      const edited = editedNow()
      const same = edited === null ? published === null : published !== null && published.feed === edited.feed && published.draft === edited.draft
      if (same) return
      published = edited ? { feed: edited.feed, draft: edited.draft } : null
      deps.onEdited(edited)
    }

    function actorOf(draft: Draft): EditActor {
      return draft.kind === 'op' ? draft.record.by : draft.by
    }

    /** 下書きの行方を残す(Claude の下書きの分だけ) */
    function noticesWith(draft: Draft | null, result: DraftNotice['result']): DraftNotice[] {
      const notices = get().draftNotices
      if (!draft || actorOf(draft) !== 'claude') return notices
      return [...notices, { draftId: draft.id, by: 'claude', result, at: japanIso(deps.now()) }]
    }

    /** 新しい下書きを作ってよいか。Claude の操作は、承認待ちの下書きがあれば断る */
    function blockedBy(by: EditActor): string | null {
      const { base, draft } = get()
      if (!base) return NO_BASE
      if (draft && by === 'claude') return `下書き ${draft.id} が承認待ちです。`
      return null
    }

    function newId(): string {
      return `d${nextDraft++}`
    }

    return {
      base: null,
      history: [],
      versions: [],
      draft: null,
      draftNotices: [],
      feedVersion: '',

      setFeedVersion(value) {
        set({ feedVersion: value })
      },

      propose(op, by) {
        const blocked = blockedBy(by)
        if (blocked) return { ok: false, message: blocked }
        const { base, history, draft: previous } = get()
        if (!base) return { ok: false, message: NO_BASE }
        if (op.type !== 'applyPolicy' && planOf(history) === null) return { ok: false, message: NO_POLICY }
        if (op.type === 'addBack' && op.items.length === 0) return { ok: false, message: '足し戻す便を選んでください。' }
        if (op.type === 'withdrawAddBack' && op.tripIds.length === 0) return { ok: false, message: '取り消す便を選んでください。' }

        const now = deps.now()
        const record: EditRecord = { op, by, at: japanIso(now) }
        // applyPolicy を含むので null にならない
        const plan = planOf([...history, record])
        let outcome: Form2Outcome
        if (plan === null) {
          outcome = { ok: false, message: NO_POLICY }
        } else {
          try {
            outcome = applyForm2(base.feed, plan, { generatedAt: generatedAtOf(now) })
          } catch (e) {
            outcome = { ok: false, message: e instanceof Error && e.message ? e.message : '方針を適用できませんでした。' }
          }
        }
        const draft: Draft = {
          kind: 'op',
          id: newId(),
          record,
          outcome,
          diff: outcome.ok ? diffOf(base.feed, outcome.result) : null,
          issues: outcome.ok ? issuesOf(base, outcome.result) : [],
        }
        set({ draft, draftNotices: noticesWith(previous, 'replaced') })
        publish()
        return { ok: true, draft }
      },

      proposeUndo(by) {
        const blocked = blockedBy(by)
        if (blocked) return { ok: false, message: blocked }
        const { base, versions, draft: previous } = get()
        if (!base || versions.length === 0) return { ok: false, message: base ? NO_HISTORY : NO_BASE }
        const result = versions.length >= 2 ? versions[versions.length - 2] : null
        const draft: Draft = { kind: 'undo', id: newId(), by, result, diff: result ? diffOf(base.feed, result) : null }
        set({ draft, draftNotices: noticesWith(previous, 'replaced') })
        publish()
        return { ok: true, draft }
      },

      commit() {
        const { draft, history, versions } = get()
        if (!draft) return { ok: false, message: NO_DRAFT }
        if (draft.kind === 'undo') {
          set({
            history: history.slice(0, -1),
            versions: versions.slice(0, -1),
            draft: null,
            draftNotices: noticesWith(draft, 'committed'),
          })
          publish()
          return { ok: true }
        }
        if (!draft.outcome.ok) return { ok: false, message: draft.outcome.message }
        const blocking = blockingIssues(draft.issues)
        if (blocking.length > 0) {
          return { ok: false, message: `検証で誤りが見つかったため、承認できません。${blocking.map((i) => i.message).join(' ')}` }
        }
        const record: EditRecord = { ...draft.record, at: japanIso(deps.now()) }
        set({
          history: [...history, record],
          versions: [...versions, draft.outcome.result],
          draft: null,
          draftNotices: noticesWith(draft, 'committed'),
        })
        publish()
        return { ok: true }
      },

      discard() {
        const { draft } = get()
        if (!draft) return
        set({ draft: null, draftNotices: noticesWith(draft, 'discarded') })
        publish()
      },

      undo() {
        const { draft, history, versions } = get()
        if (history.length === 0 && !draft) return
        set({
          history: history.slice(0, -1),
          versions: versions.slice(0, -1),
          draft: null,
          draftNotices: noticesWith(draft, 'discarded'),
        })
        publish()
      },

      undoAll() {
        const { draft, history } = get()
        if (history.length === 0 && !draft) return
        set({ history: [], versions: [], draft: null, draftNotices: noticesWith(draft, 'discarded') })
        publish()
      },

      takeDraftNotices() {
        const notices = get().draftNotices
        if (notices.length > 0) set({ draftNotices: [] })
        return notices
      },

      setBase(base) {
        set({ base, history: [], versions: [], draft: null, draftNotices: [], feedVersion: '' })
        publish()
      },

      refreshIssues() {
        const { base, draft } = get()
        if (!base || draft?.kind !== 'op' || !draft.outcome.ok) return
        // 祝日の store の状態が変わっても、祝日一覧そのものが同じなら(読み込み中になっただけなど)作り直さない
        if ((deps.holidays?.() ?? null) === issuesBasis) return
        set({ draft: { ...draft, issues: issuesOf(base, draft.outcome.result) } })
      },
    }
  })
  deps.watchHolidays?.(() => store.getState().refreshIssues())
  return store
}

/**
 * 編集の履歴と下書きを持つ。編集後のフィードが変わるたびに、到達圏の store(setEdited)へ渡す。
 * 検証には、そのときの祝日一覧(読めていなければ null)を使う。
 */
export const useEditStore = createEditStore({
  now: () => new Date(),
  onEdited: (e) => useReachStore.getState().setEdited(e),
  holidays: () => {
    const h = useHolidayStore.getState().holidays
    return h.status === 'ready' ? h.list : null
  },
  // 祝日一覧があとから読めたとき、方針の確かめ(下書き)の祝日の issue を今の一覧で作り直す
  watchHolidays: (onChange) => {
    useHolidayStore.subscribe((state, prev) => {
      if (state.holidays !== prev.holidays) onChange()
    })
  },
})
