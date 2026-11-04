import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeApi } from '../claude/session.fixture'
import type { ResearchApi } from '../claude/research'
import type { SessionPostBody } from '../claude/session'
import { ClaudeRequestError, NOT_CONNECTED, type SessionStreamEvent } from '../claude/sse'
import { runTool, type ToolDeps, type ToolOutcome } from '../claude/tools'
import { smallFeed } from '../gtfs/edit/form2.fixture'
import { stateLines } from '../claude/screenLines'
import {
  budgetReachedMessage,
  canStop,
  chatToolDeps,
  CLAUDE_UNAVAILABLE,
  checkedLine,
  CONTINUE_LINE,
  CONTINUE_PROMPT,
  continueLine,
  createChatStore,
  currentScreenState,
  draftMessage,
  dollars,
  fetchClaudeStatus,
  ENDED_NOTICE,
  RELOAD_NOTICE,
  researchText,
  RESEARCH_KNOWN_FAILED,
  RESEARCH_PAUSED,
  researchStartLine,
  sendBlockedReason,
  sessionTokenStorage,
  summarizeSearchTrips,
  STATUS_SHAPE,
  STOPPED_NOTICE,
  TOKEN_CHARS,
  TOKEN_MISSING,
  TOKEN_WRONG,
  TOOLS_WAITING,
  usageText,
  type ChatStoreDeps,
  type TokenStorage,
} from './chat'
import { useDriversStore } from './drivers'
import { createEditStore, useEditStore, type BaseGtfs } from './edit'

const NOW = new Date('2026-11-04T00:30:00Z')
const TODAY_LINE = '[画面の状態] 今日は 2026年11月4日(水)です(日本時間)。'

function memoryStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const s = {
    value: initial,
    get: () => s.value,
    set: (t: string | null) => {
      s.value = t
    },
  }
  return s
}

const POLICY_INPUT = {
  kind: 'weekday_to_saturday',
  start_date: '20261109',
  end_date: null,
  excluded_route_ids: [],
  reason_category: null,
  reason_note: '',
}

function setup(overrides: Partial<ChatStoreDeps> = {}, status = { available: true, tokenRequired: false }) {
  const edit = createEditStore({ now: () => NOW, onEdited: vi.fn() })
  const base: BaseGtfs = { feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }
  edit.getState().setBase(base)
  const toolDeps: ToolDeps = {
    edit: () => edit.getState(),
    reach: { getState: () => ({ computing: false }) as never, subscribe: () => () => undefined },
    holidays: () => null,
    today: () => '20261104',
    policyServices: () => ({ weekday: 'WK', saturday: 'SA', sundayHoliday: 'SU' }),
    hintContext: () => null,
  }
  let onBaseChange: () => void = () => undefined
  const fake = fakeApi()
  const runToolSpy = vi.fn((name: string, input: unknown, signal: AbortSignal): Promise<ToolOutcome> => runTool(name, input, toolDeps, signal))
  const deps: ChatStoreDeps = {
    fetchStatus: async () => status,
    api: fake.api,
    runTool: runToolSpy,
    screen: () => ({ today: '20261104', gtfs: null, reach: null }),
    edits: () => edit.getState(),
    takeDraftNotices: () => edit.getState().takeDraftNotices(),
    storage: memoryStorage(),
    now: () => NOW,
    watchBase: (fn) => {
      onBaseChange = fn
    },
    session: { sleep: async () => undefined, batchDelayMs: 0 },
    ...overrides,
  }
  const chat = createChatStore(deps)
  const s = chat.getState
  const messages = () => fake.posts.filter((p) => p.body.kind === 'message').map((p) => (p.body as Extract<SessionPostBody, { kind: 'message' }>).content)
  return { chat, s, edit, fake, runToolSpy, storage: deps.storage as ReturnType<typeof memoryStorage>, reload: () => onBaseChange(), messages }
}

