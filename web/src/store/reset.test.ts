import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { fakeApi } from '../claude/session.fixture'
import { basePlan, smallFeed } from '../gtfs/edit/form2.fixture'
import type { EditOp } from '../gtfs/edit/ops'
import type { GtfsFeed } from '../gtfs/load'
import { DEFAULT_REACH_PARAMS, type ReachInput, type ReachResult } from '../reach/reach'
import { RELOAD_NOTICE, useChatStore } from './chat'
import { draftName, useEditStore } from './edit'
import { useGtfsStore } from './gtfs'
import { useHolidayStore } from './holidays'
import { useMapStore } from './map'
import { DEFAULT_PRIORITY_ORDER, usePriorityStore } from './priority'
import { REACH_VIEW_DEFAULTS, useReachStore } from './reach'
import { useResearchStore } from './research'
import { resetAll } from './reset'
import { useSidePanelStore } from './sidePanel'
import { STEP_KEYS, useStepStore } from './steps'

// 本物の useChatStore(本物の useEditStore を見張る)を使い、中継(セッションの API)だけを偽物にする。
// 到達圏の計算(Web Worker)は、テストごとに差し替えられるようにする
const mocks = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof fakeApi>,
  compute: null as null | ((input: ReachInput) => Promise<ReachResult>),
}))
vi.mock('../claude/session', async (importOriginal) => {
  const { fakeApi } = await import('../claude/session.fixture')
  mocks.fake = fakeApi()
  return { ...(await importOriginal<typeof import('../claude/session')>()), createSessionApi: () => mocks.fake.api }
})
vi.mock('../reach/workerClient', () => ({
  computeReachInWorker: (input: ReachInput) => (mocks.compute ? mocks.compute(input) : new Promise(() => {})),
}))
vi.mock('../reach/refData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reach/refData')>()),
  fetchRefData: async (mesh1s: string[]) => ({ ok: false, mesh1s, missing: mesh1s, message: '参照データがありません(テスト)。' }),
}))

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: null, note: '' } }
}

const originalReset = useChatStore.getState().reset

/** GTFS を読み込み、方針を承認し、もう1つ下書きを作り、到達圏・地図・運行の前提・周辺の施設の調査・会話・手順・タブを動かした状態にする */
function loadAndWork() {
  const feed = smallFeed()
  useGtfsStore.getState().setLoaded({ label: 'test.zip', feed, size: 2048, loadedAt: 1 })
  // 到達圏は計算させない(起点が無いので recompute はすぐ戻る)。塗り分けと時間帯は利用者が動かしたものとする
  useReachStore.setState({ source: { feed, stops: [], period: { start: '20261001', end: '20261130' } }, compareMode: 'after', selectedHour: 18 })
  const edit = useEditStore.getState()
  edit.setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
  expect(edit.propose(policy(), 'user').ok).toBe(true)
  expect(useEditStore.getState().commit()).toEqual({ ok: true })
  expect(useEditStore.getState().propose(policy(), 'user').ok).toBe(true)
  useEditStore.getState().setFeedVersion('20261104-1')
  useMapStore.getState().setHighlighted('school:1')
  useResearchStore.setState({
    facilities: { status: 'ready', key: '6442', facilities: [], sources: [] },
    selected: ['school:1'],
    demo: { status: 'ready', count: 1 },
  })
  useChatStore.setState({ items: [{ id: 1, kind: 'user', text: 'こんにちは' } as never], sentLog: [{ at: 'x' } as never] })
  expect(useStepStore.getState().go('policy')).toBe(true)
  useSidePanelStore.getState().show('chat')
}

beforeEach(() => {
  // GET /api/claude/status だけに答える(AI が使える・認証コードなし)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    String(input).endsWith('/api/claude/status') ? Response.json({ available: true, tokenRequired: false }) : new Response(null, { status: 404 }),
  )
})

afterEach(() => {
  useChatStore.setState({ reset: originalReset })
  resetAll('delete')
  useStepStore.setState({ order: STEP_KEYS, current: 'load' })
  mocks.fake.removed.length = 0
  mocks.compute = null
  vi.unstubAllGlobals()
})

