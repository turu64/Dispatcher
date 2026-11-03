/**
 * [画面の状態]・[画面の操作] の行(docs/interfaces-1105.md §6.2、docs/interfaces-1104.md §10)。
 *
 * - 行は user.message の先頭の text のブロックに、1件ごとに1行で入れる(利用者の文とは別のブロック。system.message にはしない)。
 *   行が無ければこのブロックを置かない
 * - [画面の状態] は、セッションの最初の発言と、内容が変わったときだけ入れる
 * - [画面の操作] は、Claude の下書きの行方(takeDraftNotices の3つの文)と、利用者がボタンで行った編集
 *   (前に送ったときの承認済みの履歴と今の履歴を比べる)
 * - 「前に送った」の記録はセッションごとに持つ(ScreenLineTracker)。新しいセッションの最初の発言には、[画面の状態] をすべてと、
 *   承認済みの編集の要約を入れる(予算に達して新しく始めたときに、AI が今の状態を前提にできるように)
 */
import { POLICY_KIND_LABELS } from '@/components/steps/editText'
import type { Form2Result } from '@/gtfs/edit/form2'
import { formatDate, planOf, type EditRecord } from '@/gtfs/edit/ops'
import { formatDateJa } from '@/lib/dates'
import type { DraftNotice } from '@/store/edit'
import type { PolicyServices } from './tools'

/** [画面の状態] の行の材料 */
export interface ScreenState {
  /** 日本時間の今日('YYYYMMDD') */
  today: string
  /** 読み込んだ GTFS。無ければ null */
  gtfs: { label: string; validity: { start: string; end: string } | null; services: PolicyServices | null } | null
  /** 到達圏を比べる日と時間帯の幅。無ければ null */
  reach: { date: string | null; stepHours: 1 | 3 } | null
}

/** 編集の store の承認済みの履歴と版 */
export interface EditSnapshot {
  history: readonly EditRecord[]
  versions: readonly Form2Result[]
}

/** [画面の状態] の行(種類ごと) */
export function stateLines(s: ScreenState): { key: string; line: string }[] {
  const lines = [{ key: 'today', line: `[画面の状態] 今日は ${formatDateJa(s.today)}です(日本時間)。` }]
  if (s.gtfs) {
    const v = s.gtfs.validity
    const svc = s.gtfs.services
    const pick = (id: string | null | undefined) => id ?? '未選択'
    lines.push({
      key: 'gtfs',
      line: `[画面の状態] 読み込んだ GTFS:${s.gtfs.label}(有効期間 ${v ? `${formatDate(v.start)}〜${formatDate(v.end)}` : '不明'})。平日の service:${pick(svc?.weekday)}、土曜:${pick(svc?.saturday)}、日祝:${pick(svc?.sundayHoliday)}。`,
    })
  }
  if (s.reach) {
    lines.push({
      key: 'reach',
      line: `[画面の状態] 到達圏を比べる日:${s.reach.date ? formatDateJa(s.reach.date) : '未選択'}、時間帯の幅:${s.reach.stepHours}時間。`,
    })
  }
  return lines
}

/** Claude の下書きの行方の行(docs/interfaces-1104.md §10 の3つの文) */
export function draftNoticeLine(n: DraftNotice): string {
  if (n.result === 'committed') return `[画面の操作] 下書き ${n.draftId} を利用者が承認しました。`
  if (n.result === 'discarded') return `[画面の操作] 下書き ${n.draftId} を利用者が取り消しました。`
  return `[画面の操作] 下書き ${n.draftId} は、利用者の操作で置き換えられました。`
}

/** 利用者が前提情報の調査を始めたときの行(11/6) */
export function researchStartedLine(targets: number): string {
  return `[画面の操作] 利用者が前提情報の調査を始めました(対象 ${targets} 件)。`
}

function periodLabel(start: string, end: string | null): string {
  return `${formatDate(start)}〜${end === null ? '当面の間' : formatDate(end)}`
}

/**
 * 新しいセッションの最初の発言に入れる、承認済みの編集の要約。承認済みの編集が無ければ null。
 * 「[画面の操作] これまでに承認された編集:方針の適用(平日を土曜ダイヤに、{開始}〜{終了})、足し戻し {N} 本。」
 */
export function approvedSummaryLine(edits: EditSnapshot): string | null {
  const plan = planOf(edits.history)
  if (!plan) return null
  const last = edits.versions.length > 0 ? edits.versions[edits.versions.length - 1] : null
  const addedBack = last ? last.report.addBack.accepted.length : 0
  const excluded = plan.excludedRoutes.length > 0 ? `、除外した系統 ${plan.excludedRoutes.length}` : ''
  return `[画面の操作] これまでに承認された編集:方針の適用(${POLICY_KIND_LABELS[plan.kind]}、${periodLabel(plan.period.start, plan.period.end)}${excluded})、足し戻し ${addedBack} 本。`
}

function acceptedOf(versions: readonly Form2Result[], i: number): Set<string> {
  return new Set(i >= 0 && i < versions.length ? versions[i].report.addBack.accepted : [])
}

/**
 * 利用者がボタンで行った編集の行。前に送ったときの承認済みの履歴(prev)と今の履歴(now)を比べ、
 * Claude の下書き以外の変化を1件ずつ書く。claudeUndos は、その間に承認された Claude の「元に戻す」下書きの数
 * (下書きの行方の行で伝わるので、利用者の「元に戻す」から除く)
 */
