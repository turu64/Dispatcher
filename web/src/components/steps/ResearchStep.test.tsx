// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchApi, ResearchOverview, ResearchResult, ResearchStartView } from '@/claude/research'
import { fakeApi } from '@/claude/session.fixture'
import { applyForm2 } from '@/gtfs/edit/form2'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { Stop } from '@/gtfs/parse'
import { mergeBusstopFiles } from '@/ref/busstops'
import { facilityMeshes, mergeFacilityFiles } from '@/ref/facilities'
import { createChatStore, RESEARCH_KEEP_OPEN, TOKEN_MISSING, type ChatStoreDeps, type TokenStorage } from '@/store/chat'
import { useDriversStore } from '@/store/drivers'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { usePriorityStore } from '@/store/priority'
import { useReachStore } from '@/store/reach'
import { reducedStopsOf, useResearchStore } from '@/store/research'
import ResearchStep, {
  MOVEMENT_NONE,
  NOT_RESEARCHED_BADGE,
  NOT_RESEARCHED_TITLE,
  NO_BUSSTOP_DATA,
  NO_NEARBY_STOPS,
  OVERLAP_DISCLAIMER,
  REDUCED_AFTER_POLICY,
  REDUCED_NO_DATE,
  RESEARCH_DEMO,
  RESEARCH_DEMO_LOADING,
  RESEARCH_DEMO_NONE,
  RESEARCH_START,
  RESEARCH_STARTING,
  OWN_OPERATOR,
  OWN_OPERATOR_FIXED,
  PRIORITY_TITLE,
  RESEARCH_SUMMARY_TITLE,
  RESULT_ALL_LABEL,
} from './ResearchStep'

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
    // 種別が分からない学校(優先順位の外)
    item('P29:elem', 'school', 'テスト学校', 43.77, 142.355),
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
    registerKnown: vi.fn(async () => ({ registered: 0, total: 0 })),
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

/** 候補の行(チェックボックスの名前で探す) */
function rowOf(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name, hidden: true }).closest('li')!
}

