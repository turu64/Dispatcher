// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { RestoreHintContext } from '@/gtfs/edit/restore'
import type { EditOp } from '@/gtfs/edit/ops'
import { buildRestoreHintContext } from '@/store/restoreHintContext'
import { useChatStore } from '@/store/chat'
import { useEditStore } from '@/store/edit'
import { useReachStore } from '@/store/reach'
import RestoreStep from './RestoreStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

// 到達圏の前後の比較(ctx)は、この画面では作らない。ctx を渡したときだけ、R3_0730_WK に到達圏を使う2つの手がかりを付ける
// (手がかりの計算そのものは gtfs/edit/restore.test.ts で確かめている)
// 比較の日付 2026-11-04(水)は smallFeed の平日(WK)の運行日
const FAKE_CTX = { fake: true, date: '20261104' } as unknown as RestoreHintContext
vi.mock('@/store/restoreHintContext', () => ({ buildRestoreHintContext: vi.fn(() => null) }))
vi.mock('@/gtfs/edit/restore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/gtfs/edit/restore')>()
  return {
    ...original,
    createRestoreHinter: (...args: Parameters<typeof original.createRestoreHinter>) => {
      const hinter = original.createRestoreHinter(...args)
      return (trip: Parameters<typeof hinter>[0], ctx?: RestoreHintContext) => {
        const detail = hinter(trip)
        if (ctx !== FAKE_CTX || trip.tripId !== 'R3_0730_WK') return detail
        return { hints: [...detail.hints, 'onlyServiceAtStop' as const, 'restoresLostCells' as const], lostCells: { cells: 1234, population: 5678.4 } }
      }
    },
  }
})

const realAskRestore = useChatStore.getState().askRestore

function policy(): EditOp {
  const { addBackTripIds: _a, ...settings } = basePlan()
  return { type: 'applyPolicy', settings, reason: { category: null, note: '' } }
}

function candidateIds(): string[] {
  const list = screen.getByRole('list', { name: '足し戻す便の候補' })
  return within(list)
    .queryAllByRole('checkbox')
    .map((c) => /([A-Z0-9]+_\d{4}_WK)/.exec(c.getAttribute('aria-label') ?? '')?.[1] ?? '')
}

beforeEach(() => {
  act(() => {
    useEditStore.getState().setBase({ feed: smallFeed(), zip: new ArrayBuffer(0), label: 'test.zip', sample: null })
    useEditStore.getState().propose(policy(), 'user')
    useEditStore.getState().commit()
  })
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.restoreAllMocks()
  vi.mocked(buildRestoreHintContext).mockReset()
  vi.mocked(buildRestoreHintContext).mockReturnValue(null)
  useChatStore.setState({ status: { state: 'unknown' }, token: null, toolRunning: false, sending: false, budgetReached: false, askRestore: realAskRestore })
  useReachStore.setState({ computing: false, error: null })
})