const status = (id: string, state: string, reason: string | null = null): SessionStreamEvent => ({ type: 'status', id, state, reason })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('中継の状態と合言葉', () => {
  it('状態を読めないときは、ブラウザの英語の文ではなく日本語の決まった文を出す', async () => {
    // つながらない(fetch の TypeError: Failed to fetch)
    const offline = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(fetchClaudeStatus(offline)).rejects.toThrow(NOT_CONNECTED)
    // 200 だが JSON でない(nginx が画面の HTML を返したときなど。res.json() の SyntaxError)
    const html = (async () => new Response('<!doctype html><html></html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchClaudeStatus(html)).rejects.toThrow(STATUS_SHAPE)
    const shape = (async () => Response.json({ available: 'yes' })) as unknown as typeof fetch
    await expect(fetchClaudeStatus(shape)).rejects.toThrow(STATUS_SHAPE)
    await expect(fetchClaudeStatus((async () => Response.json({ available: true, tokenRequired: false })) as unknown as typeof fetch)).resolves.toEqual({
      available: true,
      tokenRequired: false,
    })
    // store の状態の文にも、英語の文は入らない
    const { s } = setup({ fetchStatus: () => fetchClaudeStatus(offline) })
    await s().loadStatus()
    expect(s().status).toEqual({ state: 'error', message: NOT_CONNECTED })
  })

  it('AI が使えなければ送らずに「AI は使えません」を出す', async () => {
    const { s, fake } = setup({}, { available: false, tokenRequired: false })
    await s().loadStatus()
    expect(s().status).toEqual({ state: 'ready', available: false, tokenRequired: false })
    expect(sendBlockedReason(s())).toBe(CLAUDE_UNAVAILABLE)
    expect(await s().send('こんにちは')).toBe(false)
    expect(fake.api.create).not.toHaveBeenCalled()
    expect(s().items.at(-1)).toMatchObject({ kind: 'error', text: CLAUDE_UNAVAILABLE })
  })

  it('合言葉が要るのに無ければ送らず、入れた合言葉を保存してヘッダーに使う', async () => {
    const { s, storage, fake } = setup({}, { available: true, tokenRequired: true })
    await s().loadStatus()
    expect(await s().send('こんにちは')).toBe(false)
    expect(s().tokenError).toBe(TOKEN_MISSING)
    expect(s().unsent).toBe('こんにちは')
    s().setToken('あいことば')
    expect(s().tokenError).toBe(TOKEN_CHARS)
    expect(storage.value).toBeNull()
    s().setToken(' secret-1 ')
    expect(storage.value).toBe('secret-1')
    expect(s().tokenError).toBeNull()
    expect(await s().send('こんにちは')).toBe(true)
    expect(fake.posts[0].token).toBe('secret-1')
  })

  it('401 なら合言葉を消して合言葉の欄に戻し「合言葉が違います」を出す', async () => {
    const { s, storage, fake } = setup({ storage: memoryStorage('old') }, { available: true, tokenRequired: true })
    await s().loadStatus()
    expect(s().token).toBe('old')
    fake.api.create = vi.fn(async () => {
      throw new ClaudeRequestError(401, '認証コードが違います。')
    })
    expect(await s().send('こんにちは')).toBe(false)
    expect(s()).toMatchObject({ token: null, tokenError: TOKEN_WRONG, unsent: 'こんにちは', sending: false })
    expect(storage.value).toBeNull()
  })

  it('429 などはサーバーの文をそのまま出し、入力欄の文を残す', async () => {
    const { s, fake } = setup()
    fake.api.create = vi.fn(async () => {
      throw new ClaudeRequestError(429, '今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください')
    })
    expect(await s().send('こんにちは')).toBe(false)
    expect(s().items.at(-1)).toMatchObject({ kind: 'error', text: '今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください' })
    expect(s().unsent).toBe('こんにちは')
  })

  it('sessionStorage が使えなくても(読み書きで例外が出ても)止まらない', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(sessionTokenStorage.get()).toBeNull()
    expect(() => sessionTokenStorage.set('x')).not.toThrow()
    expect(() => sessionTokenStorage.set(null)).not.toThrow()
  })
})

describe('セッションを始めて送る', () => {
  it('最初に送るときにセッションを作り、ストリームをつないでから、[画面の状態] の行と利用者の文を送る', async () => {
    const { s, fake, messages } = setup()
    expect(s().connection).toBe('none')
    expect(await s().send('平日を土曜ダイヤにしてください')).toBe(true)
    expect(fake.api.create).toHaveBeenCalledTimes(1)
    expect(fake.streams).toHaveLength(1)
    expect(messages()).toEqual([
      [
        { type: 'text', text: TODAY_LINE },
        { type: 'text', text: '平日を土曜ダイヤにしてください' },
      ],
    ])
    expect(s()).toMatchObject({ connection: 'open', replying: true, sending: false, budgetCents: 300 })
    expect(s().items.map((i) => i.kind)).toEqual(['user'])
    expect(s().sentLog[0].parts).toEqual([
      { kind: 'screen', text: TODAY_LINE },
      { kind: 'user', text: '平日を土曜ダイヤにしてください' },
    ])
    expect(s().sentLog[0].at).toBe('2026-11-04T09:30:00+09:00')
    // 2回目は同じセッションで、変わらない [画面の状態] は入れない
    expect(await s().send('続けて')).toBe(true)
    expect(fake.api.create).toHaveBeenCalledTimes(1)
    expect(messages()[1]).toEqual([{ type: 'text', text: '続けて' }])
  })

  it('409 が返ったら、入力欄の文を残して同じ文を出す', async () => {
    const { s, fake } = setup()
    await s().send('一つ目')
    fake.postFailures.push(new ClaudeRequestError(409, 'AI がツールの結果を待っています。少し待ってから送ってください'))
    expect(await s().send('二つ目')).toBe(false)
    expect(s().unsent).toBe('二つ目')
    expect(s().items.at(-1)).toMatchObject({ kind: 'error', text: 'AI がツールの結果を待っています。少し待ってから送ってください' })
  })

  it('取っ手が使えなくなっていたら(404)、新しいセッションを作って最初の発言として送り直す', async () => {
    const { s, fake, messages } = setup()
    await s().send('一つ目')
    fake.postFailures.push(new ClaudeRequestError(404, 'AI との会話が見つかりません。新しく始めます'))
    expect(await s().send('二つ目')).toBe(true)
    expect(fake.api.create).toHaveBeenCalledTimes(2)
    expect(messages().at(-1)).toEqual([
      { type: 'text', text: TODAY_LINE },
      { type: 'text', text: '二つ目' },
    ])
    expect(s().items.map((i) => i.kind)).toEqual(['user', 'user', 'notice'])
  })
})

describe('受け取った返答の表示', () => {
  it('delta で途中まで出し message で置き換える。同じ id のイベントを2回受け取っても1回だけ扱う', async () => {
    const { s, fake } = setup()
    await s().send('こんにちは')
    const ch = fake.last()
    ch.push(
      { type: 'thinking', id: 'e1' },
      { type: 'delta', id: null, messageId: 'm1', text: 'はい、' },
      { type: 'delta', id: null, messageId: 'm1', text: 'わか' },
    )
    await vi.waitFor(() => expect(s().items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'はい、わか', streaming: true }))
    expect(s().replying).toBe(true)
    ch.push(
      { type: 'message', id: 'e2', messageId: 'm1', text: 'はい、分かりました。' },
      // 落ちた途中経過が後から来ても使わない
      { type: 'delta', id: null, messageId: 'm1', text: '遅れた' },
      { type: 'message', id: 'e2', messageId: 'm1', text: 'はい、分かりました。' },
      { type: 'usage', id: 'e3', costCents: 42, budgetCents: 300 },
      status('e4', 'idle', 'end_turn'),
    )
    await vi.waitFor(() => expect(s().replying).toBe(false))
    const assistants = s().items.filter((i) => i.kind === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ text: 'はい、分かりました。', streaming: false })
    expect(s().usage).toEqual({ costCents: 42, budgetCents: 300 })
    expect(usageText(s().usage!)).toBe('この会話の AI の利用額 約 $0.42 / 上限 $3')
    expect(dollars(250)).toBe('$2.50')
  })

  it('Anthropic への接続が切れた(upstream)ときは文を出さず、ほかのエラーは出す', async () => {
    const { s, fake } = setup()
    await s().send('こんにちは')
    fake.last().push(
      { type: 'error', id: null, message: 'AI への接続が切れました', code: 'upstream' },
      { type: 'error', id: 'e1', message: 'AI の処理でエラーが起きました', code: 'session_error' },
    )
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'error', text: 'AI の処理でエラーが起きました' }))
    expect(s().items.filter((i) => i.kind === 'error')).toHaveLength(1)
    expect(s().replying).toBe(false)
  })

  it('サーバーのツールの動きを出し、答えたら終える', async () => {
    const { s, fake } = setup()
    await s().send('調べて')
    fake.last().push({ type: 'tool_activity', id: null, name: 'get_research_targets', done: false })
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'tool', label: '調査の対象を読んでいます…', status: 'running' }))
    fake.last().push({ type: 'tool_activity', id: null, name: 'get_research_targets', done: true })
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'tool', status: 'done' }))
  })
})