/** 行の下に出す、調べた結果(開閉の details。名前は「◯◯の調査の結果」) */
function rowResult(name: string): HTMLDetailsElement {
  return within(rowOf(name)).getByRole('group', { name: `${name}の調査の結果`, hidden: true }) as HTMLDetailsElement
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
    useMapStore.getState().setHighlighted(null)
    useEditStore.setState({ base: null, history: [], versions: [], draft: null })
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ResearchStep', () => {
  it('GTFS を読み込む前は案内だけ', () => {
    act(() => useGtfsStore.getState().clear())
    setup()
    expect(screen.getByText(/GTFS を読み込むと、運行の前提.+を設定し、周辺の事業者・学校・病院を調べられます/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: RESEARCH_START })).toBeNull()
  })

  it('調査の欄の上に、運行の前提(営業所・運転士の数)の欄を出し、欠員・在籍の運転士の数を入れられる', () => {
    setup()
    const premise = screen.getByRole('region', { name: '運行の前提(営業所・運転士の数)' })
    const research = screen.getByRole('heading', { name: '周辺の事業者・施設の調査' })
    expect(premise.compareDocumentPosition(research) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(premise).getByTestId('places-editor')).toBeTruthy()
    fireEvent.change(within(premise).getByLabelText('欠員(その日に乗務できない運転士の数)'), { target: { value: '20' } })
    fireEvent.change(within(premise).getByLabelText('在籍の運転士の数'), { target: { value: '110' } })
    expect(useDriversStore.getState()).toMatchObject({ shortage: 20, roster: 110 })
    act(() => useDriversStore.getState().reset())
  })

  it('施設を読めないときも、運行の前提の欄は出す', () => {
    setup()
    act(() => useResearchStore.setState({ facilities: { status: 'error', key: facilityMeshes(STOPS).join(','), message: '施設を読み込めませんでした' } }))
    expect(screen.getByText('施設を読み込めませんでした')).toBeTruthy()
    expect(screen.getByRole('region', { name: '運行の前提(営業所・運転士の数)' })).toBeTruthy()
  })

  it('停留所の周り 2km の候補を種類ごとにまとめ、既定で事業者と優先順位の上から選ぶ(自社と優先順位の外は選ばない)', () => {
    setup()
    const list = screen.getByRole('group', { name: '調べる対象の候補' })
    const groups = within(list).getAllByRole('group', { hidden: true }).map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['周辺のバス事業者', '入院設備のある病院', '高校・特別支援学校', '診療所', 'そのほかの学校(優先順位の外。種別が分からないもの)'])
    // 範囲の外の施設は出ない
    expect(screen.queryByText('遠くの高校')).toBeNull()
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト内科'])
    expect(screen.getByText(OWN_OPERATOR)).toBeTruthy()
    expect(screen.getByText(/選んだ対象/).textContent).toContain('4')
    // 読み込んだ GTFS の事業者のチェックボックスは、変更できない「-」(indeterminate)で、選んだ数に入れない
    const own = screen.getByRole('checkbox', { name: 'テストバス', hidden: true }) as HTMLInputElement
    expect(own.disabled).toBe(true)
    expect(own.indeterminate).toBe(true)
    expect(own.getAttribute('title')).toBe(OWN_OPERATOR_FIXED)
    act(() => useResearchStore.getState().setSelected(['P11:テストバス', 'P04:hosp']))
    expect(checkedNames()).toEqual(['テスト総合病院'])
    expect(screen.getByText(/選んだ対象/).textContent).toContain('1')
    // 出典(国土数値情報を加工した旨)
    expect(screen.getByText(includes('国土数値情報(バス停留所 P11・学校 P29・医療機関 P04)を加工して作成'))).toBeTruthy()
  })

  it('重要拠点の優先順位は、欄に今の順の要約とボタンを出し、Dialog の中で並べ替えられる。データの無い種類は「データ未対応」と出す。並べ替えると既定の選び方が変わる', async () => {
    act(() => useResearchStore.setState({ maxTargets: 1 }))
    setup()
    expect(screen.getByTestId('priority-summary').textContent).toBe('優先する順:1 入院設備のある病院、2 鉄道駅・空港、3 高校・特別支援学校 ほか 6 種類')
    // 並べ替えの一覧は Dialog の中だけ(閉じている間は出さない)
    expect(screen.queryByRole('list', { name: PRIORITY_TITLE, hidden: true })).toBeNull()
    const trigger = screen.getByRole('button', { name: PRIORITY_TITLE })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: PRIORITY_TITLE })
    const priority = within(dialog).getByRole('list', { name: PRIORITY_TITLE })
    const items = within(priority).getAllByRole('listitem')
    expect(items).toHaveLength(9)
    expect(items[0].textContent).toContain('入院設備のある病院')
    expect(within(priority).getAllByText('データ未対応')).toHaveLength(4)
    expect(items[1].textContent).toContain('空港はデータ未対応')
    expect((within(dialog).getByRole('button', { name: '既定の並びに戻す' }) as HTMLButtonElement).disabled).toBe(true)

    // 高校・特別支援学校を2つ上げる(1位に)。端に着いたら、焦点は下へのボタンに移る
    fireEvent.click(within(dialog).getByRole('button', { name: '高校・特別支援学校を上へ' }))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('高校・特別支援学校を上へ')
    fireEvent.click(within(dialog).getByRole('button', { name: '高校・特別支援学校を上へ' }))
    expect(within(priority).getAllByRole('listitem')[0].textContent).toContain('高校・特別支援学校')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('高校・特別支援学校を下へ')
    expect((within(dialog).getByRole('button', { name: '既定の並びに戻す' }) as HTMLButtonElement).disabled).toBe(false)

    // Escape で閉じ、開いたボタンに焦点が戻る。要約も今の順になる
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.getByTestId('priority-summary').textContent).toBe('優先する順:1 高校・特別支援学校、2 入院設備のある病院、3 鉄道駅・空港 ほか 6 種類(変更あり)')
    expect(checkedNames()).toEqual(['となりバス', 'テスト高等学校'])

    // 「既定の並びに戻す」で戻し、「閉じる」で閉じても焦点はボタンに戻る
    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '既定の並びに戻す' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院'])
  })

  it('重要拠点の優先順位は、行をドラッグして並べ替えられる(ほかの行の上に来たらその位置へ動かす)', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: PRIORITY_TITLE }))
    const dialog = screen.getByRole('dialog', { name: PRIORITY_TITLE })
    const rows = () => within(within(dialog).getByRole('list', { name: PRIORITY_TITLE })).getAllByRole('listitem')
    const order = () => rows().map((r) => r.getAttribute('data-testid'))
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {} }
    const before = order()
    const third = rows()[2]
    expect(third.getAttribute('draggable')).toBe('true')
    // 3番目(高校・特別支援学校)をつかんで、1番目の行の上へ
    fireEvent.dragStart(third, { dataTransfer })
    expect(third.getAttribute('aria-grabbed')).toBe('true')
    fireEvent.dragOver(rows()[0], { dataTransfer })
    expect(order()[0]).toBe(before[2])
    expect(order().slice(1, 3)).toEqual(before.slice(0, 2))
    fireEvent.drop(rows()[0], { dataTransfer })
    fireEvent.dragEnd(rows()[0], { dataTransfer })
    expect(rows().some((r) => r.getAttribute('aria-grabbed') === 'true')).toBe(false)
    expect(screen.getByTestId('priority-summary').textContent).toContain('1 高校・特別支援学校')
  })

  it('まとまりの開閉は利用者が決め、最後の1件を外しても閉じない。外から選ばれたまとまりは開く', () => {
    setup()
    const group = (name: string) => screen.getByRole('group', { name, hidden: true }) as HTMLDetailsElement
    const setOpen = (name: string, open: boolean) => {
      const el = group(name)
      el.open = open
      fireEvent(el, new Event('toggle'))
    }
    const others = 'そのほかの学校(優先順位の外。種別が分からないもの)'
    // 選んだ対象の無いまとまりは閉じ、あるまとまりは開いている
    expect(group(others).open).toBe(false)
    expect(group('診療所').open).toBe(true)

    // 利用者が開いたまとまりで1件選び、外しても開いたまま
    setOpen(others, true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト学校' }))
    expect(checkedNames()).toContain('テスト学校')
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト学校' }))
    expect(checkedNames()).not.toContain('テスト学校')
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

  it('上限(周辺のバス事業者を除く)より多くは選べない。選び直したら「既定の選び方に戻す」で戻せる', () => {
    act(() => useResearchStore.setState({ maxTargets: 3 }))
    setup()
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト学校', hidden: true }))
    expect(screen.getByRole('alert').textContent).toContain('3 件まで')
    expect(screen.getByText(/学校・病院など 3 \/ 3 件・周辺のバス事業者 1 件/)).toBeTruthy()
    expect(checkedNames()).not.toContain('テスト学校')

    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト内科', hidden: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'テスト学校', hidden: true }))
    expect(checkedNames()).toEqual(['となりバス', 'テスト総合病院', 'テスト高等学校', 'テスト学校'])
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
    // 結果は別のまとまりではなく、その施設の行の下に出す。行には要点(判断に使う時刻)だけを出し、事実のすべては閉じておく
    await waitFor(() => expect(rowResult('テスト高等学校')).toBeTruthy())
    const card = rowResult('テスト高等学校')
    expect(card.open).toBe(false)
    expect(card.querySelector('summary')?.textContent).toBe(`${RESULT_ALL_LABEL}(事実 1 件・出典 1 件)`)
    expect(screen.getByTestId('result-highlights-P29:high').textContent).toContain('始業 8:40')
    expect(within(screen.getByTestId('result-highlights-P29:high')).getByRole('link', { name: /出典 1/ }).getAttribute('href')).toBe('https://example.jp/high')
    expect(screen.queryByRole('heading', { name: /調査の結果/ })).toBeNull()
    // 欄の先頭のまとめ(種類ごとの件数と、時刻を読めた数)
    const summary = screen.getByRole('region', { name: RESEARCH_SUMMARY_TITLE })
    expect(summary.textContent).toContain('学校 1 件')
    expect(summary.textContent).toContain('始業・終業の時刻を読めた 1 件')
    expect(screen.getByTestId('research-result-note').textContent).toContain('出典を開いて確かめてください')
    expect(screen.getByRole('group', { name: '高校・特別支援学校', hidden: true }).querySelector('summary')?.textContent).toContain('(選んだ 1 件・調べた結果 1 件)')
    // 行には結果のあることのバッジも出す
    expect(within(rowOf('テスト高等学校')).getByText(/調査済み・見つかった/)).toBeTruthy()
    // 結果の無い行には出さない
    expect(within(rowOf('テスト総合病院')).queryByRole('group', { hidden: true })).toBeNull()
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
    expect(screen.getByRole('alert').textContent).toContain('「AI に相談」のタブ')
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
        // サーバーは送った対象をすべて targets に入れて返す(research.py の session_targets)
        const targets = ids.map((id) => ({ targetId: id, kind: 'school' as const, name: id, municipality: null, lat: 43.77, lon: 142.36, cached: null }))
        return { targets, total: ids.length, maxTargets: 30 }
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
    const card = rowResult('テスト総合病院')
    expect(card.textContent).toContain('デモ用の保存済みの結果')
    expect(card.open).toBe(false)
    expect(screen.getByTestId('result-highlights-P04:hosp').textContent).toContain('外来の受付 8:30〜11:00')
    // どこから来た結果か・見つかったかは、行のバッジに出す
    expect(within(rowOf('テスト総合病院')).getByText('保存済み(デモ)・一部だけ見つかった')).toBeTruthy()
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
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('施設の参照データを読み込めませんでした。サーバーがエラーを返しました(500)。'))
    expect(fetchMock).toHaveBeenCalledWith(`/api/ref/facilities/${facilityMeshes(STOPS)[0]}`)
    const calls = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls))
  })

  it('「前提情報を調べる」は送信の間、処理中(無効・aria-busy・読み上げ)になる', async () => {
    let resolve: (v: ResearchStartView) => void = () => {}
    setup({ start: () => new Promise<ResearchStartView>((r) => (resolve = r)) })
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))
    const busy = await screen.findByRole('button', { name: RESEARCH_STARTING })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    // 文字は幅を保つために残す(読み上げからは外す)
    expect(busy.textContent).toContain(RESEARCH_START)
    await act(async () => resolve({ targets: [], total: 0, maxTargets: 30 }))
    await waitFor(() => expect(screen.queryByRole('button', { name: RESEARCH_STARTING })).toBeNull())
    expect(screen.getByRole('button', { name: RESEARCH_START })).toBeTruthy()
  })

  it('「保存済みの結果(デモ)を使う」は読み込みの間、処理中になり、「読んでいます」の行は出さない', async () => {
    let resolve: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (resolve = r))),
    )
    setup()
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_DEMO }))
    const busy = await screen.findByRole('button', { name: RESEARCH_DEMO_LOADING })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(/保存済みの結果を読んでいます/)).toBeNull()
    await act(async () => resolve(Response.json({ results: [] })))
    await waitFor(() => expect(screen.getByText(RESEARCH_DEMO_NONE)).toBeTruthy())
    expect(screen.getByRole('button', { name: RESEARCH_DEMO }).getAttribute('aria-busy')).toBeNull()
  })

  it('「読み込み直す」は読み込みの間、前の理由を残したまま処理中になる', async () => {
    act(() => useResearchStore.getState().reset())
    let calls = 0
    let resolve: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => (++calls === 1 ? Promise.resolve(new Response('', { status: 500 })) : new Promise<Response>((r) => (resolve = r)))),
    )
    setup()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'))
    fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }))
    const busy = await screen.findByRole('button', { name: '読み込み直しています' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('500')
    expect(screen.queryByText(/周辺の施設を読み込んでいます/)).toBeNull()
    await act(async () => resolve(new Response('', { status: 503 })))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('503'))
    expect(screen.getByRole('button', { name: '読み込み直す' }).getAttribute('aria-busy')).toBeNull()
  })

  it('施設の行(行の下の調べた結果を含む)に、マウスとキーボードの焦点が当たると地図の強調を付け、外れると解く', async () => {
    const { research } = setup()
    const highlighted = () => useMapStore.getState().highlightedTargetId
    const row = screen.getByRole('checkbox', { name: 'テスト総合病院' }).closest('li')!
    fireEvent.mouseEnter(row)
    expect(highlighted()).toBe('P04:hosp')
    expect(row.getAttribute('data-highlighted')).toBe('true')
    fireEvent.mouseLeave(row)
    expect(highlighted()).toBeNull()

    // キーボードの焦点(チェックボックスに焦点が来る)
    const box = screen.getByRole('checkbox', { name: 'テスト高等学校' })
    act(() => box.focus())
    expect(highlighted()).toBe('P29:high')
    act(() => box.blur())
    expect(highlighted()).toBeNull()

    // ほかの行に移った後で前の行の mouseleave が来ても、今の強調は消さない
    fireEvent.mouseEnter(row)
    fireEvent.mouseEnter(screen.getByRole('checkbox', { name: 'テスト内科' }).closest('li')!)
    fireEvent.mouseLeave(row)
    expect(highlighted()).toBe('P04:clinic')

    // 行の下の調べた結果(開閉の見出しと出典のリンクの焦点も、その行の強調になる)
    fireEvent.mouseLeave(screen.getByRole('checkbox', { name: 'テスト内科' }).closest('li')!)
    fireEvent.click(screen.getByRole('button', { name: RESEARCH_START }))
    await waitFor(() => expect(research.overview).toHaveBeenCalled())
    await waitFor(() => expect(rowResult('テスト高等学校')).toBeTruthy())
    const card = rowResult('テスト高等学校')
    const summary = card.querySelector('summary')!
    act(() => summary.focus())
    expect(highlighted()).toBe('P29:high')
    act(() => summary.blur())
    expect(highlighted()).toBeNull()
    const link = within(card).getByRole('link', { name: /学校の案内/ })
    act(() => link.focus())
    expect(highlighted()).toBe('P29:high')
    act(() => link.blur())
    fireEvent.mouseEnter(rowOf('テスト高等学校'))
    expect(highlighted()).toBe('P29:high')
    // 開閉しても、行のチェックボックスは変わらない(結果は label の外に置く)
    expect(checkedNames()).toContain('テスト高等学校')
    fireEvent.click(summary)
    expect(checkedNames()).toContain('テスト高等学校')
  })

  it('手順を離れたら(部品が外れたら)、強調を解く', () => {
    setup()
    fireEvent.mouseEnter(screen.getByRole('checkbox', { name: 'テスト総合病院' }).closest('li')!)
    expect(useMapStore.getState().highlightedTargetId).toBe('P04:hosp')
    cleanup()
    expect(useMapStore.getState().highlightedTargetId).toBeNull()
  })
})

