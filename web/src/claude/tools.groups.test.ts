import { describe, expect, it, vi } from 'vitest'
import { multiFeed } from '../gtfs/edit/form2.fixture'
import type { GroupedPolicyServices } from '../gtfs/groups/view'
import { createEditStore, type BaseGtfs } from '../store/edit'
import { runTool, type PolicyServices, type ReachAccess, type ToolDeps } from './tools'

// 確定したダイヤのグループ分け(複数の組)で、AI のツールが動くこと(docs/design-service-groups.md §5.3)

const NOW = new Date('2026-11-04T00:30:00Z')

const IDLE_REACH: ReachAccess = {
  getState: () => ({
    date: '20261110',
    stepHours: 3,
    computing: false,
    error: null,
    snapshot: null,
    setDate: () => null,
    setStepHours: () => undefined,
  }),
  subscribe: () => () => undefined,
}

/** multiFeed を土曜ダイヤに入れ替える組(form2.fixture の multiPlan と同じ)。日祝は形2で表せない service があり作れない */
const CONFIRMED: GroupedPolicyServices = {
  status: 'confirmed',
  byKind: {
    weekdayToSaturday: {
      kind: 'weekdayToSaturday',
      weekdayService: '01001',
      replacementService: '03001',
      pairs: [
        { weekday: '01001', replacements: ['03001'] },
        { weekday: '01001_A', replacements: ['03001_A'] },
        { weekday: '01001_C', replacements: ['03001_C'] },
        { weekday: '01005_MSN', replacements: [] },
        { weekday: 'WB', replacements: ['SB1', 'SB2'] },
      ],
      keptWeekdayServices: ['01002_RIT'],
    },
    weekdayToSundayHoliday: {
      error: [{ severity: 'error', code: 'unsupportedService', serviceIds: ['MS'], message: '形2で表せない service が 1 つあります(MS)。' }],
    },
  },
}

function setup(services: PolicyServices) {
  const store = createEditStore({ now: () => NOW, onEdited: vi.fn() })
  const base: BaseGtfs = { feed: multiFeed(), zip: new ArrayBuffer(0), label: 'multi.zip', sample: null }
  store.getState().setBase(base)
  const deps: ToolDeps = {
    edit: () => store.getState(),
    reach: IDLE_REACH,
    holidays: () => null,
    today: () => '20261104',
    policyServices: () => services,
    hintContext: () => null,
  }
  return { store, deps }
}

const POLICY = {
  kind: 'weekday_to_saturday',
  start_date: '20261103',
  end_date: null,
  excluded_route_ids: [],
  reason_category: null,
  reason_note: '',
}

const parse = (content: string) => JSON.parse(content) as Record<string, unknown>

describe('apply_policy は確定したグループ分けの組で下書きを作る', () => {
  it('組の表(pairs・keptWeekdayServices)で下書きを作り、結果の services.groups に組・残す・なくすを書く', async () => {
    const { store, deps } = setup({ weekday: 'WK', saturday: 'SA', sundayHoliday: null, groups: CONFIRMED })
    const r = await runTool('apply_policy', POLICY, deps)
    expect(r.isError).toBe(false)
    const body = parse(r.content)
    expect(body.services).toEqual({
      weekday: '01001',
      replacement: '03001',
      groups: {
        pairs: [
          { weekday: '01001', replacements: ['03001'] },
          { weekday: '01001_A', replacements: ['03001_A'] },
          { weekday: '01001_C', replacements: ['03001_C'] },
          { weekday: 'WB', replacements: ['SB1', 'SB2'] },
        ],
        kept: ['01002_RIT'],
        erased: ['01005_MSN'],
      },
    })
    expect(body.groups_note).toBeUndefined()
    // 組ごとのなくなる便・加わる便と、期間(11/3〜)に走らないため組ごと除いた 01001_C
    const pairs = (body.summary as { pairs: { weekday: string; dropped_for_period: boolean }[] }).pairs
    expect(pairs.map((p) => p.weekday)).toEqual(['01001', '01001_A', '01001_C', '01005_MSN', 'WB'])
    expect(pairs.find((p) => p.weekday === '01001_C')!.dropped_for_period).toBe(true)
    const draft = store.getState().draft
    if (draft?.kind !== 'op' || draft.record.op.type !== 'applyPolicy') throw new Error('下書きのはず')
    expect(draft.record.op.settings.pairs?.map((p) => p.weekday)).toEqual(['01001', '01001_A', '01001_C', '01005_MSN', 'WB'])
    expect(draft.record.op.settings.keptWeekdayServices).toEqual(['01002_RIT'])
    expect('notApplied' in draft.record.op.settings).toBe(false)
  })

  it('その種類のグループ分けが作れなければ(形2で表せない service)、下書きを作らずに理由を返す', async () => {
    const { store, deps } = setup({ weekday: 'WK', saturday: 'SA', sundayHoliday: 'SU', groups: CONFIRMED })
    const r = await runTool('apply_policy', { ...POLICY, kind: 'weekday_to_sunday_holiday' }, deps)
    expect(r.isError).toBe(true)
    expect(String(parse(r.content).message)).toContain('形2で表せない service')
    expect(store.getState().draft).toBeNull()
  })

  it('グループ分けが未確定なら、画面の平日の service だけで作り、groups_note で確定を促す', async () => {
    const { store, deps } = setup({ weekday: '01001', saturday: '03001', sundayHoliday: null, groups: { status: 'unconfirmed' } })
    const r = await runTool('apply_policy', POLICY, deps)
    expect(r.isError).toBe(false)
    expect(String(parse(r.content).groups_note)).toContain('01001 だけを入れ替える')
    const draft = store.getState().draft
    if (draft?.kind !== 'op' || draft.record.op.type !== 'applyPolicy') throw new Error('下書きのはず')
    expect(draft.record.op.settings.pairs).toBeUndefined()
  })
})

