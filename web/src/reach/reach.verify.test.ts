// 実データでの確かめ。ファイルが無ければスキップする(data/raw/・data/out/ はコミットしない)。
//
// - 道北バスの GTFS(data/raw/gtfs/dohoku_bus_減便前.zip・dohoku_bus_減便後.zip)
// - 参照データ(data/out/ref/{1次メッシュ}.json。data/ の Python で作ったもの)
//
// 2026-11-02(月)の時間帯ごとの出発の数と参照データで到達圏を計算し、
// 時間帯ごとの到達できないセルの数と推計人口の割合、計算時間を出力する。
// 検証担当が Python で独立に計算した結果(PYTHON)とも照らす。入力のファイルが変わっていれば、その照合だけを飛ばす。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import * as calendar from '../gtfs/calendar'
import { departureCountsByBand, makeBands, type TimeBand } from '../gtfs/departures'
import { loadGtfsZip, type GtfsFeed } from '../gtfs/load'
import { toStops } from '../gtfs/parse'
import { cellsWithinRadius, distanceM, meshCenter, meshCode, meshCodesInBounds, parentCode, type LatLon } from './mesh'
import {
  computeReach,
  DEFAULT_REACH_PARAMS,
  refDataFromJson,
  type ReachInput,
  type ReachParams,
  type ReachResult,
  type RefData,
} from './reach'

const DOHOKU_GTFS = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const REF_MESH1 = ['6541', '6542', '6543', '6641', '6642', '6643']
const refPath = (mesh1: string) => `${REF_DIR}${mesh1}.json`
const HAS_DATA = existsSync(DOHOKU_GTFS) && REF_MESH1.every((m) => existsSync(refPath(m)))

const DATE = '20261102' // 月曜日。前日の 11/1 は日曜日

const sha256 = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

const DOHOKU_GTFS_AFTER = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))

/** 参照データの 6 ファイル(REF_MESH1 の順)と GTFS の ZIP をこの順につないだ SHA-256。Python の照合はこれが同じときだけ行う */
function inputFingerprint(gtfs: string): string | null {
  if (!HAS_DATA || !existsSync(gtfs)) return null
  const hash = createHash('sha256')
  for (const m of REF_MESH1) hash.update(readFileSync(refPath(m)))
  hash.update(readFileSync(gtfs))
  return hash.digest('hex')
}
const FINGERPRINT = inputFingerprint(DOHOKU_GTFS)
const FINGERPRINT_AFTER = inputFingerprint(DOHOKU_GTFS_AFTER)

/**
 * 検証担当が Python(python3 -I)で別に計算した値。reach.ts・mesh.ts のコードは見ずに、取り決めと JIS X 0410 の定義から書いた。
 * - 地域メッシュのコードは緯度を分・秒の余りで割っていく定義どおりに作り、中心はコードの各桁から足し上げる
 * - 距離は GRS80 のヒュベニの式、250m セルの面積は M(φ)N(φ)cosφ の Simpson 法の数値積分
 * - 近くの点は 0.02度 × 0.03度の格子で探す(kdbush は使わない)
 * - 運行日(当日 01・前日 06)と時間帯ごとの出発も GTFS から数え直した
 * 距離が徒歩圏の 1mm 以内のセルと、人口密度がしきい値の 0.1% 以内の 250m セルは 0 個(境目の丸めで結果が分かれない)。
 * 文字列の SHA-256 は、11 桁のコードの辞書順に並べた行を改行でつないだもの。
 */