describe('ResearchStep の一覧の畳み方', () => {
  // 診療所 8 件(停留所 S1 から西へ、番号の順に遠くなる)と、優先順位の外の学校 8 件
  function many(prefix: string, kind: string, detail: Record<string, unknown>) {
    return Array.from({ length: 8 }, (_, k) => item(`${prefix}${k + 1}`, kind, `${kind === 'clinic' ? '診療所' : '学校'}${k + 1}`, 43.76 + 0.0005 * k, 142.34 - 0.0005 * k, detail))
  }
  const LONG_FILE = { facilities: [...many('P04:c', 'clinic', { beds: 0 }), ...many('P29:e', 'school', {})] }
  const OTHERS = 'そのほかの学校(優先順位の外。種別が分からないもの)'

  function names(group: string): string[] {
    return within(screen.getByRole('group', { name: group, hidden: true }))
      .queryAllByRole('checkbox', { hidden: true })
      .map((c) => c.getAttribute('aria-label') ?? '')
  }

  beforeEach(() => {
    act(() => {
      const { facilities, sources } = mergeFacilityFiles([LONG_FILE])
      useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(STOPS).join(','), facilities, sources } })
    })
  })

  it('選んだ対象の無いまとまりは最初の5件まで。「続きを表示(残り N 件)」で残りを開き、開いた最初の行に焦点を移す', () => {
    setup()
    expect(names(OTHERS)).toEqual(['学校1', '学校2', '学校3', '学校4', '学校5'])
    const more = within(screen.getByRole('group', { name: OTHERS, hidden: true })).getByRole('button', { name: '続きを表示(残り 3 件)', hidden: true })
    fireEvent.click(more)
    expect(names(OTHERS)).toHaveLength(8)
    expect(within(screen.getByRole('group', { name: OTHERS, hidden: true })).queryByRole('button', { name: /続きを表示/, hidden: true })).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('学校6')
  })

  it('選んだ対象のあるまとまりは、選んだ対象のうち最後のものの後ろ3件まで。外しても減らさない。まとまりごとに開く', () => {
    act(() => useResearchStore.setState({ selected: ['P04:c2'] }))
    setup()
    // 2件目を選んでいる → 5件目まで
    expect(names('診療所')).toEqual(['診療所1', '診療所2', '診療所3', '診療所4', '診療所5'])
    // 4件目を選び足すと 7件目まで
    fireEvent.click(screen.getByRole('checkbox', { name: '診療所4' }))
    expect(names('診療所')).toHaveLength(7)
    expect(screen.getByRole('button', { name: '続きを表示(残り 1 件)', hidden: true })).toBeTruthy()
    // 外しても減らさない(押している行が消えない)
    fireEvent.click(screen.getByRole('checkbox', { name: '診療所4' }))
    expect(names('診療所')).toHaveLength(7)
    // ほかのまとまりは開かない
    expect(names(OTHERS)).toHaveLength(5)
  })
  it('調べた結果のある対象は、選んでいなくても「続きを表示」の後ろに隠さず、行の下に結果を出す', () => {
    setup()
    act(() =>
      useResearchStore.getState().mergeResults([
        {
          targetId: 'P29:e7',
          kind: 'school',
          name: '学校7',
          status: 'found',
          facts: [{ label: '始業', value: '8時30分', source: 1 }],
          sources: [{ url: 'https://example.jp/e7', title: '学校の案内' }],
          note: '',
          checkedAt: '2026-11-06T10:05:00+09:00',
          origin: 'web',
        },
      ]),
    )
    expect(names(OTHERS)).toHaveLength(8)
    expect(screen.getByRole('group', { name: '学校7の調査の結果', hidden: true }).textContent).toContain('8時30分')
  })
})

