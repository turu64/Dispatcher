// 実データでの確かめ。ファイルが無ければスキップする(data/raw/・data/out/ はコミットしない)。
//
// - 道北バスの GTFS(data/raw/gtfs/dohoku_bus_減便前.zip・dohoku_bus_減便後.zip)
// - 参照データ(data/out/ref/{1次メッシュ}.json。data/ の Python で作ったもの)
//
// 減便前は 2026-11-02(月)、減便後は 2026-11-04(水)の時間帯ごとの出発の数と参照データで到達圏を計算し、
// 調べたセル・到達できる見込みのあるセル(coverable)と、時間帯ごとの外れるセルの数と推計人口、計算時間を出力する。
// 起点は、画面と同じく stop_times に1回以上出てきて、location_type が 0(空を含む)で、乗れる行が1つ以上ある停留所だけ
// (docs/interfaces-1104.md §7。追記2の起点から、降車専用の停留所を除いたもの)。
// 形2で減便を反映した編集後(data/tools/policies の main・replaceOnly)も、9/17 版を基準として、基準の起点と coverable で
// 計算し、前後の比較(compareReach)を照らす(docs/interfaces-1103.md 追記3、1104 §7・§11)。
// 検証担当が Python で独立に計算した結果(PYTHON)とも照らす。入力のファイルが変わっていれば、その照合だけを飛ばす。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { servicesFor } from '../gtfs/calendar'
import { departureCountsByBand, makeBands, type DepartureCounts, type TimeBand } from '../gtfs/departures'
import { applyForm2 } from '../gtfs/edit/form2'
import type { Form2Plan } from '../gtfs/edit/ops'
import { loadGtfsZip, type GtfsFeed } from '../gtfs/load'
import { toStops, type Stop } from '../gtfs/parse'
import { serializeTable } from '../gtfs/write'
import { compareReach, zeroServiceRoutes, zeroServiceStops } from './compare'
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
/** 形2の方針(参照実装 data/tools/form2_ref.py に渡したものと同じ JSON。リポジトリに入っている) */
const POLICY_DIR = fileURLToPath(new URL('../../../data/tools/policies/', import.meta.url))
const EDIT_SCENARIOS = ['main', 'replaceOnly'] as const
const HAS_POLICIES = EDIT_SCENARIOS.every((n) => existsSync(`${POLICY_DIR}${n}.json`))
/** 編集後の作成日時(参照実装の --generated-at と同じ) */
const GENERATED_AT = '202611041200'
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
 * 検証担当が Python(python3 -I、標準ライブラリだけ)で別に計算した値。reach.ts・mesh.ts・compare.ts・store/reach.ts の
 * コードは見ずに、取り決め(1103 の本文・追記・追記2・追記3、1104 §7・§11)と JIS X 0410 の定義から書いた。
 * - 起点(1104 §7):stop_times に1回以上出てくる、location_type が 0 か空の停留所のうち、乗れる行が1つ以上あるもの。
 *   乗れる行は、pickup_type が '1' でなく、その便の最後の停留所(stop_sequence の数値が最大)でない行。基準の GTFS の全便で
 *   判定する(日付・service に関係なく。departure_time は見ない)。駅は起点にしない
 * - 調べるセルは、起点から 3区分のバス停の距離の最大(1,200m)以内で、親の 250m セルの人口が 1 人以上のもの
 * - 地域メッシュのコードは緯度を分・秒の余りで割っていく定義どおりに作り、中心はコードの各桁から足し上げる
 * - 距離は GRS80 のヒュベニの式、250m セルの面積は M(φ)N(φ)cosφ の Simpson 法の数値積分
 * - セル × 起点・駅は総当たりで判定する(緯度の差だけで 1,700m を超える組だけを飛ばす。kdbush は使わない)
 * - 運行日と時間帯ごとの出発も GTFS から数え直した
 * 境目までの最小の差は、調べるセルの 1,200m が 0.48mm(65422434243 と 8052_02、1,200.0005m。親の 250m セルの人口が 0 で
 * 結果に入らない)、区分のバス停の距離が 1.1mm(66423363221 と 6720_01、1,200.0011m)、区分の駅の距離が 6.3cm、
 * 人口密度がしきい値の 0.26%(6642231012)。
 * 文字列の SHA-256 は、11 桁のコードの辞書順に並べた行を改行でつないだもの。
 * 「外れるセル」は coverable のセルのうち、その時間帯に到達できないもの(表の割合の分子)。
 *
 * 11/4 に、§7 の起点の規則で計算し直した(Python は検証担当の作業場所の reach_1104.py で、リポジトリには入れていない。前の起点の規則
 * (追記2)に戻すと、11/3 の値(起点 1,460、調べるセル 18,951、coverable 17,200 など)をすべて再現することも確かめた)。
 * 乗れる行が無いので起点から除いた停留所は 10(noBoardingStops)。これで変わった数:
 * - 調べるセル 18,951 → 18,795(−156。除いた停留所のほかに 1,200m 以内の起点が無いセル)
 * - coverable 17,200 → 17,061(−139)。うち 128 は調べるセルから消え、11 は coverable でないセル(ダイヤと関係なく外れる)になった。
 *   消えた 128 のうち 15 は駅の徒歩圏で、どの時間帯でも到達できていたセル
 * - 外れるセルは、どの時間帯(3時間ごと・1時間ごと)でもちょうど 124 減る(11/3 の値から、除いた停留所しか徒歩圏に無かったセルが抜ける)
 */
