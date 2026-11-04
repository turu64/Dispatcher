// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { multiFeed, multiPlan } from '@/gtfs/edit/form2.fixture'
import { diffOf, lastVersion, useEditStore } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import ChangeOrder from './ChangeOrder'

// 変更指示書と前後の比較を、複数の組の減便の方針で確かめる(docs/design-service-groups.md §4.6・§5.3)

vi.mock('@/reach/workerClient', () => ({ computeReachInWorker: async () => new Promise(() => {}) }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T03:00:00Z') })
  useHolidayStore.setState({ holidays: { status: 'missing' } })
  act(() => useEditStore.getState().setBase({ feed: multiFeed(), zip: new ArrayBuffer(0), label: 'multi.zip', sample: null }))
  const { addBackTripIds: _a, ...settings } = multiPlan()
  act(() => {
    const proposed = useEditStore.getState().propose({ type: 'applyPolicy', settings, reason: { category: null, note: '' } }, 'user')
    if (!proposed.ok) throw new Error(proposed.message)
    const committed = useEditStore.getState().commit()
    if (!committed.ok) throw new Error(committed.message)
  })
})

afterEach(() => {
  cleanup()
  act(() => useEditStore.getState().setBase(null))
  vi.useRealTimers()
})

describe('複数の組', () => {
  it('前後の比較(diffOf)は、期間に走らないため組ごと除いた 01001_C の便を、なくなる便に数えない', () => {
    const state = useEditStore.getState()
    const diff = diffOf(state.base!.feed, lastVersion(state)!)
    expect(diff.removed.map((b) => b.tripId).sort()).toEqual(['R1_01005_1200_MSN', 'R2_0900_WB', 'R3_01001_0730'])
  })

  it('変更指示書に、ダイヤの語の文と組の内訳(組・なくす・残す・除いた組)を出す', () => {
    render(<ChangeOrder />)
    const sheet = screen.getByTestId('change-order')
    expect(sheet.textContent).toContain('入れ替えるダイヤ:')
    expect(sheet.textContent).toContain('平日のダイヤ(01001 ほか 2)を土曜のダイヤ(03001 ほか 3)の便に入れ替えます。')
    const list = within(sheet).getByRole('list', { name: '組の内訳' })
    expect(list.textContent).toContain('平日 WB ←に入れる便: 土曜 SB1・SB2')
    expect(list.textContent).toContain('なくす(入れ替えに使うダイヤがない):01005_MSN(1 便)')
    expect(list.textContent).toContain('平日のまま残す:01002_RIT')
    // 期間 11/3〜 では 01001_C の組は走らないため除く
    expect(list.textContent).toContain('減便の期間に走らないため除いた組:01001_C')
    expect(list.textContent).not.toContain('平日 01001_C')
  })
})
