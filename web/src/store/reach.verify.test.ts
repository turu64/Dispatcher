// 実データでの通しの確認:GTFS(道北バス 減便前・減便後)と data/out/ref の参照データを使い、
// 画面と同じ流れ(store の setSource → 起点の停留所を選ぶ → 参照データの取得 → servicesFor → departureCountsByBand
// → computeReach → summarizeReach → 地図の GeoJSON)で計算する。
// 期待値は、到達圏の計算の担当が Python で別に計算して照合した値(src/reach/reach.verify.test.ts の PYTHON と同じ。
// docs/interfaces-1103.md の追記2の条件)。
// ファイルが無ければ飛ばす。参照データや GTFS が作り直されて入力の指紋が変われば、Python の値との照合だけを飛ばす
// (照合し直すときは、reach.verify.test.ts の PYTHON と一緒にここの値も書き換える)
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { feedServicePeriod } from '../gtfs/calendar'
import { loadGtfsZip } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { cellsToGeoJson, stopsToGeoJson } from '../reach/geojson'
import { computeReach } from '../reach/reach'
import { fetchRefData } from '../reach/refData'
import { createReachStore } from './reach'

const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const ZIP_AFTER = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']
const ready = existsSync(ZIP) && MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`))

/** 参照データの 6 ファイル(MESHES の順)と GTFS の ZIP をこの順につないだ SHA-256(reach.verify.test.ts と同じ作り方) */
function inputFingerprint(gtfs: string): string | null {
  if (!ready || !existsSync(gtfs)) return null
  const hash = createHash('sha256')
  for (const m of MESHES) hash.update(readFileSync(`${REF_DIR}${m}.json`))
  hash.update(readFileSync(gtfs))
  return hash.digest('hex')
}

/** Python で照合した値(src/reach/reach.verify.test.ts の PYTHON から写したもの) */
const PYTHON = {
  before: {
    fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
    /** 1,582 のうち、stop_times に出てこない 122 を除く(すべて location_type 0) */
    origin: { origins: 1460, unused: 122, nonStop: 0 },
    cells: 18951,
    classCount: { urban: 5669, suburban: 1971, rural: 11311 },
    population: 1617508 / 4,
    coverable: { cells: 17200, pop: 305703.75 },
    nonCoverable: { cells: 1751, pop: 98673.25 },
    bandTotals: [3105, 3787, 3792, 3488, 2365, 282],
    outCounts: [2431, 2134, 2395, 1610, 2167, 8362],
    outPop: [22710, 39295.25, 49372, 20370.25, 39484.75, 110477.5],
    hourly: {
      bandTotals: [159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0],
      outCounts: [8331, 2874, 3418, 4171, 4667, 4028, 3187, 5209, 4607, 3456, 4331, 4830, 4392, 5623, 7365, 8490, 9906, 11043],
      outPop: [
        130042.75, 28708.25, 50101.25, 57271.5, 60749.25, 60441.75, 57223.5, 72670.5, 66206.25, 49383.75, 50301.25, 68684,
        52355, 71965, 97979.75, 116468, 152745.75, 206403,
      ],
    },
  },
  after: {
    fingerprint: '6f2acd1073c9528cb0a50d14f33388df9c24d9422b1c4ba7cdaa0342c0e7e0e0',
    origin: { origins: 1364, unused: 218, nonStop: 0 },
    cells: 18455,
    classCount: { urban: 5618, suburban: 1970, rural: 10867 },
    population: 1606895 / 4,
    coverable: { cells: 16559, pop: 294886.5 },
    nonCoverable: { cells: 1896, pop: 106837.25 },
    bandTotals: [2784, 3496, 3390, 3231, 1906, 238],
    outCounts: [2075, 1721, 1816, 1299, 2073, 7852],
    outPop: [24042.75, 34792.25, 39805, 10414.25, 31564.25, 100227.5],
  },
} as const

async function settle(store: ReturnType<typeof createReachStore>) {
  for (let i = 0; i < 400 && store.getState().computing; i++) await new Promise((r) => setTimeout(r, 5))
}

/** 画面と同じ store を作る。参照データは data/out/ref のファイルを読む(問い合わせた URL を記録する) */
async function storeFor(zip: string) {
  const feed = await loadGtfsZip(new Uint8Array(readFileSync(zip)).buffer)
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
  return { store, requested }
}

function totalsOf(counts: Map<string, number[]>, bands: number): number[] {
  const totals = new Array<number>(bands).fill(0)
  for (const arr of counts.values()) arr.forEach((n, i) => (totals[i] += n))
  return totals
}

/** 表の数と地図の GeoJSON がそろっていること(塗るセルは見込みのあるセルだけ、m のビットが 0 のセルが外れるセル) */
function expectMapMatchesTable(snap: NonNullable<ReturnType<ReturnType<typeof createReachStore>['getState']>['snapshot']>) {
  const cells = cellsToGeoJson(snap.result)
  expect(cells.features).toHaveLength(snap.summary.coverableCells)
  snap.bands.forEach((_, b) => {
    const out = cells.features.filter((f) => Math.floor(f.properties.m / 2 ** b) % 2 === 0)
    expect(out).toHaveLength(snap.summary.bands[b].unreachableCells)
  })
}

const matchesBefore = inputFingerprint(ZIP) === PYTHON.before.fingerprint
const matchesAfter = inputFingerprint(ZIP_AFTER) === PYTHON.after.fingerprint

describe.skipIf(!ready)('実データ(道北バス × data/out/ref)を画面と同じ流れで計算する', () => {
  it('減便前 2026-11-02 の3時間ごと:起点・調べたセル・見込みのあるセル・外れるセルが、Python で照合した値と一致する', async () => {
    const { store, requested } = await storeFor(ZIP)
    expect(store.getState().date).toBe('20261104')
    expect(store.getState().setDate('20261102')).toBeNull()
    await settle(store)

    const s = store.getState()
    expect(s.error).toBeNull()
    // 起点の外接矩形を 2,800m 広げた範囲の1次メッシュ
    expect(requested).toEqual(MESHES.map((m) => `/api/ref/${m}`))
    const snap = s.snapshot!
    expect(snap.date).toBe('20261102')
    expect(snap.result.usedFallback).toBe(false)
    expect(snap.result.excludedStops).toBe(0)
    // 地図の停留所の点も起点と同じ停留所
    expect(s.origins!.stops).toHaveLength(snap.origin.origins)
    expect(stopsToGeoJson(s.origins!.stops, snap.departures.counts, snap.bands.length).features).toHaveLength(snap.origin.origins)
    expectMapMatchesTable(snap)

    if (!matchesBefore) {
      console.warn('参照データか GTFS(減便前)が変わったため、Python の値との照合を飛ばしました')
      return
    }
    const p = PYTHON.before
    expect(snap.origin).toEqual(p.origin)
    expect(snap.summary.totalCells).toBe(p.cells)
    expect(snap.summary.cellsByClass).toEqual(p.classCount)
    expect(snap.summary.totalPopulation).toBe(p.population)
    expect(snap.summary.coverableCells).toBe(p.coverable.cells)
    expect(snap.summary.coverablePopulation).toBe(p.coverable.pop)
    expect(snap.summary.nonCoverableCells).toBe(p.nonCoverable.cells)
    expect(snap.summary.nonCoverablePopulation).toBe(p.nonCoverable.pop)
    expect(snap.summary.bands.map((b) => b.unreachableCells)).toEqual(p.outCounts)
    expect(snap.summary.bands.map((b) => b.unreachablePopulation)).toEqual(p.outPop)
    expect(totalsOf(snap.departures.counts, 6)).toEqual(p.bandTotals)
  }, 30_000)

  it('減便前 2026-11-02 の1時間ごと:時間帯ごとの外れるセルと推計人口が、Python で照合した値と一致する', async () => {
    const { store } = await storeFor(ZIP)
    expect(store.getState().setDate('20261102')).toBeNull()
    store.getState().setStepHours(1)
    await settle(store)

    const snap = store.getState().snapshot!
    expect(snap.stepHours).toBe(1)
    expect(snap.bands).toHaveLength(18)
    expectMapMatchesTable(snap)
    if (!matchesBefore) {
      console.warn('参照データか GTFS(減便前)が変わったため、Python の値との照合を飛ばしました')
      return
    }
    const p = PYTHON.before
    // 調べるセル・区分・見込みのあるセルは、時間帯の刻みによらない
    expect(snap.summary.totalCells).toBe(p.cells)
    expect(snap.summary.coverableCells).toBe(p.coverable.cells)
    expect(snap.summary.bands.map((b) => b.unreachableCells)).toEqual(p.hourly.outCounts)
    expect(snap.summary.bands.map((b) => b.unreachablePopulation)).toEqual(p.hourly.outPop)
    expect(totalsOf(snap.departures.counts, 18)).toEqual(p.hourly.bandTotals)
  }, 30_000)

  it.skipIf(!existsSync(ZIP_AFTER))('減便後 2026-11-04 の3時間ごと:読む参照データは4つで、Python で照合した値と一致する', async () => {
    const { store, requested } = await storeFor(ZIP_AFTER)
    expect(store.getState().date).toBe('20261104')
    await settle(store)

    const s = store.getState()
    expect(s.error).toBeNull()
    expect(requested).toEqual(['6541', '6542', '6641', '6642'].map((m) => `/api/ref/${m}`))
    const snap = s.snapshot!
    expect(snap.date).toBe('20261104')
    expect(snap.result.usedFallback).toBe(false)
    expectMapMatchesTable(snap)

    if (!matchesAfter) {
      console.warn('参照データか GTFS(減便後)が変わったため、Python の値との照合を飛ばしました')
      return
    }
    const p = PYTHON.after
    expect(snap.origin).toEqual(p.origin)
    expect(snap.summary.totalCells).toBe(p.cells)
    expect(snap.summary.cellsByClass).toEqual(p.classCount)
    expect(snap.summary.totalPopulation).toBe(p.population)
    expect(snap.summary.coverableCells).toBe(p.coverable.cells)
    expect(snap.summary.coverablePopulation).toBe(p.coverable.pop)
    expect(snap.summary.nonCoverableCells).toBe(p.nonCoverable.cells)
    expect(snap.summary.nonCoverablePopulation).toBe(p.nonCoverable.pop)
    expect(snap.summary.bands.map((b) => b.unreachableCells)).toEqual(p.outCounts)
    expect(snap.summary.bands.map((b) => b.unreachablePopulation)).toEqual(p.outPop)
    expect(totalsOf(snap.departures.counts, 6)).toEqual(p.bandTotals)
  }, 30_000)
})
