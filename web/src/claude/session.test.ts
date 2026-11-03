import { describe, expect, it, vi } from 'vitest'
import { ClaudeSession, createSessionApi, STOPPED_BY_USER, type SessionDeps, type SessionEvent, type SessionPostBody } from './session'
import { fakeApi } from './session.fixture'
import { ClaudeRequestError, type SessionStreamEvent } from './sse'
import type { ToolOutcome } from './tools'

function setup(overrides: Partial<SessionDeps> = {}) {
  const fake = fakeApi()
  const events: SessionEvent[] = []
  const sleeps: number[] = []
  const runTool = vi.fn(async (name: string): Promise<ToolOutcome> => ({ content: JSON.stringify({ status: 'ok', name }), isError: false }))
  const session = new ClaudeSession({
    api: fake.api,
    token: () => 'tok',
    runTool,
    onEvent: (e) => events.push(e),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    batchDelayMs: 0,
    ...overrides,
  })
  const of = <T extends SessionEvent['type']>(type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
  return { ...fake, session, events, sleeps, runTool, of }
}

const call = (id: string, name: string, input: unknown = {}): SessionStreamEvent => ({ type: 'tool_call', id, name, input })
const status = (id: string, state: string, reason: string | null = null): SessionStreamEvent => ({ type: 'status', id, state, reason })
const msg = (id: string, text: string): SessionStreamEvent => ({ type: 'message', id, messageId: `m-${id}`, text })

function resultsOf(body: SessionPostBody) {
  return 'results' in body ? body.results.map((r) => [r.custom_tool_use_id, r.is_error]) : []
}

describe('セッションを始める', () => {
  it('取っ手が無ければ作り、ストリームがつながってから返す。2回目は作らない', async () => {
    const t = setup()
    expect(await t.session.start()).toBe(true)
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.streams).toHaveLength(1)
    expect(t.streams[0]).toMatchObject({ handle: 'h1', lastEventId: null })
    expect(t.session.handle).toBe('h1')
    expect(t.session.budgetCents).toBe(300)
    expect(t.of('connection').map((e) => e.state)).toEqual(['connecting', 'open'])
    expect(await t.session.start()).toBe(false)
    expect(t.api.create).toHaveBeenCalledTimes(1)
    expect(t.streams).toHaveLength(1)
  })

  it('最初につなげなければ失敗を返し、次の start でもう一度つなぐ', async () => {
    const t = setup()
    t.openFailures.push(new ClaudeRequestError(null, 'つながりません'))
    await expect(t.session.start()).rejects.toMatchObject({ status: null })
    expect(t.session.handle).toBe('h1')
    expect(await t.session.start()).toBe(false)
    expect(t.streams).toHaveLength(1)
    expect(t.api.create).toHaveBeenCalledTimes(1)
  })

  it('発言は message の形で送り、送り直さない', async () => {
    const t = setup()
    await t.session.start()
    await t.session.sendMessage([{ type: 'text', text: 'こんにちは' }])
    expect(t.posts).toEqual([{ handle: 'h1', token: 'tok', body: { kind: 'message', content: [{ type: 'text', text: 'こんにちは' }] } }])
    t.postFailures.push(new ClaudeRequestError(null, 'つながりません'))
    await expect(t.session.sendMessage([{ type: 'text', text: '二つ目' }])).rejects.toMatchObject({ status: null })
    expect(t.posts).toHaveLength(2)
  })
})

