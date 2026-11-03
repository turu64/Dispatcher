// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchApi, ResearchOverview, ResearchResult, ResearchStartView } from '@/claude/research'
import { fakeApi } from '@/claude/session.fixture'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import type { Stop } from '@/gtfs/parse'
import { facilityMeshes, mergeFacilityFiles } from '@/ref/facilities'
import { createChatStore, RESEARCH_KEEP_OPEN, TOKEN_MISSING, type ChatStoreDeps, type TokenStorage } from '@/store/chat'
import { useGtfsStore } from '@/store/gtfs'
import { usePriorityStore } from '@/store/priority'
import { useReachStore } from '@/store/reach'
import { useResearchStore } from '@/store/research'
import ResearchStep, { RESEARCH_DEMO, RESEARCH_DEMO_NONE, RESEARCH_START, OWN_OPERATOR } from './ResearchStep'

// 停留所は旭川の近くの3つ。施設はその周り(範囲の外のものを1つ含む)。smallFeed の事業者は「テストバス」
const STOPS: Stop[] = [
  { id: 'S1', name: '停留所1', lat: 43.76, lon: 142.35, locationType: 0, parentStation: '' },
  { id: 'S2', name: '停留所2', lat: 43.78, lon: 142.37, locationType: 0, parentStation: '' },
  { id: 'S3', name: '停留所3', lat: 43.77, lon: 142.36, locationType: 0, parentStation: '' },
]

function item(targetId: string, kind: string, name: string, lat: number, lon: number, detail: Record<string, unknown> = {}) {
  return { target_id: targetId, kind, name, municipality: '旭川市', lat, lon, detail }
}

const FILE = {
  mesh1: '6442',
  facilities: [
    item('P04:hosp', 'hospital', 'テスト総合病院', 43.771, 142.361, { beds: 300 }),
    item('P04:clinic', 'clinic', 'テスト内科', 43.765, 142.355, { beds: 0 }),
    item('P29:high', 'school', 'テスト高等学校', 43.775, 142.36, { school_type: '高等学校', open_status: '開校中' }),
    item('P29:elem', 'school', 'テスト小学校', 43.77, 142.355, { school_type: '小学校' }),
    item('P29:far', 'school', '遠くの高校', 43.9, 142.36, { school_type: '高等学校' }),
    item('P11:テストバス', 'operator', 'テストバス', 43.77, 142.36, { stops: 50, bbox: [43.7, 142.3, 43.8, 142.4] }),
    item('P11:となりバス', 'operator', 'となりバス', 43.775, 142.365, { stops: 9, bbox: [43.77, 142.36, 43.79, 142.38] }),
  ],
  sources: ['国土数値情報を加工して作成'],
}

/** 既定で選ばれる対象(優先順位の種類から1件ずつ:病院、高校、診療所、最後に周辺の事業者) */
const DEFAULT_IDS = ['P04:hosp', 'P29:high', 'P04:clinic', 'P11:となりバス']

const HIGH_RESULT: ResearchResult = {
  targetId: 'P29:high',
  kind: 'school',
  name: 'テスト高等学校',
  status: 'found',
  facts: [{ label: '始業', value: '8時40分', source: 1 }],
  sources: [{ url: 'https://example.jp/high', title: '学校の案内' }],
  note: '冬は時刻が変わる',
  checkedAt: '2026-11-06T10:05:00+09:00',
  origin: 'web',
}

function memoryStorage(): TokenStorage {
  let value: string | null = null
  return { get: () => value, set: (t) => void (value = t) }
}