const PYTHON = {
  /** 参照データの駅が 78 のときのファイル(2026-11-03 01:29 に書かれたもの)と、9/17 版の ZIP */
  fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
  /** 起点の停留所(1,582 のうち、stop_times に出てこない 122 と、乗れる行の無い 10 を除く) */
  originStops: 1450,
  /** 乗れる行が無いので起点から除いた停留所(stop_id の順。すべての行が便の最後の停留所か pickup_type 1) */
  noBoardingStops: [
    '0010_10', // 旭川駅前
    '0310_03', // 永山14丁目
    '3474_02', // 南高校
    '5395_02', // 大雪湖
    '6891_01', // ４条６番
    '6892_01', // 深川西高校
    '7520_02', // 留萌十字街
    '7990_02', // 沼田観光情報プラザ
    '9000_02', // 旭川空港
    '9464_03', // 運転免許試験場
  ],
  /** 3時間ごとの時間帯の出発の合計 */
  bandTotals: [3105, 3787, 3792, 3488, 2365, 282],
  /** 出発がある停留所の「stop_id:6つの数」(stop_id の順) */
  stopCountsSha: '5b7a822992bbdc38e2b7d28fb6bf8440b2e3d6a9b054843d009a9d1972d3a9b9',
  /** 起点から 1,200m 以内のセル(人口で絞る前) */
  candidateCells: 54662,
  cells: 18795,
  cellsSha: '5ac40f69463622dcc0d861e50447bbdccac2a0c7dbdde4583d524beecfd92a27',
  classCount: { urban: 5620, suburban: 1949, rural: 11226 },
  /** 「コード:区分」 */
  classesSha: '36d52dd329f2142e5c24a34c9a5cd3f7da9996a3e6c0136792604a83b8786c3c',
  /** 「コード:推計人口 × 4(= 親の 250m セルの人口)」 */
  populationSha: '977cca30544839147b41dcd10e73fd1d661b56a77df667803e3f5e56f29349fb',
  populationTimes4: 1606409,
  /** 到達できる見込みのあるセル(coverable) */
  coverable: {
    cells: 17061,
    sha: '2a0730b42990ccd4a7ffce9012373c77b1fbcebca33217ae0b061fca53f4c466',
    pop: 303291.5,
    classCount: { urban: 3992, suburban: 1843, rural: 11226 },
  },
  /** ダイヤと関係なく外れるセル(coverable でないもの) */
  nonCoverable: { cells: 1734, pop: 98310.75 },
  /** 駅の徒歩圏(区分の駅の距離)に入るセル */
  railCells: 6142,
  /** 区分のバス停の距離に起点が無く、駅だけで coverable になったセル */
  railOnlyCoverable: 425,
  /** 3時間ごとの外れるセル(coverable の中)の数・コードの SHA-256・推計人口 */
  outCounts: [2307, 2010, 2271, 1486, 2043, 8238],
  outSha: [
    '2a6136cc1e66afa45c1bb984642cb1292bb5a0d07d52ba70712207303d31ebbb',
    '65d5ac0fb03eb42b29e430eb8ab153bfde203b695a1b76b8c4c23458b8757442',
    '13c6e6107028c139d468a97383223ac659b6562b42638f0a63d1dbfa23373544',
    '98a4befc1ce35dde95d7f8e85af49f33c57e6977208440c047509fa432d3cd3e',
    '84a9246cbeff5822c4317942ad8342a8836e8b290f01ee6d95df656377b4dd1b',
    '7c6a3d8f1c16ff84c8e96f36227caf44176d1e89211222d3b9cb0e665bacccba',
  ],
  outPop: [20446.25, 37031.5, 47108.25, 18106.5, 37221, 108213.75],
  /** 1時間ごと(18 の時間帯)。outShaAll は、時間帯ごとの SHA-256 を改行でつないだものの SHA-256 */
  hourly: {
    bandTotals: [159, 1519, 1427, 1189, 1229, 1369, 1337, 1157, 1298, 1230, 1246, 1012, 1045, 820, 500, 216, 66, 0],
    stopCountsSha: '21af8ca82f8a73b4dddfb20310883bd56df0ae3cb92262f6a2baba7fe1e3ef3e',
    outCounts: [8207, 2750, 3294, 4047, 4543, 3904, 3063, 5085, 4483, 3332, 4207, 4706, 4268, 5499, 7241, 8366, 9782, 10919],
    outShaAll: 'f7d4964684af4ec0c54b2c9c269d385caa0686168a8360cc20701ddfde9da9c2',
    outPop: [
      127779, 26444.5, 47837.5, 55007.75, 58485.5, 58178, 54959.75, 70406.75, 63942.5, 47120, 48037.5, 66420.25, 50091.25,
      69701.25, 95716, 114204.25, 150482, 204139.25,
    ],
  },
  /**
   * 減便後の GTFS(dohoku_bus_減便後.zip、10/29 版)を単独で読んだときの 2026-11-04 の 3時間ごと。
   * 単独で読んだフィードはそれ自身が基準になる(追記3)ので、起点もこの版から選ぶ(stop_times に出てくる停留所が減便前より少ない)。
   * 乗れる行が無いので除いた停留所は 10(9/17 版の 5395_02 大雪湖の代わりに 4510_02 雨紛２号が入る)
   */
  after: {
    fingerprint: '6f2acd1073c9528cb0a50d14f33388df9c24d9422b1c4ba7cdaa0342c0e7e0e0',
    originStops: 1354,
    bandTotals: [2784, 3496, 3390, 3231, 1906, 238],
    stopCountsSha: '28adfaec2efbb9f8299a4fa6e2ec9b978072efb4f337ce94eb6282e3e9b3bb8f',
    cells: 18297,
    cellsSha: 'e763fc1feba9b852f70eb72b20f9a9f56c3c52e1cb2167a54e1af9d6e17946e2',
    classCount: { urban: 5567, suburban: 1948, rural: 10782 },
    classesSha: '5e7c2fad0fdff53d4f8c2d36d763fbb4621aa7b7f6006bde7864cec34c849da8',
    populationSha: 'f2e6e8cbafc689e3de5237206ddc941b4a4937c9670c1fe8d45c947205d860d7',
    populationTimes4: 1595266,
    coverable: {
      cells: 16418,
      sha: '48bdbcc9da4ef77114148fa68327c2766dbaf8af47e901606e66a28306c8b705',
      pop: 292341.75,
      classCount: { urban: 3793, suburban: 1843, rural: 10782 },
    },
    nonCoverable: { cells: 1879, pop: 106474.75 },
    outCounts: [1951, 1597, 1692, 1175, 1949, 7728],
    outShaAll: 'a2755129db2d2c896554efdf6bd44e48b46b1f5e7cb7c0a6517327a53a0a775b',
    outPop: [21779, 32528.5, 37541.25, 8150.5, 29300.5, 97963.75],
  },
  /**
   * 形2の編集後(9/17 版を基準)の 2026-11-04(水)の 3時間ごと(1104 §11)。
   * 編集後の表は、参照実装 data/tools/form2_ref.py を data/tools/policies/{main,replaceOnly}.json と
   * --generated-at 202611041200 で動かした出力(trips・stop_times・calendar・calendar_dates。stops などは基準のまま)。
   * 出発の数だけを編集後の表から数え、起点・調べるセル・区分・coverable は基準(上の値)のものを使う(追記3)。
   * 基準の 2026-11-04 は、2026-11-02 と同じ出発の数・外れるセルになる(どちらも当日 01、前日 06。11/3 は文化の日で
   * calendar_dates が 01 を除き 06 を足す)。編集後も当日 01、前日 06。
   * 比較(1104 §7):coverable のセルのうち、lost は基準で到達・編集後で外れる、gained は基準で外れ・編集後で到達、
   * dayLost は基準でどれかの時間帯に到達し、編集後はどの時間帯にも到達しないセル。lostShaAll は時間帯ごとの lost の
   * コード(辞書順)の SHA-256 を改行でつないだものの SHA-256。
   * zeroStops は「stop_id:基準の 6〜24時の出発の数:scope」を §7 の順('feed' が先、出発の数の降順、stop_id の昇順)に並べた SHA-256。
   * zeroRoutes は「route_id:基準のその日の便数:scope」(route_id の順)
   */
  edited: {
    main: {
      /** 参照実装の出力の SHA-256(applyForm2 の serializeTable がこれと同じなら、Python と同じ表で計算している) */
      files: {
        trips: 'ce5d460a766a8a2d5c1e644b5b91104ee79d7327ad955c5a0d8c23fe4df95369',
        stop_times: 'ef6e0dd2fbded3b981c57793b75b536385681442db320d28d35c321ba627a378',
        calendar: '4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90',
        calendar_dates: '56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0',
      },
      bandTotals: [2768, 3500, 3402, 3233, 1906, 238],
      stopCountsSha: '75b1e6d61d65f7b2675034de07922644ee1235fa546b34013163d5ec738d4320',
      /** 基準の起点のうち、編集後の stop_times に出てこない停留所 */
      originsMissingFromEdited: 90,
      outCounts: [2465, 2111, 2171, 1658, 2463, 8242],
      outShaAll: '524e3cf04c805c59e41f486adf1d27bffd53387d01671ab7dc9574c977fe138e',
      outPop: [32196, 42945.5, 47931.25, 18541.5, 39717.5, 108380.75],
      lostCells: [281, 101, 233, 174, 420, 4],
      lostPopulation: [11893, 5914, 1308.5, 438.75, 2496.5, 167],
      gainedCells: [123, 0, 333, 2, 0, 0],
      gainedPopulation: [143.25, 0, 485.5, 3.75, 0, 0],
      lostShaAll: '4ff871ebc625c030943065293b6988d1676c4bd5d651f9423f0f39318a322a0f',
      dayLostCells: 479,
      dayLostPopulation: 10390,
      dayLostSha: 'b7564244a67752262dc5003968d790a3fdcfb26de330fd0a18fde831655e7151',
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
      files: {
        trips: '8aa9c6c3baafc8436a267c2a26ab9a7a8eeba01955b45e7452c2d79bf2ee3d20',
        stop_times: 'e1a0d696825a4448928a26c5d028a2d291b23f6a8d43cb7550927f1b6065e462',
        calendar: '4e1b57ad128edcd7c78f229ea4f6ea0976b5744632bae534046f898551101f90',
        calendar_dates: '56d5b677d6a98d2575891c82d5de71bcf480123c197b6a7a0335cd78cfe3cfe0',
      },
      bandTotals: [2324, 3500, 3391, 3120, 1867, 235],
      stopCountsSha: '119f70d38553b2e389dfd77e67128fb636e2cd07b0ea122d50ea75e28fb80d5f',
      originsMissingFromEdited: 148,
      outCounts: [3044, 2111, 2262, 1981, 2903, 8423],
      outShaAll: '0a5a254eedecb999920cc5e6acaf900357297b198a019afd1125b88ac4962a29',
      outPop: [61445.75, 42945.5, 53938.75, 43593, 62576, 110278],
      lostCells: [860, 101, 324, 667, 860, 185],
      lostPopulation: [41142.75, 5914, 7316, 27424, 25355, 2064.25],
      gainedCells: [123, 0, 333, 172, 0, 0],
      gainedPopulation: [143.25, 0, 485.5, 1937.5, 0, 0],
      lostShaAll: '400ee5b601dc6b90afec5c48e746044b9f56dd0a5ac1bf7e15329549ebaa6c4f',
      dayLostCells: 983,
      dayLostPopulation: 38102.75,
      dayLostSha: '889648d9316b4dacdf64b5f4e2384c024bcddfc2efaa741fde7cff5caea22e5a',
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

/** stop_times に1回以上出てくる stop_id(前後の空白を取った値) */
function usedStopIds(feed: GtfsFeed): Set<string> {
  const used = new Set<string>()
  for (const row of feed.tables.get('stop_times')?.rows ?? []) {
    const id = row.stop_id?.trim()
    if (id) used.add(id)
  }
  return used
}

/**
 * 乗れる行(1104 §7)が1つ以上ある stop_id。乗れる行は、pickup_type が '1' でなく、その便の最後の停留所
 * (stop_sequence の数値が最大。0 以上の10進の整数だけを読み、読めない行は最後の停留所とみなさない)でない stop_times の行。
 * 全便で判定する(日付・service に関係なく)。この確かめのために取り決めから書いたもので、画面の実装は使わない
 */
function boardingStopIds(feed: GtfsFeed): Set<string> {
  const rows = feed.tables.get('stop_times')?.rows ?? []
  const seqOf = (v: string | undefined) => {
    const t = v?.trim() ?? ''
    return /^\d+$/.test(t) ? Number(t) : null
  }
  const last = new Map<string, number>()
  for (const row of rows) {
    const q = seqOf(row.stop_sequence)
    if (q === null) continue
    const trip = row.trip_id?.trim() ?? ''
    last.set(trip, Math.max(last.get(trip) ?? -1, q))
  }
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.pickup_type?.trim() === '1') continue
    const q = seqOf(row.stop_sequence)
    if (q !== null && q === last.get(row.trip_id?.trim() ?? '')) continue
    const id = row.stop_id?.trim()
    if (id) ids.add(id)
  }
  return ids
}

/**
 * 基準と編集後(同じセル)から直接数えた比較(1104 §7 の定義。compare.ts は使わない)。
 * coverable のセルのうち、lost は基準で到達・編集後で外れる、gained はその逆、dayLost は基準でどれかの時間帯に到達し、
 * 編集後はどの時間帯にも到達しないセル。SHA-256 はコードの辞書順
 */
function lostDigest(before: ReachResult, after: ReachResult) {
  const order = codeOrder(before).filter((i) => before.coverable[i])
  const lost = before.reachable.map((band, b) => order.filter((i) => band[i] && !after.reachable[b][i]))
  const gained = before.reachable.map((band, b) => order.filter((i) => !band[i] && after.reachable[b][i]))
  const dayLost = order.filter((i) => before.reachable.some((band) => band[i]) && !after.reachable.some((band) => band[i]))
  const pop = (list: number[]) => list.reduce((s, i) => s + before.cellPopulation[i], 0)
  const codes = (list: number[]) => list.map((i) => before.cells[i])
  return {
    lostCells: lost.map((u) => u.length),
    lostPopulation: lost.map(pop),
    lostShaAll: sha256(lost.map((u) => sha256(codes(u)))),
    gainedCells: gained.map((u) => u.length),
    gainedPopulation: gained.map(pop),
    dayLostCells: dayLost.length,
    dayLostPopulation: pop(dayLost),
    dayLostSha: sha256(codes(dayLost)),
  }
}

/**
 * 画面と同じ起点(1104 §7):stop_times に1回以上出てきて、location_type が 0(空は 0 とみなす)で、乗れる行が1つ以上ある停留所。
 * 照合するときは、stop_id の前後の空白を取る
 */
function originStops(feed: GtfsFeed): Stop[] {
  const used = usedStopIds(feed)
  const boarding = boardingStopIds(feed)
  return toStops(feed).stops.filter((s) => s.locationType === 0 && used.has(s.id) && boarding.has(s.id))
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
    return inputWith(feed, DATE, bands)
  }

  /**
   * 起点は基準(9/17 版)のまま、出発の数だけを source(基準か編集後)の date から数えた入力(追記3)。
   * 編集後の stop_times に出てこない起点は、すべての時間帯を 0 とする
   */
  function inputWith(source: GtfsFeed, date: string, bands: TimeBand[]): ReachInput {
    const counts = departureCountsByBand(source, servicesFor(source, date), bands)
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

  it('起点は stop_times に出てきて乗れる行のある停留所だけ(道北バスは 1,582 のうち、出てこない 122 と乗れる行の無い 10 を除く 1,450。すべて location_type 0)', () => {
    const { stops } = toStops(feed)
    expect(stops).toHaveLength(1582)
    expect(stops.every((s) => s.locationType === 0)).toBe(true)
    const used = usedStopIds(feed)
    expect(stops.filter((s) => !used.has(s.id))).toHaveLength(122)
    expect(origins).toHaveLength(1450)
    // 乗れる行の無い停留所(すべての行が便の最後の停留所か pickup_type 1。旭川駅前 0010_10・旭川空港 9000_02 など)
    const boarding = boardingStopIds(feed)
    const noBoarding = stops.filter((s) => used.has(s.id) && !boarding.has(s.id)).map((s) => s.id)
    expect(noBoarding.sort()).toEqual(PYTHON.noBoardingStops)
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

  describe.skipIf(FINGERPRINT !== PYTHON.fingerprint || !HAS_POLICIES)(
    '形2の編集後(9/17 版を基準)の 2026-11-04 の3時間ごと:基準の起点と coverable で計算し、Python で独立に計算した値と一致する',
    () => {
      const bands = makeBands(3)
      let baseCounts: DepartureCounts
      let base: ReachResult

      beforeAll(() => {
        baseCounts = departureCountsByBand(feed, servicesFor(feed, DATE_AFTER), bands)
        base = computeReach(inputWith(feed, DATE_AFTER, bands))
      })

      it('基準の 2026-11-04 は、2026-11-02 と同じ出発の数と外れるセルになる(どちらも当日 01、前日 06)', () => {
        const services = servicesFor(feed, DATE_AFTER)
        expect([...services.today]).toEqual(['01'])
        expect([...services.yesterday]).toEqual(['06'])
        const { sha, totals } = departureDigest(baseCounts.counts, bands.length)
        expect(sha).toBe(PYTHON.stopCountsSha)
        expect(totals).toEqual(PYTHON.bandTotals)
        const got = outDigest(base)
        expect(got.counts).toEqual(PYTHON.outCounts)
        expect(got.shas).toEqual(PYTHON.outSha)
        expect(got.pop).toEqual(PYTHON.outPop)
      })

      for (const name of EDIT_SCENARIOS) {
        describe(`方針 ${name}`, () => {
          const p = PYTHON.edited[name]
          let edited: GtfsFeed
          let counts: DepartureCounts
          let after: ReachResult

          beforeAll(() => {
            const policy = JSON.parse(readFileSync(`${POLICY_DIR}${name}.json`, 'utf8')) as Omit<Form2Plan, 'kind'>
            const outcome = applyForm2(feed, { kind: 'weekdayToSaturday', ...policy }, { generatedAt: GENERATED_AT })
            if (!outcome.ok) throw new Error(outcome.message)
            edited = outcome.result.feed
            counts = departureCountsByBand(edited, servicesFor(edited, DATE_AFTER), bands)
            // 起点は基準のもの(編集後のフィードから選び直さない)
            after = computeReach(inputWith(edited, DATE_AFTER, bands))
          })

          it('編集後の4つの表は、Python が計算に使った参照実装 form2_ref.py の出力とバイト単位で同じ', () => {
            for (const [table, hash] of Object.entries(p.files)) {
              const t = edited.tables.get(table)
              if (!t) throw new Error(`編集後に ${table} がありません`)
              expect(createHash('sha256').update(serializeTable(t)).digest('hex'), table).toBe(hash)
            }
          })

          it('編集後の出発の数(停留所ごと)が一致し、編集後の stop_times に出てこない基準の起点は、出発が無い', () => {
            const services = servicesFor(edited, DATE_AFTER)
            expect([...services.today]).toEqual(['01'])
            expect([...services.yesterday]).toEqual(['06'])
            const { sha, totals } = departureDigest(counts.counts, bands.length)
            expect(sha).toBe(p.stopCountsSha)
            expect(totals).toEqual(p.bandTotals)
            const used = usedStopIds(edited)
            const missing = origins.filter((s) => !used.has(s.id))
            expect(missing).toHaveLength(p.originsMissingFromEdited)
            expect(missing.every((s) => !counts.counts.has(s.id))).toBe(true)
          })

          it('調べるセル・区分・推計人口・coverable は基準と同じ(出発の数に関係しない。分母は基準の coverable)', () => {
            expect(after.cells).toEqual(base.cells)
            expect(after.classes).toEqual(base.classes)
            expect(after.cellPopulation).toEqual(base.cellPopulation)
            expect(after.coverable).toEqual(base.coverable)
            expect(coverableDigest(after).coverable).toEqual(PYTHON.coverable)
            expect(coverableDigest(after).nonCoverable).toEqual(PYTHON.nonCoverable)
          })

          it('外れるセル(基準の coverable の中)の集合と推計人口が一致する', () => {
            const got = outDigest(after)
            expect(got.counts).toEqual(p.outCounts)
            expect(got.shaAll).toBe(p.outShaAll)
            expect(got.pop).toEqual(p.outPop)
          })

          it('compareReach の減便で外れた・新たに到達したセルと、一日を通して乗れなくなるセルが一致する', () => {
            // 2つの結果から直接数えた集合(compare.ts を使わない)
            const direct = lostDigest(base, after)
            expect(direct.lostCells).toEqual(p.lostCells)
            expect(direct.lostShaAll).toBe(p.lostShaAll)
            expect(direct.lostPopulation).toEqual(p.lostPopulation)
            expect(direct.gainedCells).toEqual(p.gainedCells)
            expect(direct.gainedPopulation).toEqual(p.gainedPopulation)
            expect(direct.dayLostCells).toBe(p.dayLostCells)
            expect(direct.dayLostSha).toBe(p.dayLostSha)
            expect(direct.dayLostPopulation).toBe(p.dayLostPopulation)
            // compareReach
            const cmp = compareReach(base, after)
            expect(cmp.bands.map((b) => b.lostCells)).toEqual(p.lostCells)
            expect(cmp.bands.map((b) => b.lostPopulation)).toEqual(p.lostPopulation)
            expect(cmp.bands.map((b) => b.gainedCells)).toEqual(p.gainedCells)
            expect(cmp.bands.map((b) => b.gainedPopulation)).toEqual(p.gainedPopulation)
            expect(cmp.dayLostCells).toBe(p.dayLostCells)
            expect(cmp.dayLostPopulation).toBe(p.dayLostPopulation)
          })

          it('運行がゼロになる停留所(「feed」が先、出発の数の降順、stop_id の順)と系統が一致する', () => {
            const stops = zeroServiceStops(origins, baseCounts, counts, edited)
            expect(stops).toHaveLength(p.zeroStops.count)
            expect(stops.filter((z) => z.scope === 'feed')).toHaveLength(p.zeroStops.feed)
            expect(sha256(stops.map((z) => `${z.stopId}:${z.beforeDepartures}:${z.scope}`))).toBe(p.zeroStops.sha)
            const routes = zeroServiceRoutes(feed, edited, DATE_AFTER)
            expect(routes.map((z) => `${z.routeId}:${z.beforeTrips}:${z.scope}`).sort()).toEqual(p.zeroRoutes)
          })
        })
      }
    },
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
