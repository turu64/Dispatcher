/**
 * アプリ内の Claude のセッション(Managed Agents。docs/interfaces-1105.md §4.2〜§4.9・§6.3・§6.5)。
 *
 * - セッションの取っ手(X-Dispatcher-Session)はメモリにだけ置く。ページを読み込み直したら新しいセッション
 * - 長いストリーム(GET /api/claude/session/stream)を1本持ち、切れたら 1・2・4・8 秒(以後 8 秒ごと)でつなぎ直す。
 *   つなぎ直すときは、最後に受け取ったイベントの id を Last-Event-ID に付ける
 * - 受け取ったイベントは id で重なりを除く。ただし tool_call は除かない:サーバーは、答えていない呼び出しを、つなぎ直しで
 *   同じ id のまま送り直すため。tool_call は呼び出しの id ごとの状態で扱う(実行中・待ち → 何もしない、
 *   結果あり → 実行せずに残した結果を送り直す、初めて → 実行する)
 * - ツールは受け取った順に1つずつ実行し、続けて届いた呼び出しをまとめて1回の tool_results で送る(1回で 10 件まで)。
 *   送る POST が通信の失敗で落ちたら 1・2・4 秒の間をおいて3回までやり直す。409(答える呼び出しが無い)は届いたものとして扱う
 * - 「止める」は、実行中のツールを止め、答えていない呼び出しの結果(実行できた分は本物の結果、ほかは「利用者が止めました」)と
 *   interrupt を1回の POST で送る
 * - 発言(message)は送り直さない(届いていたときに二重になるため)。失敗は呼び出し側に返す
 */
import {
  authHeaders,
  ClaudeRequestError,
  NOT_CONNECTED,
  openSessionStream,
  requestError,
  type SessionStreamEvent,
} from './sse'
import { byteLength, EDIT_TOOLS, errorOutcome, MAX_RESULT_BYTES, pendingDraftMessage, type ToolOutcome } from './tools'

// ---- 中継の API(§4.2) ----

export interface TextBlock {
  type: 'text'
  text: string
}

/** ツールの結果の1件(POST /api/claude/session/events の results) */
export interface ToolResultItem {
  custom_tool_use_id: string
  text: string
  is_error: boolean
}

/** POST /api/claude/session/events の本文(§4.7) */
export type SessionPostBody =
  | { kind: 'message'; content: TextBlock[] }
  | { kind: 'tool_results'; results: ToolResultItem[] }
  | { kind: 'interrupt'; results: ToolResultItem[] }

export interface SessionApi {
  /** POST /api/claude/session。セッションを作り、取っ手と1セッションの予算(セント)を返す */
  create: (token: string | null) => Promise<{ handle: string; budgetCents: number }>
  /** GET /api/claude/session/stream(sse.ts の openSessionStream) */
  openStream: (options: { token: string | null; handle: string; lastEventId: string | null; signal: AbortSignal }) => Promise<AsyncIterable<SessionStreamEvent>>
  /** POST /api/claude/session/events。失敗は ClaudeRequestError(つながらなければ status が null) */
  post: (token: string | null, handle: string, body: SessionPostBody) => Promise<void>
  /** DELETE /api/claude/session(keepalive。結果は待たない。届かなくても 24 時間の掃除で消える) */
  remove: (token: string | null, handle: string) => void
}

/** 本物の fetch でつなぐ API。base は '/api/claude' */
export function createSessionApi(fetchImpl?: typeof fetch, base = '/api/claude'): SessionApi {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init))
  const json = { 'Content-Type': 'application/json' }
  return {
    async create(token) {
      const headers = { ...json, ...authHeaders(token, null) }
      let res: Response
      try {
        res = await doFetch(`${base}/session`, { method: 'POST', headers, body: '{}' })
      } catch {
        throw new ClaudeRequestError(null, NOT_CONNECTED)
      }
      if (!res.ok) throw await requestError(res)
      const body: unknown = await res.json().catch(() => null)
      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      if (typeof b.handle !== 'string' || b.handle === '' || typeof b.budget_cents !== 'number') {
        throw new ClaudeRequestError(res.status, 'AI の中継の返答の形が違います。')
      }
      return { handle: b.handle, budgetCents: b.budget_cents }
    },
    openStream(options) {
      return openSessionStream({ ...options, fetchImpl: doFetch, url: `${base}/session/stream` })
    },
    async post(token, handle, body) {
      const headers = { ...json, ...authHeaders(token, handle) }
      let res: Response
      try {
        res = await doFetch(`${base}/session/events`, { method: 'POST', headers, body: JSON.stringify(body) })
      } catch {
        throw new ClaudeRequestError(null, NOT_CONNECTED)
      }
      if (!res.ok) throw await requestError(res)
      void res.body?.cancel().catch(() => undefined)
    },
    remove(token, handle) {
      let headers: Record<string, string>
      try {
        headers = authHeaders(token, handle)
      } catch {
        headers = authHeaders(null, handle)
      }
      try {
        void doFetch(`${base}/session`, { method: 'DELETE', headers, keepalive: true }).catch(() => undefined)
      } catch {
        // 送れなくても、24 時間の掃除で消える
      }
    },
  }
}