const PYTHON = {
  /** 参照データの駅が 78 のときのファイル(2026-11-03 01:29 に書かれたもの) */
  fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
  /** 3時間ごとの時間帯の出発の合計 */
  bandTotals: [3105, 3787, 3792, 3488, 2365, 282],
  /** 出発がある停留所の「stop_id:6つの数」(stop_id の順) */
  stopCountsSha: '5b7a822992bbdc38e2b7d28fb6bf8440b2e3d6a9b054843d009a9d1972d3a9b9',
  /** 停留所・駅から 1,600m 以内のセル(人口で絞る前) */
  candidateCells: 95947,
  cells: 31108,
  cellsSha: 'ab7f387dc2bd7433bfb5a79fda016215c4f5bd48ad2be13b49129754ed5a2af5',
  classCount: { urban: 7790, suburban: 4041, rural: 19277 },
  /** 「コード:区分」 */
  classesSha: 'd504b1883651ba1fd8ef568f652fbb1c599c486d5adb5172e78674d3a370b8d6',
  /** 「コード:推計人口 × 4(= 親の 250m セルの人口)」 */
  populationSha: '665c46e25f50417c07d6abead1b441962265ce8c2bfd18961ed01491716f8275',
  populationTimes4: 2381147,
  /** 3時間ごとの到達できないセルの数・コードの SHA-256・推計人口 */
  unreachableCounts: [7989, 7692, 7953, 7168, 7725, 13920],
  unreachableSha: [
    '516ebe631bdd0bf726bfd196600d5b57264a8fc2e9b3dd67f29e54caa9cab6f4',
    'e7e54e96fb2e68261e229df968e4e63368ad0b5bd14e9de7ccae6e812ebcc8ee',
    '6f6f816c58f479c4645a701a58aa618f090a6ad935460bff8cd59a9f08775e32',
    'a3dd6b7b23356448bade196376e0037129f34668e9e4c806a8c700ba3d9a84c6',
    '4d5b213384697c99ce918912ae309198340d0975cc41b07f947bfecd3ade6358',
    '78cdd810a30928f13b8e3afff9d2561b644d729f6f021de163211fd8a7c8f11c',
  ],
  unreachablePop: [211744.75, 228330, 238406.75, 209405, 228519.5, 299512.25],
  /** 駅の徒歩圏(区分の駅の距離)に入るセル */
  railCells: 14507,
  /** どの停留所からも 1,600m より遠く、駅だけで調べるセルに入ったもの */
  stationOnlyCells: 9409,
  stationOnlyPop: 163230,
  /** 1時間ごと(18 の時間帯)。unreachableShaAll は、時間帯ごとの SHA-256 を改行でつないだものの SHA-256 */
  hourly: {
    bandTotals: [159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0],
    stopCountsSha: '21af8ca82f8a73b4dddfb20310883bd56df0ae3cb92262f6a2baba7fe1e3ef3e',
    unreachableCounts: [13889, 8432, 8976, 9729, 10225, 9586, 8745, 10767, 10165, 9014, 9889, 10388, 9950, 11181, 12923, 14048, 15464, 16601],
    unreachableShaAll: '997beeb3059b206782d8b336288ddf213ba3c268f8bd07865464f759e4a5e93f',
    unreachablePop: [
      319077.5, 217743, 239136, 246306.25, 249784, 249476.5, 246258.25, 261705.25, 255241, 238418.5, 239336, 257718.75, 241389.75,
      260999.75, 287014.5, 305502.75, 341780.5, 395437.75,
    ],
  },
  /** 減便後の GTFS(dohoku_bus_減便後.zip)の 3時間ごと。調べるセル・区分・推計人口は減便前と同じ */
  after: {
    fingerprint: '6f2acd1073c9528cb0a50d14f33388df9c24d9422b1c4ba7cdaa0342c0e7e0e0',
    bandTotals: [2784, 3496, 3390, 3231, 1906, 238],
    stopCountsSha: '28adfaec2efbb9f8299a4fa6e2ec9b978072efb4f337ce94eb6282e3e9b3bb8f',
    unreachableCounts: [8147, 7793, 7888, 7371, 8145, 13924],
    unreachableShaAll: '4f5abbb60e4b938930d450370a1d67257ef976d8387aa6fa251a75a2e6fd73eb',
    unreachablePop: [223494.5, 234244, 239256.75, 209866, 231016, 299679.25],
  },
} as const

/** 時間帯ごとの出発の数を「stop_id:数,数,…」の行(出発がある停留所だけ、stop_id の順)にした SHA-256 と、時間帯ごとの合計 */
function departureDigest(counts: Map<string, number[]>, bands: number): { sha: string; totals: number[] } {
  const lines = [...counts.entries()]
    .filter(([, c]) => c.some((n) => n > 0))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, c]) => `${id}:${c.join(',')}`)
  const totals = Array.from({ length: bands }, (_, b) => [...counts.values()].reduce((s, c) => s + c[b], 0))
  return { sha: sha256(lines), totals }
}

