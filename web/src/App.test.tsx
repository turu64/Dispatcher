// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smallFeed } from '@/gtfs/edit/form2.fixture'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useMapStore } from '@/store/map'
import { useReachStore } from '@/store/reach'
import { STEP_KEYS, useStepStore } from '@/store/steps'
import App from './App'
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
    expect(names).toEqual(['11. 読み込み', '22. 前提情報', '33. 減便の方針', '44. 影響(到達圏)', '55. 足し戻し', '66. 出力'])
    expect(useStepStore.getState().order).toEqual(STEP_KEYS)
  })

  it('GTFS を読み込む前は、読み込みより先の手順を開けず、「AI に相談」の欄も出さない', () => {
    render(<App />)
    expect(stepButton('1. 読み込み').getAttribute('aria-current')).toBe('step')
    expect(stepButton('3. 減便の方針').disabled).toBe(true)
    const next = screen.getByRole('button', { name: /^次へ/ }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.getByText('GTFS を読み込むと先へ進めます')).toBeTruthy()
    expect((screen.getByRole('button', { name: /^戻る/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('heading', { name: '1. GTFS を読み込む' })).toBeTruthy()
    // 方針の手順は描いてあるが隠れている
    expect(screen.queryByRole('heading', { name: '3. 減便の方針' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'AI に相談' })).toBeNull()
  })

  it('読み込んだあとは見出しからどの手順へも移れ、見出しの番号は一覧の並びになる。次へ・戻るでも移る', () => {
    load()
    render(<App />)
    fireEvent.click(stepButton('5. 足し戻し'))
    expect(useStepStore.getState().current).toBe('restore')
    expect(screen.getByRole('heading', { name: '5. 足し戻し' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '1. GTFS を読み込む' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(screen.getByRole('heading', { name: '6. 出力' })).toBeTruthy()
    // 出力の中のタブの見出しには番号を付けない
    expect(screen.getByRole('heading', { name: 'GTFS を出力' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^戻る/ }))
    fireEvent.click(screen.getByRole('button', { name: /^戻る/ }))
    expect(screen.getByRole('heading', { name: '4. 影響(到達圏)' })).toBeTruthy()
    // どの手順でも「AI に相談」の欄が左の欄の下に出る
    expect(screen.getByRole('region', { name: 'AI に相談' })).toBeTruthy()
    // 鉄道駅の扱いの注記
    expect(screen.getByText('鉄道駅は時刻表データが無いため、6〜24時のすべての時間帯で使えるものとみなしています。')).toBeTruthy()
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