describe('ResearchStep の周辺の事業者', () => {
  function stop(name: string, lat: number, lon: number, operator: string, routes: string[] = []) {
    return { name, lat, lon, operators: [`P11:${operator}`], routes }
  }
  const BBOX = { stops: 9, bbox: [43.7, 142.3, 43.8, 142.4] }
  const OPERATOR_FILE = {
    facilities: [
      item('P04:hosp', 'hospital', 'テスト総合病院', 43.771, 142.361, { beds: 300 }),
      item('P29:high', 'school', 'テスト高等学校', 43.775, 142.36, { school_type: '高等学校', open_status: '開校中' }),
      item('P04:clinic', 'clinic', 'テスト内科', 43.765, 142.355, { beds: 0 }),
      item('P11:テストバス', 'operator', 'テストバス', 43.77, 142.36, BBOX),
      item('P11:となりバス', 'operator', 'となりバス', 43.775, 142.365, BBOX),
      item('P11:おおきいバス', 'operator', 'おおきいバス', 43.78, 142.37, BBOX),
      item('P11:とおいバス', 'operator', 'とおいバス', 43.7, 142.3, BBOX),
    ],
    busstops: [
      // となりバス:S1 の近く(約 110m)に1か所。系統は2つ
      stop('となり1', 43.761, 142.35, 'となりバス', ['1番', '2番']),
      // おおきいバス:S1・S2・S3 のそれぞれの近くに1か所ずつ
      stop('おおきい1', 43.7605, 142.3505, 'おおきいバス', ['A線']),
      stop('おおきい2', 43.7805, 142.3705, 'おおきいバス', ['A線']),
      stop('おおきい3', 43.7705, 142.3605, 'おおきいバス', ['B線']),
      // とおいバス:どの停留所からも遠い
      stop('とおい1', 43.7, 142.3, 'とおいバス', ['C線']),
      // 読み込んだ GTFS の事業者(テストバス)は数えない
      stop('自社1', 43.7601, 142.3501, 'テストバス', ['自社線']),
    ],
  }

  function loadFile(file: object, stops: Stop[] = STOPS) {
    act(() => {
      const { facilities, sources } = mergeFacilityFiles([file])
      const busstops = 'busstops' in file ? mergeBusstopFiles([file]).stops : null
      useResearchStore.setState({ facilities: { status: 'ready', key: facilityMeshes(stops).join(','), facilities, sources, busstops } })
    })
  }

  function operatorRows(): string[] {
    return within(screen.getByRole('group', { name: '周辺のバス事業者', hidden: true }))
      .getAllByRole('checkbox', { hidden: true })
      .map((c) => c.getAttribute('aria-label') ?? '')
  }

  function detail(targetId: string): HTMLElement {
    return screen.getByTestId(`operator-detail-${targetId}`)
  }

  it('読み込んだ GTFS の事業者をいちばん上に、次に重なりのある事業者を重なりの数の多い順に置き、重なりの無い事業者は「近くに停留所なし」と出して後ろに回す', () => {
    loadFile(OPERATOR_FILE)
    setup()
    // 「近くに停留所なし」の事業者は「続きを表示」の後ろにまとめる
    expect(operatorRows()).toEqual(['テストバス', 'おおきいバス', 'となりバス'])
    fireEvent.click(within(screen.getByRole('group', { name: '周辺のバス事業者', hidden: true })).getByRole('button', { name: '続きを表示(残り 1 件)' }))
    expect(operatorRows()).toEqual(['テストバス', 'おおきいバス', 'となりバス', 'とおいバス'])
    const far = screen.getByRole('checkbox', { name: 'とおいバス' }).closest('li')!
    expect(far.textContent).toContain(NO_NEARBY_STOPS)
    expect(screen.getByRole('checkbox', { name: 'おおきいバス' }).closest('li')!.textContent).not.toContain(NO_NEARBY_STOPS)
    // 読み込んだ GTFS の事業者には重なりを出さない
    expect(screen.queryByTestId('operator-detail-P11:テストバス')).toBeNull()
  })

  it('既定では、近くに停留所がある事業者を上限にかかわらずすべて選び、「近くに停留所なし」の事業者は選ばない', () => {
    loadFile(OPERATOR_FILE)
    act(() => useResearchStore.setState({ maxTargets: 2 }))
    setup()
    expect(checkedNames()).toEqual(['おおきいバス', 'となりバス', 'テスト総合病院', 'テスト高等学校'])
    // 事業者は上限に数えずに選べる(学校・病院などは上限に達している)
    fireEvent.click(within(screen.getByRole('group', { name: '周辺のバス事業者', hidden: true })).getByRole('button', { name: '続きを表示(残り 1 件)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'とおいバス', hidden: true }))
    expect(checkedNames()).toContain('とおいバス')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('事業者の行に、こちらの停留所との重なり(数と系統名)と、時刻が無いことの断り書きを出す', () => {
    loadFile(OPERATOR_FILE)
    setup()
    expect(detail('P11:おおきいバス').textContent).toContain('こちらの停留所 3 か所の 300m 以内に、この事業者の停留所 3 か所(系統:A線、B線)')
    expect(detail('P11:となりバス').textContent).toContain('こちらの停留所 1 か所の 300m 以内に、この事業者の停留所 1 か所(系統:1番、2番)')
    expect(screen.getByText(OVERLAP_DISCLAIMER)).toBeTruthy()
    expect(OVERLAP_DISCLAIMER).toContain('時刻表で確かめてください')
    // 承認前は、減便で発車が減る停留所の数の代わりに案内を出す
    expect(screen.getByText(REDUCED_AFTER_POLICY)).toBeTruthy()
    // まだ調べていない事業者は、行の名前の横に「未調査」のバッジ(説明は title)を付け、行の下には文を出さない
    const badge = within(rowOf('となりバス')).getByText(NOT_RESEARCHED_BADGE)
    expect(badge.getAttribute('title')).toBe(NOT_RESEARCHED_TITLE)
    expect(detail('P11:となりバス').textContent).not.toContain(NOT_RESEARCHED_TITLE)
  })

  it('停留所の参照データが無い(古いファイル)ときは、重なりを数えていないと出し、「近くに停留所なし」とは出さない', () => {
    setup()
    expect(screen.getByText(NO_BUSSTOP_DATA)).toBeTruthy()
    expect(screen.queryByText(NO_NEARBY_STOPS)).toBeNull()
    expect(screen.queryByText(OVERLAP_DISCLAIMER)).toBeNull()
  })

  it('事業者の行に、調べた結果のうち減便・ダイヤ改正・運休・特別ダイヤの事実を、出典の番号のリンクつきで出す(確認日時は調べた結果のすべてに出す)', async () => {
    loadFile(OPERATOR_FILE)
    setup()
    act(() =>
      useResearchStore.getState().mergeResults([
        {
          targetId: 'P11:おおきいバス',
          kind: 'operator',
          name: 'おおきいバス',
          status: 'found',
          facts: [
            { label: '会社の概要', value: '市内の路線バス', source: 1 },
            { label: '朝日線の減便(報道)', value: '10月から平日は1往復減便', source: 2 },
            { label: '直近のダイヤ改正', value: '令和8年5月10日に実施', source: 1 },
          ],
          sources: [
            { url: 'https://example.jp/top', title: '公式' },
            { url: 'https://example.jp/news', title: '報道' },
          ],
          note: '',
          checkedAt: '2026-11-03T18:58:59+09:00',
          origin: 'demo',
        },
        {
          targetId: 'P11:となりバス',
          kind: 'operator',
          name: 'となりバス',
          status: 'partial',
          facts: [{ label: '問い合わせ先', value: '0166-00-0000', source: 1 }],
          sources: [{ url: 'https://example.jp/t', title: 't' }],
          note: '',
          checkedAt: '2026-11-03T19:00:00+09:00',
          origin: 'web',
        },
      ]),
    )
    const big = detail('P11:おおきいバス')
    const movement = within(big).getByLabelText('調べた減便の動き')
    expect(movement.textContent).toContain('朝日線の減便(報道):10月から平日は1往復減便[2]')
    expect(movement.textContent).toContain('直近のダイヤ改正:令和8年5月10日に実施[1]')
    expect(movement.textContent).not.toContain('会社の概要')
    expect(big.textContent).toContain('確認日時 2026年11月3日 18:58・デモ用の保存済みの結果')
    expect(within(movement).getByRole('link', { name: /報道/ }).getAttribute('href')).toBe('https://example.jp/news')
    // 調べた結果のすべて(減便の動き以外の事実も)は、事業者の行の下に、最初は閉じて出す
    const all = within(big).getByRole('group', { name: 'おおきいバスの調査の結果', hidden: true }) as HTMLDetailsElement
    expect(all.open).toBe(false)
    expect(all.querySelector('summary')?.textContent).toBe(`${RESULT_ALL_LABEL}(事実 3 件・出典 2 件)`)
    expect(all.textContent).toContain('会社の概要')
    expect(all.textContent).toContain('市内の路線バス')
    expect(screen.queryByRole('heading', { name: /調査の結果/ })).toBeNull()
    // 減便などの事実が無ければ、そう出す(ほかの事実は行の下の「調べた結果のすべて」で見る)
    expect(MOVEMENT_NONE).toContain(`「${RESULT_ALL_LABEL}」`)
    expect(within(detail('P11:となりバス')).getByRole('group', { name: 'となりバスの調査の結果', hidden: true }).textContent).toContain('問い合わせ先')
    expect(detail('P11:となりバス').textContent).toContain(MOVEMENT_NONE)
    expect(detail('P11:となりバス').textContent).toContain('確認日時 2026年11月3日 19:00')
  })

  it('事業者の行にマウスや焦点が当たると、その事業者(の重なる停留所)を地図で強調する', () => {
    loadFile(OPERATOR_FILE)
    setup()
    fireEvent.mouseEnter(screen.getByRole('checkbox', { name: 'となりバス' }).closest('li')!)
    expect(useMapStore.getState().highlightedTargetId).toBe('P11:となりバス')
  })

  it('減便の方針を承認済みなら、発車が減る・なくなる停留所のうち、ほかの事業者の停留所が 300m 以内にある数も出す', () => {
    // smallFeed を平日→土曜ダイヤにすると、A(4本→3本)と S9(1本→0本)の発車が減る。C は増える
    const feed = smallFeed()
    const own: Stop[] = [
      { id: 'A', name: '駅前', lat: 43.76, lon: 142.36, locationType: 0, parentStation: '' },
      { id: 'B', name: '市役所', lat: 43.77, lon: 142.37, locationType: 0, parentStation: '' },
      { id: 'C', name: '病院前', lat: 43.78, lon: 142.38, locationType: 0, parentStation: '' },
      { id: 'S9', name: '学校前', lat: 43.79, lon: 142.39, locationType: 0, parentStation: '' },
    ]
    const outcome = applyForm2(feed, basePlan(), { generatedAt: '202610200930' })
    if (!outcome.ok) throw new Error(outcome.message)
    act(() => {
      useReachStore.setState({ origins: { stops: own, unused: 0, nonStop: 0, noBoarding: 0 } })
      useEditStore.setState({ base: { feed, zip: new ArrayBuffer(0), label: 'test', sample: null }, versions: [outcome.result] })
    })
    loadFile(
      {
        facilities: [item('P11:となりバス', 'operator', 'となりバス', 43.775, 142.365, BBOX)],
        // A の近くと C の近くに1か所ずつ(C は発車が増えるので数えない)
        busstops: [stop('となりA', 43.761, 142.36, 'となりバス', ['1番']), stop('となりC', 43.781, 142.38, 'となりバス', ['1番'])],
      },
      own,
    )
    setup()
    expect(screen.getByTestId('reduced-summary').textContent).toBe(
      '減便で発車が減る・なくなるこちらの停留所 2 か所のうち、ほかの事業者の停留所が 300m 以内にあるのは 1 か所です(2026年11月2日の発車で比べています)。',
    )
    expect(detail('P11:となりバス').textContent).toContain('こちらの停留所 2 か所の 300m 以内に、この事業者の停留所 2 か所(系統:1番)。このうち、減便で発車が減る・なくなる停留所 1 か所')
    expect(screen.queryByText(REDUCED_AFTER_POLICY)).toBeNull()
    expect(screen.queryByText(REDUCED_NO_DATE)).toBeNull()
  })

  it('承認済みでも、減便の期間に元の平日ダイヤが走る日がなければ数えず、「承認すると」とも出さずに、数えていないと出す', () => {
    const feed = smallFeed()
    const own: Stop[] = [{ id: 'A', name: '駅前', lat: 43.76, lon: 142.36, locationType: 0, parentStation: '' }]
    const outcome = applyForm2(feed, basePlan(), { generatedAt: '202610200930' })
    if (!outcome.ok) throw new Error(outcome.message)
    // 出力の有効期間を土日の2日(2026-11-07 土・11-08 日)だけにすると、元の平日ダイヤが走る日がない
    const version = { ...outcome.result, report: { ...outcome.result.report, validity: { start: '20261107', end: '20261108', days: 2 } } }
    expect(reducedStopsOf(feed, version)).toBeNull()
    // 平日を含めれば数える日が決まる(11-09 月)
    const withMonday = { ...version, report: { ...version.report, validity: { start: '20261107', end: '20261109', days: 3 } } }
    expect(reducedStopsOf(feed, withMonday)?.date).toBe('20261109')
    act(() => {
      useReachStore.setState({ origins: { stops: own, unused: 0, nonStop: 0, noBoarding: 0 } })
      useEditStore.setState({ base: { feed, zip: new ArrayBuffer(0), label: 'test', sample: null }, versions: [version] })
    })
    loadFile({ facilities: [item('P11:となりバス', 'operator', 'となりバス', 43.775, 142.365, BBOX)], busstops: [stop('となりA', 43.761, 142.36, 'となりバス', ['1番'])] }, own)
    setup()
    expect(screen.queryByTestId('reduced-summary')).toBeNull()
    expect(screen.queryByText(REDUCED_AFTER_POLICY)).toBeNull()
    expect(screen.getByText(REDUCED_NO_DATE)).toBeTruthy()
  })
})