export function userEditLines(prev: EditSnapshot, now: EditSnapshot, claudeUndos = 0): string[] {
  let p = 0
  while (p < prev.history.length && p < now.history.length && prev.history[p] === now.history[p]) p++
  const lines: string[] = []
  const removed = Math.max(0, prev.history.length - p - claudeUndos)
  if (removed > 0) {
    if (now.history.length === 0 && p === 0 && removed >= 2) lines.push('[画面の操作] 利用者がすべての編集を元に戻しました。')
    else for (let i = 0; i < removed; i++) lines.push('[画面の操作] 利用者が最後の編集を元に戻しました。')
  }
  for (let i = p; i < now.history.length; i++) {
    const record = now.history[i]
    if (record.by !== 'user') continue
    const op = record.op
    if (op.type === 'applyPolicy') {
      const s = op.settings
      lines.push(
        `[画面の操作] 利用者が方針を適用しました(${POLICY_KIND_LABELS[s.kind]}、${periodLabel(s.period.start, s.period.end)}、除外した系統 ${s.excludedRoutes.length})。`,
      )
    } else if (op.type === 'addBack') {
      // 版があれば、受け付けた便(既に足し戻してあった便・受け付けなかった便を除く)の数
      const n =
        i < now.versions.length
          ? (() => {
              const before = acceptedOf(now.versions, i - 1)
              const after = acceptedOf(now.versions, i)
              return op.items.filter((it) => after.has(it.tripId.trim()) && !before.has(it.tripId.trim())).length
            })()
          : op.items.length
      lines.push(`[画面の操作] 利用者が便を ${n} 本足し戻しました。`)
    } else {
      const n =
        i < now.versions.length
          ? (() => {
              const before = acceptedOf(now.versions, i - 1)
              const after = acceptedOf(now.versions, i)
              return [...new Set(op.tripIds.map((t) => t.trim()))].filter((t) => before.has(t) && !after.has(t)).length
            })()
          : op.tripIds.length
      lines.push(`[画面の操作] 利用者が足し戻しを ${n} 本取り消しました。`)
    }
  }
  return lines
}

/** ScreenLineTracker が読む画面の状態 */
export interface ScreenLineSource {
  screen: () => ScreenState
  edits: () => EditSnapshot
  /** 編集の store の takeDraftNotices(Claude に伝えていない下書きの行方を取り出す) */
  takeDraftNotices: () => DraftNotice[]
}

export interface PreparedLines {
  /** 発言の先頭の text のブロックに入れる行(無ければ空) */
  lines: string[]
  /** 送れたら呼ぶ(「前に送った」の記録を進める)。呼ばなければ、次の発言で同じ行をもう一度入れる */
  commit: () => void
}

/**
 * 1つのセッションの「前に送った」の記録。セッションを新しく始めたら reset する
 */
export class ScreenLineTracker {
  private readonly source: ScreenLineSource
  /** 最後に届けた [画面の状態] の行(種類ごと) */
  private sentState = new Map<string, string>()
  /** 最後に届けたときの承認済みの履歴。null はこのセッションでまだ届けていない */
  private sentEdits: EditSnapshot | null = null
  /** 取り出したが、まだ届けていない下書きの行方 */
  private unsentNotices: DraftNotice[] = []
  /** このセッションの Claude が作った「元に戻す」下書きの番号 */
  private readonly undoDrafts = new Set<string>()

  constructor(source: ScreenLineSource) {
    this.source = source
  }

  /** このセッションで、まだ発言を届けていない */
  get first(): boolean {
    return this.sentEdits === null
  }

  /** 新しいセッションにする(次の発言を最初の発言として作る) */
  reset(): void {
    this.sentState = new Map()
    this.sentEdits = null
    this.unsentNotices = []
    this.undoDrafts.clear()
  }

  /** Claude の undo_edit が作った下書き(承認されたら、利用者の「元に戻す」としては書かない) */
  noteUndoDraft(id: string): void {
    this.undoDrafts.add(id)
  }

  /**
   * 次の発言の行を作る。extra は [画面の操作] の行の後ろに足す行(11/6 の調査を始めた行など)。
   * セッションの最初の発言では、[画面の状態] をすべてと、承認済みの編集の要約を入れる。下書きの行方は入れない
   * (前のセッションの下書きの番号は、新しいセッションの AI が知らないため)
   */
  prepare(extra: readonly string[] = []): PreparedLines {
    const notices = [...this.unsentNotices, ...this.source.takeDraftNotices()]
    const first = this.first
    // 届くまでは取り出した行方を手元に残す(失敗したときに、次の発言で伝え直すため)
    this.unsentNotices = first ? [] : notices
    const state = new Map(stateLines(this.source.screen()).map((l) => [l.key, l.line]))
    const now = this.source.edits()
    const edits: EditSnapshot = { history: [...now.history], versions: [...now.versions] }
    const stateChanged = [...state].filter(([k, line]) => this.sentState.get(k) !== line).map(([, line]) => line)
    let ops: string[]
    if (this.sentEdits === null) {
      const summary = approvedSummaryLine(edits)
      ops = summary ? [summary] : []
    } else {
      const claudeUndos = notices.filter((n) => n.result === 'committed' && this.undoDrafts.has(n.draftId)).length
      ops = [...notices.map(draftNoticeLine), ...userEditLines(this.sentEdits, edits, claudeUndos)]
    }
    return {
      lines: [...stateChanged, ...ops, ...extra],
      commit: () => {
        this.sentState = state
        this.sentEdits = edits
        this.unsentNotices = []
      },
    }
  }
}
