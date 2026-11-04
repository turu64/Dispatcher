// 足し戻しの手がかりの、到達圏を使う2つ(onlyServiceAtStop・restoresLostCells。docs/interfaces-1105.md §7)の実データでの確かめ。
// 道北バスの 9/17 版(data/raw/gtfs/dohoku_bus_減便前.zip)と参照データ(data/out/ref/)、形2の方針(data/tools/policies/main.json)が
// あるときだけ走る(どれもコミットしない。方針はリポジトリにある)。
// 画面と同じ流れ(到達圏の store の setSource → setEdited → buildRestoreHintContext)で ctx を作り、main の場面の候補
// (基準の平日便のうち、編集後に同じ署名の便が無いもの)すべての手がかりを出して、計算の時間を出力する。
// 入力の指紋が変わっていれば、Python の値との照合だけを飛ばす(it.skipIf。飛ばしたことはテストの結果に skipped として出る)。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { computeReach } from '../../reach/reach'
import { fetchRefData } from '../../reach/refData'
import { createReachStore } from '../../store/reach'
import { buildRestoreHintContext } from '../../store/restoreHintContext'
import { feedServicePeriod } from '../calendar'
import { loadGtfsZip, type GtfsFeed } from '../load'
import { toStops } from '../parse'
import { diffWeekdayTrips, notice47BandOf, type TripBrief } from './diff'
import { applyForm2 } from './form2'
import type { Form2Plan } from './ops'
import { createRestoreHinter, type RestoreHintContext, type RestoreHintDetail } from './restore'

const ZIP = fileURLToPath(new URL('../../../../data/raw/gtfs/dohoku_bus_減便前.zip', import.meta.url))
const REF_DIR = fileURLToPath(new URL('../../../../data/out/ref/', import.meta.url))
const POLICY = fileURLToPath(new URL('../../../../data/tools/policies/main.json', import.meta.url))
const MESHES = ['6541', '6542', '6543', '6641', '6642', '6643']
const ready = existsSync(ZIP) && existsSync(POLICY) && MESHES.every((m) => existsSync(`${REF_DIR}${m}.json`))

/**
 * 検証担当が Python(python3 -I、標準ライブラリだけ)で別に計算した値。web のコードは見ずに、取り決め
 * (1105 §7、1104 §7・§8、1103 の追記2・追記3、CLAUDE.md の到達圏の計算条件)と JIS X 0410 の定義から書いた
 * (data/tools/restore_hints_check.py。動かし方は data/tools/README.md の「足し戻しの手がかりの照合」)。
 *
 * 入力:9/17 版の ZIP、参照データの 6 ファイル(pop250・did125・stations)、編集後は参照実装 data/tools/form2_ref.py を
 * policies/main.json と --generated-at 202611041200 で動かした出力(trips・stop_times・calendar・calendar_dates)。
 * 比較の日付は 2026-11-04(水)、3時間ごとの 6 つの時間帯、徒歩の分数・分速・しきい値は既定値。
 *
 * 手順:
 * 1. 起点:location_type が 0 か空で、基準の全便のどれかに乗れる行(pickup_type が '1' でなく、その便の stop_sequence が最大の行でない)
 *    がある停留所(1,450)
 * 2. 出発の数:当日(01)と前日(06)の便の、乗れる行の departure_time(空は数えない。前日の便は 24時間を引く)を時間帯に入れる
 * 3. 調べるセル:起点から 1,200m 以内に中心がある 8分の1地域メッシュのうち、親の 250m セルの人口が 1 以上のもの(18,795)。
 *    セルは緯度 3.75秒・経度 5.625秒の格子の番号で並べ、コードは中心の緯度経度を 1次・2次・3次・分割の順に割って作る
 * 4. 区分:DID の中は都市部、外は親の 250m セルの人口 ÷ 面積(GRS80 の M(φ)N(φ)cosφ を Simpson 法で積分)が 1,000 以上なら郊外、
 *    未満なら中山間・地方。距離は GRS80 のヒュベニの式
 * 5. 到達:区分の駅の距離以内に駅があれば前後ともすべての時間帯で到達(外れない)。無ければ、区分のバス停の距離以内の起点に、
 *    その時間帯の出発があるか。外れたセル = coverable で、基準では到達し、編集後は到達しない(6 つの時間帯で
 *    281・101・233・174・420・4。store/reach.verify.test.ts の lostCells と同じ)
 * 6. 候補:基準の平日(01)の便のうち、編集後の平日の便に同じ署名(route_id と、stop_sequence の順の stop_id・到着・出発)の便が無いもの(273)
 * 7. 便ごとに、乗れる行(1 と同じ定義)の出発の時刻(空なら到着)が入る時間帯 b と停留所 s の組を集め、
 *    - onlyServiceAtStop:どれかの組で、編集後の s の b の出発が 0
 *    - restoresLostCells:どれかの組で、b に外れたセルのうち、s からの距離がそのセルの区分のバス停の距離以内のもの。
 *      便全体でセルの重なりを除いて数え(cells)、推計人口(親の 250m セルの人口 ÷ 4)を1回ずつ足す(population)
 * sha は、候補すべての「trip_id:cells:population × 4:onlyServiceAtStop(1 か 0)」を trip_id の順に改行でつないだ SHA-256。
 */
