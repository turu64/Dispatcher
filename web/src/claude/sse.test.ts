import { describe, expect, it, vi } from 'vitest'
import { ClaudeRequestError, createSseParser, openSessionStream, readSse, toSessionEvent, type SessionStreamEvent, type SseMessage } from './sse'

/** バイト列のチャンクを順に流す本文 */
function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

/** 文字列をバイト列にし、指定した位置(バイト)で切ったチャンクにする */
function splitBytes(text: string, cuts: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  const out: Uint8Array[] = []
  let start = 0
  for (const cut of [...cuts, bytes.length]) {
    out.push(bytes.slice(start, cut))
    start = cut
  }
  return out
}

/** 失敗するはずの Promise の ClaudeRequestError */
async function errorOf(p: Promise<unknown>): Promise<ClaudeRequestError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ClaudeRequestError)
  return e as ClaudeRequestError
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const m of readSse(body)) out.push(m)
  return out
}

describe('SSE の区切り(複数の行・途中で切れたチャンク・id の行)を正しく読む', () => {
  it('空の行で1件にし、data の行が複数あれば改行でつなぐ', () => {
    const got: SseMessage[] = []
    const p = createSseParser((m) => got.push(m))
    p.push('event: delta\ndata: {"text":"一行目"}\n\nevent: message\ndata: a\ndata: b\n\n')
    expect(got).toEqual([
      { event: 'delta', data: '{"text":"一行目"}', id: null },
      { event: 'message', data: 'a\nb', id: null },
    ])
  })

  it('id の行はその件の id にし、次の件には引き継がない(途中経過には id が無い)', () => {
    const got: SseMessage[] = []
    const p = createSseParser((m) => got.push(m))
    p.push('id: sevt_1\nevent: message\ndata: {}\n\nevent: delta\ndata: {}\n\nevent: status\nid:sevt_2\ndata: {}\n\nid: a\0b\nevent: x\ndata: {}\n\n')
    expect(got.map((m) => m.id)).toEqual(['sevt_1', null, 'sevt_2', null])
  })

  it('行の途中・CR と LF の間で切れたチャンクでも、同じ件になる', () => {
    const text = 'id: sevt_1\r\nevent: message\r\ndata: {"text":"こんにちは"}\r\n\r\nevent: tool_activity\r\ndata: {"name":"x"}\r\n\r\n'
    const whole: SseMessage[] = []
    createSseParser((m) => whole.push(m)).push(text)
    for (let cut = 1; cut < text.length; cut++) {
      const got: SseMessage[] = []
      const p = createSseParser((m) => got.push(m))
      p.push(text.slice(0, cut))
      p.push(text.slice(cut))
      expect(got).toEqual(whole)
    }
    expect(whole).toHaveLength(2)
    expect(whole[0].id).toBe('sevt_1')
  })

  it('注釈の行(: ping)・最初の BOM・コロンのあとの空白1つを扱い、空の行で終わらない最後の件は出さない', () => {
    const got: SseMessage[] = []
    const p = createSseParser((m) => got.push(m))
    p.push('﻿: ping\nevent:delta\ndata:  二つの空白\n\n: ping\n\nevent: delta\ndata: 終わらない')
    p.end()
    expect(got).toEqual([{ event: 'delta', data: ' 二つの空白', id: null }])
  })

  it('CR だけの改行と、event の無い件(message)も読む', () => {
    const got: SseMessage[] = []
    const p = createSseParser((m) => got.push(m))
    p.push('data: x\r\rdata: y\r')
    p.push('\r')
    expect(got).toEqual([
      { event: 'message', data: 'x', id: null },
      { event: 'message', data: 'y', id: null },
    ])
  })

  it('日本語の文字の途中で切れたバイト列のチャンクでも、文字を壊さない', async () => {
    const text = 'event: delta\ndata: {"text":"平日を土曜ダイヤに"}\n\n'
    const bytes = new TextEncoder().encode(text).length
    for (let cut = 1; cut < bytes; cut += 3) {
      const got = await collect(bodyOf(splitBytes(text, [cut, Math.min(cut + 2, bytes - 1)])))
      expect(got).toEqual([{ event: 'delta', data: '{"text":"平日を土曜ダイヤに"}', id: null }])
    }
  })
})

