import { describe, expect, it } from 'vitest'
import { feedServicePeriod } from '../gtfs/calendar'
import { diffWeekdayTrips } from '../gtfs/edit/diff'
import { createRestoreHinter } from '../gtfs/edit/restore'
import { DATE, REACH_PARAMS, reachSetup } from '../gtfs/edit/restore.fixture'
import { toStops } from '../gtfs/parse'
import { REGION_CLASSES } from '../reach/input'
import { computeReach } from '../reach/reach'
import { createReachStore, type ReachSnapshot } from './reach'
import { buildRestoreHintContext, type ReachStateForHints } from './restoreHintContext'

async function settle(store: ReturnType<typeof createReachStore>) {
  // 計算の予約が始まるのを待ってから、終わるのを待つ
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 400 && store.getState().computing; i++) await new Promise((r) => setTimeout(r, 5))
}

/** 画面と同じ到達圏の store(計算は Web Worker を使わずに computeReach、参照データは restore.fixture の手作り) */
async function storeWithEdited() {
  const setup = reachSetup()
  const store = createReachStore({
    compute: async (input) => computeReach(structuredClone(input)),
    loadRef: async (mesh1s) => ({ ok: true, mesh1s, ref: setup.ref, stations: [], sources: [] }),
    today: () => '20261103',
    paramDelayMs: 0,
  })
  const s = store.getState()
  s.setSource({ feed: setup.base, stops: toStops(setup.base).stops, period: feedServicePeriod(setup.base) })
  for (const cls of REGION_CLASSES) {
    s.setWalkMinutes(cls, 'bus', REACH_PARAMS.walkMinutes[cls].bus)
    s.setWalkMinutes(cls, 'rail', REACH_PARAMS.walkMinutes[cls].rail)
  }
  expect(s.setDate(DATE)).toBeNull()
  await settle(store)
  store.getState().setEdited({ feed: setup.edited, period: feedServicePeriod(setup.edited), draft: false })
  return { ...setup, store }
}

describe('到達圏の store から足し戻しの手がかりの ctx を作る(buildRestoreHintContext)', () => {
  it('編集後の比較ができたら、基準と編集後の結果・日付・条件・起点から ctx を作る。計算中は null', async () => {
    const { store, base, edited, plan, ctx: expected } = await storeWithEdited()
    // setEdited の直後は計算中(出ている結果は編集後を渡す前のもの)
    expect(store.getState().computing).toBe(true)
    expect(buildRestoreHintContext(store.getState())).toBeNull()
    await settle(store)

    const state = store.getState()
    expect(state.error).toBeNull()
    const ctx = buildRestoreHintContext(state, edited)
    expect(ctx).not.toBeNull()
    const snap = state.snapshot!
    expect(ctx!.before).toBe(snap.baseline!.departures)
    expect(ctx!.after).toBe(snap.departures)
    expect(ctx!.beforeResult).toBe(snap.baseline!.result)
    expect(ctx!.afterResult).toBe(snap.result)
    expect(ctx!.bands).toBe(snap.bands)
    expect(ctx!.date).toBe(DATE)
    expect(ctx!.params).toEqual(REACH_PARAMS)
    expect(ctx!.stops).toBe(state.origins!.stops)
    // 同じ結果からは同じ ctx(外れたセルの索引を使い回すため)
    expect(buildRestoreHintContext(store.getState(), edited)).toBe(ctx)

    // store の ctx で出した手がかりは、同じ条件で直接計算した ctx の手がかりと同じ
    const diff = diffWeekdayTrips(base, edited, plan.weekdayService)
    const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    const lost = Object.fromEntries(diff.removed.map((t) => [t.tripId, hinter(t, ctx!).lostCells]))
    expect(lost).toEqual({
      A_0700_WK: { cells: 9, population: 90 },
      B_0855_WK: { cells: 18, population: 180 },
      C_0720_WK: null,
      D_0745_WK: { cells: 11, population: 110 },
      E_0750_WK: { cells: 11, population: 110 },
    })
    for (const t of diff.removed) expect(hinter(t, ctx!)).toEqual(hinter(t, expected))
  })

  it('渡した編集後のフィードが store のものと違えば null(下書きの結果を、承認済みの版の候補に使わない)', async () => {
    const { store, base } = await storeWithEdited()
    await settle(store)
    expect(buildRestoreHintContext(store.getState())).not.toBeNull()
    expect(buildRestoreHintContext(store.getState(), base)).toBeNull()
  })

  it('編集後が無い・結果が無い・比較が無い・計算に失敗した状態では null', async () => {
    const { store } = await storeWithEdited()
    await settle(store)
    const state = store.getState()
    const ok: ReachStateForHints = {
      edited: state.edited,
      origins: state.origins,
      computing: false,
      error: null,
      snapshot: state.snapshot,
    }
    expect(buildRestoreHintContext(ok)).not.toBeNull()
    expect(buildRestoreHintContext({ ...ok, edited: null })).toBeNull()
    expect(buildRestoreHintContext({ ...ok, origins: null })).toBeNull()
    expect(buildRestoreHintContext({ ...ok, snapshot: null })).toBeNull()
    expect(buildRestoreHintContext({ ...ok, computing: true })).toBeNull()
    expect(buildRestoreHintContext({ ...ok, error: '到達圏を計算できませんでした。' })).toBeNull()
    const { baseline: _baseline, ...noBaseline } = state.snapshot!
    expect(buildRestoreHintContext({ ...ok, snapshot: noBaseline as ReachSnapshot })).toBeNull()
    const { comparison: _comparison, ...noComparison } = state.snapshot!
    expect(buildRestoreHintContext({ ...ok, snapshot: noComparison as ReachSnapshot })).toBeNull()

    // 編集後を外して基準だけに戻すと null
    store.getState().setEdited(null)
    await settle(store)
    expect(buildRestoreHintContext(store.getState())).toBeNull()
  })
})
