/**
 * Claude の中継のストリーム(GET /api/claude/session/stream)を受け取る(docs/interfaces-1105.md §4.5・§4.6)。
 *
 * 合言葉とセッションの取っ手をヘッダーで送るので EventSource は使えない。fetch の本文(ReadableStream)を読み、
 * SSE(text/event-stream)の規則で区切る。流し始める前の失敗(401・404・410・429・503 など)は SSE ではなく
 * JSON({ "detail": "…" })で返る。
 */

/** SSE の1件(event・data の文字列と、その件の id の行) */
export interface SseMessage {
  event: string
  data: string
  /** その件に id の行があったときだけ、その値。無ければ null(SSE の規則と違い、前の件の id は引き継がない) */
  id: string | null
}

/**
 * SSE の区切りを読む。chunk は届いた順に push する(行や文字の途中で切れていてよい)。
 * - 行の終わりは CRLF・LF・CR のどれでもよい(CR で終わったチャンクの次が LF なら、2つで1つの行の終わり)
 * - 空の行で1件を出す。data の行が無い件は出さない。':' で始まる行は注釈(': ping' など)として読み飛ばす
 * - 'field: value' の ':' の後の空白は1つだけ除く。data の行が複数あれば '\n' でつなぐ。event が無ければ 'message'
 * - id の行は、その件の id にする(NUL を含む値は SSE の規則どおり使わない)。届いた文字の途中経過(delta)には id が無い
 * - 最初の BOM は除く。最後の件が空の行で終わっていなければ、end() でも出さない(SSE の規則どおり捨てる)
 */
export function createSseParser(onMessage: (message: SseMessage) => void): { push: (chunk: string) => void; end: () => void } {
  let buffer = ''
  let first = true
  let event = ''
  let data: string[] = []
  let id: string | null = null
  // 直前のチャンクが CR で終わった(次のチャンクの先頭の LF は、その CR と組の行の終わり)
  let skipLf = false

  function line(text: string): void {
    if (text === '') {
      if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n'), id })
      event = ''
      data = []
      id = null
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    let value = colon < 0 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id' && !value.includes('\0')) id = value
    // retry とほかの項目は使わない
  }

  return {
    push(chunk) {
      let text = chunk
      if (text === '') return
      if (first) {
        first = false
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      if (skipLf && text.startsWith('\n')) text = text.slice(1)
      skipLf = false
      buffer += text
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i)
        if (c !== 0x0a && c !== 0x0d) continue
        line(buffer.slice(start, i))
        if (c === 0x0d) {
          if (i + 1 < buffer.length) {
            if (buffer.charCodeAt(i + 1) === 0x0a) i++
          } else {
            skipLf = true
          }
        }
        start = i + 1
      }
      buffer = buffer.slice(start)
    },
    end() {
      buffer = ''
      event = ''
      data = []
      id = null
    },
  }
}

/** 本文(バイト列の流れ)を SSE の件に分けて返す。文字の途中で切れたチャンクも正しく読む(TextDecoder の stream) */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const queue: SseMessage[] = []
  const parser = createSseParser((m) => queue.push(m))
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        parser.push(decoder.decode())
        parser.end()
        while (queue.length > 0) yield queue.shift()!
        return
      }
      parser.push(decoder.decode(value, { stream: true }))
      while (queue.length > 0) yield queue.shift()!
    }
  } catch (e) {
    finished = true
    throw e
  } finally {
    // 読み終える前にやめた(呼び出し側が途中で抜けた)なら、本文の残りを捨てて接続を閉じる
    if (finished) reader.releaseLock()
    else void reader.cancel().catch(() => undefined)
  }
}

// ---- ブラウザ向けのイベント(§4.6) ----

/**
 * 中継のストリームのイベント。id は SSE の id の行(Anthropic のイベントの ID)。delta には無い。
 * tool_call の id は呼び出しの ID(custom_tool_use_id。イベントの ID と同じ sevt_…)で、必ずある
 */