describe('tool_call を実行して tool_results で送り、実行している間は送れない', () => {
  it('ツールの動きと下書きの知らせを出し、結果を「AI に送る情報」に残す。実行中は送るボタンを押せない', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { s, fake, edit, runToolSpy } = setup()
    const inner = runToolSpy.getMockImplementation()!
    runToolSpy.mockImplementation(async (name, input, signal) => {
      await gate
      return inner(name, input, signal)
    })
    await s().send('土曜ダイヤにして')
    fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'apply_policy', input: POLICY_INPUT })
    await vi.waitFor(() => expect(s().toolRunning).toBe(true))
    expect(sendBlockedReason(s())).toBe(TOOLS_WAITING)
    expect(canStop(s())).toBe(true)
    expect(await s().send('まだ?')).toBe(false)
    expect(s().items.at(-1)).toMatchObject({ kind: 'error', text: TOOLS_WAITING })
    release()
    await vi.waitFor(() => expect(s().toolRunning).toBe(false))
    expect(edit.getState().draft?.id).toBe('1')
    const items = s()
      .items.filter((i) => i.kind === 'tool' || i.kind === 'draft')
      .map(({ id: _id, ...rest }) => rest)
    expect(items).toEqual([
      { kind: 'tool', callId: 'sevt_1', name: 'apply_policy', label: '減便の方針の下書きを作っています…', status: 'done' },
      { kind: 'draft', draftId: '1', text: draftMessage('1'), step: 'policy' },
    ])
    const results = fake.posts.filter((p) => p.body.kind === 'tool_results')
    expect(results).toHaveLength(1)
    const sent = (results[0].body as Extract<SessionPostBody, { kind: 'tool_results' }>).results
    expect(sent.map((r) => r.custom_tool_use_id)).toEqual(['sevt_1'])
    expect(JSON.parse(sent[0].text)).toMatchObject({ status: 'draft', draft_id: '1' })
    expect(s().sentLog.at(-1)!.parts).toEqual([{ kind: 'tool_result', text: sent[0].text, toolName: 'apply_policy', isError: false }])
  })

  it('承認・取り消しを、次の発言の先頭に [画面の操作] の行で入れる', async () => {
    const { s, fake, edit, messages } = setup()
    await s().send('土曜ダイヤにして')
    fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'apply_policy', input: POLICY_INPUT })
    await vi.waitFor(() => expect(fake.posts.some((p) => p.body.kind === 'tool_results')).toBe(true))
    expect(edit.getState().commit()).toEqual({ ok: true })
    await s().send('学校の便を足し戻して')
    expect(messages().at(-1)).toEqual([
      { type: 'text', text: '[画面の操作] 利用者が下書き #1 を承認しました。' },
      { type: 'text', text: '学校の便を足し戻して' },
    ])
    // 利用者がボタンで足し戻した便の数
    expect(edit.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'user').ok).toBe(true)
    edit.getState().commit()
    await s().send('どうなった?')
    expect(messages().at(-1)![0]).toEqual({ type: 'text', text: '[画面の操作] 利用者が便を 1 便、平日に戻しました。' })
  })

  it('「止める」で、答えていない呼び出しの「利用者が止めました」を results に入れた interrupt を1回で送る', async () => {
    const { s, fake, runToolSpy } = setup()
    runToolSpy.mockImplementation(
      (_name, _input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('止めました', 'AbortError')))),
    )
    await s().send('影響を見せて')
    fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'summarize_impact', input: { date: null, step_hours: null } })
    await vi.waitFor(() => expect(s().toolRunning).toBe(true))
    await s().stop()
    const interrupts = fake.posts.filter((p) => p.body.kind === 'interrupt')
    expect(interrupts).toHaveLength(1)
    const results = (interrupts[0].body as Extract<SessionPostBody, { kind: 'interrupt' }>).results
    expect(results).toEqual([{ custom_tool_use_id: 'sevt_1', text: JSON.stringify({ status: 'error', message: '利用者が止めました' }), is_error: true }])
    expect(fake.posts.filter((p) => p.body.kind === 'tool_results')).toHaveLength(0)
    expect(s().toolRunning).toBe(false)
    expect(s().items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error' })
    // サーバーが止めた後の idle を送ってくる。調査の run が開いていれば案内を出す
    fake.last().push({ type: 'research', id: 'e1', kind: 'run_started', runId: 'wfr_1', name: null, phase: null, result: null, saved: null, total: null })
    fake.last().push(status('e2', 'idle', 'interrupted'))
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'notice', text: RESEARCH_PAUSED }))
    expect(s().items.at(-2)).toMatchObject({ kind: 'notice', text: STOPPED_NOTICE })
    expect(s().replying).toBe(false)
  })
})

