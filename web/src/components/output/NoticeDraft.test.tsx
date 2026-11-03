// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { EditOp, Form2Plan } from '@/gtfs/edit/ops'
import { diffOf, lastVersion, useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import NoticeDraft from './NoticeDraft'

// 到達圏の計算は、この画面では走らせない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

const SAMPLE = { available: true, name: '道北バス', source: '北海道オープンデータプラットフォーム(gtfs-data)', license: 'CC BY 4.0' }

function policy(
  reason: { category: 'temporaryShortage' | null; note: string } = { category: 'temporaryShortage', note: '病欠のため' },
  overrides: Partial<Form2Plan> = {},
): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan(overrides)
  return { type: 'applyPolicy', settings, reason }
}

function approve(...ops: EditOp[]) {
  act(() => {
    for (const op of ops) {
      useEditStore.getState().propose(op, 'user')
      useEditStore.getState().commit()
    }
  })
}

beforeEach(() => {
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  window.print = vi.fn()
  act(() => useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: SAMPLE }))
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.restoreAllMocks()
})

function pick(name: RegExp) {
  fireEvent.click(within(screen.getByRole('list', { name: '停留所の選択' })).getByRole('button', { name }))
}

describe('NoticeDraft', () => {
  it('方針を承認するまでは案内だけを出す', () => {
    render(<NoticeDraft />)
    expect(screen.getByText(/減便の方針を承認すると、停留所ごとの掲示と告知文の文案を出します/)).toBeTruthy()
    expect(document.querySelector('.print-area')).toBeNull()
  })

  it('停留所を選ぶと、期間中の系統ごとの発車時刻と、運休する時刻を掲示に出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    // 期間の中で平日ダイヤが走る最初の日(20261101 は日曜、20261102 は月曜)
    expect(screen.getByText(/2026年11月2日\(月\)/)).toBeTruthy()
    expect(screen.getByText('停留所を選ぶと、その停留所の掲示を1枚ずつ表示して印刷できます。')).toBeTruthy()
    pick(/駅前/)

    const sheet = screen.getByRole('article', { name: '駅前の掲示' })
    expect(within(sheet).getByText(/駅前 のバスの時刻が変わります/)).toBeTruthy()
    const lines = within(sheet).getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(lines.some((t) => t.includes('系統 1') && t.includes('07:00') && t.includes('08:05'))).toBe(true)
    expect(lines.some((t) => t.includes('系統 2') && t.includes('10:00'))).toBe(true)
    // 運休する時刻
    expect(within(sheet).getByText(/運休する時刻/)).toBeTruthy()
    expect(within(sheet).getAllByText(/07:30/).length).toBeGreaterThan(0)
  })

  it('発車が無くなる停留所は「発車はありません」と、近くの停留所が無いことを出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/学校前/)
    const sheet = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(sheet).getByTestId('no-departure').textContent).toContain('発車はありません')
    expect(within(sheet).getByTestId('alternatives').textContent).toContain('半径300m以内に、期間中も発車がある別の停留所はありません')
    // 自由記入は掲示に載る
    fireEvent.change(screen.getByLabelText(/代わりに使える交通の自由記入/), { target: { value: '他社の路線バス 3番乗り場' } })
    expect(within(sheet).getByText('他社の路線バス 3番乗り場')).toBeTruthy()
  })

  it('足し戻した(学)の便には印を付ける', () => {
    approve(policy(), { type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: true }] })
    render(<NoticeDraft />)
    // 足し戻した便は時刻が変わらないので、既定の「差し替える停留所だけ」には出ない。外すと選べる
    expect(within(screen.getByRole('list', { name: '停留所の選択' })).queryByRole('button', { name: /学校前/ })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '掲示を差し替える停留所だけ' }))
    pick(/学校前/)
    const sheet = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(sheet).getByTestId('segment-single').textContent).toContain('07:40')
    expect(within(sheet).getByTestId('segment-single').textContent).toContain('(学)')
    expect(within(sheet).getByText('(学)の印の便は、学校の休業日は運休します。')).toBeTruthy()
  })

  it('印刷できる 1 枚だけを出し、印刷ボタンで window.print を呼ぶ', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/駅前/)
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'この掲示を印刷する' }))
    expect(window.print).toHaveBeenCalledTimes(1)

    // 別の停留所を選んでも 1 枚
    pick(/学校前/)
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '学校前の掲示' })).toBeTruthy()

    // 告知文に切り替えても 1 枚
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    expect(document.querySelectorAll('.print-area')).toHaveLength(1)
    expect(screen.getByRole('article', { name: '告知文' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この告知文を印刷する' }))
    expect(window.print).toHaveBeenCalledTimes(2)
  })

  it('告知文は第17条の5項目と、法定の様式ではない旨の注記を出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const sheet = screen.getByRole('article', { name: '告知文' })
    for (const n of [1, 2, 3, 4, 5]) expect(within(sheet).getByTestId(`announce-item-${n}`)).toBeTruthy()
    expect(within(sheet).getByTestId('announce-item-1').textContent).toContain('2026年11月1日から')
    expect(within(sheet).getByTestId('announce-item-2').textContent).toContain('運転士の一時的な欠員(病欠のため)')
    expect(within(sheet).getByTestId('announce-item-3').textContent).toContain('当面の間')
    expect(within(sheet).getByText(/法定の様式ではありません/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('場所(対象の地域・路線)'), { target: { value: '市内の全路線' } })
    fireEvent.change(screen.getByLabelText(/代わりに使える運行系統・他の運送事業/), { target: { value: '市内循環バス(他社)' } })
    expect(within(sheet).getByTestId('announce-item-1').textContent).toContain('市内の全路線')
    expect(within(sheet).getByTestId('announce-item-5').textContent).toBe('5. 代わりに使える運行系統・他の運送事業市内循環バス(他社)')
  })

  it('告知文の1項目めは利用者向けの見出しで印刷し、第17条の項目名(事故の日時・場所)は画面だけに出す', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const item = within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-1')
    expect(item.textContent).toContain('1. 変更の日時・場所')
    // 「事故」は印刷しない注記(print-hide)の中にだけある
    const legal = within(item).getByText(/事故の日時・場所/)
    expect(legal.closest('.print-hide')).not.toBeNull()
    const printed = item.cloneNode(true) as HTMLElement
    for (const el of printed.querySelectorAll('.print-hide')) el.remove()
    expect(printed.textContent).not.toContain('事故')
  })

  it('告知文の概要は、正味の便数の差と、消える便・入る便の内訳を分けて書く', () => {
    approve(policy())
    render(<NoticeDraft />)
    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    const state = useEditStore.getState()
    const version = lastVersion(state)
    if (!state.base || !version) throw new Error('承認済みの版がありません')
    const d = diffOf(state.base.feed, version)
    const before = d.removed.length + d.same.length
    const after = d.same.length + d.added.length
    // このフィードでは平日の便が消えも入りもする(入れ替え)
    expect(d.removed.length).toBeGreaterThan(0)
    expect(d.added.length).toBeGreaterThan(0)
    const text = within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-2').textContent ?? ''
    expect(text).toContain(`${before} 便から ${after} 便(`)
    expect(text).toContain(`平日ダイヤの時刻の ${d.removed.length} 便は運休し、土曜ダイヤの時刻の ${d.added.length} 便を運行します`)
    expect(text).not.toContain('便が運休となります')
  })

  it('方針で除外した系統は、掲示と告知文で平日ダイヤのまま運行すると書く', () => {
    // 学校線(R3)を除外:学校前は R3 だけが止まり、駅前は R1・R2・R3 が止まる
    approve(policy(undefined, { excludedRoutes: ['R3'] }))
    render(<NoticeDraft />)
    pick(/駅前/)
    const station = screen.getByRole('article', { name: '駅前の掲示' })
    expect(within(station).getByText(/駅前 のバスの時刻が変わります/)).toBeTruthy()
    expect(within(station).getByTestId('sheet-lead').textContent).toContain('ただし、系統 3は平日ダイヤのまま運行します。')
    expect(within(station).getByTestId('sheet-repost').textContent).toContain('減便前の時刻の掲示と差し替えてください')

    // 学校前は時刻が変わらないので「差し替える停留所だけ」を外して選ぶ
    fireEvent.click(screen.getByRole('checkbox', { name: '掲示を差し替える停留所だけ' }))
    pick(/学校前/)
    const school = screen.getByRole('article', { name: '学校前の掲示' })
    expect(within(school).getByText(/学校前 のバスの時刻は変わりません/)).toBeTruthy()
    expect(within(school).queryByText(/時刻が変わります/)).toBeNull()
    expect(within(school).getByTestId('sheet-lead').textContent).toContain('系統 3')
    expect(within(school).getByTestId('sheet-lead').textContent).toContain('平日ダイヤのまま運行します')
    expect(within(school).getByTestId('sheet-lead').textContent).not.toContain('土曜ダイヤの時刻で運行します')
    expect(within(school).getByTestId('sheet-repost').textContent).toContain('差し替えは不要です')

    fireEvent.click(screen.getByRole('radio', { name: '告知文(第17条の雛形)' }))
    expect(within(screen.getByRole('article', { name: '告知文' })).getByTestId('announce-item-4').textContent).toContain(
      '次の系統は平日ダイヤのまま運行します:3。',
    )
  })

  it('公示日から実施日まで7日を切ると、警告を出し、理由を掲示に入れる', () => {
    approve(policy())
    render(<NoticeDraft />)
    pick(/駅前/)
    const sheet = screen.getByRole('article', { name: '駅前の掲示' })
    // 公示日が空のうちは警告しない
    expect(screen.queryByText(/公示から実施まで7日を切っています/)).toBeNull()
    expect(within(sheet).getByTestId('sheet-effective').textContent).toContain('2026年11月1日')

    fireEvent.change(screen.getByLabelText('公示日'), { target: { value: '2026-10-28' } })
    expect(screen.getByText(/公示から実施まで7日を切っています/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/7日を切るときの理由/), { target: { value: '急な欠員のため' } })
    expect(within(sheet).getByTestId('sheet-late-reason').textContent).toBe('急な欠員のため')
    expect(within(sheet).getByTestId('sheet-announce').textContent).toContain('2026年10月28日')

    // 7日以上前なら警告は消える
    fireEvent.change(screen.getByLabelText('公示日'), { target: { value: '2026-10-20' } })
    expect(screen.queryByText(/公示から実施まで7日を切っています/)).toBeNull()
  })

  it('承認前の下書きがあるときは、承認済みの内容で作っていることを知らせる', () => {
    approve(policy())
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<NoticeDraft />)
    expect(screen.getByText('承認前の下書きがあります。周知文は承認済みの内容で作っています。')).toBeTruthy()
    pick(/学校前/)
    expect(screen.getByTestId('no-departure')).toBeTruthy()
  })
})