describe('承認したあとの add_back_trips・search_trips は、すべての組の平日の service を見る', () => {
  async function approved() {
    const s = setup({ weekday: 'WK', saturday: 'SA', sundayHoliday: null, groups: CONFIRMED })
    expect((await runTool('apply_policy', POLICY, s.deps)).isError).toBe(false)
    expect(s.store.getState().commit()).toEqual({ ok: true })
    return s
  }

  it('主でない組(WB)の便は受け付け、残す service(01002_RIT)の便は戻す必要がないと返す', async () => {
    const { deps } = await approved()
    const kept = await runTool('add_back_trips', { items: [{ trip_id: 'R4_01002_1300_RIT', reason: '', school_days_only: false }] }, deps)
    expect(kept.isError).toBe(true)
    expect(String(parse(kept.content).message)).toContain('平日のまま残す service の便')
    // 残す service の便だけのときは「平日の便ではない」と書かない(矛盾して読めるため)
    expect(String(parse(kept.content).message)).not.toContain('平日の便ではない')
    const mixed = await runTool(
      'add_back_trips',
      {
        items: [
          { trip_id: 'R4_01002_1300_RIT', reason: '', school_days_only: false },
          { trip_id: 'NO_SUCH_TRIP', reason: '', school_days_only: false },
        ],
      },
      deps,
    )
    const mixedText = String(parse(mixed.content).message)
    expect(mixedText).toContain('平日の便ではない trip_id があります(NO_SUCH_TRIP)')
    expect(mixedText).toContain('R4_01002_1300_RIT は、グループ分けで平日のまま残す')
    const wb = await runTool('add_back_trips', { items: [{ trip_id: 'R2_0900_WB', reason: '通学', school_days_only: false }] }, deps)
    expect(wb.isError).toBe(false)
  })

  it('base_weekday は期間に走る組の平日の service の便(期間に走らない 01001_C と残す 01002_RIT は入れない)', async () => {
    const { deps } = await approved()
    const r = await runTool('search_trips', { scope: 'base_weekday', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 50 }, deps)
    expect(r.isError).toBe(false)
    const ids = (parse(r.content).trips as { trip_id: string }[]).map((t) => t.trip_id).sort()
    expect(ids).toEqual(['R1_01001_0700', 'R1_01001_0800_K', 'R1_01001_0900_A', 'R1_01005_1200_MSN', 'R2_0900_WB', 'R3_01001_0730'])
  })

  it('removed(なくなる便)に、期間に走らないため組ごと除いた 01001_C の便を入れない', async () => {
    const { deps } = await approved()
    const r = await runTool('search_trips', { scope: 'removed', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 50 }, deps)
    const ids = (parse(r.content).trips as { trip_id: string }[]).map((t) => t.trip_id).sort()
    expect(ids).toEqual(['R1_01005_1200_MSN', 'R2_0900_WB', 'R3_01001_0730'])
  })

  it('方針が無いときの base_weekday は、確定したグループ分けの平日の service の便', async () => {
    const { deps } = setup({ weekday: 'WK', saturday: 'SA', sundayHoliday: null, groups: CONFIRMED })
    const r = await runTool('search_trips', { scope: 'base_weekday', route_ids: null, stop_name: null, depart_from: null, depart_to: null, limit: 50 }, deps)
    const ids = (parse(r.content).trips as { trip_id: string }[]).map((t) => t.trip_id)
    expect(ids).toContain('R1_01001_1000_C')
    expect(ids).toContain('R2_0900_WB')
    expect(ids).not.toContain('R4_01002_1300_RIT')
  })
})
