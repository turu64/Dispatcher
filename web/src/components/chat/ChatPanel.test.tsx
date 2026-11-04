// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidePanel from '@/components/layout/SidePanel'
import StepPanels from '@/components/layout/StepPanels'
import PolicyStep from '@/components/steps/PolicyStep'
import { fakeApi } from '@/claude/session.fixture'
import type { SessionPostBody } from '@/claude/session'
import { ClaudeRequestError, type SessionStreamEvent } from '@/claude/sse'
import { runTool, type ToolOutcome } from '@/claude/tools'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import {
  ASK_RESTORE_PROMPT,
  budgetReachedMessage,
  chatToolDeps,
  CLAUDE_UNAVAILABLE,
  createChatStore,
  PREPARING,
  SENDING,
  setChatToolProviders,
  SEND_INFO_NOTE,
  TOKEN_WRONG,
  TOOLS_WAITING,
  type ChatStoreDeps,
  type TokenStorage,
} from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useSidePanelStore } from '@/store/sidePanel'
import { useStepStore } from '@/store/steps'
import { AskRestoreButton } from './AskRestoreButton'
import ChatPanel from './ChatPanel'
import SimpleMarkdown from './simpleMarkdown'

// 手順の欄(StepPanels)の読み込みの手順は、サンプルの有無をサーバーに聞く。ここではサーバーに届かないものとする
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
}))

const NOW = new Date('2026-11-04T00:30:00Z')

const POLICY_INPUT = {
  kind: 'weekday_to_saturday',
  start_date: '20261109',
  end_date: null,
  excluded_route_ids: [],
  reason_category: null,
  reason_note: '',
}

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

/** 本物の編集の store(画面と同じ)につないだ、チャットの store。中継(fetch とストリーム)は偽物 */
function setup(overrides: Partial<ChatStoreDeps> = {}, status = { available: true, tokenRequired: false }) {
  const fake = fakeApi()
  const deps: ChatStoreDeps = {
    fetchStatus: async () => status,
    api: fake.api,
    runTool: (name, input, signal) => runTool(name, input, chatToolDeps, signal),
    screen: () => ({ today: '20261104', gtfs: null, reach: null }),
    edits: () => useEditStore.getState(),
    takeDraftNotices: () => useEditStore.getState().takeDraftNotices(),
    storage: memoryStorage(),
    now: () => NOW,
    session: { sleep: async () => undefined, batchDelayMs: 0 },
    ...overrides,
  }
  const store = createChatStore(deps)
  return { store, fake, deps }
}

const status = (id: string, state: string, reason: string | null = null): SessionStreamEvent => ({ type: 'status', id, state, reason })

function box(): HTMLTextAreaElement {
  return screen.getByLabelText('AI への指示や質問') as HTMLTextAreaElement
}
const sendButton = () => screen.getByRole('button', { name: '送る' }) as HTMLButtonElement

async function typeAndSend(text: string) {
  fireEvent.change(box(), { target: { value: text } })
  await act(async () => {
    fireEvent.click(sendButton())
  })
}

beforeEach(() => {
  act(() => {
    useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
  })
  setChatToolProviders({ policyServices: () => ({ weekday: 'WK', saturday: 'SA', sundayHoliday: 'SU' }), hintContext: () => null })
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  act(() => useSidePanelStore.setState({ tab: 'edit' }))
  act(() => useStepStore.setState({ current: 'load' }))
  setChatToolProviders({ policyServices: null, hintContext: null })
  vi.restoreAllMocks()
})

