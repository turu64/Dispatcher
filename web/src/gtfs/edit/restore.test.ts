import { describe, expect, it } from 'vitest'
import { diffWeekdayTrips } from './diff'
import { applyForm2 } from './form2'
import { basePlan, smallFeed } from './form2.fixture'
import { compareByHints, createRestoreHinter, restoreHints } from './restore'

// 小さなフィード(form2.fixture.ts)を「平日を土曜ダイヤに」した版で、消える平日便は R1_0800_WK・R2_0900_WK・R3_0730_WK
function setup() {
  const base = smallFeed()
  const plan = basePlan()
  const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  const edited = outcome.result.feed
  const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
  const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
  const byId = new Map(diff.removed.map((t) => [t.tripId, t]))
  return { base, plan, edited, diff, hinter, byId }
}

describe('足し戻しの手がかり(restoreHints)', () => {
  it('系統の終発の便と、足し戻さないと帯の便が 0 になる便に印を付ける', () => {
    const { hinter, byId } = setup()
    // R1 の平日は 07:00 と 08:00。08:00 は終発で、朝(6〜9時)。6〜9時台には写した土曜便が残るので、帯の便は 0 にならない
    expect(hinter(byId.get('R1_0800_WK')!).hints).toEqual(['lastTripOfRoute', 'morning'])
    // R2 の平日は 09:00 の1本だけ(始発かつ終発)。土曜便は 10:00 なので、6〜9時台(公示第47号)の便が 0 になる。9:00 は朝に入らない
    expect(hinter(byId.get('R2_0900_WK')!).hints).toEqual(['firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand'])
    // R3 は平日だけの系統で、入れ替えると全曜日で便がなくなる
    expect(hinter(byId.get('R3_0730_WK')!)).toEqual({
      hints: ['weekdayOnlyRoute', 'routeWouldVanish', 'firstTripOfRoute', 'lastTripOfRoute', 'onlyTripInBand', 'morning'],
      lostCells: null,
    })
  })

  it('1つの便だけを調べても、索引を作って調べた結果と同じ', () => {
    const { base, plan, edited, hinter, byId } = setup()
    for (const trip of byId.values()) expect(restoreHints(base, edited, plan, trip)).toEqual(hinter(trip))
  })

  it('手がかりの多い順に並べる', () => {
    const { diff, hinter } = setup()
    const sorted = diff.removed
      .map((trip) => ({ trip, detail: hinter(trip) }))
      .sort(compareByHints)
      .map((c) => c.trip.tripId)
    expect(sorted).toEqual(['R3_0730_WK', 'R2_0900_WK', 'R1_0800_WK'])
  })

  it('手がかりの数が同じなら始発の時刻順にする', () => {
    const { byId } = setup()
    const a = { trip: byId.get('R1_0800_WK')!, detail: { hints: ['morning' as const], lostCells: null } }
    const b = { trip: byId.get('R3_0730_WK')!, detail: { hints: ['morning' as const], lostCells: null } }
    expect([a, b].sort(compareByHints).map((c) => c.trip.tripId)).toEqual(['R3_0730_WK', 'R1_0800_WK'])
  })
})