/** 時間帯ごとの到達できないセル(コードの辞書順)の数・SHA-256・推計人口 */
function unreachableDigest(result: ReachResult): { counts: number[]; shas: string[]; shaAll: string; pop: number[] } {
  const order = result.cells.map((_, i) => i).sort((a, b) => (result.cells[a] < result.cells[b] ? -1 : 1))
  const unreachable = result.reachable.map((band) => order.filter((i) => !band[i]))
  const shas = unreachable.map((u) => sha256(u.map((i) => result.cells[i])))
  return {
    counts: unreachable.map((u) => u.length),
    shas,
    shaAll: sha256(shas),
    pop: unreachable.map((u) => u.reduce((s, i) => s + result.cellPopulation[i], 0)),
  }
}

type ServicesFor = (feed: GtfsFeed, date: string) => { today: Set<string>; yesterday: Set<string> }

/** 対象日と前日の service_id。calendar.ts に servicesFor があれば使い、無ければ平日 01(11/2)・日曜 06(11/1)を直接作る */
function services(feed: GtfsFeed): { today: Set<string>; yesterday: Set<string> } {
  const servicesFor = (calendar as Record<string, unknown>).servicesFor as ServicesFor | undefined
  if (servicesFor) return servicesFor(feed, DATE)
  return { today: new Set(['01']), yesterday: new Set(['06']) }
}

function readRef(mesh1: string): unknown {
  return JSON.parse(readFileSync(refPath(mesh1), 'utf8'))
}

/** 時間帯ごとの、到達できないセルの数と、推計人口に占める割合 */
function unreachableByBand(result: ReachResult): { cells: number; population: number; share: number }[] {
  const total = result.cellPopulation.reduce((s, n) => s + n, 0)
  return result.reachable.map((band) => {
    let cells = 0
    let population = 0
    band.forEach((ok, i) => {
      if (ok) return
      cells++
      population += result.cellPopulation[i]
    })
    return { cells, population, share: total > 0 ? population / total : 0 }
  })
}

/** 何回か計算して、最初(読み込み直後)と2回目以降の最短の時間(ms)を返す */
function timed(input: ReachInput, runs: number): { result: ReachResult; first: number; best: number } {
  let result: ReachResult | null = null
  let first = 0
  let best = Infinity
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now()
    result = computeReach(input)
    const ms = performance.now() - t0
    if (k === 0) first = ms
    else best = Math.min(best, ms)
  }
  return { result: result as ReachResult, first, best: runs > 1 ? best : first }
}

