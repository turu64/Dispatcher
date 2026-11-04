import { create } from 'zustand'
import { ScreenLineTracker, type EditSnapshot, type ScreenState } from '../claude/screenLines'
import { ClaudeSession, createSessionApi, type ConnectionState, type DisplayStreamEvent, type SessionApi, type SessionDeps, type SessionEvent, type TextBlock } from '../claude/session'
import { createResearchApi, MAX_KNOWN_IDS, type ResearchApi, type ResearchOverview, type ResearchStartView } from '../claude/research'
import { ClaudeRequestError, NOT_CONNECTED } from '../claude/sse'
import { byteLength, MAX_RESULT_BYTES, runTool, toolLabel, type PolicyServices, type ToolDeps, type ToolOutcome } from '../claude/tools'
import { planOf } from '../gtfs/edit/ops'
import type { RestoreHintContext } from '../gtfs/edit/restore'
import { describeServices, feedValidity, guessServiceChoice, policyValidity } from '../gtfs/edit/services'
import { groupedPolicyServices } from '../gtfs/groups/view'
import type { GtfsFeed } from '../gtfs/load'
import { todayInJapan } from '../lib/dates'
import { draftName, japanIso, useEditStore, type DraftNotice } from './edit'
import { useHolidayStore } from './holidays'
import { useReachStore } from './reach'
import { useResearchStore } from './research'
import { buildRestoreHintContext } from './restoreHintContext'
import { jevPending, useServiceGroupsStore } from './serviceGroups'

/**
 * アプリ内の Claude との会話の store(docs/interfaces-1105.md §6)。
 * 中継の状態(GET /api/claude/status)、合言葉、表示する発言の列、送信中か、考えているか、ツールを実行しているか、
 * 利用額、予算に達したか、調査の進み具合、「AI に送る情報」の記録を持つ。
 * 会話の履歴は Anthropic のセッションが持つ(ブラウザは表示用の発言だけ)。セッション・ストリーム・ツールの実行と送信は
 * claude/session.ts、ツールの中身は claude/tools.ts、[画面の…] の行は claude/screenLines.ts。画面の部品は表示と入力だけをする
 */

// ---- 画面の文言 ----

export const CLAUDE_UNAVAILABLE = 'AI は使えません(API キーが設定されていません)。'
export const TOKEN_WRONG = '認証コードが違います。'
export const TOKEN_MISSING = '認証コードを入れてください。'
export const TOKEN_CHARS = '認証コードは半角の英数字と記号で入れてください。'
export const RELOAD_NOTICE = 'GTFS を読み込み直したため、AI との会話を新しく始めます。'
export const ENDED_NOTICE = 'AI との会話が終わりました。次に送ると新しく始めます。'
export const NEW_SESSION_NOTICE = 'AI との会話を新しく始めます。AI はここまでの会話を覚えていません。GTFS の編集はそのまま残ります。'
export const STOPPED_NOTICE = '止めました'
export const TOOLS_WAITING = 'AI がツールの結果を待っています。'
export const SENDING = '送っています…'
export const THINKING = '考えています…'
export const RECONNECTING = 'つなぎ直しています…'
/** 新しいセッションの最初のストリームがつながるまで(Anthropic の側の準備を待つ。docs/interfaces-1105.md §9) */
export const PREPARING = 'AI を準備しています…(最初は 15 秒ほどかかります)'
export const TEXT_TOO_LONG = '文が長すぎます。短くして送ってください。'
/** 送る前に入力欄の下に出す文(§6.4) */
export const SEND_INFO_NOTE =
  '送るのは利用者の文と、画面の状態・操作の行、ツールの結果(便の一覧や件数)です。GTFS のファイルは送りません。'
/** 調査を始めるときに SEND_INFO_NOTE に足す文(11/6) */
export const RESEARCH_SEND_NOTE = '調べる施設・事業者の名前と位置(国土数値情報)を送り、AI が Web で検索します。'
/** 調査の間に出す文 */
export const RESEARCH_KEEP_OPEN = '調査の間はこの画面を開いたままにしてください。'
/** 止めたときに調査の run が開いていれば出す文(§4.9) */
export const RESEARCH_PAUSED = '調査が止まっているかもしれません。続けるときは『調査を続けて』と送ってください。'
/** 足し戻しの手順の「AI に候補を聞く」で送る文(§6) */
/** 調査を始めたときにサーバーが会話に入れる [画面の操作] の行(server の research.START_LINE と同じ文。「AI に送る情報」に残す) */
export function researchStartLine(count: number): string {
  return `[画面の操作] 利用者が前提情報の調査を始めました(対象 ${count} 件)。`
}

/** 調査の API がつながっていないとき(テストで research を渡していないなど) */
export const RESEARCH_UNAVAILABLE = '調査の API が使えません。'
/** 調べた結果(デモを含む)の対象を、AI の会話に登録できなかったとき(送信は止めない。指摘15.1) */
export const RESEARCH_KNOWN_FAILED = '調べた結果を AI に渡せませんでした。AI は前提情報の結果を読めないことがあります。'

/** AI がツールを使いすぎて、サーバーが止めたときの error の code(server の agent_session.py。指摘15.2) */
export const TOO_MANY_TOOL_CALLS = 'too_many_tool_calls'
/** 止まった作業の「続きを頼む」で送る利用者の文 */
export const CONTINUE_PROMPT = '続けてください。'
/** 「続きを頼む」で [画面の操作] の行の後ろに足す行(この相談で AI が確かめた便が無いとき。あれば continueLine) */
export const CONTINUE_LINE = '[画面の操作] 利用者が、止まった作業の続きを頼みました。'

// ---- AI が確かめた便の件数(指摘18.4) ----

/** search_trips の scope の画面の名前(docs/wording.md) */
export const SEARCH_SCOPE_NAMES: Readonly<Record<string, string>> = {
  removed: 'なくなる便',
  added: '加わる便',
  same: '同じ便',
  added_back: '平日に戻した便',
  base_weekday: '減便前の平日の便',
}

/** search_trips の入力のうち、便を絞る条件の項目(offset は続きから読むだけなので条件に入れない) */
const SEARCH_FILTER_KEYS = ['route_ids', 'stop_name', 'depart_from', 'depart_to', 'hints'] as const

/** 1回の search_trips で AI に返した便(結果の JSON から読む) */
export interface SearchTripsSummary {
  scope: string
  /** 結果の total(条件で絞ったときは、絞った後の数) */
  total: number
  /** AI に返した便(結果が 20KB を超えて後ろを省いたときは、残った便だけ)。`{feed}:{trip_id}` */
  tripKeys: string[]
  /** 系統・停留所名・時刻・判断材料のどれかで絞った */
  filtered: boolean
}