describe('同じ id のイベントを2回受け取っても1回だけ扱い、つなぎ直しで Last-Event-ID を付ける', () => {
  it('履歴とストリームに同じ id が出ても1回だけ渡し、id の無い途中経過はそのまま渡す', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(
      { type: 'delta', id: null, messageId: 'm1', text: 'は' },
      { type: 'delta', id: null, messageId: 'm1', text: 'は' },
      msg('e1', 'はい'),
      msg('e1', 'はい'),
      status('e2', 'idle', 'end_turn'),
    )
    await vi.waitFor(() => expect(t.of('stream')).toHaveLength(4))
    expect(t.of('stream').map((e) => e.event.type)).toEqual(['delta', 'delta', 'message', 'status'])
  })

  it('切れたら 1・2・4・8・8 秒でつなぎ直し、最後に受け取った id を付ける。つながってイベントが届いたら間を戻す', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(msg('e1', 'a'), { type: 'delta', id: null, messageId: 'm2', text: 'b' })
    await vi.waitFor(() => expect(t.of('stream')).toHaveLength(2))
    for (let i = 0; i < 5; i++) t.openFailures.push(new ClaudeRequestError(502, '中継が落ちています'))
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(2))
    expect(t.sleeps).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
    expect(t.streams[1].lastEventId).toBe('e1')
    expect(t.of('connection').map((e) => e.state)).toContain('reconnecting')
    // つなぎ直した先からイベント(履歴の送り直しで、同じ id のもの)が届いたので、次に切れたら 1 秒から
    t.last().push(msg('e1', 'a'))
    await new Promise((r) => setTimeout(r, 0))
    t.last().fail(new TypeError('network error'))
    await vi.waitFor(() => expect(t.streams).toHaveLength(3))
    expect(t.sleeps.slice(6)).toEqual([1000])
    // つなぎ直したあと、同じ id は捨てる
    t.last().push(msg('e1', 'a'), msg('e3', 'c'))
    await vi.waitFor(() => expect(t.of('stream')).toHaveLength(3))
    expect(t.streams[2].lastEventId).toBe('e1')
  })

  it('つながってもすぐ error(code upstream)で閉じるなら、失敗として間を延ばす(Anthropic が落ちている間)', async () => {
    const t = setup()
    await t.session.start()
    for (let i = 0; i < 5; i++) {
      const n = t.streams.length
      t.last().push({ type: 'error', id: null, message: 'AI との接続が切れました。つなぎ直します', code: 'upstream' })
      t.last().end()
      await vi.waitFor(() => expect(t.streams).toHaveLength(n + 1))
    }
    expect(t.sleeps).toEqual([1000, 2000, 4000, 8000, 8000])
    // ほかのイベントが届いたら、次は 1 秒から
    t.last().push(status('e1', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(t.of('stream').filter((e) => e.event.type === 'status')).toHaveLength(1))
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(7))
    expect(t.sleeps.slice(5)).toEqual([1000])
  })

  it('イベントが無くても、長く開いていたストリームが切れたら 1 秒から', async () => {
    let clock = 0
    const t = setup({ now: () => clock })
    await t.session.start()
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(2))
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(3))
    expect(t.sleeps).toEqual([1000, 2000])
    // 30 秒より長く開いていた(静かな会話)
    clock += 30_000
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(4))
    expect(t.sleeps).toEqual([1000, 2000, 1000])
  })

  it('取っ手が使えない(404・410)なら、つなぎ直さずに取っ手を捨てて知らせる', async () => {
    const t = setup()
    await t.session.start()
    t.openFailures.push(new ClaudeRequestError(410, 'AI との会話は終わっています。新しく始めます。'))
    t.last().end()
    await vi.waitFor(() => expect(t.of('lost')).toHaveLength(1))
    expect(t.of('lost')[0].message).toBe('AI との会話は終わっています。新しく始めます。')
    expect(t.session.handle).toBeNull()
    expect(t.streams).toHaveLength(1)
    // 次は新しいセッション
    expect(await t.session.start()).toBe(true)
    expect(t.session.handle).toBe('h2')
  })

  it('セッションが終わった(status ended)ら取っ手を捨てる', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(status('e1', 'ended'))
    await vi.waitFor(() => expect(t.session.handle).toBeNull())
    expect(t.of('stream').map((e) => e.event)).toEqual([status('e1', 'ended')])
    expect(t.removed).toEqual([])
  })
})

