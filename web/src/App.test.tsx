// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import { useChatStore } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import { useSidePanelStore } from '@/store/sidePanel'
import { STEP_KEYS, useStepStore } from '@/store/steps'
import App from './App'
import SidePanel from './components/layout/SidePanel'
import { TooltipProvider } from './components/ui/tooltip'
import { CONTACT_TEXT } from './pages/AboutPage'

/**
 * 画面の骨組み(上の端・ステッパー・地図の出し分け・左右の幅・運営情報のページ)を、jsdom で確かめる。
 * 背景地図(MapLibre)は jsdom では作れないので作らせず、地図の store に偽物を入れて resize の呼び出しを見る。
 * サーバー(サンプル・祝日・AI の状態)には届かないものとし、到達圏は Web Worker の代わりにその場で計算する
 */

vi.mock('maplibre-gl', () => ({ default: {}, setWorkerUrl: () => {}, Map: class {} }))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '' }))
// 到達圏の重ねは地図の API を使うので、ここでは描かない(重ねは map/ 側のテストで確かめる)
vi.mock('@/map/ReachLayers', () => ({ default: () => null }))
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
}))
vi.mock('@/reach/workerClient', async () => {
  const { computeReach } = await import('@/reach/reach')
  return { computeReachInWorker: async (input: Parameters<typeof computeReach>[0]) => computeReach(input) }
})
vi.mock('@/reach/refData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/reach/refData')>()),
  fetchRefData: async (mesh1s: string[]) => ({ ok: false, mesh1s, missing: mesh1s, message: '参照データがありません(テスト)。' }),
}))

function load() {
  const feed = smallFeed()
  act(() => {
    useGtfsStore.getState().setLoaded({ label: 'test.zip', feed })
    const { stops, servicePeriod } = useGtfsStore.getState()
    useReachStore.getState().setSource({ feed, stops, period: servicePeriod })
    useEditStore.getState().setBase({ feed, zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
  })
}

/** 地図の入れ物(右の欄)。隠しているかは、この入れ物か祖先の hidden で見る */
function mapPane(): HTMLElement {
  return document.querySelector('main[aria-label="地図"]')!.closest('[data-pane="right"]') as HTMLElement
}

function stepButton(name: string): HTMLButtonElement {
  return within(screen.getByRole('navigation', { name: '手順の切り替え' })).getByRole('button', { name }) as HTMLButtonElement
}

function fakeMap() {
  const map = { resize: vi.fn() }
  act(() => useMapStore.getState().setMap(map as unknown as MapLibreMap))
  return map
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 503 })),
  )
  window.localStorage.clear()
  window.location.hash = ''
})