const PYTHON = {
  /** 参照データの 6 ファイル(MESHES の順)と ZIP をつないだ SHA-256(store/reach.verify.test.ts と同じ) */
  fingerprint: 'bb1f7d143d46c697acf434dfc7eb6b9e2aefb9fbf66ec2750e61f7ed76806ada',
  policySha: '83c39e850385b516a81f63b71444c966677ee0c34e0a86e021e96408811536c1',
  candidates: 273,
  lostPerBand: [281, 101, 233, 174, 420, 4],
  sha: '7b127b005ddbf239d7814bd2c90a26a6051c8c0e956fcf98de2c2b8d5f923fdd',
  /** restoresLostCells の便すべて(25 便)の [cells, population] */
  restoresLostCells: {
    '0007_02_01_01_0850': [43, 2303],
    '0023_08_01_01_2020': [26, 1874.25],
    '0031_07_01_01_1825': [2, 23.5],
    '0033_02_01_01_1308': [3, 1.25],
    '0033_03_01_01_1355': [3, 1.25],
    '0033_07_01_01_2044': [4, 167],
    '0041_04_01_01_1840': [26, 1874.25],
    '0103_05_01_01_1930': [375, 556.5],
    '0104_01_01_01_0838': [1, 74.25],
    '0104_04_01_01_1248': [160, 190.5],
    '0104_05_01_01_1340': [190, 207.75],
    '0105_03_01_01_1015': [13, 348.5],
    '0105_04_01_01_1055': [8, 344.25],
    '0111_01_01_01_0721': [1, 2.5],
    '0113_05_01_01_1435': [57, 1114],
    '0116_08_01_01_1623': [143, 265],
    '0901_01_01_01_0715': [181, 8495.5],
    '0901_02_01_01_0827': [144, 8145.25],
    '0902_02_01_01_0830': [95, 3212.25],
    '0908_02_01_01_0900': [88, 5565.5],
    '0909_03_01_01_1000': [88, 5565.5],
    '0911_01_01_01_0655': [1, 2.5],
    '0915_01_01_01_1550': [5, 114.75],
    '0916_02_01_01_1815': [48, 91.5],
    '0951_03_01_01_0941': [4, 307],
  } as Record<string, [number, number]>,
  /** onlyServiceAtStop の便すべて(36 便。restoresLostCells の 25 便を含む) */
  onlyServiceAtStop: [
    '0003_02_01_01_1140',
    '0003_03_01_01_1240',
    '0007_02_01_01_0850',
    '0009_01_01_01_0655',
    '0013_02_01_01_0840',
    '0023_08_01_01_2020',
    '0024_03_01_01_1050',
    '0026_02_01_01_0940',
    '0031_07_01_01_1825',
    '0033_02_01_01_1308',
    '0033_03_01_01_1355',
    '0033_07_01_01_2044',
    '0041_04_01_01_1840',
    '0101_04_01_01_1755',
    '0103_05_01_01_1930',
    '0104_01_01_01_0838',
    '0104_04_01_01_1248',
    '0104_05_01_01_1340',
    '0105_03_01_01_1015',
    '0105_04_01_01_1055',
    '0105_05_01_01_1250',
    '0111_01_01_01_0721',
    '0113_05_01_01_1435',
    '0116_08_01_01_1623',
    '0117_06_01_01_1626',
    '0118_06_01_01_1521',
    '0901_01_01_01_0715',
    '0901_02_01_01_0827',
    '0902_02_01_01_0830',
    '0908_02_01_01_0900',
    '0909_03_01_01_1000',
    '0911_01_01_01_0655',
    '0915_01_01_01_1550',
    '0916_01_01_01_1710',
    '0916_02_01_01_1815',
    '0951_03_01_01_0941',
  ],
}