describe('RestoreStep', () => {
  it('方針を承認する前は、方針の承認を促す', () => {
    act(() => useEditStore.getState().undoAll())
    render(<RestoreStep />)
    expect(screen.getByText('手順2で減便の方針を承認すると、消える平日便から足し戻す便を選べます。')).toBeTruthy()
  })

  it('候補は消える平日便で、手がかりの多い順に並べ、停留所名・手がかりで絞り込める', () => {
    render(<RestoreStep />)
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '学校' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    fireEvent.change(screen.getByLabelText('停留所名(一部)'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'lastTripOfRoute' } })
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'onlyTripInBand' } })
    expect(candidateIds()).toEqual(['R3_0730_WK', 'R2_0900_WK'])
    fireEvent.change(screen.getByLabelText('系統'), { target: { value: 'R1' } })
    expect(candidateIds()).toEqual([])
    expect(screen.getByText('当てはまる便がありません。')).toBeTruthy()
  })

  it('受け付けなかった便は、理由をつけて出し、一覧から除ける', () => {
    // R1_0700_WK は土曜の R1_0700_SA と同じ時刻なので、足し戻す必要が無い
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_0700_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
    })
    render(<RestoreStep />)
    const added = screen.getByRole('region', { name: '足し戻した便' })
    expect(added.textContent).toContain('足し戻した便(0 便)')
    expect(added.textContent).toContain('R1_0700_WK:土曜ダイヤに同じ時刻の便(R1_0700_SA)があるため、足し戻す必要がありません。')
    fireEvent.click(within(added).getByRole('button', { name: 'R1_0700_WK を一覧から除く' }))
    expect(screen.queryByRole('region', { name: '足し戻した便' })).toBeNull()
  })

  it('方針の下書きを確かめている間は、足し戻せない', () => {
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    render(<RestoreStep />)
    fireEvent.click(within(screen.getByRole('list', { name: '足し戻す便の候補' })).getAllByRole('checkbox')[0])
    expect(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' })).toHaveProperty('disabled', true)
    expect(screen.getByText('手順2の方針の下書きを承認するか、やめてから足し戻してください。')).toBeTruthy()
  })

  it('Claude の下書きがあるときに足し戻すと、画面の中で捨ててよいかを確かめ、「やめる」なら選んだ便も下書きも残る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'claude')
    })
    const draftId = useEditStore.getState().draft!.id
    const browserConfirm = vi.spyOn(window, 'confirm')
    render(<RestoreStep />)
    const boxes = () => within(screen.getByRole('list', { name: '足し戻す便の候補' })).getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes()[1])
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))

    // ボタンの場所に確認が出る。まだ何も変えていない
    const box = screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })
    expect(box.textContent).toContain(`Claude の下書き ${draftId} を捨てて、この操作をしますか。`)
    expect(screen.queryByRole('button', { name: '選んだ 1 便を足し戻す' })).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(1)

    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().draft?.id).toBe(draftId)
    expect(useEditStore.getState().history).toHaveLength(1)
    expect(boxes()[1].checked).toBe(true)
    expect(screen.queryByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeNull()

    // 「捨てて続ける」なら、Claude の下書きを捨てて足し戻す
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(useEditStore.getState().versions.at(-1)?.plan.addBackTripIds).toEqual(['R2_0900_WK'])
    expect(useEditStore.getState().draftNotices).toEqual([expect.objectContaining({ draftId, result: 'replaced' })])
    expect(screen.getByRole('status').textContent).toContain('1 便を足し戻しました')
    expect(boxes().every((b) => !b.checked)).toBe(true)
    expect(browserConfirm).not.toHaveBeenCalled()
  })

  it('Claude の下書きがあるときに足し戻しを取り消すと、足し戻した便の欄で確かめ、確かめたあとで取り消す', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'user')
      useEditStore.getState().commit()
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R2_0900_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    const added = screen.getByRole('region', { name: '足し戻した便' })
    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK の足し戻しを取り消す' }))
    const box = within(added).getByRole('group', { name: 'Claude の下書きを捨てる確認' })
    expect(useEditStore.getState().history).toHaveLength(2)
    fireEvent.click(within(box).getByRole('button', { name: 'やめる' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(useEditStore.getState().draft).not.toBeNull()

    fireEvent.click(within(added).getByRole('button', { name: 'R3_0730_WK の足し戻しを取り消す' }))
    fireEvent.click(within(within(added).getByRole('group', { name: 'Claude の下書きを捨てる確認' })).getByRole('button', { name: '捨てて続ける' }))
    expect(useEditStore.getState().history).toHaveLength(3)
    expect(useEditStore.getState().draft).toBeNull()
    expect(useEditStore.getState().versions.at(-1)?.plan.addBackTripIds).toEqual([])
  })

  it('確かめている間に Claude の下書きがなくなったら、確かめは残さず、元のボタンに戻る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    fireEvent.click(within(screen.getByRole('list', { name: '足し戻す便の候補' })).getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' }))
    expect(screen.getByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeTruthy()
    // 別の場所で Claude の下書きを承認した
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(screen.queryByRole('group', { name: 'Claude の下書きを捨てる確認' })).toBeNull()
    expect(screen.getByRole('button', { name: '選んだ 1 便を足し戻す' })).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(2)
  })

  it('Claude の足し戻しの下書きは、承認するまで履歴に入らず、承認すると足し戻した便に入る', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '通学', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/Claude の提案\):便を 1 本足し戻す/)).toBeTruthy()
    expect(useEditStore.getState().history).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '承認する' }))
    expect(useEditStore.getState().history).toHaveLength(2)
    expect(screen.getByRole('region', { name: '足し戻した便' }).textContent).toContain('理由:通学(Claude(承認済み)')
  })

  it('到達圏の比較ができていれば、停留所で唯一の便と、外れたセルが戻る(セル数と人口)を手がかりに出す。できていなければ出さない', () => {
    const { unmount } = render(<RestoreStep />)
    const list = () => screen.getByRole('list', { name: '足し戻す便の候補' })
    expect(list().textContent).not.toContain('外れたセルが戻る')
    expect(list().textContent).not.toContain('停留所で唯一の便')
    expect(screen.queryByText(/この便だけを足し戻したときの値/)).toBeNull()
    unmount()

    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    // 承認済みの編集後のフィードを渡して、手がかりの ctx を作っている
    expect(vi.mocked(buildRestoreHintContext).mock.calls.at(-1)?.[1]).toBe(useEditStore.getState().versions.at(-1)?.feed)
    expect(list().textContent).toContain('停留所で唯一の便')
    expect(list().textContent).toContain('外れたセルが戻る(1,234 セル、約 5,678 人)')
    expect(screen.getByText(/この便だけを足し戻したときの値です/)).toBeTruthy()
    // 手がかりが付いた便が先頭に来る。手がかりでの絞り込みにも出る
    expect(candidateIds()[0]).toBe('R3_0730_WK')
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 比較の日付を注記に出す
    expect(screen.getByText(/2026年11月4日\(水\)の到達圏の前後の比較から出しています/)).toBeTruthy()
  })

  it('到達圏を使う手がかりで絞り込んだまま比較が無くなったら(計算中など)、絞り込みを「すべて」に戻し、出していない理由を出す', () => {
    vi.mocked(buildRestoreHintContext).mockReturnValue(FAKE_CTX)
    render(<RestoreStep />)
    fireEvent.change(screen.getByLabelText('手がかり'), { target: { value: 'restoresLostCells' } })
    expect(candidateIds()).toEqual(['R3_0730_WK'])
    // 到達圏の計算が始まると、比較が無くなる(buildRestoreHintContext は null)
    vi.mocked(buildRestoreHintContext).mockReturnValue(null)
    act(() => useReachStore.setState({ computing: true }))
    expect(candidateIds()).toHaveLength(3)
    expect((screen.getByLabelText('手がかり') as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(/到達圏を計算しているので/)).toBeTruthy()
    // 計算に失敗したとき
    act(() => useReachStore.setState({ computing: false, error: '計算できませんでした' }))
    expect(screen.getByText(/到達圏の計算に失敗したので/)).toBeTruthy()
  })

  it('下書きを確かめている間は、到達圏を使う手がかりを出していない理由を出す', () => {
    act(() => {
      useEditStore.getState().propose({ type: 'addBack', items: [{ tripId: 'R1_0800_WK', reason: '', schoolDaysOnly: false }] }, 'claude')
    })
    render(<RestoreStep />)
    expect(screen.getByText(/下書きを確かめている間は/)).toBeTruthy()
  })

  it('比較の日付に平日の便が走らないときは、そう書く', () => {
    // 20261103 は smallFeed の WK の運休日
    vi.mocked(buildRestoreHintContext).mockReturnValue({ ...FAKE_CTX, date: '20261103' } as RestoreHintContext)
    render(<RestoreStep />)
    expect(screen.getByText(/2026年11月3日\(火\)\)は平日ダイヤの運行日ではない/)).toBeTruthy()
  })

  it('AI に候補を聞くボタン:AI が使えるときだけ押せて、押すと依頼を送る。使えないときは理由を出す', () => {
    const askRestore = vi.fn(async () => true)
    useChatStore.setState({ status: { state: 'ready', available: false, tokenRequired: false }, askRestore })
    const { unmount } = render(<RestoreStep />)
    const button = () => screen.getByRole('button', { name: 'AI に候補を聞く' }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    expect(screen.getByText(/AI は使えません/)).toBeTruthy()
    unmount()

    act(() => useChatStore.setState({ status: { state: 'ready', available: true, tokenRequired: false } }))
    render(<RestoreStep />)
    expect(button().disabled).toBe(false)
    fireEvent.click(button())
    expect(askRestore).toHaveBeenCalledTimes(1)

    // 方針の下書きを確かめている間は、足し戻せないのと同じに、聞けない
    act(() => {
      useEditStore.getState().propose(policy(), 'user')
    })
    expect(button().disabled).toBe(true)
    expect(screen.getAllByText('手順2の方針の下書きを承認するか、やめてから聞いてください。').length).toBeGreaterThan(0)
  })
})