describe('GTFS を読み込み直したら、DELETE を送り、表示と取っ手を消す', () => {
  it('発言を消して知らせを出し、次の発言は新しいセッションの最初として [画面の状態] から送る', async () => {
    const { s, fake, reload, messages } = setup()
    await s().send('一つ目')
    reload()
    expect(fake.removed).toEqual(['h1'])
    expect(s().items.map((i) => i.kind)).toEqual(['notice'])
    expect(s().items[0]).toMatchObject({ text: RELOAD_NOTICE })
    expect(s()).toMatchObject({ sentLog: [], connection: 'none', usage: null, budgetCents: null })
    await s().send('二つ目')
    expect(fake.api.create).toHaveBeenCalledTimes(2)
    expect(messages().at(-1)).toEqual([
      { type: 'text', text: TODAY_LINE },
      { type: 'text', text: '二つ目' },
    ])
  })

  it('セッションを作っている間に読み込み直したら、作ったセッションを消し、消した後の表示に失敗を出さない', async () => {
    const { s, fake, reload } = setup()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const create = fake.api.create
    fake.api.create = vi.fn(async (token: string | null) => {
      await gate
      return create(token)
    })
    const sending = s().send('一つ目')
    await vi.waitFor(() => expect(fake.api.create).toHaveBeenCalled())
    reload()
    release()
    expect(await sending).toBe(false)
    expect(fake.removed).toEqual(['h1'])
    expect(s().items.map((i) => i.kind)).toEqual(['notice'])
    expect(s()).toMatchObject({ sending: false, unsent: null })
    expect(fake.posts).toEqual([])
  })

  it('会話が無ければ知らせも DELETE も出さない', () => {
    const { s, fake, reload } = setup()
    reload()
    expect(s().items).toEqual([])
    expect(fake.removed).toEqual([])
  })

  it('GTFS を削除したとき(store/reset.ts):DELETE は1回だけ送り、知らせも消す。次に読み込んでも知らせは出さない', async () => {
    const { s, fake, reload } = setup()
    await s().send('一つ目')
    // resetAll('delete') の順:基準を捨てる(見張りが会話を終える)→ 知らせを残さずに消す
    reload()
    s().reset()
    expect(fake.removed).toEqual(['h1'])
    expect(s().items).toEqual([])
    // 次の GTFS を読み込む(基準が変わる)
    reload()
    expect(s().items).toEqual([])
    expect(fake.removed).toEqual(['h1'])
  })

  it('ページを閉じるとき(endSession)も DELETE を送る', async () => {
    const { s, fake } = setup()
    await s().send('一つ目')
    s().endSession()
    expect(fake.removed).toEqual(['h1'])
  })
})

describe('予算に達したら入力欄を閉じ、「新しく始める」を出す', () => {
  it('budget_reached で送れなくし、新しく始めると DELETE の後に作り直し、承認済みの編集の要約から送る', async () => {
    const { s, fake, edit, messages } = setup()
    await s().send('一つ目')
    expect(edit.getState().propose({ type: 'applyPolicy', settings: { kind: 'weekdayToSaturday', weekdayService: 'WK', replacementService: 'SA', period: { start: '20261109', end: null }, excludedRoutes: [] }, reason: { category: null, note: '' } }, 'user').ok).toBe(true)
    edit.getState().commit()
    fake.last().push(status('e1', 'idle', 'budget_reached'))
    await vi.waitFor(() => expect(s().budgetReached).toBe(true))
    expect(s().items.at(-1)).toMatchObject({ kind: 'notice', text: budgetReachedMessage(300) })
    expect(budgetReachedMessage(300)).toBe(
      'この会話の AI の利用額が上限(3 ドル)に達しました。続けるときは「新しく始める」を押してください。GTFS の編集はそのまま残ります。AI はここまでの会話を覚えていません。',
    )
    expect(sendBlockedReason(s())).toBe(budgetReachedMessage(300))
    expect(await s().send('二つ目')).toBe(false)
    expect(s().unsent).toBe('二つ目')
    expect(messages()).toHaveLength(1)

    s().startOver()
    expect(fake.removed).toEqual(['h1'])
    expect(s()).toMatchObject({ budgetReached: false, connection: 'none' })
    expect(await s().send('三つ目')).toBe(true)
    expect(fake.api.create).toHaveBeenCalledTimes(2)
    expect(messages().at(-1)).toEqual([
      {
        type: 'text',
        text: `${TODAY_LINE}\n[画面の操作] これまでに承認された編集:減便の方針の承認(平日を土曜ダイヤに、2026年11月9日〜当面の間)、平日に戻した便 0 便。`,
      },
      { type: 'text', text: '三つ目' },
    ])
  })

  it('セッションが終わった(ended)ら知らせ、次に送ると新しく始める', async () => {
    const { s, fake } = setup()
    await s().send('一つ目')
    fake.last().push(status('e1', 'ended'))
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'notice', text: ENDED_NOTICE }))
    expect(s().connection).toBe('none')
    expect(await s().send('二つ目')).toBe(true)
    expect(fake.api.create).toHaveBeenCalledTimes(2)
  })
})