function isSet(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.some((x) => typeof x !== 'string' || x.trim() !== '')
  return true
}

/**
 * search_trips の入力と結果から、AI に返した便を読む。結果が ok でない・20KB を超えて AI に届かない・形が違うときは null。
 * 件数は結果の trips の数(fitResult が後ろを省いたときは returned より少ない)
 */
export function summarizeSearchTrips(input: unknown, outcome: ToolOutcome): SearchTripsSummary | null {
  if (outcome.isError || byteLength(outcome.content) > MAX_RESULT_BYTES) return null
  let body: unknown
  try {
    body = JSON.parse(outcome.content)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (b.status !== 'ok' || typeof b.scope !== 'string' || typeof b.total !== 'number' || !Array.isArray(b.trips)) return null
  const tripKeys: string[] = []
  for (const t of b.trips as unknown[]) {
    if (typeof t !== 'object' || t === null) continue
    const trip = t as Record<string, unknown>
    if (typeof trip.trip_id === 'string') tripKeys.push(`${typeof trip.feed === 'string' ? trip.feed : ''}:${trip.trip_id}`)
  }
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  return { scope: b.scope, total: b.total, tripKeys, filtered: SEARCH_FILTER_KEYS.some((k) => isSet(o[k])) }
}

function scopeName(scope: string): string {
  return SEARCH_SCOPE_NAMES[scope] ?? scope
}

/** ツールの項目の括弧の中(「なくなる便 292 便のうち 50 便」。条件で絞ったときは「条件に合うなくなる便 12 便のうち 12 便」) */
export function searchTripsDetail(s: SearchTripsSummary): string {
  return `${s.filtered ? '条件に合う' : ''}${scopeName(s.scope)} ${s.total} 便のうち ${s.tripKeys.length} 便`
}

/** 1回の相談で、scope ごとに AI に返した便と最新の total */
export interface CheckedScope {
  /** 条件を付けずに探した結果の最新の total。条件を付けずに探していなければ null */
  total: number | null
  /** 条件を付けずに探した結果で返した便 */
  unfiltered: Set<string>
  /** 条件で絞った結果で返した便 */
  filtered: Set<string>
}

export type CheckedTally = Map<string, CheckedScope>

/** 相談の数えに、search_trips の1回の結果を足す */
export function addToTally(tally: CheckedTally, s: SearchTripsSummary): void {
  let c = tally.get(s.scope)
  if (!c) {
    c = { total: null, unfiltered: new Set(), filtered: new Set() }
    tally.set(s.scope, c)
  }
  if (s.filtered) for (const k of s.tripKeys) c.filtered.add(k)
  else {
    c.total = s.total
    for (const k of s.tripKeys) c.unfiltered.add(k)
  }
}

/** 条件を付けずに探した scope ごとの「なくなる便 292 便のうち 100 便」 */
function checkedMain(tally: CheckedTally): string[] {
  return [...tally].filter(([, c]) => c.total !== null).map(([scope, c]) => `${scopeName(scope)} ${c.total} 便のうち ${c.unfiltered.size} 便`)
}

/**
 * 返答の終わりに出す1行。条件を付けずに探した結果があるときだけ出す(無ければ null)。
 * 条件で絞った結果は、条件を付けずに探した結果に無い便の数だけを添える
 */
export function checkedLine(tally: CheckedTally): string | null {
  const main = checkedMain(tally)
  if (main.length === 0) return null
  const extra = [...tally]
    .map(([scope, c]) => ({ scope, n: [...c.filtered].filter((k) => !c.unfiltered.has(k)).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${scopeName(x.scope)} ${x.n} 便`)
  return `この相談で AI が確かめた便:${main.join('、')}${extra.length > 0 ? `(ほかに条件で絞って探した便:${extra.join('、')})` : ''}`
}

/** 「続きを頼む」の [画面の操作] の行。この相談で条件を付けずに探した結果があれば、確かめた件数を添える */
export function continueLine(tally: CheckedTally): string {
  const main = checkedMain(tally)
  return main.length === 0 ? CONTINUE_LINE : `${CONTINUE_LINE}${main.join('、')}を確かめ済みです。`
}

export const ASK_RESTORE_PROMPT =
  '減便の方針でなくなる平日の便のうち、通勤・通学・通院などのために平日に戻したほうがよい便を、判断材料と停留所名から選び、理由をつけて、便を平日に戻す下書きにしてください。数は多くても 10 便くらいにしてください。'

/** 利用者の文の上限(UTF-8 のバイト数。サーバーは [画面の…] の行と合わせて 32KB まで) */
export const MAX_TEXT_BYTES = 24 * 1024

/** セント → 「$0.42」「$3」(整数のドルは小数を付けない) */
export function dollars(cents: number): string {
  const v = Math.max(0, cents) / 100
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`
}

/** 入力欄の下の利用額(§6.4)。上限は budget_cents から作る(金額を直接書かない) */
export function usageText(usage: { costCents: number; budgetCents: number }): string {
  return `この会話の AI の利用額 約 ${dollars(usage.costCents)} / 上限 ${dollars(usage.budgetCents)}`
}

/** 予算に達したときの文(§4.9) */
export function budgetReachedMessage(budgetCents: number | null): string {
  const limit = budgetCents === null ? '' : `(${(budgetCents / 100).toString()} ドル)`
  return `この会話の AI の利用額が上限${limit}に達しました。続けるときは「新しく始める」を押してください。GTFS の編集はそのまま残ります。AI はここまでの会話を覚えていません。`
}

/** 下書きの知らせの文 */
export function draftMessage(id: string): string {
  return `${draftName(id)} を作りました。確かめて承認してください。`
}

// ---- 状態 ----

/** 下書きを確かめる手順(下書きの知らせの「編集で確かめる」で開く) */
export type DraftStep = 'policy' | 'restore'

export type ChatItem =
  | { id: number; kind: 'user'; text: string; at: string }
  /** AI の返答(改行を保つ)。delta で途中まで出し、同じ messageId の message で置き換える */
  | { id: number; kind: 'assistant'; messageId: string; text: string; streaming: boolean }
  /**
   * ツールの動き。callId はブラウザのツールの呼び出しの id(サーバーのツールは null)。
   * skipped は実行しなかったもの(止めた・会話を終えた)
   */
  | {
      id: number
      kind: 'tool'
      callId: string | null
      name: string
      label: string
      status: 'running' | 'done' | 'error' | 'skipped'
      /** 終えたときに名前の後ろの括弧に添える文(search_trips の「なくなる便 292 便のうち 50 便」。指摘18.4) */
      detail?: string
    }
  /** 下書きの知らせ */
  | { id: number; kind: 'draft'; draftId: string; text: string; step: DraftStep }
  | { id: number; kind: 'notice'; text: string }
  | { id: number; kind: 'error'; text: string }
  /**
   * AI がこの相談でツールを使いすぎたので、サーバーが止めた知らせ(1回の発言につき1件。文はサーバーの error の文)。
   * 「続きを頼む」のボタンを付ける。continued は続きを頼んだ後(ボタンを出さない)
   */
  | { id: number; kind: 'stopped'; text: string; continued: boolean }
  /** 返答の終わりに出す、この相談で AI が確かめた便の件数(checkedLine。指摘18.4) */
  | { id: number; kind: 'checked'; text: string }

/** id を除いた項目(項目の種類ごとに Omit する) */
type NewChatItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never

/** 「AI に送る情報」の1件の中身 */
export interface SentPart {
  kind: 'user' | 'screen' | 'tool_result' | 'interrupt'
  text: string
  /** kind が tool_result のときのツールの名前 */
  toolName?: string
  isError?: boolean
}

/** 「AI に送る情報」の1件(送るたびに、そのとき送った中身) */
export interface SentLogEntry {
  id: number
  /** ISO 8601 の日本時間 */
  at: string
  parts: SentPart[]
}

export type ClaudeStatus =
  | { state: 'unknown' | 'loading' }
  | { state: 'ready'; available: boolean; tokenRequired: boolean }
  | { state: 'error'; message: string }

/** 調査の進み具合(§4.6 の research。画面は 11/6) */
export interface ResearchProgress {
  /** 調べている(run が開いているか、対象のうち保存していないものがある) */
  active: boolean
  /** 開いている workflow run の ID */
  openRuns: string[]
  /** run の段階の名前 */
  phase: string | null
  /** run が一時停止した */
  paused: boolean
  /** 保存した数と対象の数(save_research に答えたとき)。「前提情報を調べる」で始めたときは、利用者が選んだ対象だけで数える */
  saved: number
  total: number | null
  /** 調査役に1件ずつ頼んだ数 */
  delegated: number
  /** 終わったときの結果。done は「調べ終えました」、partial は「一部を調べられませんでした」 */
  outcome: 'done' | 'partial' | null
}

export const EMPTY_RESEARCH: ResearchProgress = {
  active: false,
  openRuns: [],
  phase: null,
  paused: false,
  saved: 0,
  total: null,
  delegated: 0,
  outcome: null,
}

/** 調査の進み具合の文(調べていなければ null) */
export function researchText(r: ResearchProgress): string | null {
  if (r.active) {
    const count = r.total === null ? `${r.saved} 件` : `${r.saved} / ${r.total} 件`
    return `調べています ${count}${r.phase ? `(${r.phase})` : ''}`
  }
  if (r.outcome === 'done') return '調べ終えました'
  if (r.outcome === 'partial') return '一部を調べられませんでした'
  return null
}

export interface ChatState {
  status: ClaudeStatus
  /** 合言葉(sessionStorage に保存。使えなければこのタブの間だけ持つ) */
  token: string | null
  /** 合言葉の欄に出す文(「合言葉が違います」など) */
  tokenError: string | null
  items: ChatItem[]
  sentLog: SentLogEntry[]
  /** 送れなかった利用者の文(画面が入力欄に戻す) */
  unsent: string | null
  /** 発言を送っている(セッションを作っている間も) */
  sending: boolean
  /** AI が返答している(「考えています…」を出す)。利用者が送ってから、返答を終えるまで */
  replying: boolean
  /** ブラウザのツールを実行している・結果を送っている(この間は送れない) */
  toolRunning: boolean
  /** 中継のストリームのつながり。none はセッションが無い */
  connection: ConnectionState | 'none'
  /** この会話の利用額(usage)。届いていなければ null */
  usage: { costCents: number; budgetCents: number } | null
  /** この会話の予算(POST /api/claude/session が返した budget_cents) */
  budgetCents: number | null
  /** 予算に達した(入力欄を閉じ、「新しく始める」を出す) */
  budgetReached: boolean
  research: ResearchProgress
  /** 前提情報の調査を始められなかった・結果を読めなかった理由(前提情報の手順に出す)。無ければ null */
  researchError: string | null

  /** 中継の状態を読む(画面を開いたとき、GTFS を読み込んだとき) */
  loadStatus: () => Promise<void>
  setToken: (token: string) => void
  /**
   * 利用者の文を送る。セッションが無ければ作り、ストリームをつないでから送る。送れたら true。
   * extraLines は [画面の操作] の行の後ろに足す行(11/6 の「調査を始めました」など)
   */
  send: (text: string, options?: { extraLines?: string[] }) => Promise<boolean>
  /** 足し戻しの手順の「AI に候補を聞く」 */
  askRestore: () => Promise<boolean>
  /**
   * 止めた知らせの「続きを頼む」。「続けてください。」を送り、[画面の操作] の行で続きを頼んだことを伝える。
   * 送れたら、止めた知らせのボタンを消す
   */
  continueStopped: () => Promise<boolean>
  /**
   * 前提情報の手順の「前提情報を調べる」。セッションが無ければ作り、ストリームをつないでから
   * POST /api/claude/session/research に target_ids だけを送る([画面の操作] の行はサーバーが会話に入れる)。
   * 始められたら対象の一覧、始められなければ null(理由は researchError か、会話の欄の文)
   */
  startResearch: (targetIds: readonly string[]) => Promise<ResearchStartView | null>
  /** このセッションの対象と保存済みの結果(GET /api/claude/session/research)。セッションが無い・読めなければ null */
  loadResearch: () => Promise<ResearchOverview | null>
  /** 止める(実行中のツールを止め、interrupt を送る) */
  stop: () => Promise<void>
  /** 新しく始める(予算に達したときなど)。今のセッションを終え、次に送るときに作り直す。表示は残す */
  startOver: () => void
  /** 会話を消す(GTFS の読み込み直し。notice があれば、消したあとに出す) */
  reset: (notice?: string) => void
  /** ページを閉じるとき(pagehide)。セッションを終える(DELETE を keepalive で送る) */
  endSession: () => void
}

/** 送るボタンを押せない理由(押せるなら null) */
export function sendBlockedReason(s: Pick<ChatState, 'status' | 'budgetReached' | 'toolRunning' | 'sending' | 'budgetCents'>): string | null {
  if (s.status.state === 'ready' && !s.status.available) return CLAUDE_UNAVAILABLE
  if (s.status.state === 'error') return s.status.message
  if (s.budgetReached) return budgetReachedMessage(s.budgetCents)
  if (s.toolRunning) return TOOLS_WAITING
  if (s.sending) return SENDING
  return null
}

/**
 * AI を準備している(送ってから、最初のストリームがつながるまで)。セッションを作っている間(connection が none)と、
 * 最初の接続を待つ間(connecting)。つながった後の発言(open)とつなぎ直し(reconnecting)では出さない
 */
export function isPreparing(s: Pick<ChatState, 'sending' | 'connection'>): boolean {
  return s.sending && (s.connection === 'none' || s.connection === 'connecting')
}

/** 「止める」を押せる(返答の途中か、ツールを実行している) */
export function canStop(s: Pick<ChatState, 'replying' | 'toolRunning' | 'connection'>): boolean {
  return s.connection !== 'none' && s.connection !== 'closed' && (s.replying || s.toolRunning)
}

export interface TokenStorage {
  get: () => string | null
  set: (token: string | null) => void
}

export interface ChatStoreDeps {
  fetchStatus: () => Promise<{ available: boolean; tokenRequired: boolean }>
  /** 中継の API(createSessionApi) */
  api: SessionApi
  runTool: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolOutcome>
  screen: () => ScreenState
  edits: () => EditSnapshot
  takeDraftNotices: () => DraftNotice[]
  storage: TokenStorage
  now: () => Date
  /** GTFS を読み込み直したときに onChange を呼ぶように見張る(会話を消すため)。省けば見張らない */
  watchBase?: (onChange: () => void) => void
  /** 前提情報の調査の API(createResearchApi)。省けば調査は始められない */
  research?: ResearchApi
  /**
   * 前提情報の store に結果がある target_id(デモと Web の両方)。セッションを作ったときと、結果が増えたときに
   * POST /api/claude/session/research/known で登録する(AI が get_research_results で読めるように。指摘15.1)。省けば登録しない
   */
  knownResearchTargets?: () => readonly string[]
  /** 前提情報の結果が変わったときに onChange を呼ぶように見張る。省けば、発言を送るときにだけ登録する */
  watchResearch?: (onChange: () => void) => void
  /** セッションの待ち時間(テストで差し替える) */
  session?: Pick<SessionDeps, 'sleep' | 'reconnectDelays' | 'retryDelays' | 'batchDelayMs'>
}

const STEP_OF_TOOL: Record<string, DraftStep> = { apply_policy: 'policy', undo_edit: 'policy', add_back_trips: 'restore' }

/** GET /api/claude/status の返答が JSON でないか、形が違うときの文 */
export const STATUS_SHAPE = 'AI の状態の形が違います。'

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** チャットの store を作る(テストでは中継・ツール・画面の状態を差し替える) */
export function createChatStore(deps: ChatStoreDeps) {
  // store の中の関数から使う。store を作る関数の中で作る(onEvent が store の set を使うため)
  let session: ClaudeSession
  // 調べた結果の対象の登録(store の中で作る。前提情報の見張りから呼ぶ)
  let registerKnownRef: () => Promise<void> = async () => undefined
  const tracker = new ScreenLineTracker({ screen: deps.screen, edits: deps.edits, takeDraftNotices: deps.takeDraftNotices })

  const store = create<ChatState>()((set, get) => {
    let nextId = 1
    // 会話の世代。消した(reset)・新しく始めた(startOver)ら増やし、それより前に始めた送信の結果は表示に使わない
    let generation = 0
    // この発言で、サーバーが「ツールを使いすぎたので止めた」を知らせた(知らせを1件にし、続く「止めました」を出さない)。
    // 利用者が発言を送ったら戻す
    let stoppedLong = false
    // この相談(利用者の発言から次の発言まで)で AI に返した便(指摘18.4)。「続きを頼む」では数え直さない
    let checked: CheckedTally = new Map()
    // この相談の返答の終わりに出した件数の行(同じ文を2度出さない)
    let checkedShown: string | null = null
    // 利用者が「前提情報を調べる」で選んだ対象の数(進み具合の分母。サーバーの数は、登録した調べた結果の対象も含む)
    let researchChosen: number | null = null
    // 「続きを頼む」で送っている(send が相談を数え直さない)
    let continuing = false

    /** 新しい相談を始める(件数を数え直す) */
    function resetChecked(): void {
      checked = new Map()
      checkedShown = null
    }

    /** 返答の終わりに、この相談で AI が確かめた便の件数を1行出す(条件を付けずに探していなければ出さない) */
    function pushChecked(): void {
      const text = checkedLine(checked)
      if (text === null || text === checkedShown) return
      checkedShown = text
      push({ kind: 'checked', text })
    }

    /** サーバーの調査の進み具合の数を、利用者が選んだ対象の数にそろえる(選んだ対象のほかは保存済みの結果の対象) */
    function scopeResearch(e: Extract<DisplayStreamEvent, { type: 'research' }>): Extract<DisplayStreamEvent, { type: 'research' }> {
      if (e.kind !== 'saved' || researchChosen === null || e.saved === null || e.total === null) return e
      const extra = Math.max(0, e.total - researchChosen)
      return { ...e, saved: Math.min(researchChosen, Math.max(0, e.saved - extra)), total: researchChosen }
    }

    function push(item: NewChatItem): void {
      set({ items: [...get().items, { ...item, id: nextId++ } as ChatItem] })
    }

    function update(id: number, change: (item: ChatItem) => ChatItem): void {
      set({ items: get().items.map((i) => (i.id === id ? change(i) : i)) })
    }

    function log(parts: SentPart[]): void {
      set({ sentLog: [...get().sentLog, { id: nextId++, at: japanIso(deps.now()), parts }] })
    }

    /** 流れている返答の項目を閉じ、実行中のサーバーのツールの項目を終える */
    function closeStreaming(): void {
      const items = get().items
      if (!items.some((i) => (i.kind === 'assistant' && i.streaming) || (i.kind === 'tool' && i.callId === null && i.status === 'running'))) return
      set({
        items: items.map((i) =>
          i.kind === 'assistant' && i.streaming
            ? { ...i, streaming: false }
            : i.kind === 'tool' && i.callId === null && i.status === 'running'
              ? { ...i, status: 'done' }
              : i,
        ),
      })
    }

    /** 実行中のブラウザのツールの項目を skipped にする(会話を終えたとき) */
    function skipRunning(): void {
      set({ items: get().items.map((i) => (i.kind === 'tool' && i.status === 'running' ? { ...i, status: 'skipped' } : i)) })
    }

    function onDisplay(e: DisplayStreamEvent): void {
      switch (e.type) {
        case 'delta': {
          const item = get().items.find((i) => i.kind === 'assistant' && i.messageId === e.messageId)
          if (item?.kind === 'assistant') {
            // message で置き換えた後の途中経過は使わない
            if (item.streaming) update(item.id, (i) => ({ ...i, text: (i as { text: string }).text + e.text }))
          } else {
            push({ kind: 'assistant', messageId: e.messageId, text: e.text, streaming: true })
          }
          set({ replying: true })
          return
        }
        case 'message': {
          const item = get().items.find((i) => i.kind === 'assistant' && i.messageId === e.messageId)
          if (item) update(item.id, (i) => ({ ...i, text: e.text, streaming: false }))
          else push({ kind: 'assistant', messageId: e.messageId, text: e.text, streaming: false })
          // 調査の run が開いている間は、返答を終えても idle が来ない(§6.4)
          if (get().research.openRuns.length > 0) set({ replying: false })
          return
        }
        case 'thinking':
          set({ replying: true })
          return
        case 'tool_activity': {
          if (!e.done) {
            push({ kind: 'tool', callId: null, name: e.name, label: toolLabel(e.name), status: 'running' })
          } else {
            const running = [...get().items].reverse().find((i) => i.kind === 'tool' && i.callId === null && i.name === e.name && i.status === 'running')
            if (running) update(running.id, (i) => ({ ...i, status: 'done' }) as ChatItem)
          }
          return
        }
        case 'research':
          set({ research: nextResearch(get().research, scopeResearch(e)) })
          return
        case 'status':
          onStatus(e.state, e.reason)
          return
        case 'usage':
          set({ usage: { costCents: e.costCents, budgetCents: e.budgetCents }, budgetCents: e.budgetCents })
          return
        case 'error':
          // Anthropic への接続が切れた(サーバーがストリームを閉じる)。つなぎ直すので、文は出さない
          if (e.code === 'upstream') return
          if (e.code === TOO_MANY_TOOL_CALLS) {
            // 並行の呼び出しなどで同じ発言の中に何度来ても、知らせは1件だけ
            if (!stoppedLong) push({ kind: 'stopped', text: e.message, continued: false })
            stoppedLong = true
          } else {
            push({ kind: 'error', text: e.message })
          }
          set({ replying: false })
          closeStreaming()
          return
      }
    }

    function onStatus(state: string, reason: string | null): void {
      if (state === 'ended') {
        closeStreaming()
        skipRunning()
        set({ replying: false, research: { ...get().research, active: false, openRuns: [] } })
        pushChecked()
        push({ kind: 'notice', text: ENDED_NOTICE })
        return
      }
      if (state !== 'idle' || reason === 'requires_action') return
      closeStreaming()
      const research = get().research
      // run が無く、1件ずつ頼んだ調査が終わった
      const finished =
        research.openRuns.length === 0 && research.active
          ? { ...research, active: false, outcome: research.total !== null && research.saved >= research.total ? ('done' as const) : ('partial' as const) }
          : research
      set({ replying: false, research: finished })
      // 返答の終わり。知らせ(止めました・上限)より先に、確かめた便の件数を出す
      pushChecked()
      if (reason === 'budget_reached') {
        set({ budgetReached: true })
        push({ kind: 'notice', text: budgetReachedMessage(get().budgetCents) })
      } else if (reason === 'interrupted') {
        // サーバーがツールの使いすぎで止めたときは、その知らせ(「続きを頼む」つき)だけにする
        if (!stoppedLong) push({ kind: 'notice', text: STOPPED_NOTICE })
        if (research.openRuns.length > 0) push({ kind: 'notice', text: RESEARCH_PAUSED })
      }
    }

    function onSessionEvent(e: SessionEvent): void {
      switch (e.type) {
        case 'connection':
          set({ connection: e.state === 'closed' && !session.handle ? 'none' : e.state })
          return
        case 'stream':
          onDisplay(e.event)
          return
        case 'tool_start':
          push({ kind: 'tool', callId: e.id, name: e.name, label: toolLabel(e.name), status: 'running' })
          set({ replying: true })
          return
        case 'tool_done': {
          const item = get().items.find((i) => i.kind === 'tool' && i.callId === e.id)
          const found = searchSummaries.get(e.outcome)
          if (found) addToTally(checked, found)
          if (item) update(item.id, (i) => ({ ...i, status: e.outcome.isError ? 'error' : 'done', ...(found ? { detail: searchTripsDetail(found) } : {}) }) as ChatItem)
          const draft = e.outcome.draft
          if (draft?.kind === 'undo') tracker.noteUndoDraft(draft.id)
          if (draft && !e.outcome.isError) push({ kind: 'draft', draftId: draft.id, text: draftMessage(draft.id), step: STEP_OF_TOOL[e.name] ?? 'policy' })
          return
        }
        case 'tools':
          set({ toolRunning: e.pending > 0 })
          return
        case 'sent':
          log([
            ...e.results.map((r) => ({ kind: 'tool_result' as const, text: r.text, toolName: r.name, isError: r.isError })),
            ...(e.kind === 'interrupt' ? [{ kind: 'interrupt' as const, text: STOPPED_NOTICE }] : []),
          ])
          return
        case 'lost':
          closeStreaming()
          skipRunning()
          set({ replying: false, connection: 'none' })
          push({ kind: 'notice', text: e.message })
          return
        case 'unauthorized':
          deps.storage.set(null)
          set({ token: null, tokenError: TOKEN_WRONG })
          return
        case 'send_failed':
          push({ kind: 'error', text: e.message })
          return
      }
    }

    // search_trips の結果ごとの、AI に返した便(tool_done で同じ結果のオブジェクトから読む)
    const searchSummaries = new WeakMap<ToolOutcome, SearchTripsSummary>()

    session = new ClaudeSession({
      api: deps.api,
      token: () => get().token,
      runTool: async (name, input, signal) => {
        const outcome = await deps.runTool(name, input, signal)
        if (name === 'search_trips') {
          const summary = summarizeSearchTrips(input, outcome)
          if (summary) searchSummaries.set(outcome, summary)
        }
        return outcome
      },
      onEvent: onSessionEvent,
      ...deps.session,
    })

    // このセッションに登録した(登録を頼んでいる)調べた結果の対象。セッションが変わったら作り直す
    let known: { handle: string; ids: Set<string> } | null = null

    /**
     * 前提情報の store に結果がある対象のうち、このセッションにまだ登録していないものを登録する
     * (POST /api/claude/session/research/known。1回に MAX_KNOWN_IDS 件まで送れるので分ける)。
     * 同じセッションに同じ対象を2度送らない。失敗しても送信は止めず、researchError に短い文を出す(次の機会に送り直す)
     */
    async function registerKnown(): Promise<void> {
      const api = deps.research
      const handle = session.handle
      if (!api || !handle || !deps.knownResearchTargets) return
      if (known?.handle !== handle) known = { handle, ids: new Set() }
      const ids = known.ids
      const fresh = [...new Set(deps.knownResearchTargets())].filter((id) => !ids.has(id))
      if (fresh.length === 0) return
      // 送る前に印を付ける(見張りと送信が同時に呼んでも、同じ対象を2度送らない)
      for (const id of fresh) ids.add(id)
      for (let i = 0; i < fresh.length; i += MAX_KNOWN_IDS) {
        try {
          await api.registerKnown(get().token, handle, fresh.slice(i, i + MAX_KNOWN_IDS))
        } catch {
          // 届かなかった分は印を戻し、次に送るときに送り直す
          for (const id of fresh.slice(i)) ids.delete(id)
          if (session.handle === handle) set({ researchError: RESEARCH_KNOWN_FAILED })
          return
        }
      }
    }

    registerKnownRef = registerKnown

    /** 送る前の確かめ。送れなければ理由を出して false。text が null(調査を始めるとき)なら、入力欄に戻す文は無い */
    async function ready(text: string | null): Promise<boolean> {
      const state = get().status.state
      if (state === 'unknown' || state === 'loading') await get().loadStatus()
      const { status, token, budgetReached, toolRunning } = get()
      if (status.state !== 'ready' || !status.available) {
        push({ kind: 'error', text: status.state === 'error' ? status.message : CLAUDE_UNAVAILABLE })
        return false
      }
      if (status.tokenRequired && !token) {
        set({ tokenError: TOKEN_MISSING, ...(text !== null && { unsent: text }) })
        return false
      }
      if (budgetReached) {
        if (text !== null) set({ unsent: text })
        return false
      }
      if (toolRunning) {
        push({ kind: 'error', text: TOOLS_WAITING })
        if (text !== null) set({ unsent: text })
        return false
      }
      if (text !== null && byteLength(text) > MAX_TEXT_BYTES) {
        push({ kind: 'error', text: TEXT_TOO_LONG })
        set({ unsent: text })
        return false
      }
      return true
    }

    function onSendError(e: unknown, text: string): void {
      set({ unsent: text })
      if (e instanceof ClaudeRequestError && e.status === 401) {
        deps.storage.set(null)
        set({ token: null, tokenError: TOKEN_WRONG })
        return
      }
      push({ kind: 'error', text: errorText(e, 'AI に送れませんでした。もう一度送ってください。') })
    }

    return {
      status: { state: 'unknown' },
      token: deps.storage.get(),
      tokenError: null,
      items: [],
      sentLog: [],
      unsent: null,
      sending: false,
      replying: false,
      toolRunning: false,
      connection: 'none',
      usage: null,
      budgetCents: null,
      budgetReached: false,
      research: EMPTY_RESEARCH,
      researchError: null,

      async loadStatus() {
        set({ status: { state: 'loading' } })
        try {
          const s = await deps.fetchStatus()
          set({ status: { state: 'ready', available: s.available, tokenRequired: s.tokenRequired } })
        } catch (e) {
          set({ status: { state: 'error', message: errorText(e, 'AI の状態を確かめられませんでした。') } })
        }
      },

      setToken(token) {
        const t = token.trim()
        // HTTP のヘッダーで送るので、半角の英数字と記号だけ
        if (t !== '' && !/^[\x21-\x7e]+$/.test(t)) {
          set({ tokenError: TOKEN_CHARS })
          return
        }
        deps.storage.set(t === '' ? null : t)
        set({ token: t === '' ? null : t, tokenError: null })
      },

      async send(text, options = {}) {
        const t = text.trim()
        if (t === '' || get().sending) return false
        const gen = generation
        set({ sending: true })
        try {
          if (!(await ready(t))) return false
          if (gen !== generation) return false
          push({ kind: 'user', text: t, at: japanIso(deps.now()) })
          set({ unsent: null })
          // 新しい発言(サーバーも、この発言で止めた印を戻す)
          stoppedLong = false
          // 新しい相談なら、AI が確かめた便を数え直す。「続きを頼む」は同じ相談の続きなので数え続け、返答の終わりにまた出す
          if (continuing) checkedShown = null
          else resetChecked()
          // 取っ手が使えなくなっていたら(404・410)、1回だけ新しいセッションで送り直す
          for (let attempt = 0; ; attempt++) {
            try {
              if (!session.handle) tracker.reset()
              const created = await session.start()
              if (created) {
                researchChosen = null
                set({ budgetCents: session.budgetCents, usage: null, research: EMPTY_RESEARCH })
              }
              // 調べた結果の対象を、発言より先に登録する(AI が最初の返答から get_research_results で読めるように)
              await registerKnown()
              if (gen !== generation) return false
              const prepared = tracker.prepare(options.extraLines ?? [])
              const content: TextBlock[] = []
              if (prepared.lines.length > 0) content.push({ type: 'text', text: prepared.lines.join('\n') })
              content.push({ type: 'text', text: t })
              await session.sendMessage(content)
              if (gen !== generation) return false
              prepared.commit()
              log([...(prepared.lines.length > 0 ? [{ kind: 'screen' as const, text: prepared.lines.join('\n') }] : []), { kind: 'user', text: t }])
              set({ replying: true })
              return true
            } catch (e) {
              // 送っている間に会話を消した・新しく始めた(GTFS の読み込み直しなど)。消した後の表示に失敗を出さない
              if (gen !== generation) return false
              if (attempt === 0 && e instanceof ClaudeRequestError && (e.status === 404 || e.status === 410) && !session.handle) continue
              onSendError(e, t)
              return false
            }
          }
        } finally {
          if (gen === generation) set({ sending: false })
        }
      },

      askRestore() {
        return get().send(ASK_RESTORE_PROMPT)
      },

      async continueStopped() {
        // [画面の操作] の行に、この相談で AI が確かめた便の件数を入れる(AI が続きから探せるように。指摘18.4)
        continuing = true
        try {
          const ok = await get().send(CONTINUE_PROMPT, { extraLines: [continueLine(checked)] })
          if (ok) set({ items: get().items.map((i) => (i.kind === 'stopped' && !i.continued ? { ...i, continued: true } : i)) })
          return ok
        } finally {
          continuing = false
        }
      },

      async startResearch(targetIds) {
        if (targetIds.length === 0 || get().sending) return null
        const api = deps.research
        if (!api) {
          set({ researchError: RESEARCH_UNAVAILABLE })
          return null
        }
        const gen = generation
        set({ sending: true, researchError: null })
        try {
          if (!(await ready(null))) {
            const { status, tokenError, budgetReached, budgetCents } = get()
            const reason =
              status.state === 'error'
                ? status.message
                : status.state === 'ready' && !status.available
                  ? CLAUDE_UNAVAILABLE
                  : tokenError
                    ? `${tokenError}入力欄は「AI に相談」のタブにあります。`
                    : budgetReached
                      ? budgetReachedMessage(budgetCents)
                      : TOOLS_WAITING
            set({ researchError: reason })
            return null
          }
          if (gen !== generation) return null
          // 取っ手が使えなくなっていたら(404・410)、1回だけ新しいセッションで始め直す
          for (let attempt = 0; ; attempt++) {
            try {
              if (!session.handle) tracker.reset()
              const created = await session.start()
              if (created) {
                researchChosen = null
                set({ budgetCents: session.budgetCents, usage: null, research: EMPTY_RESEARCH })
              }
              const handle = session.handle
              if (!handle) throw new ClaudeRequestError(404, 'AI との会話が見つかりません。新しく始めます。')
              await registerKnown()
              if (gen !== generation) return null
              const view = await api.start(get().token, handle, targetIds)
              if (gen !== generation) return null
              // 調査の対象はセッションに入ったので、結果が保存されても登録し直さない
              if (known?.handle === handle) for (const t of view.targets) known.ids.add(t.targetId)
              // サーバーが会話に入れる行の件数は、送った対象の数(view.total は登録済みの調べた結果の対象も含む)
              log([{ kind: 'screen', text: researchStartLine(new Set(targetIds).size) }])
              // 調査を始めると、サーバーは user.message を送る(この発言で止めた印も戻る。新しい相談として数え直す)
              stoppedLong = false
              resetChecked()
              // 進み具合の分母は、利用者が選んだ対象の数(view.total は登録した調べた結果の対象も含む。A06 の申し送り)。
              // 保存済み(cached)の対象は調べない(§3.2)。調べる対象が無ければ、進み具合は「調べ終えました」から始める
              const chosenIds = new Set(targetIds)
              const chosen = [...new Map(view.targets.filter((t) => chosenIds.has(t.targetId)).map((t) => [t.targetId, t])).values()]
              researchChosen = chosen.length
              const saved = chosen.filter((t) => t.cached !== null).length
              const active = saved < chosen.length
              set({
                replying: true,
                research: { ...EMPTY_RESEARCH, active, saved, total: chosen.length, outcome: active ? null : 'done' },
              })
              return view
            } catch (e) {
              if (gen !== generation) return null
              if (attempt === 0 && e instanceof ClaudeRequestError && (e.status === 404 || e.status === 410)) {
                session.forget()
                continue
              }
              if (e instanceof ClaudeRequestError && e.status === 401) {
                deps.storage.set(null)
                set({ token: null, tokenError: TOKEN_WRONG, researchError: `${TOKEN_WRONG}入力欄は「AI に相談」のタブにあります。` })
                return null
              }
              set({ researchError: errorText(e, '調査を始められませんでした。もう一度試してください。') })
              return null
            }
          }
        } finally {
          if (gen === generation) set({ sending: false })
        }
      },

      async loadResearch() {
        const api = deps.research
        const handle = session.handle
        if (!api || !handle) return null
        const gen = generation
        try {
          const overview = await api.overview(get().token, handle)
          return gen === generation ? overview : null
        } catch (e) {
          if (gen === generation) set({ researchError: errorText(e, '調査の結果を読めませんでした。') })
          return null
        }
      },

      async stop() {
        if (!session.handle) return
        try {
          await session.interrupt()
        } catch (e) {
          push({ kind: 'error', text: errorText(e, 'AI を止められませんでした。') })
        }
      },

      startOver() {
        generation++
        session.close()
        tracker.reset()
        known = null
        stoppedLong = false
        resetChecked()
        researchChosen = null
        closeStreaming()
        skipRunning()
        set({ sending: false, replying: false, toolRunning: false, connection: 'none', usage: null, budgetCents: null, budgetReached: false, research: EMPTY_RESEARCH, researchError: null })
        push({ kind: 'notice', text: NEW_SESSION_NOTICE })
      },

      reset(notice) {
        generation++
        session.close()
        tracker.reset()
        known = null
        stoppedLong = false
        resetChecked()
        researchChosen = null
        set({
          items: [],
          sentLog: [],
          unsent: null,
          sending: false,
          replying: false,
          toolRunning: false,
          connection: 'none',
          usage: null,
          budgetCents: null,
          budgetReached: false,
          research: EMPTY_RESEARCH,
          researchError: null,
        })
        if (notice) push({ kind: 'notice', text: notice })
      },

      endSession() {
        session.close()
      },
    }
  })
  deps.watchBase?.(() => {
    const s = store.getState()
    const hadConversation = s.items.length > 0 || s.sending || session.handle !== null
    s.reset(hadConversation ? RELOAD_NOTICE : undefined)
  })
  // 前提情報の結果が増えたら、セッションがある間はすぐ登録する(無ければ、次にセッションを作ったときに登録する)
  deps.watchResearch?.(() => {
    if (session.handle) void registerKnownRef()
  })
  return store
}

/** research のイベントで、調査の進み具合を進める */
function nextResearch(r: ResearchProgress, e: Extract<DisplayStreamEvent, { type: 'research' }>): ResearchProgress {
  const runs = new Set(r.openRuns)
  switch (e.kind) {
    case 'run_started':
      if (e.runId) runs.add(e.runId)
      return { ...r, active: true, openRuns: [...runs], phase: null, paused: false, outcome: null }
    case 'phase_started':
      return { ...r, phase: e.name ?? e.phase ?? r.phase, paused: false }
    case 'phase_ended':
      return r
    case 'run_paused':
      return { ...r, paused: true }
    case 'run_ended':
    case 'run_error': {
      if (e.runId) runs.delete(e.runId)
      const openRuns = [...runs]
      if (openRuns.length > 0) return { ...r, openRuns }
      const complete = e.kind === 'run_ended' && e.result === 'completed' && (r.total === null || r.saved >= r.total)
      return { ...r, active: false, openRuns, phase: null, paused: false, outcome: complete ? 'done' : 'partial' }
    }
    case 'delegated':
      return { ...r, active: true, delegated: r.delegated + 1, outcome: null }
    case 'saved':
      return { ...r, saved: e.saved ?? r.saved, total: e.total ?? r.total }
    default:
      return r
  }
}

// ---- 本物のつなぎ ----

const TOKEN_KEY = 'dispatcher.claude.token'

/** sessionStorage の合言葉(読み書きは try/catch。使えなければ保存しない) */
export const sessionTokenStorage: TokenStorage = {
  get() {
    try {
      return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null
    } catch {
      return null
    }
  },
  set(token) {
    try {
      if (token === null) globalThis.sessionStorage?.removeItem(TOKEN_KEY)
      else globalThis.sessionStorage?.setItem(TOKEN_KEY, token)
    } catch {
      // 使えなければ、このタブの間だけ store に持つ(読み込み直したら入れ直す)
    }
  },
}

/**
 * GET /api/claude/status を読む。失敗はどれも日本語の決まった文の Error にする
 * (つながらないときの fetch の TypeError や、JSON でない返答の SyntaxError の英語の文を画面に出さない)
 */
export async function fetchClaudeStatus(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<{ available: boolean; tokenRequired: boolean }> {
  let res: Response
  try {
    res = await fetchImpl('/api/claude/status')
  } catch {
    throw new Error(NOT_CONNECTED)
  }
  if (!res.ok) throw new Error(`AI の状態を確かめられませんでした(${res.status})。`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(STATUS_SHAPE)
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof b.available !== 'boolean' || typeof b.tokenRequired !== 'boolean') throw new Error(STATUS_SHAPE)
  return { available: b.available, tokenRequired: b.tokenRequired }
}

/**
 * 画面とのつなぎの口。方針の手順で画面が選んでいる service と、到達圏を使う手がかりの ctx を、画面の側から渡せる
 * (渡さなければ、service は画面と同じ推定に承認済みの方針を重ねたもの、ctx は到達圏の store から buildRestoreHintContext で作る)
 */
export interface ChatToolProviders {
  policyServices: ((validity: { start: string; end: string } | null) => PolicyServices | null) | null
  hintContext: ((editedFeed: GtfsFeed) => RestoreHintContext | null) | null
}

const providers: ChatToolProviders = { policyServices: null, hintContext: null }

/** 画面の部品が、自分の選択をツールに渡す(null を渡すと既定に戻す) */
export function setChatToolProviders(p: Partial<ChatToolProviders>): void {
  Object.assign(providers, p)
}

function holidayList() {
  const h = useHolidayStore.getState().holidays
  return h.status === 'ready' ? h.list : null
}

/**
 * 画面が選び直していないときの service。方針の手順と同じ推定(guessServiceChoice)に、承認済みの方針で選んだ service を重ねる。
 * validity が null なら、承認済みの方針の有効期間(無ければ入力の有効期間)で推定する
 */
export function defaultPolicyServices(validity: { start: string; end: string } | null): PolicyServices | null {
  const { base, history } = useEditStore.getState()
  if (!base) return null
  const plan = planOf(history)
  const input = feedValidity(base.feed)
  const v = validity ?? (input && plan ? (policyValidity(input, plan.period) ?? input) : input)
  const guess = v ? guessServiceChoice(base.feed, describeServices(base.feed, holidayList()), v) : null
  const out: PolicyServices = { weekday: guess?.weekday ?? null, saturday: guess?.saturday ?? null, sundayHoliday: guess?.sundayHoliday ?? null }
  if (plan) {
    out.weekday = plan.weekdayService
    if (plan.kind === 'weekdayToSaturday') out.saturday = plan.replacementService
    else out.sundayHoliday = plan.replacementService
  }
  // 読み込みの手順のダイヤのグループ分け(Jev の答えを待っていなければ、AI のツールもダイヤ単位で減便の方針を作る)
  const sg = useServiceGroupsStore.getState()
  const grouped = groupedPolicyServices(sg.groups, !jevPending(sg.jev.state))
  if (grouped) out.groups = grouped
  return out
}

function policyServices(validity: { start: string; end: string } | null): PolicyServices | null {
  return providers.policyServices ? providers.policyServices(validity) : defaultPolicyServices(validity)
}

/** 到達圏を使う手がかりの ctx(既定は到達圏の store から作る。編集後のフィードが違えば null) */
function hintContext(feed: GtfsFeed): RestoreHintContext | null {
  return providers.hintContext ? providers.hintContext(feed) : buildRestoreHintContext(useReachStore.getState(), feed)
}

/** ツールの依存(本物の store につないだもの) */
export const chatToolDeps: ToolDeps = {
  edit: () => useEditStore.getState(),
  reach: useReachStore,
  holidays: holidayList,
  today: () => todayInJapan(new Date()),
  policyServices,
  hintContext,
}

/** [画面の状態] の行の材料(本物の store から作る) */
export function currentScreenState(): ScreenState {
  const { base } = useEditStore.getState()
  const reach = useReachStore.getState()
  const results = [...useResearchStore.getState().results.values()]
  return {
    today: todayInJapan(new Date()),
    gtfs: base ? { label: base.label, validity: feedValidity(base.feed), services: policyServices(null) } : null,
    reach: base ? { date: reach.date, stepHours: reach.stepHours } : null,
    research: { count: results.length, demo: results.filter((r) => r.origin === 'demo').length },
  }
}

/** 前提情報の store に結果がある target_id(デモと Web の両方) */
function knownResearchTargets(): string[] {
  return [...useResearchStore.getState().results.keys()]
}

/**
 * アプリ内の Claude との会話。GTFS を読み込み直したら(編集の store の基準が変わったら)セッションを終えて会話を消す。
 * ページを閉じる・読み込み直すとき(pagehide)もセッションを終える
 */
export const useChatStore = createChatStore({
  fetchStatus: () => fetchClaudeStatus(),
  api: createSessionApi(),
  research: createResearchApi(),
  runTool: (name, input, signal) => runTool(name, input, chatToolDeps, signal),
  screen: currentScreenState,
  edits: () => {
    const { history, versions } = useEditStore.getState()
    return { history, versions }
  },
  takeDraftNotices: () => useEditStore.getState().takeDraftNotices(),
  knownResearchTargets,
  watchResearch: (onChange) => {
    useResearchStore.subscribe((state, prev) => {
      if (state.results !== prev.results) onChange()
    })
  },
  storage: sessionTokenStorage,
  now: () => new Date(),
  watchBase: (onChange) => {
    useEditStore.subscribe((state, prev) => {
      if (state.base !== prev.base) onChange()
    })
  },
})

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => useChatStore.getState().endSession())
}