function setup(options: { tokenRequired?: boolean; start?: ResearchApi['start']; overview?: ResearchApi['overview'] } = {}) {
  const fake = fakeApi()
  const research: ResearchApi = {
    start: vi.fn(
      options.start ??
        (async (_token, _handle, ids): Promise<ResearchStartView> => ({
          targets: ids.map((id) => ({
            targetId: id,
            kind: 'school' as const,
            name: id,
            municipality: null,
            lat: 43.77,
            lon: 142.36,
            // 高校は保存済み
            cached: id === 'P29:high' ? { status: 'found' as const, checkedAt: '2026-11-06T10:05:00+09:00', facts: 1 } : null,
          })),
          total: ids.length,
          maxTargets: 30,
        })),
    ),
    overview: vi.fn(
      options.overview ??
        (async (): Promise<ResearchOverview> => ({ targets: [], total: 0, maxTargets: 30, results: [HIGH_RESULT], missing: [], saved: 1 })),
    ),
  }
  const deps: ChatStoreDeps = {
    fetchStatus: async () => ({ available: true, tokenRequired: options.tokenRequired ?? false }),
    api: fake.api,
    research,
    runTool: async () => ({ content: '{}', isError: false }),
    screen: () => ({ today: '20261104', gtfs: null, reach: null }),
    edits: () => ({ history: [], versions: [] }) as unknown as ReturnType<ChatStoreDeps['edits']>,
    takeDraftNotices: () => [],
    storage: memoryStorage(),
    now: () => new Date('2026-11-04T00:30:00Z'),
    session: { sleep: async () => undefined, batchDelayMs: 0 },
  }
  const chat = createChatStore(deps)
  render(<ResearchStep chat={chat} />)
  return { chat, research, fake }
}

/** その要素の文に text が含まれる(括弧を含む文を正規表現にしないため) */
function includes(text: string) {
  return (content: string) => content.includes(text)
}

function checkedNames(): string[] {
  const list = screen.getByRole('group', { name: '調べる対象の候補' })
  return within(list)
    .getAllByRole('checkbox', { hidden: true })
    .filter((c) => (c as HTMLInputElement).checked)
    .map((c) => c.getAttribute('aria-label') ?? '')
}