describe('調査の進み具合(11/6)', () => {
  it('run の始まり・段階・保存の数・終わりを数え、調べ終えたかを出す', async () => {
    const { s, fake } = setup()
    await s().send('調べて')
    const r = (kind: string, extra: Partial<Extract<SessionStreamEvent, { type: 'research' }>> = {}): SessionStreamEvent => ({
      type: 'research',
      id: `r-${kind}-${extra.saved ?? ''}`,
      kind,
      runId: 'wfr_1',
      name: null,
      phase: null,
      result: null,
      saved: null,
      total: null,
      ...extra,
    })
    fake.last().push(r('run_started'), r('phase_started', { name: '施設を調べる' }), r('saved', { saved: 2, total: 5 }))
    await vi.waitFor(() => expect(researchText(s().research)).toBe('調べています 2 / 5 件(施設を調べる)'))
    // run の間は、返答を終えても idle が来ない
    fake.last().push({ type: 'message', id: 'm1', messageId: 'm1', text: '調べています' })
    await vi.waitFor(() => expect(s().replying).toBe(false))
    fake.last().push(r('saved', { saved: 4, total: 5 }), r('run_ended', { result: 'completed' }))
    await vi.waitFor(() => expect(researchText(s().research)).toBe('一部を調べられませんでした'))
    expect(s().research.openRuns).toEqual([])
  })
})

// ---- A06(指摘15.1・15.2) ----

/** 調査の API の偽物。登録(registerKnown)と調査の開始(start)を記録する */
function fakeResearch() {
  const known: { handle: string; ids: string[] }[] = []
  const knownFailures: unknown[] = []
  const api: ResearchApi = {
    start: vi.fn(async (_token, _handle, ids) => ({
      targets: ids.map((targetId: string) => ({ targetId, kind: 'school' as const, name: targetId, municipality: null, lat: 43, lon: 142, cached: null })),
      total: ids.length + 2,
      maxTargets: 30,
    })),
    registerKnown: vi.fn(async (_token, handle, ids) => {
      known.push({ handle, ids: [...ids] })
      const failure = knownFailures.shift()
      if (failure) throw failure
      return { registered: ids.length, total: ids.length }
    }),
    overview: vi.fn(async () => {
      throw new Error('使わない')
    }),
  }
  return { api, known, knownFailures }
}

const demoIds = (n: number) => Array.from({ length: n }, (_, i) => `P29:${String(i + 1).padStart(4, '0')}`)
const RESEARCH_LINE_51 = '[画面の状態] 前提情報:調査の結果 51 件(保存済みの結果(デモ)を含む)。get_research_results で読めます。'

/** 前提情報の store の代わり(結果のある target_id と、そのうちデモの数)。changed で見張りを呼ぶ */
function setupWithResearch(initial: string[] = []) {
  const research = fakeResearch()
  let ids = initial
  let demo = initial.length
  let onResearch: () => void = () => undefined
  const t = setup({
    research: research.api,
    knownResearchTargets: () => ids,
    watchResearch: (fn) => {
      onResearch = fn
    },
    screen: () => ({ today: '20261104', gtfs: null, reach: null, research: { count: ids.length, demo } }),
  })
  const changed = (next: string[], nextDemo = demo) => {
    ids = next
    demo = nextDemo
    onResearch()
  }
  return { ...t, research, changed }
}

