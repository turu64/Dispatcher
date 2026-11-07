// 実データでの通しの確認:GTFS(道北バス 減便前・減便後)と data/out/ref の参照データを使い、
// 画面と同じ流れ(store の setSource → 起点の停留所を選ぶ → 参照データの取得 → servicesFor → departureCountsByBand
// → computeReach → summarizeReach → 地図の GeoJSON)で計算する。
// 期待値は、検証担当が Python で別に計算して照合した値(src/reach/reach.verify.test.ts の PYTHON と同じ。
// docs/interfaces-1103.md の追記3と、docs/interfaces-1104.md §7 の起点の規則(乗れる行の無い停留所を起点にしない))。
// 形2で減便を反映した編集後(data/tools/policies の main・replaceOnly を applyForm2 で適用したもの)を setEdited で渡し、
// 9/17 版を基準とした 2026-11-04 の前後の比較と、1104 §11 の 11/4・11/5 の到達点の受け入れ条件も確かめる。
// ファイルが無ければ飛ばす。参照データや GTFS が作り直されて入力の指紋が変われば、Python の値との照合だけを飛ばす
// (照合し直すときは、reach.verify.test.ts の PYTHON と一緒にここの値も書き換える)
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { feedServicePeriod } from '../gtfs/calendar'
import { applyForm2 } from '../gtfs/edit/form2'
import type { Form2Plan } from '../gtfs/edit/ops'
import { loadGtfsZip, type GtfsFeed } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { cellsToGeoJson, stopsToGeoJson } from '../reach/geojson'
import { computeReach } from '../reach/reach'
import { fetchRefData } from '../reach/refData'
import { createReachStore } from './reach'