describe('ブラウザ向けのイベント(§4.6)', () => {
  const m = (event: string, data: unknown, id: string | null = null): SseMessage => ({ event, data: JSON.stringify(data), id })

  it('9つのイベントを読み、知らない event・読めない data は読み飛ばす', () => {
    expect(toSessionEvent(m('delta', { message_id: 'm1', text: 'は' }))).toEqual({ type: 'delta', id: null, messageId: 'm1', text: 'は' })
    expect(toSessionEvent(m('message', { message_id: 'm1', text: 'はい' }, 'sevt_1'))).toEqual({
      type: 'message',
      id: 'sevt_1',
      messageId: 'm1',
      text: 'はい',
    })
    expect(toSessionEvent(m('thinking', {}, 'sevt_2'))).toEqual({ type: 'thinking', id: 'sevt_2' })
    expect(toSessionEvent(m('tool_call', { id: 'sevt_3', name: 'run_validation', input: {} }, 'sevt_3'))).toEqual({
      type: 'tool_call',
      id: 'sevt_3',
      name: 'run_validation',
      input: {},
    })
    expect(toSessionEvent(m('tool_activity', { name: 'get_research_targets', done: false }))).toEqual({
      type: 'tool_activity',
      id: null,
      name: 'get_research_targets',
      done: false,
    })
    expect(toSessionEvent(m('research', { kind: 'saved', saved: 3, total: 10 }, 'sevt_4'))).toEqual({
      type: 'research',
      id: 'sevt_4',
      kind: 'saved',
      runId: null,
      name: null,
      phase: null,
      result: null,
      saved: 3,
      total: 10,
    })
    expect(toSessionEvent(m('status', { state: 'idle', reason: 'end_turn' }, 'sevt_5'))).toEqual({
      type: 'status',
      id: 'sevt_5',
      state: 'idle',
      reason: 'end_turn',
    })
    expect(toSessionEvent(m('status', { state: 'running' }))).toEqual({ type: 'status', id: null, state: 'running', reason: null })
    expect(toSessionEvent(m('usage', { cost_cents: 42, budget_cents: 300 }))).toEqual({ type: 'usage', id: null, costCents: 42, budgetCents: 300 })
    expect(toSessionEvent(m('error', { message: 'AI の処理でエラーが起きました', code: 'session_error' }))).toEqual({
      type: 'error',
      id: null,
      message: 'AI の処理でエラーが起きました',
      code: 'session_error',
    })
    // 形の違うもの・知らないもの
    expect(toSessionEvent(m('ping', {}))).toBeNull()
    expect(toSessionEvent({ event: 'message', data: '{壊れた', id: null })).toBeNull()
    expect(toSessionEvent(m('message', { text: '番号が無い' }))).toBeNull()
    expect(toSessionEvent(m('tool_call', { name: 'run_validation', input: {} }))).toBeNull()
    expect(toSessionEvent(m('usage', { cost_cents: '42', budget_cents: 300 }))).toBeNull()
  })

  it('tool_call の data に id が無ければ、SSE の id の行を呼び出しの id にする', () => {
    expect(toSessionEvent(m('tool_call', { name: 'undo_edit', input: {} }, 'sevt_9'))).toMatchObject({ type: 'tool_call', id: 'sevt_9' })
  })
})

describe('ストリームを開く', () => {
  it('GET で、合言葉・取っ手・Last-Event-ID をヘッダーで送り、イベントを返す(取っ手は URL に入れない)', async () => {
    const sse = ': ping\n\nid: sevt_1\nevent: message\ndata: {"message_id":"m1","text":"了解"}\n\nevent: delta\ndata: {"message_id":"m2","text":"次"}\n\n'
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(bodyOf(splitBytes(sse, [7, 30])), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const events: SessionStreamEvent[] = []
    const stream = await openSessionStream({ token: 'secret-token', handle: 'v1.abc.sig', lastEventId: 'sevt_0', signal: new AbortController().signal, fetchImpl })
    for await (const e of stream) events.push(e)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/claude/session/stream')
    expect(String(url)).not.toContain('v1.abc.sig')
    expect(init?.method).toBe('GET')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['X-Dispatcher-Token']).toBe('secret-token')
    expect(headers['X-Dispatcher-Session']).toBe('v1.abc.sig')
    expect(headers['Last-Event-ID']).toBe('sevt_0')
    expect(events).toEqual([
      { type: 'message', id: 'sevt_1', messageId: 'm1', text: '了解' },
      { type: 'delta', id: null, messageId: 'm2', text: '次' },
    ])
  })

  it('Last-Event-ID が無ければ付けず、合言葉が無ければ合言葉のヘッダーも付けない', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    await openSessionStream({ token: null, handle: 'h', lastEventId: null, signal: new AbortController().signal, fetchImpl })
    const headers = (fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers['Last-Event-ID']).toBeUndefined()
    expect(headers['X-Dispatcher-Token']).toBeUndefined()
  })

  it('流し始める前の失敗は、HTTP の状態と detail の文をつけた ClaudeRequestError にする', async () => {
    const signal = new AbortController().signal
    const fail = (status: number, body: string) =>
      errorOf(openSessionStream({ token: 'x', handle: 'h', lastEventId: null, signal, fetchImpl: async () => new Response(body, { status }) }))
    const e404 = await fail(404, JSON.stringify({ detail: 'AI との会話が見つかりません。新しく始めます' }))
    expect(e404.status).toBe(404)
    expect(e404.message).toBe('AI との会話が見つかりません。新しく始めます')
    const e401 = await fail(401, 'not json')
    expect(e401.status).toBe(401)
    expect(e401.message).toBe('認証コードが違います。')
    // つながらなかった
    const down = await errorOf(
      openSessionStream({
        token: null,
        handle: 'h',
        lastEventId: null,
        signal,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch')
        },
      }),
    )
    expect(down.status).toBeNull()
    // 全角の文字はヘッダーに入れられないので、送る前に断る
    const fetchImpl = vi.fn(async () => new Response(''))
    const wide = await errorOf(openSessionStream({ token: 'あいことば', handle: 'h', lastEventId: null, signal, fetchImpl }))
    expect(wide.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