// ---- セッション ----

/** 「止める」で、実行しなかった呼び出しに返す文(§6.3) */
export const STOPPED_BY_USER = '利用者が止めました'
const ONE_EDIT_PER_RESPONSE = '編集のツール(apply_policy・add_back_trips・undo_edit)は、1回の返答で1つだけ使えます。次の返答で使ってください'
const TOOL_FAILED = 'ツールを実行できませんでした。'
const RESULT_TOO_LARGE = '結果が 20KB を超えたので送れませんでした。条件を絞って、もう一度使ってください。'
export const SEND_RESULTS_FAILED = 'ツールの結果を AI に送れませんでした。つながり直したときに、もう一度送ります。'
const CLOSED = 'AI との会話を終えました。'

/** 1回の POST に入れるツールの結果の数(§4.7) */
export const MAX_RESULTS_PER_POST = 10

/** 送った結果の1件(「AI に送る情報」に残す) */
export interface SentResult {
  id: string
  name: string
  text: string
  isError: boolean
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** tool_call を除いた、画面に渡すストリームのイベント */
export type DisplayStreamEvent = Exclude<SessionStreamEvent, { type: 'tool_call' }>

export type SessionEvent =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'stream'; event: DisplayStreamEvent }
  /** ブラウザのツールを実行し始めた */
  | { type: 'tool_start'; id: string; name: string }
  /** ブラウザのツールを実行し終えた(止めて実行しなかったものも、始めていれば届く) */
  | { type: 'tool_done'; id: string; name: string; outcome: ToolOutcome }
  /** 答えていない(実行中・待ち・送る前・送っている途中の)ブラウザのツールの呼び出しの数 */
  | { type: 'tools'; pending: number }
  /** ツールの結果(と interrupt)を送れた */
  | { type: 'sent'; kind: 'tool_results' | 'interrupt'; results: SentResult[] }
  /** 取っ手が使えなくなった(404・410)。次に送るときに新しいセッションを作る */
  | { type: 'lost'; message: string }
  /** 合言葉が違う(401) */
  | { type: 'unauthorized'; message: string }
  /** ツールの結果を送れなかった(やり直しても) */
  | { type: 'send_failed'; message: string }

export interface SessionDeps {
  api: SessionApi
  token: () => string | null
  /** ブラウザのツールを実行する(tools.ts の runTool。止めたら AbortError で reject してよい) */
  runTool: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolOutcome>
  onEvent: (event: SessionEvent) => void
  /** 待つ(テストで差し替える)。signal で止めたら reject する */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** つなぎ直す間(ミリ秒)。最後の値を以後ずっと使う。既定 [1000, 2000, 4000, 8000] */
  reconnectDelays?: readonly number[]
  /** POST をやり直す間(ミリ秒)。既定 [1000, 2000, 4000](3回までやり直す) */
  retryDelays?: readonly number[]
  /** 続けて届いた呼び出しを1回で送るため、実行し終えてから送るまで待つ時間(ミリ秒)。既定 20 */
  batchDelayMs?: number
  /** 今の時刻(ミリ秒。テストで差し替える)。既定 Date.now */
  now?: () => number
}

/**
 * つながったストリームが、この時間(ミリ秒)より長く開いていたら、つなぎ直しの間を最初に戻す。
 * つないだだけでは戻さない(中継は Anthropic につなぐ前に返答を始めることがあり、Anthropic が落ちていると、
 * 開いてすぐ error(code upstream)を送って閉じる。それで戻すと、落ちている間ずっと 1 秒ごとにつなぎ直すため。§6.4)
 */
const STABLE_STREAM_MS = 30_000

type CallStatus = 'queued' | 'running' | 'ready' | 'sending' | 'delivered' | 'failed'