beforeEach(() => {
  act(() => {
    useGtfsStore.setState({ feed: smallFeed(), stops: STOPS })
    useReachStore.setState({ origins: { stops: STOPS, unused: 0, nonStop: 0, noBoarding: 0 } })
    const { facilities, sources } = mergeFacilityFiles([FILE])
    useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources } })
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    useGtfsStore.getState().clear()
    useReachStore.setState({ origins: null })
    useResearchStore.getState().reset()
    usePriorityStore.getState().reset()
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ResearchStep', () => {
  it('GTFS を読み込む前は案内だけ', () => {
    act(() => useGtfsStore.getState().clear())
    setup()
    expect(screen.getByText(/GTFS を読み込むと、周辺の事業者・学校・病院を調べられます/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: RESEARCH_START })).toBeNull()
  })

  it('停留所の周り 2km の候補を種類ごとにまとめ、既定で事業者と優先順位の上から選ぶ(自社と優先順位の外は選ばない)', () => {
    setup()
    const list = screen.getByRole('group', { name: '調べる対象の候補' })
    const groups = within(list).getAllByRole('group', { hidden: true }).map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['周辺のバス事業者', '入院設備のある病院', '高校・特別支援学校', '診療所', 'そのほかの学校(優先順位の外。小学校・幼稚園など)'])
    // 範囲の外の施設は出ない
    expect(screen.queryByText('遠くの高校')).toBeNull()
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト内科'])
    expect(screen.getByText(OWN_OPERATOR)).toBeTruthy()
    expect(screen.getByText(/選んだ対象/).textContent).toContain('4')
    // 出典(国土数値情報を加工した旨)
    expect(screen.getByText(includes('国土数値情報(バス停留所 P11・学校 P29・医療機関 P04)を加工して作成'))).toBeTruthy()
  })

  it('重要拠点の優先順位を並べ替えられ、データの無い種類は「データ未対応」と出す。並べ替えると既定の選び方が変わる', () => {
    act(() => useResearchStore.setState({ maxTargets: 1 }))
    setup()
    const priority = screen.getByRole('list', { name: '重要拠点の優先順位', hidden: true })
    const items = within(priority).getAllByRole('listitem', { hidden: true })
    expect(items).toHaveLength(10)
    expect(items[0].textContent).toContain('入院設備のある病院')
    expect(within(priority).getAllByText('データ未対応')).toHaveLength(4)
    expect(items[1].textContent).toContain('空港はデータ未対応')
    expect(checkedNames()).toEqual(['テスト総合病院'])

    // 高校・特別支援学校を2つ上げる(1位に)
    fireEvent.click(screen.getByRole('button', { name: '高校・特別支援学校を上へ', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: '高校・特別支援学校を上へ', hidden: true }))
    expect(within(priority).getAllByRole('listitem', { hidden: true })[0].textContent).toContain('高校・特別支援学校')
    expect(checkedNames()).toEqual(['テスト高等学校'])
    expect(screen.getByRole('button', { name: '既定の並びに戻す', hidden: true })).toBeTruthy()
  })

  it('まとまりの開閉は利用者が決め、最後の1件を外しても閉じない。外から選ばれたまとまりは開く', () => {
    setup()
    const group = (name: string) => screen.getByRole('group', { name, hidden: true }) as HTMLDetailsElement
    const setOpen = (name: string, open: boolean) => {
      const el = group(name)
      el.open = open
      fireEvent(el, new Event('toggle'))
    }
    const others = 'そのほかの学校(優先順位の外。小学校・幼稚園など)'
    // 選んだ対象の無いまとまりは閉じ、あるまとまりは開いている
    expect(group(others).open).toBe(false)
    expect(group('診療所').open).toBe(true)

    // 利用者が開いたまとまりで1件選び、外しても開いたまま
    setOpen(others, true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト小学校' }))
    expect(checkedNames()).toContain('テスト小学校')
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト小学校' }))
    expect(checkedNames()).not.toContain('テスト小学校')
    expect(group(others).open).toBe(true)

    // 最初から開いていたまとまりも、最後の1件を外して閉じない(同じまとまりの中で選び直せる)
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト内科' }))
    expect(checkedNames()).not.toContain('テスト内科')
    expect(group('診療所').open).toBe(true)

    // 利用者が閉じたまとまりは、外から選ばれる(既定の選び方に戻す)と開く
    setOpen('診療所', false)
    expect(group('診療所').open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '既定の選び方に戻す' }))
    expect(checkedNames()).toContain('テスト内科')
    expect(group('診療所').open).toBe(true)
  })

  it('上限より多くは選べない。選び直したら「既定の選び方に戻す」で戻せる', () => {
    act(() => useResearchStore.setState({ maxTargets: 4 }))
    setup()
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト小学校', hidden: true }))
    expect(screen.getByRole('alert').textContent).toContain('4 件まで')
    expect(checkedNames()).not.toContain('テスト小学校')

    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト内科', hidden: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト小学校', hidden: true }))
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト小学校'])
    fireEvent.click(screen.getByRole('button', { name: '既定の選び方に戻す' }))
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト内科'])
  })

  it('「前提情報を調べる」で、選んだ対象の target_id だけを送り、進み具合と結果(事実・出典 URL・確認日時・どこから来た結果か)を出す', async () => {
    const { chat, research } = setup()
    expect(screen.getByText(includes('調べる施設・事業者の名前と位置(国土数値情報)を送り、AI が Web で検索します'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))

    await waitFor(() => expect(research.start).toHaveBeenCalledTimes(1))
    expect(research.start).toHaveBeenCalledWith(null, 'h1', DEFAULT_IDS)
    // 進み具合:保存済み(高校)の 1 件から始まる
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('調べています 1 / 4 件'))
    expect(screen.getByText(RESEARCH_KEEP_OPEN)).toBeTruthy()
    // 「AI に送る情報」に、サーバーが会話に入れた行を残す
    expect(chat.getState().sentLog.at(-1)?.parts).toEqual([{ kind: 'screen', text: '[画面の操作] 利用者が前提情報の調査を始めました(対象 4 件)。' }])
    // 調査の間は、もう一度は押せない
    expect((screen.getByRole('button', { name: RESEARCH_START }) as HTMLButtonElement).disabled).toBe(true)

    // 始めた後と、保存が進んだときに、保存済みの結果を読む
    await waitFor(() => expect(research.overview).toHaveBeenCalled())
    const card = await screen.findByRole('listitem', { name: 'テスト高等学校の調査の結果' })
    expect(card.textContent).toContain('始業')
    expect(card.textContent).toContain('8時40分')
    expect(card.textContent).toContain('冬は時刻が変わる')
    expect(card.textContent).toContain('確認日時 2026年11月6日 10:05')
    expect(card.textContent).toContain('Web で調べた結果')
    const link = within(card).getByRole('link', { name: /学校の案内/ })
    expect(link.getAttribute('href')).toBe('https://example.jp/high')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    const calls = (research.overview as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => chat.setState({ research: { ...chat.getState().research, saved: 2 } }))
    await waitFor(() => expect((research.overview as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1))
  })

  it('合言葉が要るのに入れていなければ、セッションを作らずに理由を出す', async () => {
    const { research, fake } = setup({ tokenRequired: true })
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(TOKEN_MISSING))
    expect(screen.getByRole('alert').textContent).toContain('「AI に相談」の欄')
    expect(research.start).not.toHaveBeenCalled()
    expect(fake.api.create).not.toHaveBeenCalled()
  })

  it('取っ手が使えなくなっていたら(404)、1回だけ新しいセッションで始め直す', async () => {
    const { ClaudeRequestError } = await import('@/claude/sse')
    let first = true
    const { research, fake } = setup({
      start: async (_token, _handle, ids) => {
        if (first) {
          first = false
          throw new ClaudeRequestError(404, 'AI との会話が見つかりません。新しく始めます')
        }
        return { targets: [], total: ids.length, maxTargets: 30 }
      },
    })
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))
    await waitFor(() => expect(research.start).toHaveBeenCalledTimes(2))
    expect((research.start as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(['h1', 'h2'])
    expect(fake.api.create).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('調べています 0 / 4 件'))
  })

  it('始められなかったら、サーバーの理由を出す', async () => {
    const { ClaudeRequestError } = await import('@/claude/sse')
    setup({
      start: async () => {
        throw new ClaudeRequestError(400, '参照データに無い対象があります:P29:x')
      },
    })
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('参照データに無い対象があります'))
  })

  it('「保存済みの結果(デモ)を使う」は AI を呼ばずに保存済みの結果を出し、その対象を選ぶ(候補に無い対象は使わない)', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            target_id: 'P04:hosp',
            kind: 'hospital',
            name: 'テスト総合病院',
            municipality: '旭川市',
            lat: 43.771,
            lon: 142.361,
            status: 'partial',
            facts: [{ label: '外来の受付', value: '8時30分〜11時', source: 1 }],
            sources: [{ url: 'https://example.jp/hosp', title: '外来のご案内' }],
            note: '',
            checked_at: '2026-11-06T09:00:00+09:00',
            origin: 'demo',
          },
          {
            target_id: 'P29:far',
            kind: 'school',
            name: '遠くの高校',
            municipality: '旭川市',
            lat: 43.9,
            lon: 142.36,
            status: 'found',
            facts: [],
            sources: [{ url: 'https://example.jp/far', title: 'x' }],
            note: '',
            checked_at: '2026-11-06T09:00:00+09:00',
            origin: 'demo',
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { research, fake } = setup()
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_DEMO }))
    await waitFor(() => expect(screen.getByText(includes('保存済みの結果(デモ)1 件を出し、その対象を選びました'))).toBeTruthy())
    expect((fetchMock.mock.calls as unknown[][]).map((c) => c[0])).toEqual(['/api/research/demo'])
    expect(research.start).not.toHaveBeenCalled()
    expect(fake.api.create).not.toHaveBeenCalled()
    expect(checkedNames()).toEqual(['テスト総合病院'])
    const card = screen.getByRole('listitem', { name: 'テスト総合病院の調査の結果' })
    expect(card.textContent).toContain('デモ用の保存済みの結果')
    expect(card.textContent).toContain('一部だけ見つかった')
    expect(card.textContent).toContain('確認日時 2026年11月6日 09:00')
    // 保存済みの対象は調べ直さない旨
    expect(screen.getByText(/保存済みの対象は調べ直さず/)).toBeTruthy()
  })

  it('保存済みの結果(デモ)が無ければ、そう出す(選び方は変えない)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ results: [] })),
    )
    setup()
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_DEMO }))
    await waitFor(() => expect(screen.getByText(RESEARCH_DEMO_NONE)).toBeTruthy())
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト内科'])
  })

  it('施設の参照データを読めなければ、理由と「読み込み直す」を出す', async () => {
    act(() => useResearchStore.getState().reset())
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    setup()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('施設の参照データを読み込めませんでした(サーバーがエラーを返しました(500))'))
    expect(fetchMock).toHaveBeenCalledWith(`/api/ref/facilities/${facilityMeshes(STOPS)[0]}`)
    const calls = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls))
  })
})
