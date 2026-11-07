// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { EditOp, EditRecord, PolicySettings } from '@/gtfs/edit/ops'
import type { ResearchResult } from '@/claude/research'
import { useDriversStore } from '@/store/drivers'
import { useEditStore, type Draft } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useResearchStore } from '@/store/research'
import { useStepStore } from '@/store/steps'
import Stepper from './Stepper'

/**
 * 手順のステッパーの見え方(今・済み・開けない・承認待ち)と、押して移ることを確かめる。
 * 状態は多くを store に直接入れる(下書きと履歴の作り方は store/edit.test.ts で確かめている)。
 * 承認・元に戻す・読み込み直しで済みの印が消えることは、本物の store の操作で確かめる
 */

vi.mock('maplibre-gl', () => ({ default: {}, setWorkerUrl: () => {}, Map: class {} }))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '' }))
vi.mock('@/gtfs/sample', () => ({
  fetchSampleGtfsInfo: () => new Promise(() => {}),
  fetchSampleGtfs: () => new Promise(() => {}),
}))

function settings(): PolicySettings {
  const { addBackTripIds: _a, ...rest } = basePlan()
  return rest
}

const POLICY: EditOp = { type: 'applyPolicy', settings: settings(), reason: { category: null, note: '' } }
const ADD_BACK: EditOp = { type: 'addBack', items: [{ tripId: 'T1', reason: '通学', schoolDaysOnly: false }] }
const AT = '2026-11-04T09:30:00+09:00'

function record(op: EditOp): EditRecord {
  return { op, by: 'user', at: AT }
}

/** 承認待ちの下書き(ステッパーは種類しか見ないので、結果の中身は空でよい) */
function opDraft(op: EditOp): Draft {
  return { kind: 'op', id: '1', record: record(op), outcome: { ok: false, message: '' }, diff: null, issues: [] } as unknown as Draft
}

function load() {
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null }))
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: '手順の切り替え' })
}

function stepButton(name: string): HTMLButtonElement {
  return within(nav()).getByRole('button', { name }) as HTMLButtonElement
}

/**
 * 名前と説明(読み上げで名前の後に読まれる状態)でボタンを探し、見つかるかを返す。
 * 説明は aria-describedby の先から読み上げと同じ計算で求める(説明の先が読み上げから外れると見つからなくなる)
 */
function hasStatus(name: string, description: string): boolean {
  return within(nav()).queryByRole('button', { name, description }) !== null
}

/** 状態の説明が無い(aria-describedby を付けない) */
function hasNoStatus(name: string): boolean {
  return stepButton(name).getAttribute('aria-describedby') === null && hasStatus(name, '')
}

/** 番号の丸(ボタンの最初の子) */
function circleOf(button: HTMLElement): HTMLElement {
  return button.firstElementChild as HTMLElement
}

/** 見える名前の外側(読み上げ用の名前と、折り返しを挟んだ見える名前を持つ) */
function labelOf(button: HTMLElement): HTMLElement {
  return button.lastElementChild as HTMLElement
}

function hasCheck(button: HTMLElement): boolean {
  return button.querySelector('svg.lucide-check') !== null
}

function hasDot(button: HTMLElement): boolean {
  return button.querySelector('[data-pending-dot]') !== null
}

afterEach(() => {
  cleanup()
  act(() => {
    useEditStore.getState().setBase(null)
    useGtfsStore.getState().clear()
    useResearchStore.getState().reset()
    useDriversStore.getState().reset()
    useStepStore.setState({ current: 'load' })
  })
})