export type SessionStreamEvent =
  /** 返答の文字の途中経過。落ちることがある。同じ messageId の message で置き換える */
  | { type: 'delta'; id: string | null; messageId: string; text: string }
  /** 返答の文字(正) */
  | { type: 'message'; id: string | null; messageId: string; text: string }
  /** 考え始めた合図(中身は無い) */
  | { type: 'thinking'; id: string | null }
  /** ブラウザが実行するツールの呼び出し。input は Claude が書いたまま(確かめるのは tools.ts) */
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  /** サーバーが実行するツールの動き(done: false で呼び出し、true で答えた) */
  | { type: 'tool_activity'; id: string | null; name: string; done: boolean }
  /** 調査の進み具合(11/6)。kind は run_started・phase_started・phase_ended・run_paused・run_ended・run_error・delegated・saved */
  | {
      type: 'research'
      id: string | null
      kind: string
      runId: string | null
      name: string | null
      phase: string | null
      result: string | null
      saved: number | null
      total: number | null
    }
  /** セッションの状態。state は running・reconnecting・idle・ended。idle の reason は end_turn・requires_action・budget_reached・retries_exhausted・interrupted */
  | { type: 'status'; id: string | null; state: string; reason: string | null }
  /** この会話の利用額(定価で数えたセント) */
  | { type: 'usage'; id: string | null; costCents: number; budgetCents: number }
  /** 失敗。message は日本語の決まった文。code が 'upstream' なら Anthropic への接続が切れた(つなぎ直す) */
  | { type: 'error'; id: string | null; message: string; code: string | null }

export const SESSION_EVENT_NAMES = ['delta', 'message', 'thinking', 'tool_call', 'tool_activity', 'research', 'status', 'usage', 'error'] as const

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * SSE の1件を、中継のイベントにする。知らない event・読めない data は null(読み飛ばす)。
 * 長いストリームなので、1件が壊れていても流れを止めない
 */