/** 利用者が到達圏の条件と重要拠点の優先順位を変えた状態にする */
function changeSettings() {
  // setWalkMinutes などは計算し直しの時計を掛けるので、ここでは値だけを入れる
  const params = structuredClone(useReachStore.getState().params)
  params.walkMinutes.urban.bus = 3
  params.densityThreshold = 2000
  useReachStore.setState({ params, stepHours: 1, fallbackClass: 'rural' })
  const order = usePriorityStore.getState().order
  usePriorityStore.setState({ order: [...order].reverse() })
}

describe('resetAll(GTFS の削除と読み込み直しの初期化)', () => {
  it('削除:各 store を、画面を開いた直後と同じに戻す', () => {
    loadAndWork()
    const holidays = useHolidayStore.getState().holidays
    const reset = vi.fn(originalReset)
    useChatStore.setState({ reset })

    resetAll('delete')

    expect(useGtfsStore.getState()).toMatchObject({ feed: null, label: null, size: null, loadedAt: null, stops: [], servicePeriod: null })
    expect(useEditStore.getState()).toMatchObject({ base: null, history: [], versions: [], draft: null, draftNotices: [], feedVersion: '' })
    expect(useReachStore.getState()).toMatchObject({ source: null, edited: null, origins: null, date: null, snapshot: null, error: null, computing: false, ...REACH_VIEW_DEFAULTS })
    expect(useMapStore.getState().highlightedTargetId).toBeNull()
    expect(useResearchStore.getState()).toMatchObject({ facilities: { status: 'idle' }, selected: null, targets: null, demo: { status: 'idle' } })
    expect(useResearchStore.getState().results.size).toBe(0)
    // AI との会話を終える(reset はセッションを閉じ、DELETE を送る。store/chat.test.ts)。発言も知らせも残さない
    expect(reset).toHaveBeenCalled()
    expect(reset.mock.calls.at(-1)).toEqual([])
    expect(useChatStore.getState().items).toEqual([])
    expect(useChatStore.getState().sentLog).toEqual([])
    expect(useStepStore.getState().current).toBe('load')
    expect(useSidePanelStore.getState().tab).toBe('edit')
    // 読み込む前と同じく、読み込みより先の手順は開けない
    expect(useStepStore.getState().go('policy')).toBe(false)
    expect(useStepStore.getState().go('output')).toBe(false)
    // 祝日一覧は残す
    expect(useHolidayStore.getState().holidays).toBe(holidays)
  })

  it('削除:到達圏の条件(しきい値・分数・時間帯の幅・区分)と重要拠点の優先順位も、最初の値に戻す', () => {
    loadAndWork()
    changeSettings()
    resetAll('delete')
    expect(useReachStore.getState()).toMatchObject({ params: DEFAULT_REACH_PARAMS, stepHours: 3, fallbackClass: 'suburban' })
    // 戻した条件は初期値の写し(中を書き換えても初期値は変わらない)
    expect(useReachStore.getState().params).not.toBe(DEFAULT_REACH_PARAMS)
    expect(usePriorityStore.getState().order).toEqual(DEFAULT_PRIORITY_ORDER)
  })

  it('削除:下書きの番号も 1 から数え直す(読み込み直しでは続ける)', () => {
    loadAndWork()
    const before = Number(useEditStore.getState().draft?.id)
    expect(before).toBeGreaterThan(1)

    resetAll('reload')
    loadAndWork()
    expect(Number(useEditStore.getState().draft?.id)).toBeGreaterThan(before)

    resetAll('delete')
    loadAndWork()
    // 承認した方針が「下書き #1」、承認待ちの下書きが「下書き #2」
    expect(draftName(useEditStore.getState().draft!.id)).toBe('下書き #2')
  })

  it('読み込み直し:会話は「読み込み直したため…」の知らせを残して終える。地図の見せ方は戻し、利用者の設定は残す', () => {
    loadAndWork()
    changeSettings()
    const params = useReachStore.getState().params
    const order = usePriorityStore.getState().order
    resetAll('reload')
    expect(useEditStore.getState().base).toBeNull()
    expect(useChatStore.getState().items).toMatchObject([{ kind: 'notice', text: RELOAD_NOTICE }])
    expect(useStepStore.getState().current).toBe('load')
    expect(useSidePanelStore.getState().tab).toBe('edit')
    // 塗り分け・表示する時間帯・地図の強調は戻す
    expect(useReachStore.getState()).toMatchObject({ ...REACH_VIEW_DEFAULTS })
    expect(useMapStore.getState().highlightedTargetId).toBeNull()
    // 到達圏の条件と重要拠点の優先順位は残す(別の GTFS でも同じ条件で比べられるように)
    expect(useReachStore.getState()).toMatchObject({ params, stepHours: 1, fallbackClass: 'rural' })
    expect(usePriorityStore.getState().order).toBe(order)
  })

  it('読み込んでいなくても呼べる(何も変わらない)', () => {
    resetAll('delete')
    expect(useEditStore.getState().base).toBeNull()
    expect(useChatStore.getState().items).toEqual([])
  })

  it('デモの調査結果を読んでいる間に削除したら、読めた結果を入れない', async () => {
    let release: (v: never[]) => void = () => undefined
    const pending = useResearchStore.getState().loadDemo(new Set(['school:1']), () => new Promise((r) => (release = r)))
    expect(useResearchStore.getState().demo).toEqual({ status: 'loading' })
    resetAll('delete')
    release([{ targetId: 'school:1' } as never])
    expect(await pending).toBe(0)
    expect(useResearchStore.getState().demo).toEqual({ status: 'idle' })
    expect(useResearchStore.getState().results.size).toBe(0)
  })

  it('削除:本物の会話の store で、セッションの DELETE を1回だけ送り、発言も知らせも残さない', async () => {
    loadAndWork()
    useChatStore.setState({ items: [], sentLog: [] })
    expect(await useChatStore.getState().send('こんにちは')).toBe(true)
    const handle = mocks.fake.streams.at(-1)?.handle
    expect(handle).toBeTruthy()
    expect(mocks.fake.removed).toEqual([])

    resetAll('delete')
    expect(mocks.fake.removed).toEqual([handle])
    expect(useChatStore.getState().items).toEqual([])
    expect(useChatStore.getState().connection).toBe('none')
    // もう一度呼んでも、取っ手は捨ててあるので送らない
    resetAll('delete')
    expect(mocks.fake.removed).toEqual([handle])
  })

  it('読み込み直し:本物の会話の store で、セッションの DELETE を1回だけ送り、知らせだけを残す', async () => {
    loadAndWork()
    useChatStore.setState({ items: [], sentLog: [] })
    expect(await useChatStore.getState().send('こんにちは')).toBe(true)
    const handle = mocks.fake.streams.at(-1)?.handle

    resetAll('reload')
    expect(mocks.fake.removed).toEqual([handle])
    expect(useChatStore.getState().items).toMatchObject([{ kind: 'notice', text: RELOAD_NOTICE }])
    expect(useChatStore.getState().items).toHaveLength(1)
  })

  it('到達圏を計算している間に削除したら、その結果を捨てる。次の GTFS では起点と分母を新しい GTFS から決め直す(追記3)', async () => {
    let finish: (r: ReachResult) => void = () => undefined
    const inputs: ReachInput[] = []
    mocks.compute = (input) => {
      inputs.push(input)
      return new Promise((r) => (finish = r))
    }
    const a = smallFeed()
    useGtfsStore.getState().setLoaded({ label: 'a.zip', feed: a })
    useReachStore.getState().setSource({ feed: a, stops: useGtfsStore.getState().stops, period: useGtfsStore.getState().servicePeriod })
    await vi.waitFor(() => expect(inputs).toHaveLength(1))
    expect(useReachStore.getState().computing).toBe(true)

    resetAll('delete')
    finish({ cells: [] } as never)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(useReachStore.getState()).toMatchObject({ source: null, snapshot: null, computing: false, origins: null })

    // 別の GTFS(停留所の ID が違う)を読み込む
    const b = renameStops(smallFeed(), 'B_')
    useGtfsStore.getState().setLoaded({ label: 'b.zip', feed: b })
    useReachStore.getState().setSource({ feed: b, stops: useGtfsStore.getState().stops, period: useGtfsStore.getState().servicePeriod })
    const ids = useReachStore.getState().origins?.stops.map((s) => s.id) ?? []
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id.startsWith('B_'))).toBe(true)
  })
})

/** 停留所の ID に接頭辞を付けた写し(stops と stop_times) */
function renameStops(feed: GtfsFeed, prefix: string): GtfsFeed {
  for (const name of ['stops', 'stop_times']) {
    const table = feed.tables.get(name)!
    for (const row of table.rows) row.stop_id = prefix + row.stop_id
  }
  return feed
}