interface CallState {
  name: string
  input: unknown
  status: CallStatus
  /** 実行を始めた(tool_start を出した) */
  started: boolean
  result: { text: string; isError: boolean } | null
}

function abortError(): DOMException {
  return new DOMException('止めました', 'AbortError')
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 結果の text が 20KB を超えたら、送れない旨の is_error にする(tools.ts の fitResult で収まらなかったとき) */
function resultOf(outcome: ToolOutcome): { text: string; isError: boolean } {
  if (byteLength(outcome.content) <= MAX_RESULT_BYTES) return { text: outcome.content, isError: outcome.isError }
  return { text: errorOutcome(RESULT_TOO_LARGE).content, isError: true }
}

/** 呼び出し側の待ち(start が、ストリームがつながるのを待つ) */
interface Waiter {
  resolve: () => void
  reject: (e: unknown) => void
}

/**
 * 1つのセッションの取っ手・ストリーム・送信・ツールの実行。close か forget で捨てると、新しいセッションとして使い直せる
 */
export class ClaudeSession {
  private readonly deps: SessionDeps
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly reconnectDelays: readonly number[]
  private readonly retryDelays: readonly number[]
  private readonly batchDelayMs: number
  private readonly now: () => number

  private handleValue: string | null = null
  private budget: number | null = null
  /** セッションの世代。捨てるたびに増やし、古い世代の非同期の処理の結果は使わない */
  private gen = 0
  /** この世代の処理を止める(ストリーム・待ち・ツール) */
  private life = new AbortController()
  private streamRunning = false
  private connected = false
  private everConnected = false
  private waiters: Waiter[] = []
  private lastEventId: string | null = null
  private readonly seen = new Set<string>()
  private readonly calls = new Map<string, CallState>()
  private queue: string[] = []
  private pumping: Promise<void> | null = null
  private toolCtrl: AbortController | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private interrupting = false
  /** 1回の返答の中の編集のツール(まとめて送るまでを1回の返答とみなす) */
  private batch: { editUsed: boolean; editDraft: string | null } = { editUsed: false, editDraft: null }
  private lastPending = 0

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.sleep = deps.sleep ?? defaultSleep
    this.reconnectDelays = deps.reconnectDelays ?? [1000, 2000, 4000, 8000]
    this.retryDelays = deps.retryDelays ?? [1000, 2000, 4000]
    this.batchDelayMs = deps.batchDelayMs ?? 20
    this.now = deps.now ?? (() => Date.now())
  }

  /** 今のセッションの取っ手(無ければ null) */
  get handle(): string | null {
    return this.handleValue
  }

  /** POST /api/claude/session が返した予算(セント) */
  get budgetCents(): number | null {
    return this.budget
  }

  get isConnected(): boolean {
    return this.connected
  }

  /** 答えていないブラウザのツールの呼び出しの数 */
  get pendingTools(): number {
    let n = 0
    for (const c of this.calls.values()) if (c.status === 'queued' || c.status === 'running' || c.status === 'ready' || c.status === 'sending') n++
    return n
  }

  /**
   * セッションを使えるようにする。取っ手が無ければ作り、ストリームをつないで、つながるまで待つ(§6.5。ストリームを先に開く)。
   * 失敗は ClaudeRequestError。作ったら true を返す(新しいセッション)
   */
  async start(): Promise<boolean> {
    let created = false
    if (!this.handleValue) {
      const gen = this.gen
      const { handle, budgetCents } = await this.deps.api.create(this.deps.token())
      if (gen !== this.gen || this.handleValue) {
        // 作っている間に捨てられた(GTFS の読み込み直しなど)か、ほかの呼び出しが先に作った。作ったものは消す
        this.deps.api.remove(this.deps.token(), handle)
        if (gen !== this.gen) throw new ClaudeRequestError(null, CLOSED)
      } else {
        this.resetState()
        this.handleValue = handle
        this.budget = budgetCents
        created = true
      }
    }
    if (this.connected) return created
    const wait = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }))
    if (!this.streamRunning) void this.runStream(this.gen)
    await wait
    return created
  }

  /**
   * 発言を送る(§4.7 の message)。content は text のブロック 1〜2 個(2 個のときは1つ目が [画面の…] の行)。
   * 送れなかった結果があれば先に送る。失敗は ClaudeRequestError(404・410 なら取っ手を捨てる)
   */
  async sendMessage(content: TextBlock[]): Promise<void> {
    const handle = this.handleValue
    if (!handle) throw new ClaudeRequestError(404, 'AI との会話が見つかりません。新しく始めます')
    if ([...this.calls.values()].some((c) => c.status === 'failed')) {
      for (const c of this.calls.values()) if (c.status === 'failed') c.status = 'ready'
      this.emitPending()
      await this.flush()
    }
    try {
      await this.deps.api.post(this.deps.token(), handle, { kind: 'message', content })
    } catch (e) {
      this.onRequestError(e, handle)
      throw e
    }
  }

  /**
   * 止める(§6.3)。実行中のツールを止め、答えていない呼び出しの結果と interrupt を1回の POST で送る。
   * 実行し終えていた呼び出しは本物の結果を、実行していない呼び出しは「利用者が止めました」を送る。送った結果を返す
   */
  async interrupt(): Promise<SentResult[]> {
    const handle = this.handleValue
    if (!handle || this.interrupting) return []
    const gen = this.gen
    this.interrupting = true
    this.clearFlushTimer()
    try {
      this.toolCtrl?.abort()
      if (this.pumping) await this.pumping
      if (this.flushing) await this.flushing
      if (gen !== this.gen) return []
      this.stopQueued()
      const ids = [...this.calls].filter(([, c]) => c.status === 'ready' || c.status === 'failed').map(([id]) => id)
      // 10 件を超える分は、先に tool_results で送る
      const head = ids.slice(0, Math.max(0, ids.length - MAX_RESULTS_PER_POST))
      const tail = ids.slice(head.length)
      for (let i = 0; i < head.length; i += MAX_RESULTS_PER_POST) {
        await this.deliver(gen, handle, 'tool_results', head.slice(i, i + MAX_RESULTS_PER_POST))
      }
      if (gen !== this.gen) return []
      return await this.deliver(gen, handle, 'interrupt', tail)
    } finally {
      if (gen === this.gen) {
        this.interrupting = false
        this.batch = { editUsed: false, editDraft: null }
        // 止めている間に届いた呼び出しにも「利用者が止めました」で答える
        if (this.queue.length > 0) {
          this.stopQueued()
          this.scheduleFlush(0)
        }
        this.emitPending()
      }
    }
  }

  /** セッションを終える(DELETE を keepalive で送り、取っ手を捨てる。§6.5) */
  close(): void {
    const handle = this.handleValue
    const token = this.deps.token()
    this.forget()
    if (handle) this.deps.api.remove(token, handle)
  }

  /** 取っ手を捨てる(サーバーには送らない。終わったセッション・見つからないセッション) */
  forget(): void {
    const hadHandle = this.handleValue !== null || this.streamRunning
    this.gen++
    this.life.abort()
    this.life = new AbortController()
    this.toolCtrl?.abort()
    this.toolCtrl = null
    this.clearFlushTimer()
    this.handleValue = null
    this.budget = null
    this.connected = false
    this.streamRunning = false
    this.rejectWaiters(new ClaudeRequestError(null, CLOSED))
    this.resetState()
    this.emitPending()
    if (hadHandle) this.deps.onEvent({ type: 'connection', state: 'closed' })
  }

  // ---- ストリーム ----

  private resetState(): void {
    this.everConnected = false
    this.lastEventId = null
    this.seen.clear()
    this.calls.clear()
    this.queue = []
    this.pumping = null
    this.flushing = null
    this.interrupting = false
    this.batch = { editUsed: false, editDraft: null }
  }

  private resolveWaiters(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.resolve()
  }

  private rejectWaiters(e: unknown): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.reject(e)
  }

  private async runStream(gen: number): Promise<void> {
    this.streamRunning = true
    const life = this.life.signal
    let attempt = 0
    try {
      while (gen === this.gen && this.handleValue) {
        const handle = this.handleValue
        const ctrl = new AbortController()
        const onLife = () => ctrl.abort()
        life.addEventListener('abort', onLife, { once: true })
        this.deps.onEvent({ type: 'connection', state: this.everConnected ? 'reconnecting' : 'connecting' })
        try {
          const events = await this.deps.api.openStream({ token: this.deps.token(), handle, lastEventId: this.lastEventId, signal: ctrl.signal })
          if (gen !== this.gen) return
          this.connected = true
          this.everConnected = true
          this.deps.onEvent({ type: 'connection', state: 'open' })
          this.resolveWaiters()
          const openedAt = this.now()
          try {
            for await (const event of events) {
              if (gen !== this.gen) return
              // つなぎ直しの間を戻すのは、中継が Anthropic とつながっていると分かってから
              // (Anthropic への接続の失敗 error(code upstream)のほかのイベントが届いたとき)
              if (!(event.type === 'error' && event.code === 'upstream')) attempt = 0
              this.onStreamEvent(event)
            }
          } finally {
            // 長く開いていたストリーム(静かな会話)が切れたときも、間を戻す
            if (this.now() - openedAt >= STABLE_STREAM_MS) attempt = 0
          }
        } catch (e) {
          if (gen !== this.gen || life.aborted) return
          this.connected = false
          this.rejectWaiters(e)
          if (e instanceof ClaudeRequestError && (e.status === 401 || e.status === 404 || e.status === 410)) {
            this.onRequestError(e, handle)
            if (e.status === 401) {
              this.streamRunning = false
              this.deps.onEvent({ type: 'connection', state: 'closed' })
            }
            return
          }
          if (!this.everConnected) {
            // 最初につなげなかった(start が失敗を返す)。次に送るときに、もう一度つなぐ
            this.streamRunning = false
            this.deps.onEvent({ type: 'connection', state: 'closed' })
            return
          }
        } finally {
          life.removeEventListener('abort', onLife)
          ctrl.abort()
        }
        if (gen !== this.gen) return
        this.connected = false
        this.deps.onEvent({ type: 'connection', state: 'reconnecting' })
        const delay = this.reconnectDelays[Math.min(attempt, this.reconnectDelays.length - 1)]
        attempt++
        try {
          await this.sleep(delay, life)
        } catch {
          return
        }
      }
    } finally {
      if (gen === this.gen) {
        this.streamRunning = false
        this.connected = false
      }
    }
  }

  private onStreamEvent(event: SessionStreamEvent): void {
    if (event.id) this.lastEventId = event.id
    if (event.type === 'tool_call') {
      this.onToolCall(event.id, event.name, event.input)
      return
    }
    if (event.id) {
      if (this.seen.has(event.id)) return
      this.seen.add(event.id)
    }
    if (event.type === 'status' && event.state === 'idle' && event.reason === 'requires_action') {
      // 呼び出しがそろった合図。結果があれば待たずに送る
      this.scheduleFlush(0)
    }
    this.deps.onEvent({ type: 'stream', event })
    if (event.type === 'status' && event.state === 'ended') this.forget()
  }

  /** 404・410・401 の失敗を扱う */
  private onRequestError(e: unknown, handle: string): void {
    if (!(e instanceof ClaudeRequestError)) return
    if (e.status === 401) {
      this.deps.onEvent({ type: 'unauthorized', message: e.message })
      return
    }
    if ((e.status === 404 || e.status === 410) && this.handleValue === handle) {
      this.forget()
      this.deps.onEvent({ type: 'lost', message: e.message })
    }
  }

  // ---- ツールの実行と結果の送信 ----

  private emitPending(): void {
    const pending = this.pendingTools
    if (pending === this.lastPending) return
    this.lastPending = pending
    this.deps.onEvent({ type: 'tools', pending })
  }

  private onToolCall(id: string, name: string, input: unknown): void {
    const c = this.calls.get(id)
    if (!c) {
      this.calls.set(id, { name, input, status: 'queued', started: false, result: null })
      this.queue.push(id)
      this.emitPending()
      if (this.interrupting) return
      this.pump()
      return
    }
    // 実行中・待ち・送る前・送っている途中なら何もしない(結果はまとめて送る)
    if (c.status !== 'delivered' && c.status !== 'failed') return
    // つなぎ直しでサーバーが送り直した呼び出し:実行せずに、残した結果を送る(§6.3)
    c.status = 'ready'
    this.emitPending()
    this.scheduleFlush()
  }

  private pump(): void {
    if (this.pumping) return
    const gen = this.gen
    this.pumping = (async () => {
      while (this.queue.length > 0 && gen === this.gen && !this.interrupting) {
        const id = this.queue.shift()!
        const c = this.calls.get(id)
        if (!c || c.status !== 'queued') continue
        c.status = 'running'
        c.started = true
        this.deps.onEvent({ type: 'tool_start', id, name: c.name })
        const ctrl = new AbortController()
        this.toolCtrl = ctrl
        let outcome: ToolOutcome
        if (EDIT_TOOLS.has(c.name) && this.batch.editUsed) {
          outcome = errorOutcome(this.batch.editDraft ? pendingDraftMessage(this.batch.editDraft) : ONE_EDIT_PER_RESPONSE)
        } else {
          try {
            outcome = await this.deps.runTool(c.name, c.input, ctrl.signal)
          } catch (e) {
            outcome = errorOutcome(isAbort(e) || ctrl.signal.aborted ? STOPPED_BY_USER : TOOL_FAILED)
          }
        }
        if (this.toolCtrl === ctrl) this.toolCtrl = null
        if (gen !== this.gen) return
        if (EDIT_TOOLS.has(c.name)) {
          this.batch.editUsed = true
          if (outcome.draft && this.batch.editDraft === null) this.batch.editDraft = outcome.draft.id
        }
        c.result = resultOf(outcome)
        c.input = undefined
        c.status = 'ready'
        this.deps.onEvent({ type: 'tool_done', id, name: c.name, outcome })
      }
    })().finally(() => {
      if (gen !== this.gen) return
      this.pumping = null
      if (!this.interrupting) this.scheduleFlush()
      this.emitPending()
    })
  }

  /** 実行していない呼び出しを「利用者が止めました」にする */
  private stopQueued(): void {
    for (const id of this.queue) {
      const c = this.calls.get(id)
      if (!c || c.status !== 'queued') continue
      c.result = resultOf(errorOutcome(STOPPED_BY_USER))
      c.input = undefined
      c.status = 'ready'
    }
    this.queue = []
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private scheduleFlush(delay = this.batchDelayMs): void {
    this.clearFlushTimer()
    const gen = this.gen
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (gen === this.gen) void this.flush()
    }, delay)
  }

  /** 結果のある呼び出しを、まとめて tool_results で送る(実行中・待ちがあれば、終わってから) */
  private flush(): Promise<void> {
    if (this.flushing) {
      // 送っている間に増えた結果は、送り終えてからもう一度送る
      return this.flushing.then(() => this.flush())
    }
    if (this.pumping || this.queue.length > 0 || this.interrupting) return Promise.resolve()
    const handle = this.handleValue
    if (!handle) return Promise.resolve()
    const ids = [...this.calls].filter(([, c]) => c.status === 'ready').map(([id]) => id)
    if (ids.length === 0) return Promise.resolve()
    const gen = this.gen
    this.batch = { editUsed: false, editDraft: null }
    this.flushing = (async () => {
      for (let i = 0; i < ids.length; i += MAX_RESULTS_PER_POST) {
        await this.deliver(gen, handle, 'tool_results', ids.slice(i, i + MAX_RESULTS_PER_POST))
        if (gen !== this.gen) return
      }
    })().finally(() => {
      if (gen === this.gen) this.flushing = null
    })
    return this.flushing
  }

  /** 結果(と interrupt)を送る。通信の失敗はやり直し、409 は届いたものとして扱う */
  private async deliver(gen: number, handle: string, kind: 'tool_results' | 'interrupt', ids: string[]): Promise<SentResult[]> {
    const sent: SentResult[] = []
    for (const id of ids) {
      const c = this.calls.get(id)
      if (!c?.result) continue
      c.status = 'sending'
      sent.push({ id, name: c.name, text: c.result.text, isError: c.result.isError })
    }
    if (kind === 'tool_results' && sent.length === 0) return []
    this.emitPending()
    const results: ToolResultItem[] = sent.map((r) => ({ custom_tool_use_id: r.id, text: r.text, is_error: r.isError }))
    const body: SessionPostBody = { kind, results }
    let failure: unknown = null
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.api.post(this.deps.token(), handle, body)
        break
      } catch (e) {
        if (gen !== this.gen) return []
        if (e instanceof ClaudeRequestError && e.status === 409) break
        const retryable = e instanceof ClaudeRequestError && (e.status === null || e.status >= 500)
        if (!retryable || attempt >= this.retryDelays.length) {
          failure = e
          break
        }
        try {
          await this.sleep(this.retryDelays[attempt], this.life.signal)
        } catch {
          return []
        }
        if (gen !== this.gen) return []
      }
    }
    if (gen !== this.gen) return []
    for (const r of sent) {
      const c = this.calls.get(r.id)
      if (c) c.status = failure ? 'failed' : 'delivered'
    }
    this.emitPending()
    if (failure) {
      this.onRequestError(failure, handle)
      if (gen === this.gen) this.deps.onEvent({ type: 'send_failed', message: SEND_RESULTS_FAILED })
      return []
    }
    this.deps.onEvent({ type: 'sent', kind, results: sent })
    return sent
  }
}
