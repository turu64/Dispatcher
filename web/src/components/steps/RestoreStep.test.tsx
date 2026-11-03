// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basePlan, smallFeed } from '@/gtfs/edit/form2.fixture'
import type { EditOp } from '@/gtfs/edit/ops'
import { useEditStore } from '@/store/edit'
import RestoreStep from './RestoreStep'

// 到達圏の store への受け渡し(setEdited)は、この画面では計算しない
vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

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
})
