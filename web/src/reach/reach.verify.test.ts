// 実データでの確かめ。ファイルが無ければスキップする(data/raw/・data/out/ はコミットしない)。
//
// - 道北バスの GTFS(data/raw/gtfs/dohoku_bus_減便前.zip・dohoku_bus_減便後.zip)
// - 参照データ(data/out/ref/{1次メッシュ}.json。data/ の Python で作ったもの)
//
// 減便前は 2026-11-02(月)、減便後は 2026-11-04(水)の時間帯ごとの出発の数と参照データで到達圏を計算し、
// 調べたセル・到達できる見込みのあるセル(coverable)と、時間帯ごとの外れるセルの数と推計人口、計算時間を出力する。
// 起点は、画面と同じく stop_times に1回以上出てくる停留所で、location_type が 0(空を含む)のものだけ(取り決めの追記2)。
// 検証担当が Python で独立に計算した結果(PYTHON)とも照らす。入力のファイルが変わっていれば、その照合だけを飛ばす。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { servicesFor } from '../gtfs/calendar'
import { departureCountsByBand, makeBands, type TimeBand } from '../gtfs/departures'
import { loadGtfsZip, type GtfsFeed } from '../gtfs/load'
import { toStops, type Stop } from '../gtfs/parse'
import { cellsWithinRadius, distanceM, meshCenter, meshCode, meshCodesInBounds, parentCode, type LatLon } from './mesh'
import {
  computeReach,
  DEFAULT_REACH_PARAMS,
  refDataFromJson,
  type ReachInput,
  type ReachParams,
  type ReachResult,
  type RefData,
  type RegionClass,
} from './reach'

const DOHOKU_GTFS = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const DOHOKU_GTFS_AFTER = fileURLToPath(new URL('../../../data/raw/gtfs/dohoku_bus_減便後.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../data/out/ref/', import.meta.url))
const REF_MESH1 = ['6541', '6542', '6543', '6641', '6642', '6643']
const refPath = (mesh1: string) => `${REF_DIR}${mesh1}.json`
const HAS_DATA = existsSync(DOHOKU_GTFS) && REF_MESH1.every((m) => existsSync(refPath(m)))

/** 減便前の対象日。月曜日で、前日の 11/1 は日曜日 */
const DATE = '20261102'
/** 減便後の対象日。水曜日で、前日の 11/3(文化の日)は calendar_dates で日祝ダイヤ(06)になる */
const DATE_AFTER = '20261104'

/** 参照データの読み込み範囲(取り決めの追記2):バス停の距離の最大 1,200m + 駅の距離の最大 1,600m */
const REF_MARGIN_M = 2800

const sha256 = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')

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
 * 検証担当が Python(python3 -I)で別に計算した値。reach.ts・mesh.ts のコードは見ずに、取り決め(追記2まで)と
 * JIS X 0410 の定義から書いた。
 * - 起点は stop_times に1回以上出てくる、location_type が 0 か空の停留所。駅は起点にしない
 * - 調べるセルは、起点から 3区分のバス停の距離の最大(1,200m)以内で、親の 250m セルの人口が 1 人以上のもの
 * - 地域メッシュのコードは緯度を分・秒の余りで割っていく定義どおりに作り、中心はコードの各桁から足し上げる
 * - 距離は GRS80 のヒュベニの式、250m セルの面積は M(φ)N(φ)cosφ の Simpson 法の数値積分
 * - 近くの点は 0.02度 × 0.03度の格子で探す(kdbush は使わない)
 * - 運行日と時間帯ごとの出発も GTFS から数え直した
 * 距離が徒歩圏の 1mm 以内のセル(区分のバス停・駅の距離)は 0 個、人口密度がしきい値の 0.1% 以内の 250m セルも 0 個。
 * 調べるセルの 1,200m の 1mm 以内は1つ(65422434243、1,200.0005m)あるが、親の 250m セルの人口が 0 で結果に入らない。
 * 文字列の SHA-256 は、11 桁のコードの辞書順に並べた行を改行でつないだもの。
 * 「外れるセル」は coverable のセルのうち、その時間帯に到達できないもの(表の割合の分子)。
 *
 * 11/3 に別の検証担当が、上の Python を見ずに取り決め(追記2まで)だけから計算を書き直し(セル × 起点・駅を、
 * 緯度の差だけで 1,700m を超える組を除いて総当たりし、250m セルの面積は Simpson 法)、3つの場合のここの値が
 * すべて一致することを確かめた。
 * そのときの境目までの最小の差は、区分のバス停の距離が 1.1mm(66423363221 と 6720_01、1,200.0011m)、
 * 区分の駅の距離が 6.3cm、人口密度がしきい値の 0.26%(6642231012)。
 */