const ZIP = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const ZIP_AFTER = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']
/** 形2の方針(参照実装 data/tools/form2_ref.py に渡したものと同じ JSON) */
const POLICY_DIR = fileURLToPath(new URL('../../../data/tools/policies/', import.meta.url))
const HAS_POLICIES = ['main', 'replaceOnly'].every((n) => existsSync(`${POLICY_DIR}${n}.json`))
const ready = existsSync(ZIP) && MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`))

/** 参照データの 6 ファイル(MESHES の順)と GTFS の ZIP をこの順につないだ SHA-256(reach.verify.test.ts と同じ作り方) */
function inputFingerprint(gtfs: string): string | null {
  if (!ready || !existsSync(gtfs)) return null
  const hash = createHash('sha256')
  for (const m of MESHES) hash.update(readFileSync(`${REF_DIR}${m}.json`))
  hash.update(readFileSync(gtfs))
  return hash.digest('hex')
}

/** Python で照合した値(src/reach/reach.verify.test.ts の PYTHON から写したもの。1104 §7 の起点の規則で 11/4 に計算し直した) */
const PYTHON = {
  before: {
    fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
    /** 1,582 のうち、stop_times に出てこない 122 と、乗れる行の無い 10 を除く(すべて location_type 0) */
    origin: { origins: 1450, unused: 122, nonStop: 0, noBoarding: 10 },
    cells: 18795,
    classCount: { urban: 5620, suburban: 1949, rural: 11226 },
    population: 1606409 / 4,
    coverable: { cells: 17061, pop: 303291.5 },
    nonCoverable: { cells: 1734, pop: 98310.75 },
    /** 3時間ごと。2026-11-02 と 2026-11-04 で同じ(どちらも当日 01、前日 06) */
    bandTotals: [3105, 3787, 3792, 3488, 2365, 282],
    outCounts: [2307, 2010, 2271, 1486, 2043, 8238],
    outPop: [20446.25, 37031.5, 47108.25, 18106.5, 37221, 108213.75],
    hourly: {
      bandTotals: [159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0],
      outCounts: [8207, 2750, 3294, 4047, 4543, 3904, 3063, 5085, 4483, 3332, 4207, 4706, 4268, 5499, 7241, 8366, 9782, 10919],
      outPop: [
        127779, 26444.5, 47837.5, 55007.75, 58485.5, 58178, 54959.75, 70406.75, 63942.5, 47120, 48037.5, 66420.25, 50091.25,
        69701.25, 95716, 114204.25, 150482, 204139.25,
      ],
    },
  },
  /** 10/29 版を単独で読んだとき(それ自身が基準) */
  after: {
    fingerprint: '6f2acd1073c9528cb0a50d14f33388df9c24d9422b1c4ba7cdaa0342c0e7e0e0',
    origin: { origins: 1354, unused: 218, nonStop: 0, noBoarding: 10 },
    cells: 18297,
    classCount: { urban: 5567, suburban: 1948, rural: 10782 },
    population: 1595266 / 4,
    coverable: { cells: 16418, pop: 292341.75 },
    nonCoverable: { cells: 1879, pop: 106474.75 },
    bandTotals: [2784, 3496, 3390, 3231, 1906, 238],
    outCounts: [1951, 1597, 1692, 1175, 1949, 7728],
    outPop: [21779, 32528.5, 37541.25, 8150.5, 29300.5, 97963.75],
  },
  /**
   * 形2の編集後(9/17 版を基準)の 2026-11-04 の3時間ごと。起点・セル・coverable は基準のもの。
   * zeroStops の sha は「stop_id:基準の出発の数:scope」を §7 の順に並べた SHA-256。zeroRoutes は「route_id:基準の便数:scope」(route_id の順)
   */
  edited: {
    main: {
      bandTotals: [2768, 3500, 3402, 3233, 1906, 238],
      outCounts: [2465, 2111, 2171, 1658, 2463, 8242],
      outPop: [32196, 42945.5, 47931.25, 18541.5, 39717.5, 108380.75],
      lostCells: [281, 101, 233, 174, 420, 4],
      lostPopulation: [11893, 5914, 1308.5, 438.75, 2496.5, 167],
      gainedCells: [123, 0, 333, 2, 0, 0],
      gainedPopulation: [143.25, 0, 485.5, 3.75, 0, 0],
      dayLostCells: 479,
      dayLostPopulation: 10390,
      zeroStops: { count: 91, feed: 91, sha: 'aec44b530589012dc2ddb052c3360d405a43bac1e735c221f4039897701ed2c3' },
      zeroRoutes: [
        '0007:1:feed',
        '0009:2:feed',
        '0037:1:feed',
        '0038:1:feed',
        '0044:1:feed',
        '0045:2:feed',
        '0047:2:feed',
        '0078:1:feed',
        '0440:1:feed',
        '0665:1:feed',
      ],
    },
    replaceOnly: {
      bandTotals: [2324, 3500, 3391, 3120, 1867, 235],
      outCounts: [3044, 2111, 2262, 1981, 2903, 8423],
      outPop: [61445.75, 42945.5, 53938.75, 43593, 62576, 110278],
      lostCells: [860, 101, 324, 667, 860, 185],
      lostPopulation: [41142.75, 5914, 7316, 27424, 25355, 2064.25],
      gainedCells: [123, 0, 333, 172, 0, 0],
      gainedPopulation: [143.25, 0, 485.5, 1937.5, 0, 0],
      dayLostCells: 983,
      dayLostPopulation: 38102.75,
      zeroStops: { count: 149, feed: 149, sha: '20bca0db2fa142af5ab902feead298234b75dd3b922cdc0993bf60a34ef0c1db' },
      zeroRoutes: [
        '0007:1:feed',
        '0009:2:feed',
        '0019:2:feed',
        '0021:3:feed',
        '0024:1:feed',
        '0031:11:feed',
        '0037:1:feed',
        '0038:1:feed',
        '0044:1:feed',
        '0045:2:feed',
        '0047:2:feed',
        '0058:1:feed',
        '0075:1:feed',
        '0078:1:feed',
        '0114:1:feed',
        '0151:1:feed',
        '0440:1:feed',
        '0665:1:feed',
        '0669:1:feed',
      ],
    },
  },
} as const

async function settle(store: ReturnType<typeof createReachStore>) {
  // 計算の予約(schedule(0))が始まるのを待ってから、終わるのを待つ
  await new Promise((r) => setTimeout(r, 0))
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
  return { store, requested, feed }
}

/** 基準のフィードに形2の方針(data/tools/policies/{name}.json)を当てた編集後のフィード(参照実装と同じ作成日時) */
function editedFeed(base: GtfsFeed, name: 'main' | 'replaceOnly'): GtfsFeed {
  const policy = JSON.parse(readFileSync(`${POLICY_DIR}${name}.json`, 'utf8')) as Omit<Form2Plan, 'kind'>
  const outcome = applyForm2(base, { kind: 'weekdayToSaturday', ...policy }, { generatedAt: '202611041200' })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.result.feed
}

function sha256(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex')
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

  it.skipIf(!matchesBefore || !HAS_POLICIES)(
    '形2の編集後(main・replaceOnly)を渡すと、9/17 版を基準とした 2026-11-04 の比較が Python の値と一致し、11/4・11/5 の到達点の条件を満たす',
    async () => {
      const { store, feed } = await storeFor(ZIP)
      await settle(store)
      expect(store.getState().date).toBe('20261104')
      const lostOf: Record<string, number[]> = {}

      for (const name of ['main', 'replaceOnly'] as const) {
        const edited = editedFeed(feed, name)
        store.getState().setEdited({ feed: edited, period: feedServicePeriod(edited), draft: false })
        await settle(store)
        const s = store.getState()
        expect(s.error).toBeNull()
        const snap = s.snapshot!
        const p = PYTHON.edited[name]
        expect(snap.date).toBe('20261104')
        expect(snap.stepHours).toBe(3)
        expect(snap.draft).toBe(false)
        // 起点・セル・coverable は基準のもの(編集後のフィードから選び直さない)
        expect(snap.origin).toEqual(PYTHON.before.origin)
        expect(s.origins!.stops).toHaveLength(PYTHON.before.origin.origins)
        expect(snap.summary.totalCells).toBe(PYTHON.before.cells)
        expect(snap.summary.coverableCells).toBe(PYTHON.before.coverable.cells)
        expect(snap.summary.coverablePopulation).toBe(PYTHON.before.coverable.pop)
        expect(snap.summary.nonCoverableCells).toBe(PYTHON.before.nonCoverable.cells)
        // 基準(baseline)は同じ日付の 9/17 版。2026-11-04 は 2026-11-02 と同じ値になる
        const baseline = snap.baseline!
        expect(baseline.summary.coverableCells).toBe(PYTHON.before.coverable.cells)
        expect(baseline.summary.bands.map((b) => b.unreachableCells)).toEqual(PYTHON.before.outCounts)
        expect(baseline.summary.bands.map((b) => b.unreachablePopulation)).toEqual(PYTHON.before.outPop)
        expect(totalsOf(baseline.departures.counts, 6)).toEqual(PYTHON.before.bandTotals)
        expect(baseline.result.cells).toEqual(snap.result.cells)
        expect(baseline.result.coverable).toEqual(snap.result.coverable)
        // 表示する側は編集後
        expect(totalsOf(snap.departures.counts, 6)).toEqual(p.bandTotals)
        expect(snap.summary.bands.map((b) => b.unreachableCells)).toEqual(p.outCounts)
        expect(snap.summary.bands.map((b) => b.unreachablePopulation)).toEqual(p.outPop)
        expectMapMatchesTable(snap)
        // 前後の比較
        const cmp = snap.comparison!
        expect(cmp.bands.map((b) => b.lostCells)).toEqual(p.lostCells)
        expect(cmp.bands.map((b) => b.lostPopulation)).toEqual(p.lostPopulation)
        expect(cmp.bands.map((b) => b.gainedCells)).toEqual(p.gainedCells)
        expect(cmp.bands.map((b) => b.gainedPopulation)).toEqual(p.gainedPopulation)
        expect(cmp.dayLostCells).toBe(p.dayLostCells)
        expect(cmp.dayLostPopulation).toBe(p.dayLostPopulation)
        // 運行がゼロになる停留所・系統
        const zeroStops = snap.zeroStops!
        expect(zeroStops).toHaveLength(p.zeroStops.count)
        expect(zeroStops.filter((z) => z.scope === 'feed')).toHaveLength(p.zeroStops.feed)
        expect(sha256(zeroStops.map((z) => `${z.stopId}:${z.beforeDepartures}:${z.scope}`))).toBe(p.zeroStops.sha)
        expect(snap.zeroRoutes!.map((z) => `${z.routeId}:${z.beforeTrips}:${z.scope}`).sort()).toEqual(p.zeroRoutes)
        lostOf[name] = cmp.bands.map((b) => b.lostCells)
      }

      // 11/4 の到達点(夜の空白が地図で見える):main で減便で外れたセルが最も多い時間帯は 18〜21時か 21〜24時
      const main = lostOf.main
      const top = Math.max(...main)
      const snap = store.getState().snapshot!
      const topBands = snap.bands.filter((_, b) => main[b] === top).map((band) => band.startHour)
      expect(topBands.length).toBeGreaterThan(0)
      expect(topBands.every((h) => h === 18 || h === 21)).toBe(true)
      // 11/5 の到達点(足し戻すと空白が減る):main(足し戻しあり)は replaceOnly(足し戻しなし)より 6〜9時の外れたセルが少ない
      const morning = snap.bands.findIndex((band) => band.startHour === 6)
      expect(lostOf.main[morning]).toBeLessThan(lostOf.replaceOnly[morning])
    },
    30_000,
  )
})