describe('「AI に相談」のタブ', () => {
  it('GTFS を読み込むまでは出さず、読み込むと出る', () => {
    act(() => useEditStore.getState().setBase(null))
    const { store } = setup()
    const { container } = render(<ChatPanel store={store} />)
    expect(container.textContent).toBe('')
    act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
    expect(screen.getByRole('log', { name: 'AI との会話' })).toBeTruthy()
    // 名前は外側のタブの中身が持つので、ここでは「AI に相談」の区域を作らない(読み上げで二重にしない)
    expect(screen.queryByRole('region', { name: 'AI に相談' })).toBeNull()
  })

  it('タブの中身なので、折りたたみの見出しのボタンは無い', () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    expect(screen.queryByRole('button', { name: 'AI に相談' })).toBeNull()
    expect(screen.getByRole('log', { name: 'AI との会話' })).toBeTruthy()
  })

  it('隠れている間に増えた発言は、タブを開いたときにいちばん下まで流す。増えていなければ前のスクロールの位置に戻す', () => {
    const { store } = setup()
    const { rerender } = render(<ChatPanel store={store} active={false} />)
    const log = screen.getByRole('log', { name: 'AI との会話' })
    // jsdom は高さを持たないので、会話の箱の中身の高さを決めておく
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 500 })
    act(() => store.setState({ items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '返答', streaming: false }] }))
    // 隠れている間は流さない(隠れていると高さが 0 のため)
    expect(log.scrollTop).toBe(0)
    rerender(<ChatPanel store={store} active />)
    expect(log.scrollTop).toBe(500)

    log.scrollTop = 120
    fireEvent.scroll(log)
    rerender(<ChatPanel store={store} active={false} />)
    // 隠すと位置が 0 に戻るブラウザの代わり
    log.scrollTop = 0
    rerender(<ChatPanel store={store} active />)
    expect(log.scrollTop).toBe(120)
  })

  it('利用者の文が増えたら「AI に相談」のタブに切り替える', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} active={false} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    expect(useSidePanelStore.getState().tab).toBe('edit')
    await typeAndSend('土曜ダイヤにして')
    expect(useSidePanelStore.getState().tab).toBe('chat')
  })

  it('AI が使えないときは理由を出し、入力欄と送るボタンを押せなくする。ほかの手順はそのまま動く', async () => {
    const { store, fake } = setup({}, { available: false, tokenRequired: false })
    render(
      <>
        <ChatPanel store={store} />
        <PolicyStep />
      </>,
    )
    await screen.findByText(new RegExp(CLAUDE_UNAVAILABLE.replace(/[()]/g, '\\$&')))
    expect(box().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(screen.getByText(/ほかの手順はすべてボタンで使えます/)).toBeTruthy()
    expect(fake.api.create).not.toHaveBeenCalled()
    // 方針の手順は、AI が使えなくても入力できる
    expect(screen.getByRole('button', { name: '対象便を確かめる' })).toBeTruthy()
  })

  it('状態を読めなかったときは、理由を出し、もう一度確かめられる', async () => {
    let calls = 0
    const { store } = setup({
      fetchStatus: async () => {
        calls++
        if (calls === 1) throw new Error('AI の状態を確かめられませんでした(500)。')
        return { available: true, tokenRequired: false }
      },
    })
    render(<ChatPanel store={store} />)
    await screen.findByText(/AI の状態を確かめられませんでした\(500\)/)
    expect(sendButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }))
    await waitFor(() => expect(screen.queryByText(/確かめられませんでした/)).toBeNull())
    expect(box().disabled).toBe(false)
  })

  it('合言葉が要るときは合言葉の欄を出し、入れるまで送れない。違えば「合言葉が違います」で欄に戻る', async () => {
    const storage = memoryStorage()
    const { store, fake } = setup({ storage }, { available: true, tokenRequired: true })
    render(<ChatPanel store={store} />)
    const field = (await screen.findByLabelText('認証コード')) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(box(), { target: { value: 'こんにちは' } })
    expect(sendButton().disabled).toBe(true)

    fireEvent.change(field, { target: { value: 'secret-1' } })
    fireEvent.click(screen.getByRole('button', { name: '設定' }))
    expect(storage.value).toBe('secret-1')
    await waitFor(() => expect(screen.queryByLabelText('認証コード')).toBeNull())
    expect(sendButton().disabled).toBe(false)

    fake.api.create = vi.fn(async () => {
      throw new ClaudeRequestError(401, '認証コードが違います。')
    })
    await act(async () => {
      fireEvent.click(sendButton())
    })
    expect(await screen.findByText(TOKEN_WRONG)).toBeTruthy()
    expect(screen.getByLabelText('認証コード')).toBeTruthy()
    expect(storage.value).toBeNull()
    // 送れなかった文は入力欄に戻っている
    expect(box().value).toBe('こんにちは')
  })

  it('送ると中継に届き、返答が途中から出て、考えています…は返答が終わるまで出る。利用額と送った情報も出る', async () => {
    const { store, fake } = setup()
    render(<ChatPanel store={store} />)
    await screen.findByText('減便の方針の指示や質問を送れます', { exact: false })
    await typeAndSend('平日を土曜ダイヤにしてください')
    expect(box().value).toBe('')
    const message = fake.posts.find((p) => p.body.kind === 'message')!.body as Extract<SessionPostBody, { kind: 'message' }>
    expect(message.content.at(-1)).toEqual({ type: 'text', text: '平日を土曜ダイヤにしてください' })
    const conversation = screen.getByRole('list', { name: '会話' })
    expect(within(conversation).getByText('平日を土曜ダイヤにしてください')).toBeTruthy()
    expect(screen.getByText('考えています…')).toBeTruthy()

    const ch = fake.last()
    ch.push({ type: 'delta', id: null, messageId: 'm1', text: '承知しました。' })
    await screen.findByText('承知しました。')
    ch.push(
      { type: 'message', id: 'e1', messageId: 'm1', text: '承知しました。\n**方針**を確かめます。\n- 期間\n- 対象の便' },
      { type: 'usage', id: 'e2', costCents: 42, budgetCents: 300 },
      status('e3', 'idle', 'end_turn'),
    )
    await waitFor(() => expect(screen.queryByText('考えています…')).toBeNull())
    const reply = within(conversation).getByText('方針', { selector: 'strong' })
    expect(reply.tagName).toBe('STRONG')
    expect(within(conversation).getAllByRole('listitem').some((li) => li.textContent === '期間')).toBe(true)
    expect(screen.getByText(/この会話の AI の利用額 約 \$0\.42 \/ 上限 \$3/)).toBeTruthy()
    expect(screen.getByText(SEND_INFO_NOTE)).toBeTruthy()
  })

  it('最初のストリームがつながるまで「AI を準備しています…」を出し、つながったら消す。2回目の発言では出さない', async () => {
    const { store, fake } = setup()
    // 新しいセッションの最初の接続は、Anthropic の側の準備を待つので遅い。つながるのを手で進める
    let open: () => void = () => undefined
    const opened = new Promise<void>((r) => (open = r))
    const realOpen = fake.api.openStream
    fake.api.openStream = vi.fn(async (o) => {
      await opened
      return realOpen(o)
    })
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    expect(screen.queryByText(PREPARING)).toBeNull()
    await typeAndSend('平日を土曜ダイヤにしてください')
    expect(await screen.findByText(PREPARING)).toBeTruthy()
    // 「送っています…」は重ねて出さない。まだ発言は送っていない
    expect(screen.queryByText(SENDING)).toBeNull()
    expect(fake.posts.some((p) => p.body.kind === 'message')).toBe(false)

    await act(async () => open())
    await waitFor(() => expect(screen.queryByText(PREPARING)).toBeNull())
    expect(fake.posts.some((p) => p.body.kind === 'message')).toBe(true)
    expect(screen.getByText('考えています…')).toBeTruthy()

    // つながったセッションへの次の発言では出さない
    act(() => fake.last().push(status('e1', 'idle', 'end_turn')))
    await waitFor(() => expect(screen.queryByText('考えています…')).toBeNull())
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const realPost = fake.api.post
    fake.api.post = vi.fn(async (...args: Parameters<typeof realPost>) => {
      await gate
      return realPost(...args)
    })
    await typeAndSend('続けて')
    // 送信の間は送るボタンが処理中の形になり、「送っています…」の文は出さない
    const busy = screen.getByRole('button', { name: '送信中' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(SENDING)).toBeNull()
    expect(screen.queryByText(PREPARING)).toBeNull()
    await act(async () => release())
    expect(fake.api.create).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Enter(Mac は ⌘+Enter)で送り、Enter だけでは送らない', async () => {
    const { store, fake } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '質問です' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(fake.api.create).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => expect(fake.posts.some((p) => p.body.kind === 'message')).toBe(true))
    expect(box().value).toBe('')
  })

  it('送れなかった(429)ときはサーバーの文を出し、入力欄に文を戻す', async () => {
    const { store, fake } = setup()
    fake.api.create = vi.fn(async () => {
      throw new ClaudeRequestError(429, '今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください')
    })
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('こんにちは')
    expect(await screen.findByText('今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください')).toBeTruthy()
    await waitFor(() => expect(box().value).toBe('こんにちは'))
  })

  it('ツールの動きを出し、結果を待つ間は送れず、終わると送れる。止めるも出る', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { store, fake } = setup({
      runTool: async (name, input, signal): Promise<ToolOutcome> => {
        await gate
        return runTool(name, input, chatToolDeps, signal)
      },
    })
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('便を探して')
    act(() => {
      fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'search_trips', input: { scope: 'base_weekday', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 5 } })
    })
    await screen.findByText('便を探しています…')
    fireEvent.change(box(), { target: { value: '続けて' } })
    await waitFor(() => expect(sendButton().disabled).toBe(true))
    expect(screen.getByText(TOOLS_WAITING)).toBeTruthy()
    expect(screen.getByRole('button', { name: '止める' })).toBeTruthy()
    release()
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(screen.getByText('便を探しました')).toBeTruthy()
    expect(screen.queryByText(TOOLS_WAITING)).toBeNull()
  })

  it('止めるを押すと、interrupt を送る', async () => {
    const { store, fake } = setup({
      runTool: (_name, _input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('止めました', 'AbortError')))),
    })
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('影響を見せて')
    act(() => {
      fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'summarize_impact', input: { date: null, step_hours: null } })
    })
    const stop = await screen.findByRole('button', { name: '止める' })
    await act(async () => {
      fireEvent.click(stop)
    })
    expect(fake.posts.filter((p) => p.body.kind === 'interrupt')).toHaveLength(1)
    // サーバーが、止めた後の idle を interrupted で知らせると、止める表示は消えて「止めました」が出る
    act(() => {
      fake.last().push(status('e1', 'idle', 'interrupted'))
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: '止める' })).toBeNull())
    expect(within(screen.getByRole('list', { name: '会話' })).getByText('止めました')).toBeTruthy()
  })

  it('AI がツールを使いすぎて止めたら、知らせを1件だけ出し、「続きを頼む」で続きを送る(指摘15.2)', async () => {
    const { store, fake } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('便を全部調べて')
    const stopped = 'AI がこの相談でツールを 12 回使ったので、ここで止めました。続けるときは「続きを頼む」を押してください'
    act(() => {
      fake.last().push(
        { type: 'error', id: 'e1', message: stopped, code: 'too_many_tool_calls' },
        { type: 'error', id: 'e2', message: stopped, code: 'too_many_tool_calls' },
        { type: 'error', id: 'e3', message: stopped, code: 'too_many_tool_calls' },
        status('e4', 'idle', 'interrupted'),
      )
    })
    const list = screen.getByRole('list', { name: '会話' })
    const button = (await within(list).findByRole('button', { name: '続きを頼む' })) as HTMLButtonElement
    await waitFor(() => expect(store.getState().replying).toBe(false))
    expect(within(list).getAllByText(stopped)).toHaveLength(1)
    expect(within(list).queryByText('止めました')).toBeNull()
    // 送っている間は押せない
    act(() => store.setState({ sending: true }))
    expect(button.disabled).toBe(true)
    act(() => store.setState({ sending: false }))
    expect(button.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button)
    })
    const sent = fake.posts.filter((p) => p.body.kind === 'message').at(-1)!.body as Extract<SessionPostBody, { kind: 'message' }>
    expect(sent.content).toEqual([
      { type: 'text', text: '[画面の操作] 利用者が、止まった作業の続きを頼みました。' },
      { type: 'text', text: '続けてください。' },
    ])
    // 続きを頼んだら、ボタンは消える
    await waitFor(() => expect(within(list).queryByRole('button', { name: '続きを頼む' })).toBeNull())
    expect(within(list).getByText('続きを頼みました。')).toBeTruthy()
    expect(within(list).getByText('続けてください。')).toBeTruthy()
  })

  it('上限に達したら入力欄を閉じて上限の文を出し、「新しく始める」で入力欄が戻る', async () => {
    const { store, fake } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('こんにちは')
    act(() => {
      fake.last().push({ type: 'usage', id: 'e1', costCents: 300, budgetCents: 300 }, status('e2', 'idle', 'budget_reached'))
    })
    expect(await screen.findByText(budgetReachedMessage(300))).toBeTruthy()
    expect(screen.queryByLabelText('AI への指示や質問')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '新しく始める' }))
    expect(await screen.findByLabelText('AI への指示や質問')).toBeTruthy()
    expect(screen.getByText(/AI との会話を新しく始めます/)).toBeTruthy()
  })

  it('「AI に送る情報」に、送った中身を時刻つきで残す。折りたたみ', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    const details = screen.getByText(/AI に送る情報/).closest('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('まだ何も送っていません')
    await typeAndSend('こんにちは')
    const log = within(details).getByRole('list', { name: '送った情報' })
    expect(log.textContent).toContain('09:30:00')
    expect(log.textContent).toContain('利用者の文')
    expect(log.textContent).toContain('こんにちは')
    expect(log.textContent).toContain('画面の状態・操作の行')
    expect(screen.getByText(/AI に送る情報\(1 回\)/)).toBeTruthy()
  })

  it('つなぎ直している間は「つなぎ直しています…」を出す', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() => store.setState({ connection: 'reconnecting' }))
    expect(screen.getByText('つなぎ直しています…')).toBeTruthy()
  })

  it('調査の進み具合を出す(11/5 は表示の口だけ)', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() => store.setState({ research: { active: true, openRuns: ['r1'], phase: '検索', paused: false, saved: 3, total: 12, delegated: 0, outcome: null } }))
    expect(screen.getByText('調べています 3 / 12 件(検索)')).toBeTruthy()
    expect(screen.getByText('調査の間はこの画面を開いたままにしてください。')).toBeTruthy()
  })

  it('下書きの知らせに「編集で確かめる」が付く。タブは勝手に切り替えず、押すと「編集」のタブでその手順が開き、欄に焦点が移る', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const { store, fake } = setup()
    render(
      <>
        <ChatPanel store={store} />
        <StepPanels />
      </>,
    )
    await waitFor(() => expect(box().disabled).toBe(false))
    await typeAndSend('土曜ダイヤにして')
    expect(useSidePanelStore.getState().tab).toBe('chat')
    // 送ったあとで「編集」のタブに戻った利用者がいる。AI が下書きを作っても、「AI に相談」には切り替えない
    act(() => useSidePanelStore.getState().show('edit'))
    act(() => {
      fake.last().push({ type: 'tool_call', id: 'sevt_1', name: 'apply_policy', input: POLICY_INPUT })
    })
    // 開く手順の番号と名前は手順の一覧(steps/registry.ts)の並びから出し、ボタンの説明にする
    const jump = await screen.findByRole('button', { name: '編集で確かめる' })
    expect(jump.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(jump.getAttribute('aria-describedby')!)?.textContent).toBe('開く手順:「3. 減便の方針」')
    expect(screen.getByText('下書き #1 を作りました。確かめて承認してください。')).toBeTruthy()
    // 知らせは札(Card)で、名前「下書き #1」と、承認待ちの間は中身の要約を出す
    const card = jump.closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('下書き #1')).toBeTruthy()
    expect(within(card).getByText('承認待ち')).toBeTruthy()
    expect(card.textContent).toContain('減便の方針:平日を土曜ダイヤに')
    expect(useSidePanelStore.getState().tab).toBe('edit')
    // まだ読み込みの手順を開いていて、方針の手順は隠れている
    expect(useStepStore.getState().current).toBe('load')
    expect(screen.queryByRole('heading', { name: '3. 減便の方針' })).toBeNull()
    act(() => useSidePanelStore.getState().show('chat'))
    fireEvent.click(jump)
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(useStepStore.getState().current).toBe('policy')
    expect(screen.getByRole('heading', { name: '3. 減便の方針' })).toBeTruthy()
    expect(scroll).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('step-policy')
  })

  it('会話のスクロールが端に着いても、左の欄やページに伝わらない(overscroll-behavior: contain)', () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    expect(screen.getByRole('log', { name: 'AI との会話' }).className).toContain('overscroll-contain')
  })
})