const PYTHON = {
  /** 参照データの駅が 78 のときのファイル(2026-11-03 01:29 に書かれたもの) */
  fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
  /** 起点の停留所(1,582 のうち、stop_times に出てこない 122 を除く) */
  originStops: 1460,
  /** 3時間ごとの時間帯の出発の合計 */
  bandTotals: [3105, 3787, 3792, 3488, 2365, 282],
  /** 出発がある停留所の「stop_id:6つの数」(stop_id の順) */
  stopCountsSha: '5b7a822992bbdc38e2b7d28fb6bf8440b2e3d6a9b054843d009a9d1972d3a9b9',
  /** 起点から 1,200m 以内のセル(人口で絞る前) */
  candidateCells: 54903,
  cells: 18951,
  cellsSha: 'b1b114112b15455dc4dfe43934b98b1060783caee0031ea554368af5df44c366',
  classCount: { urban: 5669, suburban: 1971, rural: 11311 },
  /** 「コード:区分」 */
  classesSha: 'd821febe5a9847c162d978fa54569b0d22c0b41f42f2fd9fa024e7eac23d58e4',
  /** 「コード:推計人口 × 4(= 親の 250m セルの人口)」 */
  populationSha: 'f3dd08b45a3634bebca395465d2cbc7ab62c84a468e01fd914e65021346f75b6',
  populationTimes4: 1617508,
  /** 到達できる見込みのあるセル(coverable) */
  coverable: {
    cells: 17200,
    sha: '29770298b08b3123cee7bf5f66502f72f6ee545c98d820b0b74d773f5cf4694d',
    pop: 305703.75,
    classCount: { urban: 4029, suburban: 1860, rural: 11311 },
  },
  /** ダイヤと関係なく外れるセル(coverable でないもの) */
  nonCoverable: { cells: 1751, pop: 98673.25 },
  /** 駅の徒歩圏(区分の駅の距離)に入るセル */
  railCells: 6157,
  /** 区分のバス停の距離に起点が無く、駅だけで coverable になったセル */
  railOnlyCoverable: 402,
  /** 3時間ごとの外れるセル(coverable の中)の数・コードの SHA-256・推計人口 */
  outCounts: [2431, 2134, 2395, 1610, 2167, 8362],
  outSha: [
    '6d63b0df7f9fc92fef2ffc2eeeb3ff8a16eb0a8e882ef6a93a1f4e71f269c650',
    'd1022eada27a571a53ac55020ac08d2920131c16a09b6c06e289a0425cc87d08',
    '389ec692e160724ea5988d3ddb3d5df460b09fbc9104a990cc425fce5c8a796a',
    '4fe4a2d88e17622dc6f1449b7f3608f81ac920864f5336c50e507bfb6643441b',
    'a41a73313611a165bf4b3bc6b1470e1184a2f5c02d244f593893c700874a7143',
    '296f38686df2eb550f57a7dad3c5cf6f8c0be38f61e22d2e546b51d53d202c5c',
  ],
  outPop: [22710, 39295.25, 49372, 20370.25, 39484.75, 110477.5],
  /** 1時間ごと(18 の時間帯)。outShaAll は、時間帯ごとの SHA-256 を改行でつないだものの SHA-256 */
  hourly: {
    bandTotals: [159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0],
    stopCountsSha: '21af8ca82f8a73b4dddfb20310883bd56df0ae3cb92262f6a2baba7fe1e3ef3e',
    outCounts: [8331, 2874, 3418, 4171, 4667, 4028, 3187, 5209, 4607, 3456, 4331, 4830, 4392, 5623, 7365, 8490, 9906, 11043],
    outShaAll: '9dce90ac2d3a269f0db205c3408503e221035f655a965937f13124caa47b4700',
    outPop: [
      130042.75, 28708.25, 50101.25, 57271.5, 60749.25, 60441.75, 57223.5, 72670.5, 66206.25, 49383.75, 50301.25, 68684, 52355,
      71965, 97979.75, 116468, 152745.75, 206403,
    ],
  },
  /**
   * 減便後の GTFS(dohoku_bus_減便後.zip)の 2026-11-04 の 3時間ごと。
   * stop_times に出てくる停留所が減便前より少ない(1,364)ので、調べるセルも減便前と違う
   */
  after: {
    fingerprint: '6f2acd1073c9528cb0a50d14f33388df9c24d9422b1c4ba7cdaa0342c0e7e0e0',
    originStops: 1364,
    bandTotals: [2784, 3496, 3390, 3231, 1906, 238],
    stopCountsSha: '28adfaec2efbb9f8299a4fa6e2ec9b978072efb4f337ce94eb6282e3e9b3bb8f',
    cells: 18455,
    cellsSha: '83cbbaee503966527cff9399c044ade982f5b8f86abf68b588105334cee9b2df',
    classCount: { urban: 5618, suburban: 1970, rural: 10867 },
    classesSha: 'c79d0de7a783685493464b5012d2b34cad16be5c1796e8adb742a723ce3be045',
    populationSha: 'aabc004d5adfb6fde7458c2e16bd2f44a2fda2efb970d70d4bd18fb89f8e0ca9',
    populationTimes4: 1606895,
    coverable: {
      cells: 16559,
      sha: '9f6701062bc7148e7342a27cfc71ca4189c65da78e6ee0924f24353702853480',
      pop: 294886.5,
      classCount: { urban: 3832, suburban: 1860, rural: 10867 },
    },
    nonCoverable: { cells: 1896, pop: 106837.25 },
    outCounts: [2075, 1721, 1816, 1299, 2073, 7852],
    outShaAll: '381a69d3deceb06f21221294402c5391804c412fdba623fb69c55db58e6ad33f',
    outPop: [24042.75, 34792.25, 39805, 10414.25, 31564.25, 100227.5],
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

/** コードの辞書順の、結果の番号 */
function codeOrder(result: ReachResult): number[] {
  return result.cells.map((_, i) => i).sort((a, b) => (result.cells[a] < result.cells[b] ? -1 : 1))
}

/** 調べたセル・区分・推計人口の SHA-256 と数 */
function cellDigest(result: ReachResult) {
  const order = codeOrder(result)
  const classCount: Record<RegionClass, number> = { urban: 0, suburban: 0, rural: 0 }
  for (const c of result.classes) classCount[c]++
  return {
    cells: result.cells.length,
    cellsSha: sha256(order.map((i) => result.cells[i])),
    classCount,
    classesSha: sha256(order.map((i) => `${result.cells[i]}:${result.classes[i]}`)),
    // 推計人口 × 4 は親の 250m セルの人口(整数)。÷ 4 は浮動小数でも割り切れる
    populationSha: sha256(order.map((i) => `${result.cells[i]}:${result.cellPopulation[i] * 4}`)),
    populationTimes4: result.cellPopulation.reduce((s, n) => s + n * 4, 0),
  }
}

/** coverable のセル(コードの辞書順)の数・SHA-256・推計人口・区分の内訳と、coverable でないセルの数・推計人口 */
function coverableDigest(result: ReachResult) {
  const order = codeOrder(result)
  const cov = order.filter((i) => result.coverable[i])
  const non = order.filter((i) => !result.coverable[i])
  const classCount: Record<RegionClass, number> = { urban: 0, suburban: 0, rural: 0 }
  for (const i of cov) classCount[result.classes[i]]++
  const pop = (list: number[]) => list.reduce((s, i) => s + result.cellPopulation[i], 0)
  return {
    coverable: { cells: cov.length, sha: sha256(cov.map((i) => result.cells[i])), pop: pop(cov), classCount },
    nonCoverable: { cells: non.length, pop: pop(non) },
  }
}

/** 時間帯ごとの外れるセル(coverable の中で到達できないもの。コードの辞書順)の数・SHA-256・推計人口 */
function outDigest(result: ReachResult): { counts: number[]; shas: string[]; shaAll: string; pop: number[] } {
  const order = codeOrder(result).filter((i) => result.coverable[i])
  const out = result.reachable.map((band) => order.filter((i) => !band[i]))
  const shas = out.map((u) => sha256(u.map((i) => result.cells[i])))
  return {
    counts: out.map((u) => u.length),
    shas,
    shaAll: sha256(shas),
    pop: out.map((u) => u.reduce((s, i) => s + result.cellPopulation[i], 0)),
  }
}

/**
 * 画面と同じ起点(取り決めの追記2):stop_times に1回以上出てくる停留所で、location_type が 0(空は 0 とみなす)のもの。
 * 照合するときは、stop_id の前後の空白を取る
 */
function originStops(feed: GtfsFeed): Stop[] {
  const used = new Set<string>()
  for (const row of feed.tables.get('stop_times')?.rows ?? []) {
    const id = row.stop_id?.trim()
    if (id) used.add(id)
  }
  return toStops(feed).stops.filter((s) => s.locationType === 0 && used.has(s.id))
}

function readRef(mesh1: string): unknown {
  return JSON.parse(readFileSync(refPath(mesh1), 'utf8'))
}

async function loadFeed(path: string): Promise<GtfsFeed> {
  const buf = readFileSync(path)
  return loadGtfsZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
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

/** 停留所の外接矩形を marginM だけ広げた範囲にかかる 1次メッシュ(緯度・経度の換算は広めに取る) */
function mesh1Around(points: LatLon[], marginM: number): string[] {
  const south = Math.min(...points.map((s) => s.lat))
  const north = Math.max(...points.map((s) => s.lat))
  const west = Math.min(...points.map((s) => s.lon))
  const east = Math.max(...points.map((s) => s.lon))
  const dLat = marginM / 110_500
  const dLon = marginM / (111_300 * Math.cos(((north + dLat) * Math.PI) / 180))
  return [...meshCodesInBounds({ south: south - dLat, west: west - dLon, north: north + dLat, east: east + dLon }, 4)].sort()
}

describe.skipIf(!HAS_DATA)('道北バス(減便前)と参照データでの到達圏', () => {
  let feed: GtfsFeed
  let ref: RefData
  let origins: Stop[]

  beforeAll(async () => {
    feed = await loadFeed(DOHOKU_GTFS)
    ref = refDataFromJson(REF_MESH1.map(readRef))
    origins = originStops(feed)
  }, 60_000)

  function inputFor(bands: TimeBand[]): ReachInput {
    const counts = departureCountsByBand(feed, servicesFor(feed, DATE), bands)
    const zeros = new Array<number>(bands.length).fill(0)
    const stops = origins.map((s) => ({ lat: s.lat, lon: s.lon, bandCounts: counts.counts.get(s.id) ?? zeros }))
    return { stops, ref, fallbackClass: 'suburban', params: DEFAULT_REACH_PARAMS, bandCount: bands.length }
  }

  it('参照データの 6 つのファイルを1つにまとめる(1次メッシュをまたぐ重複は無い)', () => {
    const files = REF_MESH1.map(readRef) as { pop250: Record<string, number>; did125: string[]; stations: unknown[] }[]
    expect(ref.pop250.size).toBe(files.reduce((s, f) => s + Object.keys(f.pop250).length, 0))
    expect(ref.did125.size).toBe(files.reduce((s, f) => s + f.did125.length, 0))
    expect(ref.stations).toHaveLength(files.reduce((s, f) => s + f.stations.length, 0))
  })

  it('起点は stop_times に出てくる停留所だけ(道北バスは 1,582 のうち 1,460。すべて location_type 0)', () => {
    const { stops } = toStops(feed)
    expect(stops).toHaveLength(1582)
    expect(stops.every((s) => s.locationType === 0)).toBe(true)
    expect(origins).toHaveLength(1460)
  })

  it('起点の範囲を 2,800m(バス停 1,200m + 駅 1,600m)広げた範囲にかかる 1次メッシュは、6 つの参照データのファイルと一致する', () => {
    expect(mesh1Around(origins, REF_MARGIN_M)).toEqual(REF_MESH1)
  })

  for (const step of [3, 1] as const) {
    it(`${step}時間ごと:2 秒以内に計算でき、21〜24 時台の外れるセルが最も多い`, () => {
      const bands = makeBands(step)
      const input = inputFor(bands)
      const { result, first, best } = timed(input, 3)

      expect(result.usedFallback).toBe(false)
      expect(result.excludedStops).toBe(0)
      expect(result.reachable).toHaveLength(bands.length)
      expect(result.classes).toHaveLength(result.cells.length)
      expect(result.cellPopulation).toHaveLength(result.cells.length)
      expect(result.coverable).toHaveLength(result.cells.length)
      expect(result.cellPopulation.every((n) => n >= 0.25)).toBe(true)

      const { coverable, nonCoverable } = coverableDigest(result)
      const out = outDigest(result)
      const { classCount } = cellDigest(result)
      const total = result.cellPopulation.reduce((s, n) => s + n, 0)
      console.log(
        [
          `${step}時間ごと:起点の停留所 ${input.stops.length}、駅 ${ref.stations.length}、調べたセル ${result.cells.length}` +
            `(都市部 ${classCount.urban}、郊外 ${classCount.suburban}、中山間・地方 ${classCount.rural})、推計人口 ${Math.round(total)} 人`,
          `到達できる見込みのあるセル ${coverable.cells}(推計人口 ${Math.round(coverable.pop)} 人)、` +
            `ダイヤと関係なく外れるセル ${nonCoverable.cells}(推計人口 ${Math.round(nonCoverable.pop)} 人)`,
          `計算時間:1回目 ${first.toFixed(0)} ms、2回目以降の最短 ${best.toFixed(0)} ms`,
          ...bands.map(
            (b, i) =>
              `  ${b.label.padEnd(7, ' ')} 外れるセル ${String(out.counts[i]).padStart(6, ' ')}` +
              `(${((out.counts[i] / coverable.cells) * 100).toFixed(1)}%)、推計人口 ${Math.round(out.pop[i])} 人` +
              `(${((out.pop[i] / coverable.pop) * 100).toFixed(1)}%)`,
          ),
        ].join('\n'),
      )

      // 2 秒以内(ほかのテストと並んで走ると遅くなるため、2回目以降の最短で判定する)
      expect(best).toBeLessThan(2000)
      // 夜(21〜24時)は便が少なく、外れるセルが最も多い
      const night = bands.findIndex((b) => b.startHour === 21)
      const maxCells = Math.max(...out.counts)
      if (step === 3) expect(out.counts[night]).toBe(maxCells)
      else expect(Math.max(...out.counts.slice(night))).toBe(maxCells) // 1時間ごとなら 21〜24時のどれか
    }, 60_000)
  }

  it('到達できるセルは、すべて到達できる見込みもある(coverable でないセルは、どの時間帯でも到達できない)', () => {
    const result = computeReach(inputFor(makeBands(1)))
    for (const band of result.reachable) {
      expect(band.every((ok, i) => !ok || result.coverable[i])).toBe(true)
    }
    expect(result.coverable.some((v) => !v)).toBe(true)
  }, 60_000)

  it('すべてのセルで、kdbush を使わず全部の停留所・駅との距離で判定した結果(到達と coverable)と一致する', () => {
    const bands = makeBands(3)
    const input = inputFor(bands)
    const result = computeReach(input)
    const r = Object.fromEntries(
      Object.entries(DEFAULT_REACH_PARAMS.walkMinutes).map(([c, m]) => [c, { bus: m.bus * 80, rail: m.rail * 80 }]),
    ) as Record<string, { bus: number; rail: number }>
    // 緯度 1度は 110,574m 以上あるので、緯度の差が 1,700 ÷ 110,000 度を超える停留所は 1,700m より遠く、
    // どの区分のバス停の距離(最大 1,200m)にも入らない。距離の計算を省くのはその停留所だけにする
    const latSkip = 1700 / 110_000
    const mismatched: string[] = []
    let nonCoverable = 0
    for (let i = 0; i < result.cells.length; i++) {
      const center = meshCenter(result.cells[i])
      const { bus, rail } = r[result.classes[i]]
      const byRail = ref.stations.some((s) => distanceM(center, s) <= rail)
      const nearStops = input.stops.filter((s) => Math.abs(s.lat - center.lat) <= latSkip && distanceM(center, s) <= bus)
      const coverable = byRail || nearStops.length > 0
      const reach = bands.map((_, b) => byRail || nearStops.some((s) => s.bandCounts[b] > 0))
      if (result.coverable[i] !== coverable || reach.some((ok, b) => result.reachable[b][i] !== ok)) {
        mismatched.push(result.cells[i])
      }
      if (!coverable) nonCoverable++
    }
    expect(mismatched).toEqual([])
    expect(nonCoverable).toBeGreaterThan(10)
  }, 60_000)

  it('駅だけのまわりのセルは調べない(調べたセルは、どれも起点の停留所から 1,200m 以内)', () => {
    const result = computeReach(inputFor(makeBands(3)))
    const near = new Set(cellsWithinRadius(origins, 1200))
    expect(result.cells.every((c) => near.has(c))).toBe(true)
    // 起点から 1,200m より遠い駅のセルは入らない(例:駅から 1,200m 以内でも、起点からは遠いセル)
    const stationCells = new Set(cellsWithinRadius(ref.stations, 1600))
    const stationOnly = [...stationCells].filter((c) => !near.has(c) && (ref.pop250.get(parentCode(c, 10)) ?? 0) >= 1)
    expect(stationOnly.length).toBeGreaterThan(0)
    const cells = new Set(result.cells)
    expect(stationOnly.some((c) => cells.has(c))).toBe(false)
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

  describe.skipIf(FINGERPRINT !== PYTHON.fingerprint)('Python で独立に計算した結果との照合(減便前、2026-11-02)', () => {
    let input: ReachInput
    let result: ReachResult

    beforeAll(() => {
      input = inputFor(makeBands(3))
      result = computeReach(input)
    })

    it('起点の停留所の数と、時間帯ごとの出発の数(停留所ごと)が一致する', () => {
      expect(input.stops).toHaveLength(PYTHON.originStops)
      const { sha, totals } = departureDigest(departureCountsByBand(feed, servicesFor(feed, DATE), makeBands(3)).counts, 6)
      expect(sha).toBe(PYTHON.stopCountsSha)
      expect(totals).toEqual(PYTHON.bandTotals)
    })

    it('調べるセル(起点から 1,200m 以内で、親の 250m セルの人口が 1 人以上)が一致する', () => {
      expect(cellsWithinRadius(input.stops, 1200)).toHaveLength(PYTHON.candidateCells)
      const got = cellDigest(result)
      expect(got.cells).toBe(PYTHON.cells)
      expect(got.cellsSha).toBe(PYTHON.cellsSha)
    })

    it('セルの区分と推計人口が一致する', () => {
      const got = cellDigest(result)
      expect(got.classCount).toEqual(PYTHON.classCount)
      expect(got.classesSha).toBe(PYTHON.classesSha)
      expect(got.populationSha).toBe(PYTHON.populationSha)
      expect(got.populationTimes4).toBe(PYTHON.populationTimes4)
    })

    it('到達できる見込みのあるセル(coverable)と、ダイヤと関係なく外れるセルの数・推計人口が一致する', () => {
      const got = coverableDigest(result)
      expect(got.coverable).toEqual(PYTHON.coverable)
      expect(got.nonCoverable).toEqual(PYTHON.nonCoverable)
    })

    it('駅の徒歩圏に入るセルと、駅だけで coverable になったセルの数が一致する', () => {
      const rail = Object.fromEntries(
        Object.entries(DEFAULT_REACH_PARAMS.walkMinutes).map(([c, m]) => [c, m.rail * DEFAULT_REACH_PARAMS.speedMPerMin]),
      ) as Record<string, number>
      const bus = Object.fromEntries(
        Object.entries(DEFAULT_REACH_PARAMS.walkMinutes).map(([c, m]) => [c, m.bus * DEFAULT_REACH_PARAMS.speedMPerMin]),
      ) as Record<string, number>
      const byRail = result.cells.map((cell, i) => ref.stations.some((s) => distanceM(meshCenter(cell), s) <= rail[result.classes[i]]))
      expect(byRail.filter(Boolean)).toHaveLength(PYTHON.railCells)
      // 駅の徒歩圏に入るが、区分のバス停の距離に起点が無いセル
      const railOnly = result.cells.filter(
        (cell, i) => byRail[i] && !input.stops.some((s) => distanceM(meshCenter(cell), s) <= bus[result.classes[i]]),
      )
      expect(railOnly).toHaveLength(PYTHON.railOnlyCoverable)
    })

    it('6 つの時間帯それぞれで、外れるセル(coverable の中)の集合と推計人口が一致する', () => {
      const got = outDigest(result)
      expect(got.counts).toEqual(PYTHON.outCounts)
      expect(got.shas).toEqual(PYTHON.outSha)
      expect(got.pop).toEqual(PYTHON.outPop)
    })

    it('1時間ごと(18 の時間帯)でも、出発の数と、外れるセルの集合・推計人口が一致する', () => {
      const bands = makeBands(1)
      const { sha, totals } = departureDigest(departureCountsByBand(feed, servicesFor(feed, DATE), bands).counts, bands.length)
      expect(sha).toBe(PYTHON.hourly.stopCountsSha)
      expect(totals).toEqual(PYTHON.hourly.bandTotals)
      const hourly = computeReach(inputFor(bands))
      // 調べるセル・区分・coverable は時間帯の分け方によらない
      expect(hourly.cells).toEqual(result.cells)
      expect(hourly.classes).toEqual(result.classes)
      expect(hourly.coverable).toEqual(result.coverable)
      const got = outDigest(hourly)
      expect(got.counts).toEqual(PYTHON.hourly.outCounts)
      expect(got.shaAll).toBe(PYTHON.hourly.outShaAll)
      expect(got.pop).toEqual(PYTHON.hourly.outPop)
    }, 60_000)
  })

  it.skipIf(FINGERPRINT_AFTER !== PYTHON.after.fingerprint)(
    '減便後の GTFS(2026-11-04)でも、調べるセル・coverable・外れるセルの集合と推計人口が Python で計算した値と一致する(3時間ごと)',
    async () => {
      const after = await loadFeed(DOHOKU_GTFS_AFTER)
      const bands = makeBands(3)
      const services = servicesFor(after, DATE_AFTER)
      expect([...services.today]).toEqual(['01'])
      expect([...services.yesterday]).toEqual(['06'])
      const counts = departureCountsByBand(after, services, bands).counts
      const { sha, totals } = departureDigest(counts, bands.length)
      expect(sha).toBe(PYTHON.after.stopCountsSha)
      expect(totals).toEqual(PYTHON.after.bandTotals)

      const afterOrigins = originStops(after)
      expect(afterOrigins).toHaveLength(PYTHON.after.originStops)
      // 起点の範囲を 2,800m 広げた範囲の 1次メッシュは、6 つの参照データのファイルに収まる
      expect(mesh1Around(afterOrigins, REF_MARGIN_M).every((m) => REF_MESH1.includes(m))).toBe(true)

      const zeros = new Array<number>(bands.length).fill(0)
      const stops = afterOrigins.map((s) => ({ lat: s.lat, lon: s.lon, bandCounts: counts.get(s.id) ?? zeros }))
      const { result, best } = timed(
        { stops, ref, fallbackClass: 'suburban', params: DEFAULT_REACH_PARAMS, bandCount: bands.length },
        3,
      )
      expect(best).toBeLessThan(2000)

      const cells = cellDigest(result)
      expect(cells.cells).toBe(PYTHON.after.cells)
      expect(cells.cellsSha).toBe(PYTHON.after.cellsSha)
      expect(cells.classCount).toEqual(PYTHON.after.classCount)
      expect(cells.classesSha).toBe(PYTHON.after.classesSha)
      expect(cells.populationSha).toBe(PYTHON.after.populationSha)
      expect(cells.populationTimes4).toBe(PYTHON.after.populationTimes4)

      const cov = coverableDigest(result)
      expect(cov.coverable).toEqual(PYTHON.after.coverable)
      expect(cov.nonCoverable).toEqual(PYTHON.after.nonCoverable)

      const got = outDigest(result)
      expect(got.counts).toEqual(PYTHON.after.outCounts)
      expect(got.shaAll).toBe(PYTHON.after.outShaAll)
      expect(got.pop).toEqual(PYTHON.after.outPop)
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

    it(`${label}:駅だけで到達できる見込み(coverable)になるかも、北東・北西などの向きで ${R}m の 0.1mm で分かれる`, () => {
      // セルを DID(都市部)にし、都市部のバス停は 8,000m、駅は 10,000m、中山間・地方のバス停は 9,000m にする。
      // 起点はセルから南へ 8,500m(都市部のバス停の距離の外、調べるセルの半径 9,000m の内)に置き、駅だけで coverable が決まるようにする
      const params: ReachParams = {
        ...DEFAULT_REACH_PARAMS,
        walkMinutes: { urban: { bus: 100, rail: 125 }, suburban: { bus: 100, rail: 125 }, rural: { bus: 112.5, rail: 125 } },
      }
      const stop = pointAt(center, 180, 8500)
      const didRef = refOf({ [parentCode(cell, 10)]: 100 }, [cell])
      for (const b of [0, 45, 60, 85, 275, 315]) {
        const run = (stationD: number) => {
          const result = computeReach({
            stops: [{ lat: stop.lat, lon: stop.lon, bandCounts: [1] }],
            ref: { ...didRef, stations: [pointAt(center, b, stationD)] },
            fallbackClass: 'suburban',
            params,
            bandCount: 1,
          })
          const i = result.cells.indexOf(cell)
          if (i < 0) throw new Error(`${cell} は調べたセルに入っていません`)
          expect(result.classes[i]).toBe('urban')
          return { coverable: result.coverable[i], reachable: result.reachable[0][i] }
        }
        expect(run(R - 1e-4)).toEqual({ coverable: true, reachable: true })
        expect(run(R + 1e-4)).toEqual({ coverable: false, reachable: false })
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
    expect(result.coverable).toEqual([true])
  })

  it('駅は時刻表が無いので、bandCount が 0 でも例外にならず、時間帯の無い結果を返す(coverable は出す)', () => {
    const result = computeReach(base({ bandCount: 0, ref: refOf({ [P]: 100 }, [T], [C]) }))
    expect(result.reachable).toEqual([])
    expect(result.cells).toContain(T)
    expect(result.coverable[result.cells.indexOf(T)]).toBe(true)
  })

  it('bandCount が 0 でも、駅の無いセルの coverable は、区分のバス停の距離以内の起点で決まる', () => {
    // 都市部(T)はバス停 400m。起点は T の中心にあるので coverable。都市部でない隣のセルも郊外の 800m 以内で coverable
    const result = computeReach(base({ bandCount: 0, ref: refOf({ [P]: 100 }, [T]) }))
    expect(result.coverable.every(Boolean)).toBe(true)
    // 起点が 1,000m 先なら、T(都市部 400m)は coverable でない
    const far = pointAt(C, 0, 1000)
    const away = computeReach(base({ bandCount: 0, stops: [{ lat: far.lat, lon: far.lon, bandCounts: [] }], ref: refOf({ [P]: 100 }, [T]) }))
    expect(away.coverable[away.cells.indexOf(T)]).toBe(false)
  })
})
