// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { editGroups } from '@/gtfs/groups/edit'
import { kyotoLike } from '@/gtfs/groups/groups.fixture'
import { mergeJevAnswers } from '@/gtfs/groups/merge'
import { policyServicesFor } from '@/gtfs/groups/policy'
import { proposeGroups } from '@/gtfs/groups/rules'
import type { JevJudgeResponse, ServiceGroups } from '@/gtfs/groups/types'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { GroupReplaceFields } from './GroupReplaceFields'
import { hasKindEdits, manualEdits, targetsText, type ReplaceMode } from './groupReplace'

// 減便の方針の詳しい設定の「入れ替えるダイヤ」(指摘19。docs/tasks-1105.md の U04)

const SAT = 'weekdayToSaturday' as const

afterEach(() => {
  cleanup()
  act(() => useServiceGroupsStore.getState().reset())
})

function applyAll(groups: ServiceGroups, edits: ReturnType<typeof manualEdits>): ServiceGroups {
  return edits.reduce((g, e) => editGroups(g, e), groups)
}

function row(groups: ServiceGroups, id: string) {
  return groups.byKind[SAT].rows.find((r) => r.serviceId === id)!
}

describe('manualEdits(手動の欄の選択 → GroupEdit)', () => {
  const g = proposeGroups(kyotoLike())

  it('入れ替えない:先に割り当てを外してから残す(editGroups が受け付ける順)', () => {
    const edits = manualEdits(g.byKind[SAT], '01001_A', { replace: false })
    expect(edits).toEqual([
      { kind: SAT, serviceId: '03001_A', into: null },
      { kind: SAT, serviceId: '01001_A', treatment: 'keep' },
    ])
    const next = applyAll(g, edits)
    expect(row(next, '01001_A')).toMatchObject({ treatment: 'keep', basisMark: 'edited' })
    const v = policyServicesFor(next, SAT)
    if ('error' in v) throw new Error('作れるはず')
    expect(v.keptWeekdayServices).toContain('01001_A')
    expect(v.pairs?.map((p) => p.weekday)).not.toContain('01001_A')
  })

  it('入れ替え先を選ぶ:ほかの割り当てを外し、選んだ service をこの平日の service に付け替える', () => {
    // 03001_A を 01005_MSN(今は「なくす」)に付け替える
    const edits = manualEdits(g.byKind[SAT], '01005_MSN', { replace: true, target: '03001_A' })
    expect(edits).toEqual([{ kind: SAT, serviceId: '03001_A', into: '01005_MSN' }])
    const next = applyAll(g, edits)
    const v = policyServicesFor(next, SAT)
    if ('error' in v) throw new Error('作れるはず')
    expect(v.pairs).toContainEqual({ weekday: '01005_MSN', replacements: ['03001_A'] })
    // 01001_A は入れ替え先がなくなり「なくす」になる(入れ替え先は1つ)
    expect(v.pairs).toContainEqual({ weekday: '01001_A', replacements: [] })
  })

  it('便をなくす:割り当てを外し、扱いはなくす(今と同じ扱いの直しは入れない)', () => {
    expect(manualEdits(g.byKind[SAT], '01001_A', { replace: true, target: null })).toEqual([{ kind: SAT, serviceId: '03001_A', into: null }])
  })

  it('残していた service を入れ替えるにすると、扱いだけをなくすにする', () => {
    expect(manualEdits(g.byKind[SAT], '01002_RIT', { replace: true })).toEqual([{ kind: SAT, serviceId: '01002_RIT', treatment: 'erase' }])
    // 今と同じなら何もしない
    expect(manualEdits(g.byKind[SAT], '01002_RIT', { replace: false })).toEqual([])
    expect(manualEdits(g.byKind[SAT], '01001_A', { replace: true, target: '03001_A' })).toEqual([])
  })

  it('入れ替えに使う service・知らない service・形2で表せない service の「入れ替える」は直しにしない', () => {
    expect(manualEdits(g.byKind[SAT], '03001_A', { replace: false })).toEqual([])
    expect(manualEdits(g.byKind[SAT], 'NO_SUCH', { replace: false })).toEqual([])
    expect(manualEdits(g.byKind[SAT], '01001', { replace: true, target: 'NO_SUCH' })).toEqual([])
  })

  it('targetsText:1つ・複数・なし', () => {
    expect(targetsText(['03001'])).toBe('03001')
    expect(targetsText(['03001', 'SB1', 'SB2'])).toBe('03001 ほか 2')
    expect(targetsText([])).toBe('便をなくす')
  })

  it('hasKindEdits:その種類に直した行があるか', () => {
    expect(hasKindEdits(g, SAT)).toBe(false)
    expect(hasKindEdits(null, SAT)).toBe(false)
    const edited = editGroups(g, { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    expect(hasKindEdits(edited, SAT)).toBe(true)
    expect(hasKindEdits(edited, 'weekdayToSundayHoliday')).toBe(false)
  })
})

describe('画面', () => {
  function show(groups: ServiceGroups, mode: ReplaceMode = 'manual', onModeChange: (m: ReplaceMode) => void = () => {}) {
    act(() => useServiceGroupsStore.setState({ status: 'ready', groups }))
    const v = policyServicesFor(groups, SAT)
    render(
      <GroupReplaceFields
        kind={SAT}
        value={'error' in v ? null : v}
        errors={'error' in v ? v.error : null}
        mode={mode}
        onModeChange={onModeChange}
        tripCounts={new Map()}
        dropped={new Set()}
        skipped={new Set()}
      />,
    )
  }

  function manualRow(serviceId: string): HTMLElement {
    return screen.getByTestId('group-replace-manual').querySelector(`[data-service="${serviceId}"]`) as HTMLElement
  }

  it('食い違い(規則と Jev)の行は、手動の欄で Jev の値を出し、「規則の値のまま進める」で受け入れる。焦点は行の選び方に移す', () => {
    const res: JevJudgeResponse = {
      model: 'typesafe-ai/jev',
      results: [
        {
          serviceId: '03001_A',
          role: 'saturday',
          provider: 'typesafe-ai',
          sent: { state: {}, questions: {} },
          weekdayCounterpart: { choice: '01005_MSN', probabilities: { '01005_MSN': 0.95 }, confidence: 0.95 },
        },
      ],
      failures: [],
      usage: { inputTokens: 1, costUsd: 0 },
    }
    show(mergeJevAnswers(proposeGroups(kyotoLike()), res))
    // 規則では 03001_A は 01001_A に入る。その行に食い違いを出す
    const r = manualRow('01001_A')
    expect(r.textContent).toContain('03001_A は、規則と Jev が食い違っています(Jev:01005_MSN)')
    fireEvent.click(within(r).getByRole('button', { name: '規則の値のまま進める' }))
    expect(row(useServiceGroupsStore.getState().groups!, '03001_A')).toMatchObject({ into: '01001_A', intoMark: 'edited' })
    expect(document.activeElement).toBe(within(manualRow('01001_A')).getByRole('radio', { name: '入れ替える' }))
    // 受け入れたあとは「案に戻す」で戻せる
    fireEvent.click(within(manualRow('01001_A')).getByRole('button', { name: '案に戻す' }))
    expect(row(useServiceGroupsStore.getState().groups!, '03001_A').intoMark).toBe('conflict')
  })

  it('入れ替えないにした行は、入れ替え先を出さない', () => {
    show(proposeGroups(kyotoLike()))
    expect(within(manualRow('01002_RIT')).queryByRole('combobox')).toBeNull()
    expect(within(manualRow('01002_RIT')).getByRole('radio', { name: '入れ替えない' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(manualRow('01002_RIT')).getByRole('radio', { name: '入れ替える' }))
    const select = within(manualRow('01002_RIT')).getByRole('combobox', { name: '01002_RIT の入れ替え先(土曜)' }) as HTMLSelectElement
    expect(select.value).toBe('__none__')
    expect(manualRow('01002_RIT').textContent).toContain('期間の間この service の便をなくします')
  })

  it('自動では組の内訳を出し、手動の欄は出さない。自動に戻すとこの種類の直しを捨てる', () => {
    const modes: ReplaceMode[] = []
    const edited = editGroups(proposeGroups(kyotoLike()), { kind: SAT, serviceId: '01005_MSN', treatment: 'keep' })
    show(edited, 'manual', (m) => modes.push(m))
    fireEvent.click(screen.getByRole('radio', { name: '自動(グループ分けのとおり。既定)' }))
    expect(modes).toEqual(['auto'])
    expect(hasKindEdits(useServiceGroupsStore.getState().groups, SAT)).toBe(false)
    cleanup()
    show(proposeGroups(kyotoLike()), 'auto')
    expect(screen.queryByTestId('group-replace-manual')).toBeNull()
    expect(screen.getByRole('list', { name: '組の内訳' })).toBeTruthy()
  })
})