describe('調べた結果の対象を、セッションを作るたびに登録する(指摘15.1)', () => {
  it('デモを読み込んでから最初の発言をすると、50 件ずつに分けて登録してから、前提情報の行と発言を送る', async () => {
    const { s, fake, research, messages } = setupWithResearch(demoIds(51))
    expect(await s().send('平日を土曜ダイヤにしてください')).toBe(true)
    expect(research.known).toEqual([
      { handle: 'h1', ids: demoIds(51).slice(0, 50) },
      { handle: 'h1', ids: demoIds(51).slice(50) },
    ])
    // 登録 → 送信の順
    const knownOrder = (research.api.registerKnown as ReturnType<typeof vi.fn>).mock.invocationCallOrder
    const postOrder = (fake.api.post as ReturnType<typeof vi.fn>).mock.invocationCallOrder
    expect(Math.max(...knownOrder)).toBeLessThan(Math.min(...postOrder))
    expect(messages()).toEqual([
      [
        { type: 'text', text: `${TODAY_LINE}\n${RESEARCH_LINE_51}` },
        { type: 'text', text: '平日を土曜ダイヤにしてください' },
      ],
    ])
    // 同じセッションには同じ集まりを2度送らない。件数が変わらなければ前提情報の行も入れない
    expect(await s().send('二つ目')).toBe(true)
    expect(research.known).toHaveLength(2)
    expect(messages()[1]).toEqual([{ type: 'text', text: '二つ目' }])
    expect(s().researchError).toBeNull()
  })

  it('結果が 0 件なら登録も前提情報の行も無い。セッションがある間に結果が増えたら、増えた分だけすぐ登録し、次の発言で件数を伝える', async () => {
    const { s, research, messages, changed } = setupWithResearch()
    // セッションが無い間は登録しない
    changed(demoIds(3))
    expect(research.known).toEqual([])
    changed([])
    expect(await s().send('一つ目')).toBe(true)
    expect(research.known).toEqual([])
    expect(messages()[0]).toEqual([
      { type: 'text', text: TODAY_LINE },
      { type: 'text', text: '一つ目' },
    ])
    changed(demoIds(3), 3)
    await vi.waitFor(() => expect(research.known).toEqual([{ handle: 'h1', ids: demoIds(3) }]))
    // Web で調べた結果が1件増えた(デモではない)
    changed([...demoIds(3), 'P04:1'], 3)
    await vi.waitFor(() => expect(research.known).toHaveLength(2))
    expect(research.known[1]).toEqual({ handle: 'h1', ids: ['P04:1'] })
    expect(await s().send('二つ目')).toBe(true)
    expect(research.known).toHaveLength(2)
    expect(messages()[1]).toEqual([
      { type: 'text', text: '[画面の状態] 前提情報:調査の結果 4 件(保存済みの結果(デモ)を含む)。get_research_results で読めます。' },
      { type: 'text', text: '二つ目' },
    ])
    // デモが無ければ括弧の補足を付けない
    changed(['P04:1'], 0)
    expect(await s().send('三つ目')).toBe(true)
    expect(messages()[2][0]).toEqual({ type: 'text', text: '[画面の状態] 前提情報:調査の結果 1 件。get_research_results で読めます。' })
  })

  it('セッションを作り直したら(新しく始める・取っ手が使えなくなった)、また登録する', async () => {
    const { s, fake, research } = setupWithResearch(demoIds(2))
    await s().send('一つ目')
    expect(research.known).toEqual([{ handle: 'h1', ids: demoIds(2) }])
    s().startOver()
    await s().send('二つ目')
    expect(research.known.at(-1)).toEqual({ handle: 'h2', ids: demoIds(2) })
    // 404 で作り直して送り直すときも
    fake.postFailures.push(new ClaudeRequestError(404, 'AI との会話が見つかりません。新しく始めます'))
    expect(await s().send('三つ目')).toBe(true)
    expect(research.known.map((k) => k.handle)).toEqual(['h1', 'h2', 'h3'])
  })

  it('登録に失敗しても発言は送り、前提情報の手順に短い文を出す。次の発言で登録し直す', async () => {
    const { s, research, messages } = setupWithResearch(demoIds(2))
    research.knownFailures.push(new ClaudeRequestError(429, '回数の上限です'))
    expect(await s().send('一つ目')).toBe(true)
    expect(messages()).toHaveLength(1)
    expect(s().researchError).toBe(RESEARCH_KNOWN_FAILED)
    expect(await s().send('二つ目')).toBe(true)
    expect(research.known).toEqual([
      { handle: 'h1', ids: demoIds(2) },
      { handle: 'h1', ids: demoIds(2) },
    ])
  })

  it('「前提情報を調べる」でセッションを作ったときも、調査を始める前に登録する。「AI に送る情報」の件数は送った対象の数', async () => {
    const { s, research } = setupWithResearch(demoIds(2))
    const view = await s().startResearch(['P04:1', 'P04:2', 'P04:1'])
    expect(view).not.toBeNull()
    expect(research.known).toEqual([{ handle: 'h1', ids: demoIds(2) }])
    const knownOrder = (research.api.registerKnown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const startOrder = (research.api.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(knownOrder).toBeLessThan(startOrder)
    // サーバーの返す total(4)は登録済みの対象も含む。会話に入る行は送った対象の数(2)
    expect(s().sentLog.at(-1)!.parts).toEqual([{ kind: 'screen', text: researchStartLine(2) }])
  })

  it('調査の進み具合の分母は、利用者が選んだ対象の数。サーバーの数(登録した調べた結果の対象を含む)からそろえる(A06 の申し送り)', async () => {
    const { s, fake } = setupWithResearch(demoIds(2))
    await s().startResearch(['P04:1', 'P04:2', 'P04:1'])
    expect(s().research).toMatchObject({ active: true, saved: 0, total: 2 })
    expect(researchText(s().research)).toBe('調べています 0 / 2 件')
    // サーバーは、登録したデモの2件(保存済み)と選んだ2件を合わせて数える
    const saved = (id: string, n: number, total: number): SessionStreamEvent => ({
      type: 'research',
      id,
      kind: 'saved',
      runId: null,
      name: null,
      phase: null,
      result: null,
      saved: n,
      total,
    })
    fake.last().push(saved('e1', 3, 4))
    await vi.waitFor(() => expect(researchText(s().research)).toBe('調べています 1 / 2 件'))
    // あとからデモの結果が増えて(登録して)サーバーの数が増えても、分母は選んだ数のまま
    fake.last().push(saved('e2', 5, 5))
    await vi.waitFor(() => expect(s().research).toMatchObject({ saved: 2, total: 2 }))
    // 新しく始めたら、サーバーの数をそのまま使う
    s().startOver()
    await s().send('調べて')
    fake.last().push(saved('e3', 1, 3))
    await vi.waitFor(() => expect(s().research).toMatchObject({ saved: 1, total: 3 }))
  })

  it('サーバーの targets が空・一部欠けで返っても、分母は選んだ対象の数で、調べている最中に「調べ終えました」と出さない', async () => {
    const { s, research } = setupWithResearch()
    const start = research.api.start as ReturnType<typeof vi.fn>
    // targets が空
    start.mockImplementationOnce(async () => ({ targets: [], total: 2, maxTargets: 30 }))
    await s().startResearch(['P04:1', 'P04:2', 'P04:1'])
    expect(s().research).toMatchObject({ active: true, saved: 0, total: 2, outcome: null })
    expect(researchText(s().research)).toBe('調べています 0 / 2 件')
    // 一部欠け(返った1件は保存済み)
    s().startOver()
    start.mockImplementationOnce(async () => ({
      targets: [{ targetId: 'P04:1', kind: 'hospital' as const, name: 'P04:1', municipality: null, lat: 43, lon: 142, cached: { status: 'found' as const, checkedAt: '2026-11-04T10:00:00+09:00', facts: 2 } }],
      total: 2,
      maxTargets: 30,
    }))
    await s().startResearch(['P04:1', 'P04:2'])
    expect(s().research).toMatchObject({ active: true, saved: 1, total: 2, outcome: null })
    expect(researchText(s().research)).toBe('調べています 1 / 2 件')
  })
})

describe('ツールを使いすぎて止めた知らせ(指摘15.2)', () => {
  const tooMany = (id: string): SessionStreamEvent => ({
    type: 'error',
    id,
    message: 'AI がこの相談でツールを 12 回使ったので、ここで止めました。続けるときは「続きを頼む」を押してください',
    code: 'too_many_tool_calls',
  })

  it('同じ発言の中で4回来ても知らせは1件で、そのあとの interrupted で「止めました」を足さない。「続きを頼む」で続きを送る', async () => {
    const { s, fake, messages } = setup()
    await s().send('便を全部調べて')
    fake.last().push(tooMany('e1'), tooMany('e2'), tooMany('e3'), tooMany('e4'), status('e5', 'idle', 'interrupted'))
    await vi.waitFor(() => expect(s().replying).toBe(false))
    expect(s().items.filter((i) => i.kind === 'stopped')).toHaveLength(1)
    expect(s().items.filter((i) => i.kind === 'error')).toHaveLength(0)
    expect(s().items.some((i) => i.kind === 'notice' && i.text === STOPPED_NOTICE)).toBe(false)
    expect(s().items.at(-1)).toMatchObject({ kind: 'stopped', continued: false })

    expect(await s().continueStopped()).toBe(true)
    expect(messages().at(-1)).toEqual([
      { type: 'text', text: CONTINUE_LINE },
      { type: 'text', text: CONTINUE_PROMPT },
    ])
    expect(CONTINUE_LINE).toBe('[画面の操作] 利用者が、止まった作業の続きを頼みました。')
    expect(s().items.find((i) => i.kind === 'stopped')).toMatchObject({ continued: true })
    expect(s().items.at(-1)).toMatchObject({ kind: 'user', text: '続けてください。' })

    // 次の発言でまた上限を超えたら、また1回出す。利用者が「止める」で止めたときは「止めました」を出す
    fake.last().push(tooMany('e6'), tooMany('e7'), status('e8', 'idle', 'interrupted'))
    await vi.waitFor(() => expect(s().items.filter((i) => i.kind === 'stopped')).toHaveLength(2))
    expect(s().items.some((i) => i.kind === 'notice' && i.text === STOPPED_NOTICE)).toBe(false)
    await s().send('別の質問')
    fake.last().push(status('e9', 'idle', 'interrupted'))
    await vi.waitFor(() => expect(s().items.at(-1)).toMatchObject({ kind: 'notice', text: STOPPED_NOTICE }))
  })
})

// ---- A08(指摘18.4) ----

describe('AI が確かめた便の件数(指摘18.4)', () => {
  const search = (extra: Record<string, unknown> = {}) => ({
    scope: 'base_weekday',
    route_ids: null,
    stop_name: null,
    depart_from: null,
    depart_to: null,
    limit: 2,
    ...extra,
  })
  let callNo = 0
  /** search_trips を呼ばせて、結果を送り終えるまで待つ */
  async function callSearch(t: ReturnType<typeof setup>, input: Record<string, unknown>) {
    const id = `sevt_${++callNo}`
    const before = t.fake.posts.filter((p) => p.body.kind === 'tool_results').length
    t.fake.last().push({ type: 'tool_call', id, name: 'search_trips', input })
    await vi.waitFor(() => expect(t.fake.posts.filter((p) => p.body.kind === 'tool_results').length).toBe(before + 1))
    return t.s().items.find((i) => i.kind === 'tool' && i.callId === id)
  }
  const checkedItems = (t: ReturnType<typeof setup>) => t.s().items.filter((i) => i.kind === 'checked')

  it('search_trips の項目に「減便前の平日の便 4 便のうち 2 便」の形の件数を添える。条件で絞ったときは「条件に合う」を付ける', async () => {
    const t = setup()
    await t.s().send('平日の便を見せて')
    expect(await callSearch(t, search())).toMatchObject({ status: 'done', detail: '減便前の平日の便 4 便のうち 2 便' })
    expect(await callSearch(t, search({ route_ids: ['R2'], limit: 5 }))).toMatchObject({ status: 'done', detail: '条件に合う減便前の平日の便 1 便のうち 1 便' })
    // 失敗した呼び出し(減便の方針が無いので removed は探せない)には件数を付けない
    const failed = await callSearch(t, search({ scope: 'removed' }))
    expect(failed).toMatchObject({ status: 'error' })
    expect(failed && 'detail' in failed ? failed.detail : undefined).toBeUndefined()
  })

  it('返答の終わりに、この相談で AI が確かめた便を1行出す。条件で絞った結果は件数だけを添え、相談ごとに数え直す', async () => {
    const t = setup()
    await t.s().send('平日の便を見せて')
    await callSearch(t, search())
    // 同じ便を2回返しても1回と数え、total は最新のもの
    await callSearch(t, search({ limit: 3 }))
    // R2 の便は、条件を付けずに探した3便(7:00・7:30・8:00)に無い
    await callSearch(t, search({ route_ids: ['R2'], limit: 5 }))
    t.fake.last().push({ type: 'message', id: 'm1', messageId: 'm1', text: '4 便のうち 3 便を見ました' }, status('e1', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(checkedItems(t)).toHaveLength(1))
    expect(checkedItems(t)[0]).toMatchObject({
      text: 'この相談で AI が確かめた便:減便前の平日の便 4 便のうち 3 便(ほかに条件で絞って探した便:減便前の平日の便 1 便)',
    })
    expect(t.s().items.at(-1)?.kind).toBe('checked')
    // 同じ相談の idle がもう一度来ても、同じ行は出さない
    t.fake.last().push(status('e2', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(t.s().replying).toBe(false))
    expect(checkedItems(t)).toHaveLength(1)

    // 次の相談は数え直す。条件で絞った結果しか無ければ、行は出さない
    await t.s().send('R2 の便は?')
    await callSearch(t, search({ route_ids: ['R2'], limit: 5 }))
    t.fake.last().push(status('e3', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(t.s().replying).toBe(false))
    expect(checkedItems(t)).toHaveLength(1)
    await t.s().send('全部見て')
    await callSearch(t, search({ limit: 1 }))
    t.fake.last().push(status('e4', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(checkedItems(t)).toHaveLength(2))
    expect(checkedItems(t)[1]).toMatchObject({ text: 'この相談で AI が確かめた便:減便前の平日の便 4 便のうち 1 便' })
  })

  it('「続きを頼む」の [画面の操作] の行に確かめた件数を入れ、続きの返答では数え続ける', async () => {
    const t = setup()
    await t.s().send('便を全部調べて')
    await callSearch(t, search())
    t.fake.last().push(
      { type: 'error', id: 'e1', message: 'AI がこの相談でツールを 12 回使ったので、ここで止めました。', code: 'too_many_tool_calls' },
      status('e2', 'idle', 'interrupted'),
    )
    await vi.waitFor(() => expect(checkedItems(t)).toHaveLength(1))
    // 止めた知らせのあとに、件数の行
    expect(t.s().items.slice(-2).map((i) => i.kind)).toEqual(['stopped', 'checked'])
    expect(await t.s().continueStopped()).toBe(true)
    expect(t.messages().at(-1)).toEqual([
      { type: 'text', text: '[画面の操作] 利用者が、止まった作業の続きを頼みました。減便前の平日の便 4 便のうち 2 便を確かめ済みです。' },
      { type: 'text', text: CONTINUE_PROMPT },
    ])
    await callSearch(t, search({ limit: 4 }))
    t.fake.last().push(status('e3', 'idle', 'end_turn'))
    await vi.waitFor(() => expect(checkedItems(t)).toHaveLength(2))
    expect(checkedItems(t)[1]).toMatchObject({ text: 'この相談で AI が確かめた便:減便前の平日の便 4 便のうち 4 便' })
    // 確かめた便が無ければ、続きの行は今までの文のまま
    expect(continueLine(new Map())).toBe(CONTINUE_LINE)
  })

  it('結果の数は AI に届いた便から数える。省いた便・同じ trip_id の別の feed・結果の形が違うとき', () => {
    const outcome = (body: unknown) => ({ content: JSON.stringify(body), isError: false })
    const body = {
      status: 'ok',
      scope: 'removed',
      total: 292,
      returned: 50,
      truncated: 2,
      trips: [
        { feed: 'base', trip_id: 'T1' },
        { feed: 'edited', trip_id: 'T1' },
      ],
    }
    const s1 = summarizeSearchTrips({ scope: 'removed', route_ids: [], stop_name: ' ', depart_from: null, depart_to: null, limit: 50 }, outcome(body))
    expect(s1).toEqual({ scope: 'removed', total: 292, tripKeys: ['base:T1', 'edited:T1'], filtered: false })
    // offset は条件ではなく、hints は条件
    expect(summarizeSearchTrips({ scope: 'removed', offset: 50 }, outcome(body))?.filtered).toBe(false)
    expect(summarizeSearchTrips({ scope: 'removed', hints: ['morning'] }, outcome(body))?.filtered).toBe(true)
    expect(summarizeSearchTrips({}, { content: JSON.stringify(body), isError: true })).toBeNull()
    expect(summarizeSearchTrips({}, outcome({ status: 'error', message: 'x' }))).toBeNull()
    expect(summarizeSearchTrips({}, { content: 'not json', isError: false })).toBeNull()
    // 20KB を超えた結果は AI に届かない
    expect(summarizeSearchTrips({}, outcome({ ...body, pad: 'x'.repeat(21 * 1024) }))).toBeNull()
    expect(checkedLine(new Map())).toBeNull()
  })
})

describe('置いた営業所・車庫・休憩施設の名前は AI に送らない(F02)', () => {
  // 場所は画面の中だけに持つ(store/drivers.ts)。[画面の状態] の行・発言・ツールの結果のどれにも名前が入らないことを確かめる回帰テスト
  const NAMES = ['秘匿の営業所F02', '秘匿の車庫F02', '秘匿の休憩所F02']
  const leaks = (text: string) => NAMES.filter((n) => text.includes(n))

  function placeAll() {
    useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
    const d = useDriversStore.getState()
    d.addPlace({ type: 'office', name: NAMES[0], lat: 43.76, lon: 142.36 })
    d.addPlace({ type: 'garage', name: NAMES[1], lat: 43.77, lon: 142.36 })
    d.addPlace({ type: 'rest', name: NAMES[2], lat: 43.76, lon: 142.37 })
    d.setShortage(20)
    expect(useDriversStore.getState().places.map((p) => p.name)).toEqual(NAMES)
  }

  afterEach(() => {
    useDriversStore.setState({ shortage: null, places: [], placing: null })
    useEditStore.getState().setBase(null)
  })

  it('[画面の状態] の材料と行に入らない', () => {
    placeAll()
    const screen = currentScreenState()
    expect(leaks(JSON.stringify(screen))).toEqual([])
    const lines = stateLines(screen).map((l) => l.line)
    expect(lines.length).toBeGreaterThan(1)
    expect(leaks(lines.join('\n'))).toEqual([])
  })

  it('発言と、6つのツールのうち AI が呼べるものの結果に入らない', async () => {
    placeAll()
    const { s, fake } = setup({
      screen: currentScreenState,
      runTool: (name, input, signal) => runTool(name, input, chatToolDeps, signal),
    })
    expect(await s().send('営業所の場所を教えて')).toBe(true)
    const calls: [string, unknown][] = [
      ['apply_policy', POLICY_INPUT],
      ['summarize_impact', { date: '20261111', step_hours: 3 }],
      ['search_trips', { scope: 'removed', route_ids: [], stop_name: null, depart_from: null, depart_to: null, limit: 10, offset: null, hints: null }],
      ['run_validation', {}],
      ['undo_edit', {}],
    ]
    for (const [i, [name, input]] of calls.entries()) {
      fake.last().push({ type: 'tool_call', id: `sevt_${i}`, name, input })
      await vi.waitFor(() => expect(fake.posts.filter((p) => p.body.kind === 'tool_results')).toHaveLength(i + 1))
      // 減便の方針の下書きを承認してから、ほかのツールを呼ぶ
      if (name === 'apply_policy') expect(useEditStore.getState().commit()).toEqual({ ok: true })
    }
    expect(await s().send('続けて')).toBe(true)
    expect(fake.posts.length).toBeGreaterThan(calls.length)
    expect(leaks(JSON.stringify(fake.posts))).toEqual([])
    expect(leaks(JSON.stringify(s().sentLog))).toEqual([])
  })
})