afterEach(() => {
  cleanup()
  act(() => {
    useEditStore.getState().setBase(null)
    useReachStore.getState().setSource(null)
    useGtfsStore.getState().clear()
    useMapStore.getState().setMap(null)
    useStepStore.setState({ current: 'load' })
    useSidePanelStore.setState({ tab: 'edit' })
    useChatStore.getState().reset()
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('画面の骨組み', () => {
  it('アプリ名と、上の端に運営情報へのリンクを出す。データの出典は手順の欄には出さない', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Dispatcher' })).toBeTruthy()
    const link = screen.getByRole('link', { name: 'このサイトについて・データの出典' })
    expect(link.getAttribute('href')).toBe('#/about')
    expect(screen.queryByText('北海道オープンデータプラットフォーム')).toBeNull()
  })

  it('手順は 読み込み → 前提情報 → 減便の方針 → 影響(到達圏。日付と時間帯を含む)→ 足し戻し → 出力 の順に並ぶ', () => {
    render(<App />)
    const nav = screen.getByRole('navigation', { name: '手順の切り替え' })
    const names = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(names).toEqual(['11. 読み込み', '22. 前提情報', '33. 減便の方針', '44. 影響(到達圏)', '55. 平日便を戻す', '66. 出力'])
    expect(useStepStore.getState().order).toEqual(STEP_KEYS)
  })

  it('GTFS を読み込む前は、読み込みより先の手順を開けない。左の欄のタブは出すが、「AI に相談」は案内だけ', () => {
    render(<App />)
    expect(stepButton('1. 読み込み').getAttribute('aria-current')).toBe('step')
    expect(stepButton('3. 減便の方針').disabled).toBe(true)
    const next = screen.getByRole('button', { name: /^次へ/ }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.getByText('GTFS を読み込むと先へ進めます')).toBeTruthy()
    // 最初の手順では「戻る」を出さない
    expect(screen.queryByRole('button', { name: /^戻る/ })).toBeNull()
    expect(screen.getByRole('heading', { name: '1. GTFS を読み込む' })).toBeTruthy()
    // 方針の手順は描いてあるが隠れている
    expect(screen.queryByRole('heading', { name: '3. 減便の方針' })).toBeNull()
    expect(screen.queryByRole('log', { name: 'AI との会話', hidden: true })).toBeNull()
    expect(within(screen.getByRole('tablist', { name: '左の欄の表示' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['編集', 'AI に相談'])
    expect(tab('編集').getAttribute('aria-selected')).toBe('true')

    // 「AI に相談」を開くと、会話の欄ではなく案内と、手順「読み込み」を開くボタンが出る
    fireEvent.mouseDown(tab('AI に相談'))
    const panel = screen.getByRole('tabpanel', { name: 'AI に相談' })
    expect(within(panel).getByText('GTFS を読み込むと、AI に相談できます')).toBeTruthy()
    expect(within(panel).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: '手順「読み込み」を開く' }))
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(useStepStore.getState().current).toBe('load')
    expect(screen.getByRole('heading', { name: '1. GTFS を読み込む' })).toBeTruthy()
  })

  it('読み込んだあとは見出しからどの手順へも移れ、見出しの番号は一覧の並びになる。次へ・戻るでも移る', () => {
    load()
    render(<App />)
    fireEvent.click(stepButton('5. 平日便を戻す'))
    expect(useStepStore.getState().current).toBe('restore')
    expect(screen.getByRole('heading', { name: '5. 平日便を戻す' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '1. GTFS を読み込む' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(screen.getByRole('heading', { name: '6. 出力' })).toBeTruthy()
    // 最後の手順では「次へ」を出さない
    expect(screen.queryByRole('button', { name: /^次へ/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^戻る/ })).toBeTruthy()
    // 出力の中のタブの見出しには番号を付けない
    expect(screen.getByRole('heading', { name: 'GTFS を出力' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^戻る/ }))
    fireEvent.click(screen.getByRole('button', { name: /^戻る/ }))
    expect(screen.getByRole('heading', { name: '4. 影響(到達圏)' })).toBeTruthy()
    // どの手順でも、左の欄のタブから「AI に相談」を開ける
    expect(screen.getByRole('tab', { name: 'AI に相談' })).toBeTruthy()
    // 鉄道駅の扱いの注記
    expect(screen.getByText('鉄道駅は時刻表データがないため、6〜24時のすべての時間帯で使えるものとみなしています。')).toBeTruthy()
  })

  it('地図を出さない手順(方針・出力)では地図の入れ物を隠し、地図に戻ると map.resize() を呼ぶ', () => {
    load()
    render(<App />)
    const map = fakeMap()
    expect(mapPane().hidden).toBe(false)
    map.resize.mockClear()

    fireEvent.click(stepButton('3. 減便の方針'))
    expect(mapPane().hidden).toBe(true)
    expect(screen.getByRole('separator', { hidden: true }).hidden).toBe(true)
    // 地図は消さずに隠す
    expect(document.querySelector('main[aria-label="地図"]')).not.toBeNull()
    expect(map.resize).not.toHaveBeenCalled()

    fireEvent.click(stepButton('4. 影響(到達圏)'))
    expect(mapPane().hidden).toBe(false)
    expect(map.resize).toHaveBeenCalledTimes(1)

    fireEvent.click(stepButton('6. 出力'))
    expect(mapPane().hidden).toBe(true)
  })

  it('タブで出力の種類を切り替える(中身は消さずに隠す)', () => {
    load()
    render(<App />)
    fireEvent.click(stepButton('6. 出力'))
    const tabs = screen.getByRole('tablist', { name: '出力の種類' })
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['GTFS', '変更指示書', '周知文', '停留所の一覧'])
    fireEvent.mouseDown(within(tabs).getByRole('tab', { name: '変更指示書' }))
    expect(screen.getByRole('heading', { name: '変更指示書' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'GTFS を出力' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'GTFS を出力', hidden: true })).toBeTruthy()
  })

  it('#/about で運営情報のページを開き、「画面に戻る」で元の手順と地図に戻る', () => {
    load()
    render(<App />)
    fireEvent.click(stepButton('4. 影響(到達圏)'))
    const map = fakeMap()
    map.resize.mockClear()

    act(() => {
      window.location.hash = '#/about'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByRole('heading', { name: 'このサイトについて' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'データの出典' })).toBeTruthy()
    for (const text of ['北海道オープンデータプラットフォーム', 'e-Stat', '国土数値情報', 'OpenStreetMap Japan']) {
      expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0)
    }
    expect(screen.getByText(/MIT License/)).toBeTruthy()
    expect(screen.getByText(/Built with Claude: Japan 2026/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'お問い合わせ' })).toBeTruthy()
    expect(screen.getByText(CONTACT_TEXT)).toBeTruthy()
    // 手順と地図は隠れている(消えていない)
    expect(screen.queryByRole('navigation', { name: '手順の切り替え' })).toBeNull()
    expect(mapPane().closest('[hidden]')).not.toBeNull()

    const back = screen.getByRole('link', { name: '画面に戻る' })
    expect(back.getAttribute('href')).toBe('#/')
    act(() => {
      window.location.hash = '#/'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.queryByRole('heading', { name: 'このサイトについて' })).toBeNull()
    expect(useStepStore.getState().current).toBe('reach')
    expect(screen.getByRole('heading', { name: '4. 影響(到達圏)' })).toBeTruthy()
    expect(mapPane().closest('[hidden]')).toBeNull()
    expect(map.resize).toHaveBeenCalledTimes(1)
  })
})

function tab(name: string | RegExp): HTMLElement {
  return within(screen.getByRole('tablist', { name: '左の欄の表示' })).getByRole('tab', { name })
}

/** 「編集」のタブを開いている間の、AI の発言の読み上げの領域(タブの列の中にあり、隠れない) */
function announcer(): HTMLElement {
  const found = screen.getAllByRole('status').find((el) => el.classList.contains('sr-only') && el.closest('[role="tablist"]') === null && el.parentElement?.querySelector('[role="tablist"]'))
  return found as HTMLElement
}

/** 方針の下書き(AI が作ったもの)を作る */
function proposeClaudePolicy() {
  const { addBackTripIds: _a, ...settings } = basePlan()
  act(() => {
    useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '' } }, 'claude')
  })
}

describe('左の欄のタブ(編集と AI に相談)', () => {
  it('読み込んだら「編集」と「AI に相談」のタブが出て、切り替えると中身が入れ替わる。地図は手順のとおり出す', () => {
    load()
    render(<App />)
    const list = screen.getByRole('tablist', { name: '左の欄の表示' })
    expect(within(list).getAllByRole('tab').map((t) => t.textContent)).toEqual(['編集', 'AI に相談'])
    expect(tab('編集').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('navigation', { name: '手順の切り替え' })).toBeTruthy()
    expect(screen.queryByRole('tabpanel', { name: 'AI に相談' })).toBeNull()

    fireEvent.mouseDown(tab('AI に相談'))
    expect(useSidePanelStore.getState().tab).toBe('chat')
    expect(within(screen.getByRole('tabpanel', { name: 'AI に相談' })).getByRole('log', { name: 'AI との会話' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: '手順の切り替え' })).toBeNull()
    // 手順は消さずに隠している
    expect(screen.getByRole('navigation', { name: '手順の切り替え', hidden: true })).toBeTruthy()
    // 地図はタブではなく手順で出し分ける(読み込みの手順は地図を出し、方針の手順は隠す)
    expect(useStepStore.getState().current).toBe('load')
    expect(mapPane().hidden).toBe(false)
    act(() => {
      useStepStore.getState().go('policy')
    })
    expect(mapPane().hidden).toBe(true)
    act(() => {
      useStepStore.getState().go('load')
    })
    expect(mapPane().hidden).toBe(false)

    fireEvent.mouseDown(tab('編集'))
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(screen.getByRole('navigation', { name: '手順の切り替え' })).toBeTruthy()
  })

  it('矢印キーでタブを移れる', async () => {
    load()
    // 焦点が移るのを待つ間に背景地図を作り始めないよう、左の欄だけを描く
    render(
      <TooltipProvider>
        <SidePanel wide={false} />
      </TooltipProvider>,
    )
    act(() => tab('編集').focus())
    fireEvent.keyDown(tab('編集'), { key: 'ArrowRight' })
    // Radix は焦点を次の描画の後で移す
    await waitFor(() => expect(document.activeElement).toBe(tab('AI に相談')))
    expect(useSidePanelStore.getState().tab).toBe('chat')
  })

  it('タブを切り替えても、入力中の文と手順の入力中の値は消えない', () => {
    load()
    render(<App />)
    fireEvent.mouseDown(tab('AI に相談'))
    const box = screen.getByLabelText('AI への指示や質問') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '書きかけの質問' } })
    fireEvent.mouseDown(tab('編集'))
    fireEvent.mouseDown(tab('AI に相談'))
    expect((screen.getByLabelText('AI への指示や質問') as HTMLTextAreaElement).value).toBe('書きかけの質問')
    expect(screen.getByLabelText('AI への指示や質問')).toBe(box)
  })

  it('「AI に相談」のタブを開いたまま印刷すると、印刷の直前に「編集」のタブへ切り替える(白紙にしないため)', () => {
    load()
    render(<App />)
    fireEvent.mouseDown(tab('AI に相談'))
    expect(useSidePanelStore.getState().tab).toBe('chat')
    act(() => {
      window.dispatchEvent(new Event('beforeprint'))
    })
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(screen.getByRole('navigation', { name: '手順の切り替え' })).toBeTruthy()
  })

  it('GTFS を読み込み直したら「編集」のタブに戻す', () => {
    load()
    render(<App />)
    fireEvent.mouseDown(tab('AI に相談'))
    expect(useSidePanelStore.getState().tab).toBe('chat')
    load()
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(tab('編集').getAttribute('aria-selected')).toBe('true')
  })

  it('AI が下書きを作ってもタブは切り替えず、「編集」のタブに「承認待ち」の印を出す。「編集で確かめる」で承認する手順へ移る', () => {
    load()
    render(<App />)
    fireEvent.mouseDown(tab('AI に相談'))
    proposeClaudePolicy()
    act(() => {
      useChatStore.setState({ items: [{ id: 1, kind: 'draft', draftId: '1', text: '下書き #1 を作りました。', step: 'policy' }] })
    })
    expect(useSidePanelStore.getState().tab).toBe('chat')
    expect(tab(/^編集/).textContent).toBe('編集(承認待ち)')
    fireEvent.click(screen.getByRole('button', { name: '編集で確かめる' }))
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(useStepStore.getState().current).toBe('policy')
    expect(screen.getByRole('heading', { name: '3. 減便の方針' })).toBeTruthy()
    // 下書きを捨てたら印は消える
    act(() => useEditStore.getState().discard())
    expect(tab(/^編集/).textContent).toBe('編集')
  })

  it('「編集」のタブのまま AI が下書きを作っても、タブは切り替えない。「承認待ち」の印を出し、読み上げで知らせる', () => {
    load()
    render(<App />)
    expect(useSidePanelStore.getState().tab).toBe('edit')
    proposeClaudePolicy()
    act(() => {
      useChatStore.setState({ items: [{ id: 1, kind: 'draft', draftId: '1', text: '下書き #1 を作りました。確かめて承認してください。', step: 'policy' }] })
    })
    expect(useSidePanelStore.getState().tab).toBe('edit')
    expect(tab(/^編集/).textContent).toBe('編集(承認待ち)')
    expect(tab(/^編集/).getAttribute('aria-selected')).toBe('true')
    // 会話の箱は隠れていて読み上げられないので、隠れない場所で知らせる
    expect(announcer().textContent).toBe('下書き #1 を作りました。手順「3. 減便の方針」で確かめて承認してください。')
  })

  it('読み上げの知らせは「編集」のタブを開いている間だけ入れる。返答は終わってから、エラーも知らせる', () => {
    load()
    render(<App />)
    act(() => useChatStore.setState({ items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日', streaming: true }] }))
    expect(announcer().textContent).toBe('')
    act(() => useChatStore.setState({ items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日を土曜ダイヤにします。', streaming: false }] }))
    expect(announcer().textContent).toBe('AI が返答しました。「AI に相談」のタブで読めます。')
    // 「AI に相談」のタブを開いている間は、会話の箱が読み上げるので入れない
    fireEvent.mouseDown(tab(/^AI に相談/))
    expect(announcer().textContent).toBe('')
    act(() => {
      useChatStore.setState((s) => ({ items: [...s.items, { id: 2, kind: 'assistant', messageId: 'm2', text: '続き', streaming: false }] }))
    })
    expect(announcer().textContent).toBe('')
    fireEvent.mouseDown(tab('編集'))
    act(() => useChatStore.setState((s) => ({ items: [...s.items, { id: 3, kind: 'error', text: 'つながりませんでした。' }] })))
    expect(announcer().textContent).toBe('AI との会話でエラーが出ました。「AI に相談」のタブで確かめてください。')
  })

  it('手順のボタンから AI に文を送って「AI に相談」に切り替えたら、焦点を会話の箱に移す', () => {
    load()
    render(<App />)
    const next = screen.getByRole('button', { name: /次へ/ })
    act(() => next.focus())
    act(() => useChatStore.setState({ items: [{ id: 1, kind: 'user', text: '候補を選んでください', at: '2026-11-04T09:00:00+09:00' }] }))
    expect(useSidePanelStore.getState().tab).toBe('chat')
    expect(document.activeElement).toBe(screen.getByRole('log', { name: 'AI との会話' }))
  })

  it('「AI に相談」のタブの中で文が増えたときは、焦点を動かさない', async () => {
    load()
    // 状態を待つ間に背景地図を作り始めないよう、左の欄だけを描く
    render(
      <TooltipProvider>
        <SidePanel wide={false} />
      </TooltipProvider>,
    )
    fireEvent.mouseDown(tab('AI に相談'))
    // このテストでは AI の状態を読めない(503)ので、入力欄の代わりに「もう一度確かめる」に焦点を置く
    const retry = await screen.findByRole('button', { name: 'もう一度確かめる' })
    act(() => retry.focus())
    act(() => useChatStore.setState({ items: [{ id: 1, kind: 'user', text: '質問', at: '2026-11-04T09:00:00+09:00' }] }))
    expect(document.activeElement).toBe(retry)
  })

  it('「編集」のタブに戻ったら、手順の欄のスクロールの位置を戻す', () => {
    load()
    render(<App />)
    const scroller = screen.getByRole('tabpanel', { name: '編集' }).querySelector('.overflow-y-auto') as HTMLElement
    scroller.scrollTop = 200
    fireEvent.scroll(scroller)
    fireEvent.mouseDown(tab('AI に相談'))
    // 隠すと位置が 0 に戻るブラウザの代わり
    scroller.scrollTop = 0
    fireEvent.mouseDown(tab('編集'))
    expect(scroller.scrollTop).toBe(200)
  })

  it('AI のタブで返答が流れ始めたのを見てから「編集」に移っても、返答が終われば点を出す', () => {
    load()
    render(<App />)
    fireEvent.mouseDown(tab('AI に相談'))
    act(() => {
      useChatStore.setState({ replying: true, items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日', streaming: true }] })
    })
    fireEvent.mouseDown(tab('編集'))
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談(返答中)')
    act(() => {
      useChatStore.setState({ replying: false, items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日を土曜ダイヤにします。', streaming: false }] })
    })
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談(新しい発言あり)')
  })

  it('「編集」のタブを開いている間、AI が返答していればスピナー、見ていない発言があれば点を「AI に相談」のタブに出す。開けば消える', () => {
    load()
    render(<App />)
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談')
    act(() => useChatStore.setState({ replying: true }))
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談(返答中)')
    act(() => {
      useChatStore.setState({
        replying: false,
        items: [{ id: 1, kind: 'assistant', messageId: 'm1', text: '平日を土曜ダイヤにします。', streaming: false }],
      })
    })
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談(新しい発言あり)')
    fireEvent.mouseDown(tab(/^AI に相談/))
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談')
    // AI のタブを開いている間は、返答中でも印を出さない
    act(() => useChatStore.setState({ replying: true }))
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談')
    // 編集に戻っても、見た発言には点を付けない
    act(() => useChatStore.setState({ replying: false }))
    fireEvent.mouseDown(tab('編集'))
    expect(tab(/^AI に相談/).textContent).toBe('AI に相談')
  })
})

describe('左右の幅', () => {
  // jsdom には PointerEvent が無いので、MouseEvent に pointerId を足したもので代える
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class FakePointerEvent extends MouseEvent {
        pointerId: number
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init)
          this.pointerId = init.pointerId ?? 0
        }
      }
      vi.stubGlobal('PointerEvent', FakePointerEvent)
    }
  })

  // jsdom の窓の幅は 1024px。上限は 60% で 614px
  function separator(): HTMLElement {
    return screen.getByRole('separator', { name: '手順の欄と地図の幅' })
  }
  function leftWidth(): string {
    return (separator().previousElementSibling as HTMLElement).style.width
  }

  it('区切りをドラッグして幅を変え、最小 320px・最大は窓の 60% に収め、ブラウザに覚える', () => {
    render(<App />)
    expect(leftWidth()).toBe('400px')
    fireEvent.pointerDown(separator(), { button: 0, clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(separator(), { clientX: 500, pointerId: 1 })
    expect(leftWidth()).toBe('500px')
    fireEvent.pointerMove(separator(), { clientX: 900, pointerId: 1 })
    expect(leftWidth()).toBe('614px')
    fireEvent.pointerUp(separator(), { clientX: 100, pointerId: 1 })
    expect(leftWidth()).toBe('320px')
    expect(window.localStorage.getItem('dispatcher.leftPaneWidth')).toBe('320')
    // 離したあとは動かない
    fireEvent.pointerMove(separator(), { clientX: 600, pointerId: 1 })
    expect(leftWidth()).toBe('320px')
  })

  it('覚えた幅で開き、矢印キーでも変えられる', () => {
    window.localStorage.setItem('dispatcher.leftPaneWidth', '480')
    render(<App />)
    expect(leftWidth()).toBe('480px')
    fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    expect(leftWidth()).toBe('496px')
    fireEvent.keyDown(separator(), { key: 'Home' })
    expect(leftWidth()).toBe('320px')
    expect(window.localStorage.getItem('dispatcher.leftPaneWidth')).toBe('320')
  })

  it('ブラウザの保存が使えなくても、既定の幅で開いて動く', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<App />)
    expect(leftWidth()).toBe('400px')
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    expect(leftWidth()).toBe('384px')
  })
})