describe.skipIf(!HAS_DATA)('道北バス(減便前)と参照データでの到達圏', () => {
  let feed: GtfsFeed
  let ref: RefData

  beforeAll(async () => {
    const buf = readFileSync(DOHOKU_GTFS)
    feed = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    ref = refDataFromJson(REF_MESH1.map(readRef))
  }, 60_000)

  function inputFor(bands: TimeBand[]): ReachInput {
    const counts = departureCountsByBand(feed, services(feed), bands)
    const zeros = new Array<number>(bands.length).fill(0)
    const stops = toStops(feed).stops.map((s) => ({ lat: s.lat, lon: s.lon, bandCounts: counts.counts.get(s.id) ?? zeros }))
    return { stops, ref, fallbackClass: 'suburban', params: DEFAULT_REACH_PARAMS, bandCount: bands.length }
  }

  it('参照データの 6 つのファイルを1つにまとめる(1次メッシュをまたぐ重複は無い)', () => {
    const files = REF_MESH1.map(readRef) as { pop250: Record<string, number>; did125: string[]; stations: unknown[] }[]
    expect(ref.pop250.size).toBe(files.reduce((s, f) => s + Object.keys(f.pop250).length, 0))
    expect(ref.did125.size).toBe(files.reduce((s, f) => s + f.did125.length, 0))
    expect(ref.stations).toHaveLength(files.reduce((s, f) => s + f.stations.length, 0))
  })

  it('停留所の範囲を 1,600m 広げた範囲にかかる 1次メッシュは、6 つの参照データのファイルと一致する', () => {
    const { stops } = toStops(feed)
    const south = Math.min(...stops.map((s) => s.lat))
    const north = Math.max(...stops.map((s) => s.lat))
    const west = Math.min(...stops.map((s) => s.lon))
    const east = Math.max(...stops.map((s) => s.lon))
    const dLat = 1600 / 110_500
    const dLon = 1600 / (111_300 * Math.cos(((north + dLat) * Math.PI) / 180))
    const mesh1 = meshCodesInBounds({ south: south - dLat, west: west - dLon, north: north + dLat, east: east + dLon }, 4)
    expect([...mesh1].sort()).toEqual(REF_MESH1)
  })

  for (const step of [3, 1] as const) {
    it(`${step}時間ごと:2 秒以内に計算でき、21〜24 時台の到達できないセルが最も多い`, () => {
      const bands = makeBands(step)
      const input = inputFor(bands)
      const { result, first, best } = timed(input, 3)

      expect(result.usedFallback).toBe(false)
      expect(result.excludedStops).toBe(0)
      expect(result.reachable).toHaveLength(bands.length)
      expect(result.classes).toHaveLength(result.cells.length)
      expect(result.cellPopulation).toHaveLength(result.cells.length)
      expect(result.cellPopulation.every((n) => n >= 0.25)).toBe(true)

      const rows = unreachableByBand(result)
      const total = result.cellPopulation.reduce((s, n) => s + n, 0)
      const classCount = { urban: 0, suburban: 0, rural: 0 }
      for (const c of result.classes) classCount[c]++
      console.log(
        [
          `${step}時間ごと:停留所 ${input.stops.length}、駅 ${ref.stations.length}、調べたセル ${result.cells.length}` +
            `(都市部 ${classCount.urban}、郊外 ${classCount.suburban}、中山間・地方 ${classCount.rural})、推計人口 ${Math.round(total)} 人`,
          `計算時間:1回目 ${first.toFixed(0)} ms、2回目以降の最短 ${best.toFixed(0)} ms`,
          ...bands.map(
            (b, i) =>
              `  ${b.label.padEnd(7, ' ')} 到達できないセル ${String(rows[i].cells).padStart(6, ' ')}` +
              `(${((rows[i].cells / result.cells.length) * 100).toFixed(1)}%)、推計人口 ${Math.round(rows[i].population)} 人(${(rows[i].share * 100).toFixed(1)}%)`,
          ),
        ].join('\n'),
      )

      // 2 秒以内(ほかのテストと並んで走ると遅くなるため、2回目以降の最短で判定する)
      expect(best).toBeLessThan(2000)
      // 夜(21〜24時)は便が少なく、到達できないセルが最も多い
      const night = bands.findIndex((b) => b.startHour === 21)
      const maxCells = Math.max(...rows.map((r) => r.cells))
      if (step === 3) expect(rows[night].cells).toBe(maxCells)
      else expect(Math.max(...rows.slice(night).map((r) => r.cells))).toBe(maxCells) // 1時間ごとなら 21〜24時のどれか
    }, 60_000)
  }

  it('セルを間引いて、kdbush を使わず全部の停留所・駅との距離で判定した結果と一致する', () => {
    const bands = makeBands(3)
    const input = inputFor(bands)
    const result = computeReach(input)
    const r = Object.fromEntries(
      Object.entries(DEFAULT_REACH_PARAMS.walkMinutes).map(([c, m]) => [c, { bus: m.bus * 80, rail: m.rail * 80 }]),
    ) as Record<string, { bus: number; rail: number }>
    let checked = 0
    for (let i = 0; i < result.cells.length; i += 97) {
      const center = meshCenter(result.cells[i])
      const { bus, rail } = r[result.classes[i]]
      const byRail = ref.stations.some((s) => distanceM(center, s) <= rail)
      const expected = bands.map(
        (_, b) => byRail || input.stops.some((s) => s.bandCounts[b] > 0 && distanceM(center, s) <= bus),
      )
      expect(result.reachable.map((band) => band[i])).toEqual(expected)
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  }, 60_000)

  // ---- 以下は検証担当が足したもの ----

  it('入力のファイルが Python で計算したときと違えば、照合を飛ばしたことを知らせる', () => {
    if (FINGERPRINT !== PYTHON.fingerprint) {
      console.warn(
        `参照データか GTFS が、Python で計算したときから変わっています(${FINGERPRINT})。` +
          'Python との照合のテストは飛ばしました。照合するときは、検証担当の Python で計算し直して PYTHON を書き換えてください。',
      )
    }
    expect(FINGERPRINT).toMatch(/^[0-9a-f]{64}$/)
  })

  describe.skipIf(FINGERPRINT !== PYTHON.fingerprint)('Python で独立に計算した結果との照合(減便前)', () => {
    let input: ReachInput
    let result: ReachResult
    /** コードの辞書順の、結果の番号 */
    let order: number[]

    beforeAll(() => {
      input = inputFor(makeBands(3))
      result = computeReach(input)
      order = result.cells.map((_, i) => i).sort((a, b) => (result.cells[a] < result.cells[b] ? -1 : 1))
    })

    it('時間帯ごとの出発の数(停留所ごと)が一致する', () => {
      const { sha, totals } = departureDigest(departureCountsByBand(feed, services(feed), makeBands(3)).counts, 6)
      expect(sha).toBe(PYTHON.stopCountsSha)
      expect(totals).toEqual(PYTHON.bandTotals)
    })

    it('調べるセル(1,600m 以内で、親の 250m セルの人口が 1 人以上)が一致する', () => {
      const stopsAndStations: LatLon[] = [...input.stops, ...ref.stations]
      expect(cellsWithinRadius(stopsAndStations, 1600)).toHaveLength(PYTHON.candidateCells)
      expect(result.cells).toHaveLength(PYTHON.cells)
      expect(sha256(order.map((i) => result.cells[i]))).toBe(PYTHON.cellsSha)
    })

    it('セルの区分と推計人口が一致する', () => {
      const count = { urban: 0, suburban: 0, rural: 0 }
      for (const c of result.classes) count[c]++
      expect(count).toEqual(PYTHON.classCount)
      expect(sha256(order.map((i) => `${result.cells[i]}:${result.classes[i]}`))).toBe(PYTHON.classesSha)
      // 推計人口 × 4 は親の 250m セルの人口(整数)。÷ 4 は浮動小数でも割り切れる
      expect(sha256(order.map((i) => `${result.cells[i]}:${result.cellPopulation[i] * 4}`))).toBe(PYTHON.populationSha)
      expect(result.cellPopulation.reduce((s, n) => s + n * 4, 0)).toBe(PYTHON.populationTimes4)
    })

    it('6 つの時間帯それぞれで、到達できないセルの集合と推計人口が一致する', () => {
      const got = unreachableDigest(result)
      expect(got.counts).toEqual(PYTHON.unreachableCounts)
      expect(got.shas).toEqual(PYTHON.unreachableSha)
      expect(got.pop).toEqual(PYTHON.unreachablePop)
    })

    it('1時間ごと(18 の時間帯)でも、出発の数と、到達できないセルの集合・推計人口が一致する', () => {
      const bands = makeBands(1)
      const { sha, totals } = departureDigest(departureCountsByBand(feed, services(feed), bands).counts, bands.length)
      expect(sha).toBe(PYTHON.hourly.stopCountsSha)
      expect(totals).toEqual(PYTHON.hourly.bandTotals)
      const hourly = computeReach(inputFor(bands))
      expect(hourly.cells).toEqual(result.cells)
      const got = unreachableDigest(hourly)
      expect(got.counts).toEqual(PYTHON.hourly.unreachableCounts)
      expect(got.shaAll).toBe(PYTHON.hourly.unreachableShaAll)
      expect(got.pop).toEqual(PYTHON.hourly.unreachablePop)
    }, 60_000)

    it('駅の徒歩圏に入るセルの数と、駅だけで調べるセルに入ったセルの数が一致する', () => {
      const rail = Object.fromEntries(
        Object.entries(DEFAULT_REACH_PARAMS.walkMinutes).map(([c, m]) => [c, m.rail * DEFAULT_REACH_PARAMS.speedMPerMin]),
      ) as Record<string, number>
      const byRail = result.cells.filter((cell, i) => ref.stations.some((s) => distanceM(meshCenter(cell), s) <= rail[result.classes[i]]))
      expect(byRail).toHaveLength(PYTHON.railCells)
      // 停留所から 1,600m 以内のセルに入らないものは、駅だけで調べるセルに入った
      const nearStops = new Set(cellsWithinRadius(input.stops, 1600))
      const stationOnly = result.cells.map((_, i) => i).filter((i) => !nearStops.has(result.cells[i]))
      expect(stationOnly).toHaveLength(PYTHON.stationOnlyCells)
      expect(stationOnly.reduce((s, i) => s + result.cellPopulation[i], 0)).toBe(PYTHON.stationOnlyPop)
    })
  })

  it.skipIf(FINGERPRINT_AFTER !== PYTHON.after.fingerprint)(
    '減便後の GTFS でも、出発の数と、到達できないセルの集合・推計人口が Python で計算した値と一致する(3時間ごと)',
    async () => {
      const buf = readFileSync(DOHOKU_GTFS_AFTER)
      const after = await loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      const bands = makeBands(3)
      const counts = departureCountsByBand(after, services(after), bands).counts
      const { sha, totals } = departureDigest(counts, bands.length)
      expect(sha).toBe(PYTHON.after.stopCountsSha)
      expect(totals).toEqual(PYTHON.after.bandTotals)
      const zeros = new Array<number>(bands.length).fill(0)
      const stops = toStops(after).stops.map((s) => ({ lat: s.lat, lon: s.lon, bandCounts: counts.get(s.id) ?? zeros }))
      const result = computeReach({ stops, ref, fallbackClass: 'suburban', params: DEFAULT_REACH_PARAMS, bandCount: bands.length })
      // 停留所は減便前と同じなので、調べるセルも同じ
      expect(result.cells).toEqual(computeReach(inputFor(bands)).cells)
      const got = unreachableDigest(result)
      expect(got.counts).toEqual(PYTHON.after.unreachableCounts)
      expect(got.shaAll).toBe(PYTHON.after.unreachableShaAll)
      expect(got.pop).toEqual(PYTHON.after.unreachablePop)
    },
    60_000,
  )

  it('結果のセルは、南の行から北へ、各行は西から東の順に並ぶ(重複なし)', () => {
    const result = computeReach(inputFor(makeBands(3)))
    for (let i = 1; i < result.cells.length; i++) {
      const a = meshCenter(result.cells[i - 1])
      const b = meshCenter(result.cells[i])
      expect(a.lat < b.lat || (a.lat === b.lat && a.lon < b.lon)).toBe(true)
    }
  }, 60_000)
})

// ---- 検証担当が足した、手で作った例 ----

const RAD = Math.PI / 180

/** from から、北から時計回りに bearing 度の向きへ、distanceM(from, 点) が d になる点(距離の比で数回直す) */
function pointAt(from: LatLon, bearing: number, d: number): LatLon {
  const north = Math.cos(bearing * RAD)
  const east = Math.sin(bearing * RAD)
  let t = d
  let p = from
  for (let k = 0; k < 12; k++) {
    p = { lat: from.lat + (north * t) / 111_120, lon: from.lon + (east * t) / (111_320 * Math.cos(from.lat * RAD)) }
    const got = distanceM(from, p)
    if (got === 0) break
    t *= d / got
  }
  return p
}

function refOf(pop: Record<string, number>, did: string[] = [], stations: LatLon[] = []): RefData {
  return { pop250: new Map(Object.entries(pop)), did125: new Set(did), stations }
}

/** すべての区分で、バス停も駅も同じ分数にした条件 */
function uniformParams(minutes: number): ReachParams {
  const m = { bus: minutes, rail: minutes }
  return { ...DEFAULT_REACH_PARAMS, walkMinutes: { urban: m, suburban: m, rural: m } }
}

function reachOf(result: ReachResult, cell: string): boolean[] {
  const i = result.cells.indexOf(cell)
  if (i < 0) throw new Error(`${cell} は調べたセルに入っていません`)
  return result.reachable.map((band) => band[i])
}

describe('候補の箱が取りこぼさない(高緯度・赤道近くで、半径 10km)', () => {
  // 半径 125 分 × 80m = 10,000m。北東・北西の向きは、点がセルより北にあって経度 1度が短くなるので、箱がいちばん窮屈になる
  const R = 10_000
  const bearings = Array.from({ length: 72 }, (_, k) => k * 5)

  for (const [label, lat, lon] of [
    ['北緯 66.5 度(地域メッシュの北の端の近く)', 66.5, 140.3],
    ['北緯 0.2 度(赤道の近く)', 0.2, 140.3],
    ['北緯 45.5 度・東経 141.9 度(稚内の近く)', 45.5, 141.9],
  ] as const) {
    const cell = meshCode(lat, lon, 11)
    const center = meshCenter(cell)
    const ref = refOf({ [parentCode(cell, 10)]: 100 })

    it(`${label}:72 の向きで、${R}m の 0.1mm 内側の停留所はすべて届き、0.1mm 外側はすべて届かない(時間帯 72 個)`, () => {
      // セルを調べる対象に入れるため、セルの中心に出発の無い停留所も置く
      const seed = { lat: center.lat, lon: center.lon, bandCounts: [] }
      const at = (d: number) =>
        computeReach({
          stops: [
            seed,
            ...bearings.map((b, k) => {
              const p = pointAt(center, b, d)
              const bandCounts = new Array<number>(bearings.length).fill(0)
              bandCounts[k] = 1
              return { lat: p.lat, lon: p.lon, bandCounts }
            }),
          ],
          ref,
          fallbackClass: 'suburban',
          params: uniformParams(125),
          bandCount: bearings.length,
        })
      for (const b of bearings) {
        expect(Math.abs(distanceM(center, pointAt(center, b, R - 1e-4)) - (R - 1e-4))).toBeLessThan(1e-6)
      }
      const inside = at(R - 1e-4)
      expect(inside.excludedStops).toBe(0)
      expect(reachOf(inside, cell)).toEqual(bearings.map(() => true))
      const outside = at(R + 1e-4)
      expect(outside.excludedStops).toBe(0)
      expect(reachOf(outside, cell)).toEqual(bearings.map(() => false))
    }, 60_000)

    it(`${label}:鉄道駅も、北東・北西などの向きで ${R}m の 0.1mm 内側なら届き、外側なら届かない`, () => {
      // セルを調べる対象に入れるため、セルの中心に出発の無い停留所を置く
      const seed = { lat: center.lat, lon: center.lon, bandCounts: [0, 0] }
      for (const b of [0, 45, 60, 75, 85, 90, 275, 300, 315]) {
        const run = (d: number) =>
          computeReach({
            stops: [seed],
            ref: { ...ref, stations: [pointAt(center, b, d)] },
            fallbackClass: 'suburban',
            params: uniformParams(125),
            bandCount: 2,
          })
        expect(reachOf(run(R - 1e-4), cell)).toEqual([true, true])
        expect(reachOf(run(R + 1e-4), cell)).toEqual([false, false])
      }
    }, 60_000)
  }
})

describe('境目と入力の形(検証担当)', () => {
  const T = '65425228243'
  const P = parentCode(T, 10)
  const C = meshCenter(T)
  const base = (over: Partial<ReachInput>): ReachInput => ({
    stops: [{ lat: C.lat, lon: C.lon, bandCounts: [1, 0] }],
    ref: null,
    fallbackClass: 'suburban',
    params: DEFAULT_REACH_PARAMS,
    bandCount: 2,
    ...over,
  })

  it('ref が undefined(Worker 越しなどで型を外れた値)でも、参照データが無いときと同じ結果で、usedFallback は true', () => {
    const withNull = computeReach(base({ ref: null }))
    const withUndefined = computeReach(base({ ref: undefined as unknown as null }))
    expect(withUndefined).toEqual(withNull)
    expect(withUndefined.usedFallback).toBe(true)
  })

  it('ref の pop250 が Map でない(JSON のまま渡した)などの形の誤りは、日本語のエラーにする', () => {
    const json = { pop250: { [P]: 100 }, did125: [T], stations: [] }
    expect(() => computeReach(base({ ref: json as unknown as RefData }))).toThrow('参照データの形が正しくありません')
    const noStations = { pop250: new Map([[P, 100]]), did125: new Set([T]) }
    expect(() => computeReach(base({ ref: noStations as unknown as RefData }))).toThrow('参照データの形が正しくありません')
  })

  it('DID の中のセルでも、親の 250m セルの人口が 0 なら調べるセルに入らない', () => {
    const result = computeReach(base({ ref: refOf({}, [T]) }))
    expect(result.cells).toEqual([])
  })

  it('bandCounts が時間帯の数より長ければ、余りの時間帯は見ない', () => {
    const result = computeReach(base({ stops: [{ lat: C.lat, lon: C.lon, bandCounts: [0, 1, 7, 7] }], ref: refOf({ [P]: 100 }, [T]) }))
    expect(result.reachable).toHaveLength(2)
    expect(reachOf(result, T)).toEqual([false, true])
  })

  it('徒歩の分数が 0 なら、セルの中心ちょうどの停留所だけが、そのセルに届く', () => {
    const zero = { bus: 0, rail: 0 }
    const params: ReachParams = { ...DEFAULT_REACH_PARAMS, walkMinutes: { urban: zero, suburban: zero, rural: zero } }
    const result = computeReach(base({ params }))
    expect(result.cells).toEqual([T])
    expect(reachOf(result, T)).toEqual([true, false])
  })

  it('駅は時刻表が無いので、bandCount が 0 でも例外にならず、時間帯の無い結果を返す', () => {
    const result = computeReach(base({ bandCount: 0, ref: refOf({ [P]: 100 }, [T], [C]) }))
    expect(result.reachable).toEqual([])
    expect(result.cells).toContain(T)
  })
})