function fingerprint(): string {
  const hash = createHash('sha256')
  for (const m of MESHES) hash.update(readFileSync(`${REF_DIR}${m}.json`))
  hash.update(readFileSync(ZIP))
  return hash.digest('hex')
}

async function settle(store: ReturnType<typeof createReachStore>) {
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 2000 && store.getState().computing; i++) await new Promise((r) => setTimeout(r, 5))
}

/** 入力(参照データ・ZIP・方針)が、Python で計算したときと同じか。テストを集める時点で決める(it.skipIf に使うため) */
const matches =
  ready && fingerprint() === PYTHON.fingerprint && createHash('sha256').update(readFileSync(POLICY)).digest('hex') === PYTHON.policySha

describe.skipIf(!ready)('足し戻しの手がかり(到達圏を使う2つ)を道北バスの main の場面で出す', () => {
  let base: GtfsFeed
  let edited: GtfsFeed
  let plan: Form2Plan
  let ctx: RestoreHintContext | null = null
  let removed: TripBrief[] = []
  let details = new Map<string, RestoreHintDetail>()

  beforeAll(async () => {
    if (!matches) console.warn('参照データか GTFS か方針が変わったため、Python の値との照合を飛ばします(skipped として出ます)')
    base = await loadGtfsZip(new Uint8Array(readFileSync(ZIP)).buffer)
    const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as Omit<Form2Plan, 'kind'>
    plan = { kind: 'weekdayToSaturday', ...policy }
    const outcome = applyForm2(base, plan, { generatedAt: '202611041200' })
    if (!outcome.ok) throw new Error(outcome.message)
    edited = outcome.result.feed

    // 画面と同じ到達圏の store(計算は Web Worker を使わずに computeReach、参照データは data/out/ref のファイル)
    const store = createReachStore({
      compute: async (input) => computeReach(structuredClone(input)),
      loadRef: (mesh1s) =>
        fetchRefData(
          mesh1s,
          async (url) => {
            const mesh1 = url.replace('/api/ref/', '')
            return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(`${REF_DIR}${mesh1}.json`, 'utf8')) }
          },
          new Map(),
        ),
      today: () => '20261103',
      paramDelayMs: 0,
    })
    store.getState().setSource({ feed: base, stops: toStops(base).stops, period: feedServicePeriod(base) })
    await settle(store)
    store.getState().setEdited({ feed: edited, period: feedServicePeriod(edited), draft: false })
    await settle(store)
    expect(store.getState().error).toBeNull()
    expect(store.getState().snapshot?.date).toBe('20261104')
    ctx = buildRestoreHintContext(store.getState(), edited)

    const diff = diffWeekdayTrips(base, edited, plan.weekdayService, plan.excludedRoutes)
    removed = diff.removed
    // 画面と同じ作り方で、候補すべての手がかりを出す時間を測る(索引を作る時間と、外れたセルの索引を作る時間を含む)
    const t0 = performance.now()
    const hinter = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    details = new Map(removed.map((t) => [t.tripId, hinter(t, ctx ?? undefined)]))
    const cold = performance.now() - t0
    // 2回目(同じ ctx。外れたセルの索引は覚えてある。便の索引は作り直す)
    const t1 = performance.now()
    const again = createRestoreHinter(base, edited, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    for (const t of removed) again(t, ctx ?? undefined)
    const warm = performance.now() - t1
    console.log(
      `足し戻しの手がかり(main、候補 ${removed.length} 便):1回目 ${cold.toFixed(1)}ms、2回目(同じ ctx)${warm.toFixed(1)}ms。` +
        `restoresLostCells ${[...details.values()].filter((d) => d.lostCells).length} 便、` +
        `onlyServiceAtStop ${[...details.values()].filter((d) => d.hints.includes('onlyServiceAtStop')).length} 便`,
    )
  }, 60_000)

  /**
   * 時刻で決まる判断材料を、到達圏と同じ3時間ごとの区切りにそろえた(U05、指摘17)ことで変わった数。
   * - onlyTripInBand:21 → 25 便。公示第47号の区分(6〜9時台・10〜14時台・15〜19時台・20時台〜翌5時台)から3時間ごと
   *   (START_BANDS)にしたため、帯の境目が変わった。
   *   - 付くようになった 8 便:同じ系統の減便後の便が、公示の区分では同じ帯にあったが3時間ごとでは別の帯になる便
   *     (例 0908 の 09:00 は、公示では 6〜9時台に減便後の便があったが、9〜12時には無い。0033 の 13:08・13:55 は
   *     10〜14時台にあった便が 12〜15時には無い)
   *   - 付かなくなった 4 便:公示の区分では帯に減便後の便が無かったが、3時間ごとの帯にはある便(例 0003 の 09:50 は
   *     公示では 6〜9時台(9時台を含む)で 0 だったが、9〜12時には減便後の便がある。0006 の 20:19 は 20時台〜翌5時台で
   *     0 だったが、18〜21時にはある)
   * - evening:71 → 90 便。始発が 15〜19時から 15〜21時に広げたため、19:00〜20:59 に始発がある 19 便が加わった
   * 出力 GTFS は変わらない(判断材料は候補の並びと絞り込みだけに使う。form2.verify.test.ts・write.verify.test.ts)
   */
  it.skipIf(!matches)('時刻で決まる判断材料(onlyTripInBand・evening)を3時間ごとで数える。U05 の前の区切りとの差(U05)', () => {
    const ids = (hint: 'onlyTripInBand' | 'evening') => [...details].filter(([, d]) => d.hints.includes(hint)).map(([id]) => id).sort()
    // U05 の前の定義:onlyTripInBand は公示第47号の区分、evening は始発が 15〜19時
    const diff = diffWeekdayTrips(base, edited, plan.weekdayService, plan.excludedRoutes)
    const editedBands = new Set([...diff.same, ...diff.added].map((t) => `${t.routeId}\t${notice47BandOf(t.firstSeconds)}`))
    const oldOnly = removed
      .filter((t) => t.firstSeconds !== null && !editedBands.has(`${t.routeId}\t${notice47BandOf(t.firstSeconds)}`))
      .map((t) => t.tripId)
      .sort()
    const startsIn = (t: TripBrief, from: number, to: number) => t.firstSeconds !== null && t.firstSeconds >= from * 3600 && t.firstSeconds < to * 3600
    const oldEvening = removed.filter((t) => startsIn(t, 15, 19)).length

    const only = ids('onlyTripInBand')
    expect([oldOnly.length, only.length]).toEqual([21, 25])
    expect(only.filter((id) => !oldOnly.includes(id))).toEqual([
      '0013_02_01_01_0840',
      '0024_03_01_01_1050',
      '0028_01_01_01_0740',
      '0033_02_01_01_1308',
      '0033_03_01_01_1355',
      '0041_04_01_01_1840',
      '0908_02_01_01_0900',
      '0909_03_01_01_1000',
    ])
    expect(oldOnly.filter((id) => !only.includes(id))).toEqual(['0003_01_01_01_0950', '0003_02_01_01_1140', '0006_06_01_01_2019', '0910_02_01_01_0925'])

    expect([oldEvening, ids('evening').length]).toEqual([71, 90])
    expect(removed.filter((t) => startsIn(t, 19, 21))).toHaveLength(19)
  })

  it('到達圏の比較ができていて、ctx がある', () => {
    expect(ctx).not.toBeNull()
    expect(ctx!.bands).toHaveLength(6)
    expect(ctx!.date).toBe('20261104')
  })

  it.skipIf(!matches)('restoresLostCells の値が、Python で独立に計算した値と一致する(25 便すべて)。onlyServiceAtStop の便も一致する', () => {
    expect(removed).toHaveLength(PYTHON.candidates)
    // 時間帯ごとの外れたセル(ctx の前後の結果から数える)
    const lost = ctx!.bands.map(
      (_, b) => ctx!.beforeResult.reachable[b].filter((r, i) => ctx!.beforeResult.coverable[i] && r && !ctx!.afterResult.reachable[b][i]).length,
    )
    expect(lost).toEqual(PYTHON.lostPerBand)

    const got: Record<string, [number, number]> = {}
    for (const [id, d] of details) if (d.lostCells) got[id] = [d.lostCells.cells, d.lostCells.population]
    expect(Object.keys(PYTHON.restoresLostCells).length).toBeGreaterThanOrEqual(10)
    expect(got).toEqual(PYTHON.restoresLostCells)
    for (const [id, d] of details) expect(d.hints.includes('restoresLostCells')).toBe(d.lostCells !== null && id in got)

    const only = [...details].filter(([, d]) => d.hints.includes('onlyServiceAtStop')).map(([id]) => id)
    expect(only.sort()).toEqual(PYTHON.onlyServiceAtStop)

    // 候補すべての値の SHA-256(手がかりの無い便を含む)
    const lines = [...details]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, d]) => `${id}:${d.lostCells?.cells ?? 0}:${(d.lostCells?.population ?? 0) * 4}:${d.hints.includes('onlyServiceAtStop') ? 1 : 0}`)
    expect(createHash('sha256').update(lines.join('\n')).digest('hex')).toBe(PYTHON.sha)
  })
})
