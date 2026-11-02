// 実データでの通しの確認:GTFS(道北バス 減便前)と data/out/ref の参照データを使い、
// 画面と同じ流れ(store の setSource → 参照データの取得 → servicesFor → departureCountsByBand → computeReach)で計算する。
// 期待値は、到達圏の計算の担当が Python で別に計算して照合した値(2026-11-02、3時間ごと)。
// ファイルが無ければ飛ばす。参照データが作り直されて値が変われば、期待値の見直しが要る
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { feedServicePeriod } from '../gtfs/calendar'
import { loadGtfsZip } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { computeReach } from '../reach/reach'
import { fetchRefData } from '../reach/refData'
import { createReachStore } from './reach'

const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']
const ready = existsSync(ZIP) && MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`))

async function settle(store: ReturnType<typeof createReachStore>) {
  for (let i = 0; i < 200 && store.getState().computing; i++) await new Promise((r) => setTimeout(r, 5))
}

describe.skipIf(!ready)('実データ(道北バス 減便前 × data/out/ref)を画面と同じ流れで計算する', () => {
  it('2026-11-02 の3時間ごとの「外れるセル」が、Python で照合した値と一致する', async () => {
    const feed = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const requested: string[] = []
    const store = createReachStore({
      compute: async (input) => computeReach(structuredClone(input)),
      loadRef: (mesh1s) =>
        fetchRefData(
          mesh1s,
          async (url) => {
            requested.push(url)
            const mesh1 = url.replace('/api/ref/', '')
            return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(`${REF_DIR}${mesh1}.json`, 'utf8')) }
          },
          new Map(),
        ),
      today: () => '20261103',
      paramDelayMs: 0,
    })

    store.getState().setSource({ feed, stops: toStops(feed).stops, period: feedServicePeriod(feed) })
    expect(store.getState().date).toBe('20261104')
    expect(store.getState().setDate('20261102')).toBeNull()
    await settle(store)

    const s = store.getState()
    expect(s.error).toBeNull()
    expect(requested).toEqual(MESHES.map((m) => `/api/ref/${m}`))
    const snap = s.snapshot!
    expect(snap.date).toBe('20261102')
    expect(snap.result.usedFallback).toBe(false)
    expect(snap.result.excludedStops).toBe(0)
    expect(snap.summary.totalCells).toBe(31108)
    expect(snap.summary.cellsByClass).toEqual({ urban: 7790, suburban: 4041, rural: 19277 })
    expect(snap.summary.totalPopulation).toBeCloseTo(595286.75, 6)
    expect(snap.summary.bands.map((b) => b.unreachableCells)).toEqual([7989, 7692, 7953, 7168, 7725, 13920])
    const pops = snap.summary.bands.map((b) => b.unreachablePopulation)
    ;[211744.75, 228330, 238406.75, 209405, 228519.5, 299512.25].forEach((p, i) => expect(pops[i]).toBeCloseTo(p, 6))
    // 時間帯ごとの出発の数(担当が照合した値)
    const totals = [0, 0, 0, 0, 0, 0]
    for (const arr of snap.departures.counts.values()) arr.forEach((n, i) => (totals[i] += n))
    expect(totals).toEqual([3105, 3787, 3792, 3488, 2365, 282])
  }, 30_000)
})