export function toSessionEvent(message: SseMessage): SessionStreamEvent | null {
  if (!(SESSION_EVENT_NAMES as readonly string[]).includes(message.event)) return null
  let data: unknown
  try {
    data = JSON.parse(message.data)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const id = message.id
  switch (message.event) {
    case 'delta':
    case 'message': {
      const messageId = str(d.message_id)
      const text = str(d.text)
      if (messageId === null || text === null) return null
      return { type: message.event, id, messageId, text }
    }
    case 'thinking':
      return { type: 'thinking', id }
    case 'tool_call': {
      const callId = str(d.id) ?? id
      const name = str(d.name)
      if (!callId || name === null) return null
      return { type: 'tool_call', id: callId, name, input: d.input }
    }
    case 'tool_activity': {
      const name = str(d.name)
      if (name === null || typeof d.done !== 'boolean') return null
      return { type: 'tool_activity', id, name, done: d.done }
    }
    case 'research': {
      const kind = str(d.kind)
      if (kind === null) return null
      return {
        type: 'research',
        id,
        kind,
        runId: str(d.run_id),
        name: str(d.name),
        phase: str(d.phase),
        result: str(d.result),
        saved: num(d.saved),
        total: num(d.total),
      }
    }
    case 'status': {
      const state = str(d.state)
      if (state === null) return null
      return { type: 'status', id, state, reason: str(d.reason) }
    }
    case 'usage': {
      const costCents = num(d.cost_cents)
      const budgetCents = num(d.budget_cents)
      if (costCents === null || budgetCents === null) return null
      return { type: 'usage', id, costCents, budgetCents }
    }
    default:
      return { type: 'error', id, message: str(d.message) || 'AI の処理でエラーが起きました', code: str(d.code) }
  }
}

// ---- 要求の失敗とヘッダー ----

/** 中継への要求の失敗(HTTP の状態つき)。status が null なら、つながらなかった */
export class ClaudeRequestError extends Error {
  readonly status: number | null
  constructor(status: number | null, message: string) {
    super(message)
    this.name = 'ClaudeRequestError'
    this.status = status
  }
}

export const NOT_CONNECTED = 'AI の中継につながりませんでした。サーバーが動いているか確かめてください。'
export const TOKEN_CHARS_ERROR = '合言葉に使えない文字があります。半角の英数字と記号で入れてください。'

/** HTTP の状態ごとの、サーバーが文を返さなかったときの文 */
export function defaultMessage(status: number): string {
  if (status === 401) return '合言葉が違います。'
  if (status === 404) return 'AI との会話が見つかりません。新しく始めます'
  if (status === 409) return 'AI がツールの結果を待っています。少し待ってから送ってください'
  if (status === 410) return 'AI との会話は終わっています。新しく始めます'
  if (status === 413) return '送る内容が大きすぎます。'
  if (status === 429) return 'AI の利用回数の上限に達しました。しばらくしてから使ってください。'
  if (status === 503) return 'AI は使えません(API キーが設定されていません)。'
  return `AI に送れませんでした(${status})。もう一度送ってください`
}

/** 失敗の返答(JSON の detail)を ClaudeRequestError にする */
export async function requestError(res: Response): Promise<ClaudeRequestError> {
  const body: unknown = await res.json().catch(() => null)
  const detail = typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined
  return new ClaudeRequestError(res.status, typeof detail === 'string' && detail ? detail : defaultMessage(res.status))
}

/**
 * 合言葉と取っ手のヘッダー。HTTP のヘッダーには半角の文字しか入れられない(全角の文字があると fetch が送る前に失敗する)
 * ので、合言葉に使えない文字があれば 401 の ClaudeRequestError を投げる
 */
export function authHeaders(token: string | null, handle: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  if (token) {
    if (!/^[\x21-\x7e]+$/.test(token)) throw new ClaudeRequestError(401, TOKEN_CHARS_ERROR)
    headers['X-Dispatcher-Token'] = token
  }
  if (handle) headers['X-Dispatcher-Session'] = handle
  return headers
}

export interface StreamOptions {
  token: string | null
  /** セッションの取っ手(X-Dispatcher-Session) */
  handle: string
  /** 最後に受け取ったイベントの id(つなぎ直すときの Last-Event-ID)。無ければ付けない */
  lastEventId: string | null
  signal: AbortSignal
  /** テストで差し替える */
  fetchImpl?: typeof fetch
  /** 既定は '/api/claude/session/stream' */
  url?: string
}

/**
 * 中継のストリームを開き、イベントを返す。返す Promise が解決したら、ストリームがつながっている。
 * 流し始める前の失敗は ClaudeRequestError で、止めた(signal)ときは AbortError で reject する。
 * 流れている途中で切れたら、イテレーターが例外を投げるか終わる(呼び出し側がつなぎ直す)
 */
export async function openSessionStream(options: StreamOptions): Promise<AsyncIterable<SessionStreamEvent>> {
  const doFetch = options.fetchImpl ?? fetch
  const headers: Record<string, string> = { Accept: 'text/event-stream', ...authHeaders(options.token, options.handle) }
  if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId
  let res: Response
  try {
    res = await doFetch(options.url ?? '/api/claude/session/stream', { method: 'GET', headers, signal: options.signal, cache: 'no-store' })
  } catch (e) {
    if (options.signal.aborted) throw e
    throw new ClaudeRequestError(null, NOT_CONNECTED)
  }
  if (!res.ok) throw await requestError(res)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    void res.body?.cancel().catch(() => undefined)
    throw new ClaudeRequestError(res.status, 'AI の中継の返答の形が違います。')
  }
  const body = res.body
  return (async function* events(): AsyncGenerator<SessionStreamEvent> {
    for await (const message of readSse(body)) {
      const event = toSessionEvent(message)
      if (event) yield event
    }
  })()
}