describe('会話の見た目(吹き出し・入力欄・例文の札)', () => {
  it('会話が空のときは例文の札を出し、押すと入力欄に入って焦点が移る。送らない', async () => {
    const { store, fake } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    const group = screen.getByRole('group', { name: /例文/ })
    const chips = within(group).getAllByRole('button')
    expect(chips.length).toBeGreaterThanOrEqual(2)
    expect(chips.length).toBeLessThanOrEqual(3)
    const example = '平日を土曜ダイヤにしてください。期間は 11/9 から当面の間'
    fireEvent.click(within(group).getByRole('button', { name: example }))
    expect(box().value).toBe(example)
    expect(document.activeElement).toBe(box())
    // 押しただけでは送らない
    await act(async () => undefined)
    expect(fake.api.create).not.toHaveBeenCalled()
    expect(fake.posts).toHaveLength(0)
    expect(store.getState().items).toHaveLength(0)
    // 札は submit ではない(フォームを送らない)
    for (const chip of chips) expect((chip as HTMLButtonElement).type).toBe('button')
  })

  it('例文の札を押しても、書きかけの文は消さない', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '書きかけの質問' } })
    const group = screen.getByRole('group', { name: /例文/ })
    fireEvent.click(within(group).getAllByRole('button')[0])
    expect(box().value).toBe('書きかけの質問')
    expect(document.activeElement).toBe(box())
  })

  it('例文の札と案内は、会話の箱(role=log)の外に出す', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    const log = screen.getByRole('log', { name: 'AI との会話' })
    expect(log.contains(screen.getByRole('group', { name: /例文/ }))).toBe(false)
    expect(log.contains(screen.getByText('減便の方針の指示や質問を送れます'))).toBe(false)
  })

  it('減便の方針が無いうちは方針の例文、方針を承認したら(または下書きがあれば)平日に戻す候補と影響の例文を出す', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    const labels = () => within(screen.getByRole('group', { name: /例文/ })).getAllByRole('button').map((b) => b.textContent)
    expect(labels().every((t) => t?.startsWith('平日を'))).toBe(true)
    act(() => useEditStore.setState({ draft: { kind: 'undo', id: '1', by: 'user', result: null, diff: null } }))
    expect(labels()).toHaveLength(2)
    expect(labels().some((t) => t?.includes('平日に戻した'))).toBe(true)
    expect(labels().some((t) => t?.includes('到達圏から外れる区画'))).toBe(true)
  })

  it('返答の途中でツールの行が加わっても、入力中の点は1組だけ出す', async () => {
    const { store } = setup()
    const { container } = render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() =>
      store.setState({
        replying: true,
        items: [
          { id: 1, kind: 'assistant', messageId: 'm1', text: '調べます', streaming: true },
          { id: 2, kind: 'tool', callId: null, name: 'search_trips', label: '便を探しています…', status: 'running' },
        ],
      }),
    )
    expect(container.querySelectorAll('[data-slot="typing-dots"]')).toHaveLength(1)
    expect(container.querySelector('[data-kind="assistant"] [data-slot="typing-dots"]')).toBeNull()
  })

  it('発言があると例文の札は出さない', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() => store.setState({ items: [{ id: 1, kind: 'notice', text: 'お知らせ' }] }))
    expect(screen.queryByRole('group', { name: /例文/ })).toBeNull()
  })

  it('送るボタンはアイコンで、読み上げの名前は「送る」。入力欄と同じ枠に入る', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    const button = sendButton()
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    const composer = box().closest('[data-slot="composer"]')!
    expect(composer).toBeTruthy()
    expect(composer.contains(button)).toBe(true)
  })

  it('入力欄は文の長さに合わせて高さが伸び、上限を超えたら中でスクロールする', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    // jsdom は高さを計算しないので、伸びる仕組み(field-sizing: content)と上限・手での変更なしのクラスを確かめる
    const cls = box().className.split(/\s+/)
    expect(cls).toContain('field-sizing-content')
    expect(cls).toContain('max-h-[min(10rem,25dvh)]')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).toContain('resize-none')
  })

  it('考えている間は入力中の点を出し、返答が流れている間は吹き出しの中に出す。点は読み上げず、動きを減らす設定では動かさない', async () => {
    const { store } = setup()
    const { container } = render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() => store.setState({ replying: true }))
    const status = screen.getByText('考えています…')
    expect(status.getAttribute('role')).toBe('status')
    const dots = container.querySelectorAll('[data-slot="typing-dots"]')
    expect(dots).toHaveLength(1)
    expect(dots[0].getAttribute('aria-hidden')).toBe('true')
    // 3つの点は、ずらして(animation-delay を style で。クラスだと animation の一括指定で 0s に戻る)順に弾む
    const animated = [...dots[0].children] as HTMLElement[]
    expect(animated).toHaveLength(3)
    for (const dot of animated) {
      expect(dot.className).toContain('motion-safe:animate-bounce')
      expect(dot.className).not.toMatch(/(^|\s)animate-bounce/)
    }
    expect(new Set(animated.map((d) => d.style.animationDelay)).size).toBe(3)

    act(() => store.setState({ items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日', streaming: true }] }))
    const bubble = container.querySelector('[data-kind="assistant"]')!
    expect(bubble.querySelectorAll('[data-slot="typing-dots"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="typing-dots"]')).toHaveLength(1)
    expect(screen.getByText('考えています…')).toBeTruthy()

    act(() => store.setState({ replying: false, items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日です', streaming: false }] }))
    expect(container.querySelectorAll('[data-slot="typing-dots"]')).toHaveLength(0)
    expect(screen.queryByText('考えています…')).toBeNull()
  })

  it('利用者の発言は右寄せの濃い色の吹き出し、AI の発言はアイコンつき。名前は「あなた」「AI」', async () => {
    const { store } = setup()
    const { container } = render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() =>
      store.setState({
        items: [
          { id: 1, kind: 'user', text: '質問です', at: '2026-11-04T09:30:00+09:00' },
          { id: 2, kind: 'assistant', messageId: 'm1', text: '**答え**です', streaming: false },
        ],
      }),
    )
    const user = container.querySelector('[data-kind="user"]')!
    expect(user.textContent).toBe('あなた質問です')
    expect(within(user as HTMLElement).getByText('質問です').className).toContain('bg-primary')
    const ai = container.querySelector('[data-kind="assistant"]')!
    expect(ai.textContent).toContain('AI')
    expect(ai.querySelector('svg')).toBeTruthy()
    expect(within(ai as HTMLElement).getByText('答え', { selector: 'strong' })).toBeTruthy()
  })

  it('下書きの札は、承認待ちの間だけ「承認待ち」と中身の要約を出す', async () => {
    const { store } = setup()
    render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() => useEditStore.setState({ draft: { kind: 'undo', id: '2', by: 'claude', result: null, diff: null } }))
    act(() => store.setState({ items: [{ id: 1, kind: 'draft', draftId: '2', text: '下書き #2 を作りました。確かめて承認してください。', step: 'policy' }] }))
    const card = screen.getByRole('button', { name: '編集で確かめる' }).closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('下書き #2')).toBeTruthy()
    expect(within(card).getByText('承認待ち')).toBeTruthy()
    expect(within(card).getByText('編集を取り消す(元に戻す)')).toBeTruthy()
    act(() => useEditStore.setState({ draft: null }))
    expect(within(card).queryByText('承認待ち')).toBeNull()
    expect(within(card).queryByText('編集を取り消す(元に戻す)')).toBeNull()
  })

  it('ツールの状態は、アイコンと文字で示す。エラーは目立つ知らせ(role=alert)にする', async () => {
    const { store } = setup()
    const { container } = render(<ChatPanel store={store} />)
    await waitFor(() => expect(box().disabled).toBe(false))
    act(() =>
      store.setState({
        items: [
          { id: 1, kind: 'tool', callId: 'c1', name: 'search_trips', label: '便を探しています…', status: 'running' },
          { id: 2, kind: 'tool', callId: 'c2', name: 'search_trips', label: '便を探しています…', status: 'done' },
          { id: 3, kind: 'tool', callId: 'c3', name: 'run_validation', label: '検証しています…', status: 'error' },
          { id: 4, kind: 'tool', callId: 'c4', name: 'run_validation', label: '検証しています…', status: 'skipped' },
          { id: 5, kind: 'error', text: '送れませんでした' },
        ],
      }),
    )
    const tools = container.querySelectorAll('[data-kind="tool"]')
    expect([...tools].map((t) => t.textContent)).toEqual([
      '便を探しています…',
      '便を探しました',
      '検証しています(うまくいきませんでした)',
      '検証しています(行いませんでした)',
    ])
    for (const t of tools) expect(t.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(within(container.querySelector('[data-kind="error"]') as HTMLElement).getByRole('alert').textContent).toBe('送れませんでした')
  })
})

describe('左の欄のタブの列の位置', () => {
  // jsdom は配置を計算しないので、クラスで確かめる(実際の位置はブラウザで確かめた)
  for (const wide of [true, false]) {
    it(`タブを切り替えても、タブの列の位置は変わらない(${wide ? '地図を隠す広い手順では中央にそろえる' : '地図を出す手順'})`, async () => {
      const { store } = setup()
      render(<SidePanel wide={wide} chatStore={store} />)
      const list = () => screen.getByRole('tablist', { name: '左の欄の表示' })
      const classes = () => [list().parentElement!.className, list().className]
      const onEdit = classes()
      if (wide) expect(onEdit[0]).toContain('justify-center')
      act(() => useSidePanelStore.getState().show('chat'))
      expect(classes()).toEqual(onEdit)
      await waitFor(() => expect(box().disabled).toBe(false))
    })
  }
})

describe('AI に候補を聞く', () => {
  it('AI が使えるときだけ押せる。押すと候補を選ぶ依頼を送る', async () => {
    const { store, fake } = setup()
    render(<AskRestoreButton store={store} />)
    const button = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    // 状態を確かめている間は押せない
    expect(button.disabled).toBe(true)
    await waitFor(() => expect(button.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(button)
    })
    const message = fake.posts.find((p) => p.body.kind === 'message')!.body as Extract<SessionPostBody, { kind: 'message' }>
    expect(message.content.at(-1)).toEqual({ type: 'text', text: ASK_RESTORE_PROMPT })
  })

  it('押すと、左の欄が「AI に相談」のタブに切り替わる', async () => {
    const { store } = setup()
    render(
      <>
        <AskRestoreButton store={store} />
        <ChatPanel store={store} active={false} />
      </>,
    )
    const button = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    expect(useSidePanelStore.getState().tab).toBe('edit')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(useSidePanelStore.getState().tab).toBe('chat')
  })

  it('AI が使えない・合言葉が無い・ツールを実行している・上限に達したときは押せず、理由を出す', async () => {
    const unavailable = setup({}, { available: false, tokenRequired: false })
    const first = render(<AskRestoreButton store={unavailable.store} />)
    await screen.findByText(/AI は使えません/)
    expect((screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement).disabled).toBe(true)
    first.unmount()

    const needToken = setup({}, { available: true, tokenRequired: true })
    const second = render(<AskRestoreButton store={needToken.store} />)
    await screen.findByText(/認証コードを入れると使えます/)
    expect((screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement).disabled).toBe(true)
    second.unmount()

    const ready = setup()
    render(<AskRestoreButton store={ready.store} />)
    const button = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    act(() => ready.store.setState({ toolRunning: true }))
    expect(button.disabled).toBe(true)
    expect(screen.getByText(TOOLS_WAITING)).toBeTruthy()
    act(() => ready.store.setState({ toolRunning: false, budgetReached: true }))
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/上限/)).toBeTruthy()
  })

  it('送信の間は処理中のボタンになり、「送っています…」の文を出さない。送り終えたら元の名前に戻る', async () => {
    const { store, fake } = setup()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const realPost = fake.api.post
    fake.api.post = vi.fn(async (...args: Parameters<typeof realPost>) => {
      await gate
      return realPost(...args)
    })
    render(<AskRestoreButton store={store} />)
    const button = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    await act(async () => {
      fireEvent.click(button)
    })
    const busy = screen.getByRole('button', { name: '送信中' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(SENDING)).toBeNull()
    await act(async () => release())
    await waitFor(() => expect(screen.getByRole('button', { name: 'AI に候補を聞く' })).toBeTruthy())
    expect(fake.posts.some((p) => p.body.kind === 'message')).toBe(true)
  })

  it('押したボタンだけを処理中にする。「送る」で送っている間、「AI に候補を聞く」は押せないが処理中の形にはしない(逆も同じ)', async () => {
    const { store, fake } = setup()
    let release: () => void = () => undefined
    let gate = new Promise<void>((r) => (release = r))
    const realPost = fake.api.post
    fake.api.post = vi.fn(async (...args: Parameters<typeof realPost>) => {
      await gate
      return realPost(...args)
    })
    render(
      <>
        <ChatPanel store={store} />
        <AskRestoreButton store={store} />
      </>,
    )
    const ask = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(ask.disabled).toBe(false))

    // 「送る」で送る:押した「送る」だけが処理中になる
    await typeAndSend('続けて')
    expect(screen.getByRole('button', { name: '送信中' }).getAttribute('aria-busy')).toBe('true')
    expect(ask.disabled).toBe(true)
    expect(ask.getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('button', { name: 'AI に候補を聞く' })).toBe(ask)
    // 押せない理由(送っている)は「AI に候補を聞く」の下に出す
    expect(screen.getByText(SENDING)).toBeTruthy()
    await act(async () => release())
    await waitFor(() => expect(ask.disabled).toBe(false))
    expect(screen.queryByRole('button', { name: '送信中' })).toBeNull()

    // 「AI に候補を聞く」で送る:「送る」は処理中の形にしない
    gate = new Promise<void>((r) => (release = r))
    await act(async () => {
      fireEvent.click(ask)
    })
    expect(ask.getAttribute('aria-busy')).toBe('true')
    expect(sendButton().getAttribute('aria-busy')).toBeNull()
    expect(sendButton().disabled).toBe(true)
    await act(async () => release())
    await waitFor(() => expect(screen.getByRole('button', { name: 'AI に候補を聞く' }).getAttribute('aria-busy')).toBeNull())
  })

  it('ほかの処理(前提情報の調査など)で送っている間は、2つのボタンとも押せないが処理中の形にはしない', async () => {
    const { store } = setup()
    render(
      <>
        <ChatPanel store={store} />
        <AskRestoreButton store={store} />
      </>,
    )
    const ask = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(ask.disabled).toBe(false))
    fireEvent.change(box(), { target: { value: '質問です' } })
    act(() => store.setState({ sending: true }))
    expect(ask.disabled).toBe(true)
    expect(ask.getAttribute('aria-busy')).toBeNull()
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByRole('button', { name: '送信中' })).toBeNull()
  })

  it('外から渡した理由(方針の下書きの確認中など)でも押せなくする', async () => {
    const { store } = setup()
    render(<AskRestoreButton store={store} blocked="減便の方針の下書きを承認するか、やめてから聞いてください。" />)
    const button = screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    await waitFor(() => expect(screen.getByText('減便の方針の下書きを承認するか、やめてから聞いてください。')).toBeTruthy())
    expect(button.disabled).toBe(true)
  })
})

describe('AI の返答の整え', () => {
  it('太字と箇条書きだけを整え、改行を保つ。HTML は文字のまま出す', () => {
    const { container } = render(<SimpleMarkdown text={'**大事**です\n続き\n\n- 一つ目\n* 二つ目\n<b>タグ</b>'} />)
    expect(container.querySelectorAll('strong')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('br')).toBeTruthy()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>タグ</b>')
  })
})
