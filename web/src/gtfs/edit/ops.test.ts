import { describe, expect, it } from 'vitest'
import type { GtfsFeed } from '../load'
import { serializeTable } from '../write'
import { applyForm2, type Form2Result } from './form2'
import { basePlan, smallFeed } from './form2.fixture'
import {
  addBackReasons,
  planOf,
  policyReasonOf,
  type EditOp,
  type EditRecord,
  type Form2Plan,
  type PolicySettings,
} from './ops'

const OPTS = { generatedAt: '202611041200' }
const TABLES = ['trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_info'] as const

function settings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  const { addBackTripIds: _a, ...rest } = basePlan()
  return { ...rest, ...overrides }
}

function record(op: EditOp, at = '2026-11-04T09:30:00+09:00', by: EditRecord['by'] = 'user'): EditRecord {
  return { op, by, at }
}

const POLICY: EditRecord = record({ type: 'applyPolicy', settings: settings(), reason: { category: 'temporaryShortage', note: '欠員 2 名' } })

function addBack(ids: string[], reason = ''): EditRecord {
  return record({ type: 'addBack', items: ids.map((tripId) => ({ tripId, reason, schoolDaysOnly: false })) })
}

function apply(feed: GtfsFeed, plan: Form2Plan | null): GtfsFeed {
  if (plan === null) return feed
  const outcome = applyForm2(feed, plan, OPTS)
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result.feed
}

/** 5 つの表を書き出したバイト列(結果を比べるため) */
function bytesOf(feed: GtfsFeed): string[] {
  return TABLES.map((name) => new TextDecoder().decode(serializeTable(feed.tables.get(name)!)))
}

describe('planOf と編集の操作', () => {
  it('操作の列から作った結果は、計画をまとめて適用した結果と同じ', () => {
    const base = smallFeed()
    const history = [POLICY, addBack(['R3_0730_WK']), addBack(['R1_0800_WK', 'R3_0730_WK'])]
    const plan = planOf(history)
    expect(plan).toEqual(basePlan({ addBackTripIds: ['R3_0730_WK', 'R1_0800_WK'] }))
    expect(bytesOf(apply(base, plan))).toEqual(bytesOf(apply(base, basePlan({ addBackTripIds: ['R3_0730_WK', 'R1_0800_WK'] }))))
  })

  it('足し戻しを後から足しても、計画全体を一度に適用した trip_id と同じになる', () => {
    const base = smallFeed()
    // 方針だけの版では、R1_0800_SA の写しは消した平日便の id(R1_0800_WK)を使う
    const first = applyForm2(base, planOf([POLICY])!, OPTS) as { ok: true; result: Form2Result }
    expect(first.result.report.tripIds.derived).toContainEqual({ from: 'R1_0800_SA', to: 'R1_0800_WK' })
    // R1_0800_WK を足し戻すと、基準と計画全体から作り直すので、写しは R1_0800_WK_2 になる
    const history = [POLICY, addBack(['R1_0800_WK'])]
    const rebuilt = applyForm2(base, planOf(history)!, OPTS) as { ok: true; result: Form2Result }
    const once = applyForm2(base, basePlan({ addBackTripIds: ['R1_0800_WK'] }), OPTS) as { ok: true; result: Form2Result }
    expect(rebuilt.result.report.tripIds).toEqual(once.result.report.tripIds)
    expect(rebuilt.result.report.tripIds.derived).toContainEqual({ from: 'R1_0800_SA', to: 'R1_0800_WK_2' })
    expect(bytesOf(rebuilt.result.feed)).toEqual(bytesOf(once.result.feed))
  })

  it('元に戻すと1つ前の版に戻り、すべて戻すと編集後は基準と同じ表になる', () => {
    const base = smallFeed()
    const history = [POLICY, addBack(['R3_0730_WK']), addBack(['R1_0800_WK'])]
    // versions[i] は history[0..i] を適用した結果
    const versions = history.map((_, i) => apply(base, planOf(history.slice(0, i + 1))))
    // 元に戻す = 最後の操作を除いて作り直す
    const undone = apply(base, planOf(history.slice(0, -1)))
    expect(bytesOf(undone)).toEqual(bytesOf(versions[1]))
    expect(bytesOf(undone)).not.toEqual(bytesOf(versions[2]))
    // すべて戻す = 履歴が空(計画は null、編集後は基準そのもの)
    expect(planOf([])).toBeNull()
    const all = apply(base, planOf([]))
    for (const name of base.tables.keys()) expect(all.tables.get(name)).toBe(base.tables.get(name))
  })

  it('方針を変えても足し戻しの一覧は残る', () => {
    const changed = record({
      type: 'applyPolicy',
      settings: settings({ period: { start: '20261102', end: '20261120' }, excludedRoutes: ['R2'] }),
      reason: { category: null, note: '' },
    })
    const plan = planOf([POLICY, addBack(['R3_0730_WK', 'R1_0800_WK']), changed])
    expect(plan?.addBackTripIds).toEqual(['R3_0730_WK', 'R1_0800_WK'])
    expect(plan?.period).toEqual({ start: '20261102', end: '20261120' })
    expect(plan?.excludedRoutes).toEqual(['R2'])
    expect(policyReasonOf([POLICY, changed])).toEqual({ category: null, note: '' })
    expect(policyReasonOf([])).toBeNull()
    // 取り消すと一覧から除く。最初の applyPolicy より前の足し戻しは数えない
    const withdrawn = planOf([addBack(['R2_0900_WK']), POLICY, addBack(['R3_0730_WK', 'R1_0800_WK']), record({ type: 'withdrawAddBack', tripIds: ['R3_0730_WK'] })])
    expect(withdrawn?.addBackTripIds).toEqual(['R1_0800_WK'])
  })

  it('足し戻しの理由は便ごとに残り、同じ便を2回足したときは最初の理由を使う', () => {
    const history: EditRecord[] = [
      POLICY,
      record({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '高校の通学', schoolDaysOnly: true }] }, '2026-11-04T09:31:00+09:00'),
      record({ type: 'addBack', items: [{ tripId: 'R3_0730_WK', reason: '2回目', schoolDaysOnly: false }] }, '2026-11-04T09:32:00+09:00', 'claude'),
      record({ type: 'addBack', items: [{ tripId: 'R1_0800_WK', reason: '病院の通院', schoolDaysOnly: false }] }, '2026-11-04T09:33:00+09:00', 'claude'),
      record({ type: 'withdrawAddBack', tripIds: ['R1_0800_WK'] }, '2026-11-04T09:34:00+09:00'),
      record({ type: 'addBack', items: [{ tripId: 'R1_0800_WK', reason: '足し直し', schoolDaysOnly: false }] }, '2026-11-04T09:35:00+09:00'),
    ]
    const reasons = addBackReasons(history)
    expect(reasons.get('R3_0730_WK')).toEqual({ reason: '高校の通学', schoolDaysOnly: true, by: 'user', at: '2026-11-04T09:31:00+09:00' })
    // 取り消したあとに足し直したときは、足し直したときの理由
    expect(reasons.get('R1_0800_WK')).toEqual({ reason: '足し直し', schoolDaysOnly: false, by: 'user', at: '2026-11-04T09:35:00+09:00' })
    expect([...reasons.keys()]).toEqual(planOf(history)?.addBackTripIds)
  })
})