describe('tool_call を順に実行し、まとめて tool_results で送る', () => {
  it('続けて届いた呼び出しを順に実行し、1回の POST で送る。実行している間は答えていない数に入る', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({
      runTool: vi.fn(async (name: string) => {
        if (name === 'summarize_impact') await gate
        return { content: `{"status":"ok","name":"${name}"}`, isError: false }
      }),
    })
    await t.session.start()
    t.last().push(call('c1', 'summarize_impact'), call('c2', 'search_trips'), call('c3', 'run_validation'))
    await vi.waitFor(() => expect(t.of('tool_start')).toHaveLength(1))
    expect(t.session.pendingTools).toBe(3)
    expect(t.posts).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
    expect(t.of('tool_start').map((e) => e.id)).toEqual(['c1', 'c2', 'c3'])
    expect(t.posts[0].body).toEqual({
      kind: 'tool_results',
      results: [
        { custom_tool_use_id: 'c1', text: '{"status":"ok","name":"summarize_impact"}', is_error: false },
        { custom_tool_use_id: 'c2', text: '{"status":"ok","name":"search_trips"}', is_error: false },
        { custom_tool_use_id: 'c3', text: '{"status":"ok","name":"run_validation"}', is_error: false },
      ],
    })
    await vi.waitFor(() => expect(t.session.pendingTools).toBe(0))
    expect(t.of('tools').map((e) => e.pending)).toEqual([1, 2, 3, 0])
    expect(t.of('sent')[0].results.map((r) => r.name)).toEqual(['summarize_impact', 'search_trips', 'run_validation'])
  })

  it('実行の繰り返しを抜けた直後に届いた呼び出しも実行し、結果を送る(結果待ちのまま止まらない)', async () => {
    // 11/3 のブラウザでの確かめ:search_trips と summarize_impact が並んで届き、2つ目が繰り返しを抜けた後に届いて止まった
    // delay が -1 なら、1つ目の終わりの知らせの中で同期に届ける。0 以上なら、その数の microtask の後に届ける
    for (let delay = -1; delay <= 40; delay++) {
      const events: SessionEvent[] = []
      let pushLater: () => void = () => undefined
      const t = setup({
        onEvent: (e) => {
          events.push(e)
          if (e.type === 'tool_done' && e.id === 'c1') {
            if (delay < 0) {
              pushLater()
              return
            }
            let n = delay
            const step = () => (n-- > 0 ? queueMicrotask(step) : pushLater())
            queueMicrotask(step)
          }
        },
      })
      await t.session.start()
      pushLater = () => t.last().push(call('c2', 'summarize_impact'))
      t.last().push(call('c1', 'search_trips'))
      await vi.waitFor(() => expect(t.posts.flatMap((p) => resultsOf(p.body)).map(([id]) => id), `delay ${delay}`).toEqual(['c1', 'c2']))
      expect(t.session.pendingTools, `delay ${delay}`).toBe(0)
    }
  })

  it('1回の返答の2つ目の編集のツールは実行せず、下書きが承認待ちと答える', async () => {
    const runTool = vi.fn(async (name: string): Promise<ToolOutcome> => {
      if (name === 'apply_policy') return { content: '{"status":"draft","draft_id":"1"}', isError: false, draft: { id: '1', kind: 'op' } }
      return { content: '{"status":"ok"}', isError: false }
    })
    const t = setup({ runTool })
    await t.session.start()
    t.last().push(call('c1', 'apply_policy'), call('c2', 'add_back_trips'), call('c3', 'run_validation'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
    expect(runTool.mock.calls.map((c) => c[0])).toEqual(['apply_policy', 'run_validation'])
    const results = (t.posts[0].body as { results: { text: string; is_error: boolean }[] }).results
    expect(results[1].is_error).toBe(true)
    expect(results[1].text).toContain('下書き #1 が承認待ちです')
    // 次の返答では、また1つ目の編集のツールを実行する
    t.last().push(call('c4', 'undo_edit'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(2))
    expect(runTool.mock.calls.map((c) => c[0])).toEqual(['apply_policy', 'run_validation', 'undo_edit'])
  })

  it('結果が 10 件を超えたら 10 件ずつに分けて送る', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(...Array.from({ length: 12 }, (_, i) => call(`c${i}`, 'run_validation')))
    await vi.waitFor(() => expect(t.posts).toHaveLength(2))
    expect(t.posts.map((p) => resultsOf(p.body).length)).toEqual([10, 2])
  })

  it('requires_action の idle が来たら、待たずに送る', async () => {
    const t = setup({ batchDelayMs: 60_000 })
    await t.session.start()
    t.last().push(call('c1', 'run_validation'))
    await vi.waitFor(() => expect(t.of('tool_done')).toHaveLength(1))
    expect(t.posts).toHaveLength(0)
    t.last().push(status('e9', 'idle', 'requires_action'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
  })

  it('20KB を超えた結果は、送れない旨の is_error にする', async () => {
    const t = setup({ runTool: async () => ({ content: JSON.stringify({ status: 'ok', x: 'あ'.repeat(8000) }), isError: false }) })
    await t.session.start()
    t.last().push(call('c1', 'search_trips'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
    const r = (t.posts[0].body as { results: { text: string; is_error: boolean }[] }).results[0]
    expect(r.is_error).toBe(true)
    expect(JSON.parse(r.text).message).toContain('20KB')
  })

  it('ツールが例外を投げても、is_error で答える', async () => {
    const t = setup({
      runTool: async () => {
        throw new Error('壊れた')
      },
    })
    await t.session.start()
    t.last().push(call('c1', 'search_trips'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
    expect(resultsOf(t.posts[0].body)).toEqual([['c1', true]])
  })
})

describe('送り直された tool_call(同じ id)には、実行せずに残した結果を送る', () => {
  it('実行中・待ちの間に同じ id が届いても1回だけ実行し、送った後の同じ id には残した結果を送る', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(call('c1', 'apply_policy'), call('c1', 'apply_policy'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(1))
    expect(t.runTool).toHaveBeenCalledTimes(1)
    // つなぎ直しでサーバーが送り直した
    t.last().end()
    await vi.waitFor(() => expect(t.streams).toHaveLength(2))
    t.last().push(call('c1', 'apply_policy'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(2))
    expect(t.runTool).toHaveBeenCalledTimes(1)
    expect(t.posts[1].body).toEqual(t.posts[0].body)
  })

  it('POST が通信の失敗で落ちたら 1・2・4 秒でやり直し、やり直しの 409 は届いたものとして扱う', async () => {
    const t = setup()
    await t.session.start()
    t.postFailures.push(new ClaudeRequestError(null, 'つながりません'), new ClaudeRequestError(502, '中継'), new ClaudeRequestError(409, '答える呼び出しがありません'))
    t.last().push(call('c1', 'run_validation'))
    await vi.waitFor(() => expect(t.of('sent')).toHaveLength(1))
    expect(t.posts).toHaveLength(3)
    expect(t.sleeps).toEqual([1000, 2000])
    expect(t.session.pendingTools).toBe(0)
    expect(t.of('send_failed')).toHaveLength(0)
  })

  it('やり直しても送れなければ知らせ、送り直された呼び出しで、実行せずにもう一度送る', async () => {
    const t = setup()
    await t.session.start()
    for (let i = 0; i < 4; i++) t.postFailures.push(new ClaudeRequestError(null, 'つながりません'))
    t.last().push(call('c1', 'apply_policy'))
    await vi.waitFor(() => expect(t.of('send_failed')).toHaveLength(1))
    expect(t.posts).toHaveLength(4)
    expect(t.sleeps).toEqual([1000, 2000, 4000])
    // 送れなかった結果は答えていない数に入れない(送るボタンを止めない)。次の発言の前に送り直す
    expect(t.session.pendingTools).toBe(0)
    t.last().push(call('c1', 'apply_policy'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(5))
    expect(t.runTool).toHaveBeenCalledTimes(1)
    expect(resultsOf(t.posts[4].body)).toEqual([['c1', false]])
  })

  it('送れなかった結果は、次の発言の前に送る', async () => {
    const t = setup()
    await t.session.start()
    for (let i = 0; i < 4; i++) t.postFailures.push(new ClaudeRequestError(null, 'つながりません'))
    t.last().push(call('c1', 'run_validation'))
    await vi.waitFor(() => expect(t.of('send_failed')).toHaveLength(1))
    await t.session.sendMessage([{ type: 'text', text: '続けて' }])
    expect(t.posts.slice(4).map((p) => p.body.kind)).toEqual(['tool_results', 'message'])
  })
})

describe('「止める」で、答えていない呼び出しの「利用者が止めました」を results に入れた interrupt を1回で送る', () => {
  it('実行中のツールを止め、実行し終えた分は本物の結果を、ほかは「利用者が止めました」を送る', async () => {
    const runTool = vi.fn(
      (name: string, _input: unknown, signal: AbortSignal) =>
        new Promise<ToolOutcome>((resolve, reject) => {
          if (name === 'run_validation') resolve({ content: '{"status":"ok"}', isError: false })
          signal.addEventListener('abort', () => reject(new DOMException('止めました', 'AbortError')))
        }),
    )
    const t = setup({ runTool })
    await t.session.start()
    t.last().push(call('c1', 'run_validation'), call('c2', 'summarize_impact'), call('c3', 'search_trips'))
    await vi.waitFor(() => expect(t.of('tool_start')).toHaveLength(2))
    const sent = await t.session.interrupt()
    expect(t.posts).toHaveLength(1)
    const body = t.posts[0].body as { kind: string; results: { custom_tool_use_id: string; text: string; is_error: boolean }[] }
    expect(body.kind).toBe('interrupt')
    expect(body.results.map((r) => [r.custom_tool_use_id, r.is_error])).toEqual([
      ['c1', false],
      ['c2', true],
      ['c3', true],
    ])
    expect(JSON.parse(body.results[1].text)).toEqual({ status: 'error', message: STOPPED_BY_USER })
    expect(JSON.parse(body.results[2].text)).toEqual({ status: 'error', message: STOPPED_BY_USER })
    expect(sent.map((r) => r.id)).toEqual(['c1', 'c2', 'c3'])
    // 始めていない c3 は実行しない
    expect(runTool.mock.calls.map((c) => c[0])).toEqual(['run_validation', 'summarize_impact'])
    expect(t.session.pendingTools).toBe(0)
    // 止めた呼び出しが送り直されても、実行せずに同じ結果を送る
    t.last().push(call('c3', 'search_trips'))
    await vi.waitFor(() => expect(t.posts).toHaveLength(2))
    expect(runTool).toHaveBeenCalledTimes(2)
    expect(resultsOf(t.posts[1].body)).toEqual([['c3', true]])
  })

  it('答えていない呼び出しが無ければ、results を空にした interrupt だけを送る', async () => {
    const t = setup()
    await t.session.start()
    await t.session.interrupt()
    expect(t.posts.map((p) => p.body)).toEqual([{ kind: 'interrupt', results: [] }])
  })
})

describe('終える', () => {
  it('close は DELETE を送り、取っ手とストリームを捨てる。次の start は新しいセッション', async () => {
    const t = setup()
    await t.session.start()
    t.last().push(call('c1', 'run_validation'))
    t.session.close()
    expect(t.removed).toEqual(['h1'])
    expect(t.session.handle).toBeNull()
    expect(t.streams[0].signal.aborted).toBe(true)
    expect(t.of('connection').at(-1)?.state).toBe('closed')
    expect(await t.session.start()).toBe(true)
    expect(t.session.handle).toBe('h2')
    expect(t.streams[1].lastEventId).toBeNull()
  })

  it('作っている間に閉じられたら、作ったセッションを消す', async () => {
    const t = setup()
    const pending = t.session.start()
    t.session.close()
    await expect(pending).rejects.toBeInstanceOf(ClaudeRequestError)
    expect(t.removed).toEqual(['h1'])
    expect(t.session.handle).toBeNull()
  })

  it('401 なら合言葉が違うと知らせる', async () => {
    const t = setup()
    await t.session.start()
    t.postFailures.push(new ClaudeRequestError(401, '認証コードが違います。'))
    await expect(t.session.sendMessage([{ type: 'text', text: 'x' }])).rejects.toMatchObject({ status: 401 })
    expect(t.of('unauthorized')).toHaveLength(1)
    expect(t.session.handle).toBe('h1')
  })
})

describe('本物の fetch でつなぐ API', () => {
  it('作成・送信・削除のパスとヘッダー(取っ手は URL に入れない)', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (String(url).endsWith('/session') && init?.method === 'POST') return Response.json({ handle: 'v1.abc.sig', budget_cents: 300 })
      return new Response(null, { status: 202 })
    })
    const api = createSessionApi(fetchImpl as typeof fetch)
    expect(await api.create('tok')).toEqual({ handle: 'v1.abc.sig', budgetCents: 300 })
    await api.post('tok', 'v1.abc.sig', { kind: 'tool_results', results: [{ custom_tool_use_id: 'sevt_1', text: '{}', is_error: false }] })
    api.remove('tok', 'v1.abc.sig')
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', '/api/claude/session'],
      ['POST', '/api/claude/session/events'],
      ['DELETE', '/api/claude/session'],
    ])
    expect(calls[0].init.body).toBe('{}')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      kind: 'tool_results',
      results: [{ custom_tool_use_id: 'sevt_1', text: '{}', is_error: false }],
    })
    const h = (i: number) => calls[i].init.headers as Record<string, string>
    expect(h(0)['X-Dispatcher-Token']).toBe('tok')
    expect(h(0)['X-Dispatcher-Session']).toBeUndefined()
    expect(h(1)['X-Dispatcher-Session']).toBe('v1.abc.sig')
    expect(h(2)['X-Dispatcher-Session']).toBe('v1.abc.sig')
    expect(calls[2].init.keepalive).toBe(true)
    for (const c of calls) expect(c.url).not.toContain('v1.abc.sig')
  })

  it('失敗は HTTP の状態とサーバーの文をつけて返し、つながらなければ status が null', async () => {
    const api = createSessionApi((async () => Response.json({ detail: 'AI がツールの結果を待っています。少し待ってから送ってください' }, { status: 409 })) as typeof fetch)
    await expect(api.post(null, 'h', { kind: 'message', content: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject({
      status: 409,
      message: 'AI がツールの結果を待っています。少し待ってから送ってください',
    })
    const down = createSessionApi((async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch)
    await expect(down.create(null)).rejects.toMatchObject({ status: null })
    // 全角の合言葉は送る前に断る(つながらなかったことにしない)
    await expect(down.create('あいことば')).rejects.toMatchObject({ status: 401 })
    // 形の違う作成の返答
    const odd = createSessionApi((async () => Response.json({ handle: '' })) as typeof fetch)
    await expect(odd.create(null)).rejects.toBeInstanceOf(ClaudeRequestError)
  })
})