describe('手順のステッパー', () => {
  it('6つの手順を番号つきの名前で並べ、名前に状態を混ぜない', () => {
    render(<Stepper />)
    expect(within(nav()).getAllByRole('listitem')).toHaveLength(6)
    const names = ['1. 読み込み', '2. 運行の前提', '3. 減便の方針', '4. 影響(到達圏)', '5. 平日便を戻す', '6. 出力']
    const buttons = within(nav()).getAllByRole('button')
    expect(buttons).toHaveLength(6)
    names.forEach((n, i) => expect(buttons[i]).toBe(stepButton(n)))
    // 見える名前は、狭い列で「減便の/方針」「影響/(到達圏)」と折り返せるよう <wbr> を挟む(読み上げからは隠す)
    const visible = stepButton('3. 減便の方針').querySelector('span[aria-hidden="true"]:last-child')!
    expect(visible.innerHTML).toBe('減便の<wbr>方針')
    expect(stepButton('4. 影響(到達圏)').querySelector('span[aria-hidden="true"]:last-child')!.innerHTML).toBe('影響<wbr>(到達圏)')
  })

  it('読み込む前は2〜6を押せず、薄くして「GTFS を読み込むと開けます」を出す。今の手順は aria-current="step"', () => {
    render(<Stepper />)
    const first = stepButton('1. 読み込み')
    expect(first.getAttribute('aria-current')).toBe('step')
    expect(first.disabled).toBe(false)
    expect(circleOf(first).className).toContain('bg-primary')
    expect(labelOf(first).className).toContain('font-semibold')
    for (const name of ['2. 運行の前提', '3. 減便の方針', '4. 影響(到達圏)', '5. 平日便を戻す', '6. 出力']) {
      const b = stepButton(name)
      expect(b.disabled).toBe(true)
      expect(b.title).toBe('GTFS を読み込むと開けます')
      expect(b.getAttribute('aria-current')).toBeNull()
      // ボタン全体は半透明にせず(丸の下の横線が透けるため)、丸と名前を薄くする
      expect(b.className).not.toContain('opacity')
      expect(circleOf(b).className).toContain('text-muted-foreground/50')
      expect(circleOf(b).className).toContain('bg-background')
      expect(labelOf(b).className).toContain('text-muted-foreground/50')
      fireEvent.click(b)
    }
    expect(useStepStore.getState().current).toBe('load')
    // まだ何も済んでいない。横線も塗らない
    expect(hasCheck(first)).toBe(false)
    expect(hasNoStatus('1. 読み込み')).toBe(true)
    expect(nav().querySelectorAll('[data-lit]')).toHaveLength(0)
  })

  it('読み込んだら読み込みが済みになり(チェック)、どの手順へも押して移れる', () => {
    load()
    render(<Stepper />)
    const first = stepButton('1. 読み込み')
    expect(hasCheck(first)).toBe(true)
    expect(hasStatus('1. 読み込み', '済み')).toBe(true)
    expect(hasStatus('1. 読み込み', '')).toBe(false)
    // 丸の中は番号の代わりにチェック。名前は変わらない(stepButton('1. 読み込み') で見つかる)
    expect(circleOf(first).textContent).toBe('')
    // 押せる手順は薄くしない
    expect(circleOf(stepButton('2. 運行の前提')).className).not.toContain('text-muted-foreground/50')

    fireEvent.click(stepButton('4. 影響(到達圏)'))
    expect(useStepStore.getState().current).toBe('reach')
    const reach = stepButton('4. 影響(到達圏)')
    expect(reach.getAttribute('aria-current')).toBe('step')
    expect(stepButton('1. 読み込み').getAttribute('aria-current')).toBeNull()
    // 塗るのは今の手順の丸だけ。名前を太字にするのも今の手順だけ
    expect(circleOf(reach).className).toContain('bg-primary')
    expect(labelOf(reach).className).toContain('font-semibold')
    expect(circleOf(stepButton('1. 読み込み')).className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
    expect(labelOf(stepButton('1. 読み込み')).className).not.toContain('font-semibold')
    // 見るだけの手順は、開いても済みにしない
    expect(hasCheck(reach)).toBe(false)
    expect(hasNoStatus('4. 影響(到達圏)')).toBe(true)
  })

  it('済みはデータで決める:在籍の運転士の数か営業所、承認した方針、平日に戻した便', () => {
    load()
    render(<Stepper />)
    for (const name of ['2. 運行の前提', '3. 減便の方針', '5. 平日便を戻す', '6. 出力']) expect(hasCheck(stepButton(name))).toBe(false)

    // 周辺の施設の調査の結果だけでは、運行の前提は済みにしない
    act(() => useResearchStore.getState().mergeResults([{ targetId: 'op:1' } as unknown as ResearchResult]))
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(false)
    // 欠員だけでも済みにしない(欠員は減便の方針の手順で入れる)
    act(() => useDriversStore.getState().setShortage(19))
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(false)
    // 在籍の運転士の数を入れたら済み
    act(() => useDriversStore.getState().setRoster(150))
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(true)
    expect(hasStatus('2. 運行の前提', '済み')).toBe(true)
    // 在籍を消しても、営業所を置いていれば済み
    act(() => {
      useDriversStore.getState().setRoster(null)
      useDriversStore.setState({ places: [{ id: 'p1', type: 'office', name: '営業所', lat: 43.76, lon: 142.36 }] })
    })
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(true)
    act(() => useDriversStore.setState({ places: [] }))
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(false)
    act(() => useDriversStore.getState().setRoster(150))

    act(() => useEditStore.setState({ history: [record(POLICY)] }))
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(true)
    expect(hasStatus('3. 減便の方針', '済み')).toBe(true)
    expect(hasCheck(stepButton('5. 平日便を戻す'))).toBe(false)

    act(() => useEditStore.setState({ history: [record(POLICY), record(ADD_BACK)] }))
    expect(hasCheck(stepButton('5. 平日便を戻す'))).toBe(true)

    // 平日に戻した便をすべて取り消したら、済みでなくなる
    act(() => useEditStore.setState({ history: [record(POLICY), record(ADD_BACK), record({ type: 'withdrawAddBack', tripIds: ['T1'] })] }))
    expect(hasCheck(stepButton('5. 平日便を戻す'))).toBe(false)
    // 見るだけの手順は済みにしない
    expect(hasCheck(stepButton('4. 影響(到達圏)'))).toBe(false)
    expect(hasCheck(stepButton('6. 出力'))).toBe(false)
  })

  it('承認待ちの下書きがある手順に点を出し、説明で「承認待ち」と伝える', () => {
    load()
    render(<Stepper />)
    act(() => useEditStore.setState({ draft: opDraft(POLICY) }))
    const policy = stepButton('3. 減便の方針')
    expect(hasDot(policy)).toBe(true)
    expect(hasStatus('3. 減便の方針', '承認待ちの下書きあり')).toBe(true)
    expect(hasDot(stepButton('5. 平日便を戻す'))).toBe(false)

    // 平日に戻す下書きは「平日便を戻す」。方針は承認済みなので、済みと承認待ちを並べない
    act(() => useEditStore.setState({ history: [record(POLICY)], draft: opDraft(ADD_BACK) }))
    expect(hasDot(stepButton('3. 減便の方針'))).toBe(false)
    expect(hasStatus('3. 減便の方針', '済み')).toBe(true)
    expect(hasDot(stepButton('5. 平日便を戻す'))).toBe(true)
    expect(hasStatus('5. 平日便を戻す', '承認待ちの下書きあり')).toBe(true)

    // 承認済みの方針を置き換える下書きは、済みと承認待ちの両方
    act(() => useEditStore.setState({ draft: opDraft(POLICY) }))
    expect(hasStatus('3. 減便の方針', '済み、承認待ちの下書きあり')).toBe(true)

    // 元に戻す下書きは「減便の方針」で確かめる
    act(() => useEditStore.setState({ draft: { kind: 'undo', id: '2', by: 'claude', result: null, diff: null } }))
    expect(hasDot(stepButton('3. 減便の方針'))).toBe(true)
    expect(hasDot(stepButton('5. 平日便を戻す'))).toBe(false)

    act(() => useEditStore.setState({ draft: null }))
    expect(hasDot(stepButton('3. 減便の方針'))).toBe(false)
    expect(hasStatus('3. 減便の方針', '済み')).toBe(true)
  })

  it('横線は最後の済んだ手順までを塗る(見るだけの手順を挟んでも途中で切らず、出力までは伸ばさない)', () => {
    load()
    render(<Stepper />)
    /** 塗った横線を「前の手順→後の手順」の組で返す(li の左半分は前の手順から、右半分は次の手順へ) */
    const litPairs = () =>
      within(nav())
        .getAllByRole('listitem')
        .flatMap((li, i) =>
          [...li.querySelectorAll(':scope > [data-lit]')].map((el) => (el.className.includes('left-0') ? `${i}-${i + 1}` : `${i + 1}-${i + 2}`)),
        )
    // 読み込みだけでは、塗る横線は無い
    expect(litPairs()).toEqual([])

    act(() => useDriversStore.getState().setRoster(150))
    act(() => useEditStore.setState({ history: [record(POLICY), record(ADD_BACK)] }))
    // 1・2・3・5 が済み。1→5 は切れ目なく塗り、5→6 は塗らない
    expect(new Set(litPairs())).toEqual(new Set(['1-2', '2-3', '3-4', '4-5']))
    expect(litPairs()).toHaveLength(8)
  })

  it('承認・元に戻す・読み込み直しで、済みの印が付き、消える(本物の store の操作で)', () => {
    act(() => useGtfsStore.getState().setLoaded({ label: 'test.zip', feed: smallFeed() }))
    load()
    render(<Stepper />)
    act(() => useDriversStore.getState().setRoster(150))
    expect(hasCheck(stepButton('2. 運行の前提'))).toBe(true)

    act(() => {
      expect(useEditStore.getState().propose(POLICY, 'user').ok).toBe(true)
    })
    expect(hasDot(stepButton('3. 減便の方針'))).toBe(true)
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(false)
    act(() => {
      expect(useEditStore.getState().commit()).toEqual({ ok: true })
    })
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(true)
    expect(hasDot(stepButton('3. 減便の方針'))).toBe(false)

    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'user')
      expect(useEditStore.getState().commit()).toEqual({ ok: true })
    })
    expect(hasCheck(stepButton('5. 平日便を戻す'))).toBe(true)

    // 元に戻すと、平日に戻した便が無くなる
    act(() => useEditStore.getState().undo())
    expect(hasCheck(stepButton('5. 平日便を戻す'))).toBe(false)
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(true)
    // すべて元に戻すと、方針も無くなる
    act(() => useEditStore.getState().undoAll())
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(false)
    act(() => {
      useEditStore.getState().propose(POLICY, 'user')
      useEditStore.getState().commit()
    })
    expect(hasCheck(stepButton('3. 減便の方針'))).toBe(true)

    // 読み込み直し(LoadStep と同じく、前の GTFS を捨ててから読み込む)。在籍の運転士の数は gtfs の store の購読で消える
    act(() => {
      useGtfsStore.getState().clear()
      useEditStore.getState().setBase(null)
    })
    expect(useDriversStore.getState().roster).toBeNull()
    for (const name of ['2. 運行の前提', '3. 減便の方針', '4. 影響(到達圏)']) expect(stepButton(name).disabled).toBe(true)
    act(() => useGtfsStore.getState().setLoaded({ label: 'test.zip', feed: smallFeed() }))
    load()
    const checked = within(nav())
      .getAllByRole('button')
      .filter((b) => hasCheck(b))
    expect(checked).toEqual([stepButton('1. 読み込み')])
  })

  it('地図を隠す広い手順では、幅を抑えて中央にそろえる', () => {
    const { rerender } = render(<Stepper />)
    const list = () => screen.getByRole('navigation', { name: '手順の切り替え' }).querySelector('ol')!
    expect(list().className).not.toContain('max-w-2xl')
    rerender(<Stepper wide />)
    expect(list().className).toContain('max-w-2xl')
    expect(list().className).toContain('mx-auto')
  })
})
