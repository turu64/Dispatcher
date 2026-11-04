import KDBush from 'kdbush'
import { activeServiceIds } from '../calendar'
import { parseGtfsTime, type DepartureCounts, type TimeBand } from '../departures'
import type { GtfsFeed, GtfsRow } from '../load'
import { NON_NEGATIVE_INTEGER, toStops } from '../parse'
import { distanceM, meshCenter, type LatLon } from '../../reach/mesh'
import type { ReachParams, ReachResult } from '../../reach/reach'
import { createTripBriefer, START_BAND_NO_TIME, startBandOf, type TripBrief } from './diff'
import { formatMinutes, type FacilityHintKind, type FacilityTiming, type FacilityWindow, type FacilityWindows, type LongBreak } from './facilityHours'
import { pairsOf, weekdayServicesOf, type Form2Plan } from './ops'
import { compareStrings, sortByStopSequence, stopTimesByTrip } from './signature'

/**
 * 足し戻しの手がかり(docs/interfaces-1104.md §8、docs/interfaces-1105.md §7)。コードが出し、画面の並べ替え・絞り込みと、
 * Claude の提案の材料にする。
 * 基準と編集後の便の表だけで決まる手がかり(weekdayOnlyRoute〜evening)は、いつでも出す。
 * 到達圏を使う onlyServiceAtStop・restoresLostCells は、到達圏の前後の比較(ctx。store/restoreHintContext.ts の
 * buildRestoreHintContext で作る)を渡したときだけ出す。ctx を渡さなければ 11/4 と同じ結果になる。
 * 学校・病院の手がかり nearFacility(docs/tasks-1103.md の T19)は、ctx に前提情報の施設(ctx.facilities)があるときだけ出す。
 * 時間帯の窓は施設ごと(HintFacility.windows。調べた受付時間・始業・終業から facilityHours.ts が決め、読めなければ既定。T27)。
 * 時間帯はすべて開始を含み終わりを含まない。
 * 時間帯の区切りは到達圏の3時間ごとにそろえる(docs/tasks-1105.md の U05、指摘17)。onlyTripInBand は始発の時間帯
 * (diff.ts の START_BANDS。3時間ごと)、evening は 15〜21時(3時間の帯2つ)、到達圏を使う2つは地図の時間帯の幅
 * (ctx.bands。3時間ごとか1時間ごと)で数える。公示第47号の区分は使わない(届出の目安の表だけが使う)。
 */

export type RestoreHint =
  /** その系統に、基準の写す元の service の便が1本も無い(平日だけの系統) */
  | 'weekdayOnlyRoute'
  /** その系統が編集後に全曜日で便がなくなる(§6 の vanishes)。足し戻せば系統が残る */
  | 'routeWouldVanish'
  /** 基準の平日で、その系統の始発の便 */
  | 'firstTripOfRoute'
  /** 基準の平日で、その系統の終発の便(足し戻さないと終発が早まる) */
  | 'lastTripOfRoute'
  /**
   * その系統のその始発の時間帯(3時間ごと。diff.ts の START_BANDS)で、この便を足し戻さないと編集後の平日の便が 0。
   * 同じ時間帯のなくなる便が複数あれば、どれにも付く(「唯一の便」ではない。指摘15.3。前後の便数は RestoreHintDetail.band)。
   * 方向は分けない
   */
  | 'onlyTripInBand'
  /** 始発が [6:00, 9:00)(通勤・通学。3時間の帯1つ) */
  | 'morning'
  /** 始発が [15:00, 21:00)(帰宅。3時間の帯2つ。U05 で 19時から 21時に広げた) */
  | 'evening'
  /**
   * その便の乗れる停留所のどれかで、比較の日付・その時間帯(地図の時間帯の幅)に、編集後の出発が 0 になる(11/5)。
   * 同じ停留所・時間帯のなくなる便が複数あれば、どれにも付く
   */
  | 'onlyServiceAtStop'
  /** その便の乗れる停留所が、その時間帯(地図の時間帯の幅)に「減便で外れた」セルを、区分のバス停の距離の中に含む(11/5) */
  | 'restoresLostCells'
  /**
   * 便の停留所の徒歩圏に学校・病院があり、施設ごとの時間帯の窓(学校は始業前・下校、病院は通院の行き・帰り)に
   * その停留所に着く・出る(T19)。窓は調べた受付時間・始業・終業から決め、読めなければ既定(FACILITY_WINDOWS。
   * 学校は 7〜9時着・14〜18時発、病院は 8〜11時着・11〜16時発)(T27)
   */
  | 'nearFacility'

export interface RestoreHintDetail {
  hints: RestoreHint[]
  /**
   * restoresLostCells のとき、この便だけを足し戻したときに戻るセルの数と、その推計人口の合計(11/5)。ほかは null。
   * 同じセルは、2つの時間帯で戻っても1つと数える。ほかの便の足し戻しとの重なりは考えない
   */
  lostCells: { cells: number; population: number } | null
  /**
   * 便の停留所の徒歩圏にある学校・病院(T19)。時間帯の窓に当たる施設を先に、次に重要拠点の優先順位、施設までの距離の順。
   * ctx に施設が無いときと、徒歩圏に施設が1つも無いときは入れない(項目ごと無い)
   */
  facilities?: NearFacility[]
  /**
   * onlyTripInBand のとき、その系統のその始発の時間帯(3時間ごと。START_BANDS の名前。例「6〜9時」)と、その系統・時間帯の
   * 減便前・減便後の平日の便数(after は 0)。ほかは null(A03。指摘15.3)
   */
  band: { label: string; before: number; after: number } | null
  /** その系統の減便前・減便後の平日の便数(方向は分けない。A03) */
  routeTrips: { before: number; after: number }
}

// ---- 学校・病院の手がかり(T19)----

// 施設の種類・窓の型と既定の窓は facilityHours.ts に置く(調べた事実から窓を決める関数と同じ場所)。ここからも使えるようにする
export { FACILITY_WINDOWS } from './facilityHours'
export type { FacilityHintKind, FacilityTiming, FacilityWindow, FacilityWindows, LongBreak } from './facilityHours'

/** 既定の窓のときの、時間帯の窓の名前(理由の文に入れる。FACILITY_WINDOWS と同じ時刻) */
export const FACILITY_WINDOW_LABELS: Record<FacilityHintKind, Record<FacilityTiming, string>> = {
  school: { arrive: '始業前(7〜9時着)', depart: '下校(14〜18時発)' },
  hospital: { arrive: '通院の行き(8〜11時着)', depart: '通院の帰り(11〜16時発)' },
}

/** 時間帯の窓の短い名前(調べた結果の窓の理由の文に入れる) */
export const FACILITY_WINDOW_NAMES: Record<FacilityHintKind, Record<FacilityTiming, string>> = {
  school: { arrive: '始業前', depart: '下校' },
  hospital: { arrive: '通院の行き', depart: '通院の帰り' },
}

/**
 * 理由の文に入れる窓の名前。既定の窓は FACILITY_WINDOW_LABELS(「始業前(7〜9時着)」)、調べた結果の窓は時刻と出どころ
 * (「通院の行き(7:30〜11:30着。調べた外来の受付 8:00〜11:30・13:00〜15:15 に合わせた窓)」)
 */
export function facilityWindowLabel(kind: FacilityHintKind, timing: FacilityTiming, w: FacilityWindow): string {
  if (w.source === 'default') return FACILITY_WINDOW_LABELS[kind][timing]
  const mark = timing === 'arrive' ? '着' : '発'
  return `${FACILITY_WINDOW_NAMES[kind][timing]}(${formatMinutes(w.from)}〜${formatMinutes(w.to)}${mark}。調べた${w.basis ?? '結果'} に合わせた窓)`
}

/** 前提情報の調査の結果の要点(調べた施設だけ) */
export interface FacilityResearchNote {
  status: 'found' | 'partial' | 'not_found'
  /** 確認日時(日本時間の ISO 8601) */
  checkedAt: string
  origin: 'web' | 'demo'
  /** 事実(ラベル・値・出典の URL。出典が読めなければ null) */
  facts: { label: string; value: string; url: string | null }[]
}

/** 手がかりに使う施設(store/restoreHintContext.ts が、前提情報の施設の参照データと到達圏の条件から作る) */
export interface HintFacility {
  targetId: string
  name: string
  kind: FacilityHintKind
  /** 重要拠点の種類の名前(「高校・特別支援学校」など) */
  categoryLabel: string
  /** 重要拠点の優先順位(1 が最も高い) */
  rank: number
  lat: number
  lon: number
  /** 徒歩圏の半径(m)。施設のあるセルの区分のバス停の分数 × 分速(到達圏の計算と同じ距離) */
  radiusM: number
  /** 前提情報の調査の結果(あれば) */
  research?: FacilityResearchNote
  /**
   * 時間帯の窓(施設ごと。T27)。調べた受付時間・始業・終業を読めた窓は source が research で、読めなければ既定
   * (FACILITY_WINDOWS。defaultFacilityWindows)
   */
  windows: FacilityWindows
  /**
   * 調べた結果から読んだ長期休業(学校だけ。年は持たない。T27)。減便の期間と重なるかは facilityHours.ts の overlapLongBreaks で
   * 出す。休校日運休(学)の印は自動で付けない。読めなければ空
   */
  longBreaks: readonly LongBreak[]
}

/** 便が施設の時間帯の窓に当たった停留所と時刻 */
export interface FacilityMatch {
  timing: FacilityTiming
  stopId: string
  stopName: string
  /** 着く(arrive)・出る(depart)時刻 'HH:MM' */
  time: string
  /** 停留所から施設までの直線距離(m、整数に丸める) */
  distanceM: number
}

/** 便の停留所の徒歩圏にある施設 */
export interface NearFacility {
  facility: HintFacility
  /** 便の停留所のうち、施設に最も近いもの(乗るか降りるかできる停留所だけ。通過する停留所は除く) */
  stopId: string
  stopName: string
  /** その停留所から施設までの直線距離(m、整数に丸める) */
  distanceM: number
  /** 時間帯の窓に当たった停留所と時刻(arrive・depart の順に最大1つずつ)。空なら徒歩圏にあるだけ */
  matches: FacilityMatch[]
}

/**
 * 施設の手がかりの理由の文(施設名・種類・窓・停留所・時刻・距離)。窓に当たらなければ徒歩圏にあることだけを書く。
 * 窓は、調べた結果から決めたものなら時刻と出どころ(「調べた外来の受付 8:00〜11:30 に合わせた窓」)を入れる(数はコードが出す)
 */
export function nearFacilityText(n: NearFacility): string {
  const f = n.facility
  const head = `${f.name}(${f.categoryLabel})`
  if (n.matches.length === 0) return `${head}:${n.stopName}から約 ${n.distanceM}m`
  const parts = n.matches.map(
    (m) =>
      `${facilityWindowLabel(f.kind, m.timing, f.windows[m.timing])}に${m.stopName} ${m.time}${m.timing === 'arrive' ? '着' : '発'}(施設まで約 ${m.distanceM}m)`,
  )
  return `${head}の${parts.join('、')}`
}

/** 窓に当たった施設のうち、最も高い優先順位(無ければ Infinity) */
export function bestFacilityRank(detail: RestoreHintDetail): number {
  let best = Infinity
  for (const n of detail.facilities ?? []) if (n.matches.length > 0 && n.facility.rank < best) best = n.facility.rank
  return best
}

/**
 * 到達圏を使う手がかり(11/5)のときだけ渡す。到達圏の store の、同じ日付・同じ条件の基準と編集後の結果
 * (docs/interfaces-1104.md §7 の比較。同じ起点・同じセル・同じ時間帯)から作る(store/restoreHintContext.ts)
 */
export interface RestoreHintContext {
  /** 基準の時間帯ごとの出発の数(departureCountsByBand) */
  before: DepartureCounts
  /** 編集後の時間帯ごとの出発の数 */
  after: DepartureCounts
  /**
   * 比較の時間帯(結果の reachable と同じ並び)。地図の時間帯の幅(3時間ごとか1時間ごと)に従い、到達圏を使う2つの
   * 手がかりはこの区切りで数える(U05 の D6)
   */
  bands: TimeBand[]
  /** 基準の到達圏。セル・区分・推計人口・coverable は、これを使う(編集後と等しい) */
  beforeResult: ReachResult
  afterResult: ReachResult
  /** 比較の日付('YYYYMMDD')。この日に基準で走る平日の便にだけ、2つの手がかりを出す */
  date: string
  /** 到達圏の計算に使った条件。区分ごとのバス停の距離は walkMinutes[区分].bus × speedMPerMin */
  params: ReachParams
  /** 到達圏の起点の停留所(store の origins.stops)。停留所の位置はここから取る */
  stops: readonly { id: string; lat: number; lon: number }[]
  /**
   * 学校・病院の手がかり(nearFacility)に使う施設(T19)。前提情報の施設の参照データを読めていなければ undefined で、
   * nearFacility を出さない。読めていて対象の施設が無ければ空の配列
   */
  facilities?: readonly HintFacility[]
}

/** 画面に出す手がかりの名前(並びは RestoreHint の順) */
export const RESTORE_HINT_LABELS: Record<RestoreHint, string> = {
  weekdayOnlyRoute: '平日だけの系統',
  routeWouldVanish: '全曜日で便がなくなる系統',
  firstTripOfRoute: '系統の始発',
  lastTripOfRoute: '系統の終発',
  onlyTripInBand: '時間帯の便がなくなる',
  morning: '朝(6〜9時)',
  evening: '夕方・夜(15〜21時)',
  onlyServiceAtStop: '停留所の発車がなくなる',
  restoresLostCells: '到達圏が戻る',
  nearFacility: '学校・病院の近く',
}

/** morning・evening の始発の時刻の範囲(時。開始を含み終わりを含まない)。どちらも3時間ごとの時間帯の区切りに合わせる(U05) */
export const MORNING = { from: 6, to: 9 } as const
export const EVENING = { from: 15, to: 21 } as const

/** 数を桁区切りにする(理由の文に入れる) */
function count(n: number): string {
  return n.toLocaleString('ja-JP')
}

/**
 * 判断材料を説明する1文(画面と AI に出す。A03、指摘15.3)。時間帯・停留所・系統の全体のどれについての判断材料かを書き、
 * 「唯一の便」とは書かない。数はすべて detail から入れる(コードが出した数)。系統の便数は方向を分けない。
 * 例:「6〜9時に、この系統の便が減便後 0 便になります(減便前 3 便)」「系統の平日の始発です(系統の平日 11 便。方向は分けていません)」
 */
export function hintSentence(hint: RestoreHint, detail: RestoreHintDetail): string {
  const route = detail.routeTrips
  switch (hint) {
    case 'weekdayOnlyRoute':
      return `平日だけの系統です(入れ替えに使うダイヤに、この系統の便がありません。系統の平日 ${count(route.before)} 便)`
    case 'routeWouldVanish':
      return `平日に戻さないと、この系統は減便後に全曜日で便がなくなります(系統の平日 ${count(route.before)} 便)`
    case 'firstTripOfRoute':
      return `系統の平日の始発です(系統の平日 ${count(route.before)} 便。方向は分けていません)`
    case 'lastTripOfRoute':
      return `系統の平日の終発です(系統の平日 ${count(route.before)} 便。方向は分けていません)`
    case 'onlyTripInBand': {
      const band = detail.band
      if (!band) return '始発の時間帯(3時間ごと)に、この系統の減便後の平日の便がなくなります'
      return `${band.label}に、この系統の便が減便後 ${count(band.after)} 便になります(減便前 ${count(band.before)} 便)`
    }
    case 'morning':
      return `始発が${RESTORE_HINT_LABELS.morning}の便です`
    case 'evening':
      return `始発が${RESTORE_HINT_LABELS.evening}の便です`
    case 'onlyServiceAtStop':
      return '平日に戻さないと、この便が発車する停留所のどれかで、比較する日付のその時間帯の発車が減便後 0 便になります'
    case 'restoresLostCells': {
      const lost = detail.lostCells
      if (!lost) return '平日に戻すと、到達圏から外れる区画が戻ります'
      return `平日に戻すと、到達圏から外れる区画のうち ${count(lost.cells)} 区画(推計人口 約 ${count(Math.round(lost.population))} 人)が戻ります(この便だけを平日に戻したときの値)`
    }
    case 'nearFacility': {
      const matched = (detail.facilities ?? []).filter((n) => n.matches.length > 0)
      if (matched.length === 0) return '停留所の徒歩圏にある学校・病院の時間帯に当たります'
      const more = matched.length > 1 ? `。ほか ${count(matched.length - 1)} 施設` : ''
      return `停留所の徒歩圏にある学校・病院の時間帯に当たります(${nearFacilityText(matched[0])}${more})`
    }
  }
}

const HINT_ORDER: RestoreHint[] = [
  'weekdayOnlyRoute',
  'routeWouldVanish',
  'firstTripOfRoute',
  'lastTripOfRoute',
  'onlyTripInBand',
  'morning',
  'evening',
  'onlyServiceAtStop',
  'restoresLostCells',
  'nearFacility',
]

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** 系統(route_id)ごとの、ある service の便の始発時刻(秒)の一覧 */
function firstSecondsByRoute(trips: readonly TripBrief[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const t of trips) {
    if (t.firstSeconds === null) continue
    const list = out.get(t.routeId)
    if (list) list.push(t.firstSeconds)
    else out.set(t.routeId, [t.firstSeconds])
  }
  return out
}

/** 系統(route_id)ごとの便数 */
function countByRoute(trips: readonly TripBrief[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of trips) out.set(t.routeId, (out.get(t.routeId) ?? 0) + 1)
  return out
}

/** 系統 × 始発の時間帯(3時間ごと。START_BANDS)ごとの便数。キーは `${route_id}\t${時間帯の名前}`。始発の時刻の無い便は数えない */
function countByRouteBand(trips: readonly TripBrief[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of trips) {
    const band = startBandOf(t.firstSeconds)
    if (band === START_BAND_NO_TIME) continue
    const key = `${t.routeId}\t${band}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

// ---- 到達圏を使う手がかり(11/5)----

/** 便の乗れる行の1つ(停留所と、出発の時刻。出発が空の行は入れない) */
interface BoardingRow {
  stopId: string
  seconds: number
}

/**
 * stop_sequence を、先頭の 0 を除いた10進の文字列にする。0 以上の10進の整数でなければ null
 * (読めない値は最後の停留所の判定に使わない。gtfs/departures.ts と reach/input.ts の boardingStopIds と同じ規則)
 */
function sequenceOf(row: GtfsRow): string | null {
  const s = trimmed(row.stop_sequence)
  if (!NON_NEGATIVE_INTEGER.test(s)) return null
  return s.replace(/^0+(?=\d)/, '')
}

/** sequenceOf の値 a が b より大きいか(桁数が多いほど大きく、同じ桁数なら文字の並びで決まる) */
function isLaterSequence(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b
}

/**
 * 便の乗れる行(docs/interfaces-1104.md §7 の「乗れる行」:pickup_type が '1' でなく、その便の最後の停留所でない行)。
 * 最後の停留所は stop_sequence を数として比べて最大の行(同じ値の行が複数あれば、どれも最後)。
 * 時刻は出発だけ(到達圏の出発の数と同じ。docs/interfaces-1105.md §7)。出発が空・読めない行と、stop_id が空の行は除く
 */
function boardingRowsOf(rows: readonly GtfsRow[]): BoardingRow[] {
  let last: string | null = null
  for (const row of rows) {
    const seq = sequenceOf(row)
    if (seq !== null && (last === null || isLaterSequence(seq, last))) last = seq
  }
  const out: BoardingRow[] = []
  for (const row of rows) {
    if (trimmed(row.pickup_type) === '1') continue
    const seq = sequenceOf(row)
    if (seq !== null && seq === last) continue
    const stopId = trimmed(row.stop_id)
    if (stopId === '') continue
    // 到達圏の出発の数(departures.ts)と同じく、departure_time だけを使う。空の行は数えない(取り決め 1105 §7)
    const seconds = parseGtfsTime(trimmed(row.departure_time))
    if (seconds === null) continue
    out.push({ stopId, seconds })
  }
  return out
}

/** ctx ごとに1回だけ作る索引(停留所ごとの、まわりの「減便で外れた」セル) */
interface LostCellIndex {
  /** [時間帯][セル]。coverable で、基準では到達でき、編集後は外れるセルが 1 */
  lost: Uint8Array[]
  /**
   * 停留所(stop_id)ごとの、どれかの時間帯で外れたセルのうち、停留所からの距離がそのセルの区分のバス停の距離以内のもの
   * (セルの番号の昇順)。距離は到達圏の計算(reach.ts の computeReach)と同じく distanceM(meshCenter(セル), 停留所) で、
   * ちょうどの距離は届くとする
   */
  near: Map<string, number[]>
  bandStarts: number[]
  bandEnds: number[]
}

const lostCellIndexes = new WeakMap<RestoreHintContext, LostCellIndex>()

const RAD = Math.PI / 180
/**
 * 候補の箱の広さ。緯度 1度の長さは 110,574m 以上、経度 1度の長さは 111,319m × cos(緯度) 以上なので、
 * 110,000m で割れば箱は実際の距離より広くなる(取りこぼさない)。箱は候補を絞るだけで、最後は distanceM で判定する
 */
const M_PER_DEG_LOWER = 110_000
const BOX_MARGIN = 1.01

function lostCellIndexOf(ctx: RestoreHintContext): LostCellIndex {
  const cached = lostCellIndexes.get(ctx)
  if (cached) return cached
  const { beforeResult: before, afterResult: after, bands, params } = ctx
  const n = before.cells.length
  if (
    after.cells.length !== n ||
    before.reachable.length !== bands.length ||
    after.reachable.length !== bands.length ||
    before.classes.length !== n ||
    before.coverable.length !== n ||
    before.cellPopulation.length !== n
  ) {
    throw new Error('便を平日に戻す判断材料に渡した到達圏の比較の形が合いません(減便前と減便後の区画、時間帯の数)。')
  }

  // 1. 時間帯ごとの「減便で外れた」セル(compareReach の lostCells と同じ定義)
  const any = new Uint8Array(n)
  const lost = bands.map((_, b) => {
    const was = before.reachable[b]
    const now = after.reachable[b]
    const row = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (before.coverable[i] && was[i] === true && now[i] !== true) {
        row[i] = 1
        any[i] = 1
      }
    }
    return row
  })

  // 2. 外れたセルごとに、区分のバス停の距離以内の起点の停留所を探し、停留所ごとに並べる(computeReach と同じ向き・同じ判定)
  const points: { id: string; lat: number; lon: number }[] = ctx.stops.filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon),
  )
  const near = new Map<string, number[]>()
  if (points.length > 0) {
    const index = new KDBush(points.length)
    for (const p of points) index.add(p.lon, p.lat)
    index.finish()
    for (let i = 0; i < n; i++) {
      if (!any[i]) continue
      const minutes = params.walkMinutes[before.classes[i]]
      if (!minutes) continue
      const radius = minutes.bus * params.speedMPerMin
      const center: LatLon = meshCenter(before.cells[i])
      const dLat = (radius / M_PER_DEG_LOWER) * BOX_MARGIN
      const north = Math.min(Math.abs(center.lat) + dLat, 89)
      const dLon = (radius / (M_PER_DEG_LOWER * Math.cos(north * RAD))) * BOX_MARGIN
      for (const k of index.range(center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat)) {
        const p = points[k]
        if (distanceM(center, p) > radius) continue
        const list = near.get(p.id)
        // 同じ stop_id の点が複数あっても、同じセルは1回だけ入れる(セルは番号の順に見るので、最後と比べればよい)
        if (!list) near.set(p.id, [i])
        else if (list[list.length - 1] !== i) list.push(i)
      }
    }
  }

  const index: LostCellIndex = {
    lost,
    near,
    bandStarts: bands.map((b) => b.startHour * 3600),
    bandEnds: bands.map((b) => b.endHour * 3600),
  }
  lostCellIndexes.set(ctx, index)
  return index
}

/** 秒の時刻が入る時間帯の番号。どれにも入らなければ -1(6〜24時の外など) */
function bandOf(index: LostCellIndex, seconds: number): number {
  for (let b = 0; b < index.bandStarts.length; b++) {
    if (seconds >= index.bandStarts[b] && seconds < index.bandEnds[b]) return b
  }
  return -1
}

// ---- 学校・病院の手がかりの計算(T19)----

/** 便の1行の、施設の窓に使う時刻(秒)。arrive は降りられる行の到着、depart は乗れる行の出発。使えなければ null */
interface FacilityRow {
  stopId: string
  arrive: number | null
  depart: number | null
  /** 降りられるか乗れる行(時刻が空でも)。どちらもできない行(通過など)は、施設の最寄りの停留所にもしない */
  usable: boolean
}

/**
 * 便の行を、施設の窓に使う時刻にする(stop_sequence の順)。
 * - arrive:降りられる行(drop_off_type が '1' でなく、便の最初の停留所でない行)の arrival_time。空なら departure_time
 *   (GTFS では、到着と出発を分けないときは同じ値を入れる)。最後の停留所(終点)も含む(学校前が終点の便があるため)
 * - depart:乗れる行(pickup_type が '1' でなく、便の最後の停留所でない行)の departure_time。空なら arrival_time
 * 最初・最後の停留所は stop_sequence を数として比べて決める(同じ値の行が複数あれば、どれも最初・最後)。
 * stop_sequence の読めない行は、最初・最後のどちらにもしない。stop_id が空の行は除く
 */
function facilityRowsOf(rows: readonly GtfsRow[]): FacilityRow[] {
  let first: string | null = null
  let last: string | null = null
  for (const row of rows) {
    const seq = sequenceOf(row)
    if (seq === null) continue
    if (first === null || isLaterSequence(first, seq)) first = seq
    if (last === null || isLaterSequence(seq, last)) last = seq
  }
  const out: FacilityRow[] = []
  for (const row of sortByStopSequence(rows)) {
    const stopId = trimmed(row.stop_id)
    if (stopId === '') continue
    const seq = sequenceOf(row)
    const arrival = parseGtfsTime(trimmed(row.arrival_time)) ?? parseGtfsTime(trimmed(row.departure_time))
    const departure = parseGtfsTime(trimmed(row.departure_time)) ?? parseGtfsTime(trimmed(row.arrival_time))
    const canAlight = trimmed(row.drop_off_type) !== '1' && !(seq !== null && seq === first)
    const canBoard = trimmed(row.pickup_type) !== '1' && !(seq !== null && seq === last)
    out.push({ stopId, arrive: canAlight ? arrival : null, depart: canBoard ? departure : null, usable: canAlight || canBoard })
  }
  return out
}

/** 秒を 'HH:MM' にする */
function clockOf(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 秒の時刻が施設の窓(分。開始を含み終わりを含まない)に入るか */
function inWindow(seconds: number, w: FacilityWindow): boolean {
  return seconds >= w.from * 60 && seconds < w.to * 60
}

const TIMINGS: readonly FacilityTiming[] = ['arrive', 'depart']

/** 施設の索引(施設の並びごとに1回だけ作る)。停留所ごとの徒歩圏の施設は、使った停留所の分だけ覚えておく */
interface FacilityIndex {
  index: KDBush | null
  points: readonly HintFacility[]
  maxRadius: number
  byStop: Map<string, { facility: HintFacility; distance: number }[]>
}

/** 施設の並びの、手がかりの並び:窓に当たる施設を先に、次に優先順位、施設までの距離、target_id の順 */
function compareNear(a: NearFacility & { raw: number }, b: NearFacility & { raw: number }): number {
  const ma = a.matches.length > 0 ? 0 : 1
  const mb = b.matches.length > 0 ? 0 : 1
  if (ma !== mb) return ma - mb
  if (a.facility.rank !== b.facility.rank) return a.facility.rank - b.facility.rank
  if (a.raw !== b.raw) return a.raw - b.raw
  return compareStrings(a.facility.targetId, b.facility.targetId)
}

/**
 * 手がかりを判定する関数を作る。基準と編集後の索引は1回だけ作り、候補の便ごとに使い回す。
 * baseWeekday は基準の平日便、editedWeekday は編集後の平日便。手がかりに使うのは系統と始発の時刻だけなので、
 * diffWeekdayTrips の結果から作れる(基準の平日 = removed + same、編集後の平日 = same + added。same は署名が同じなので
 * 系統と時刻は基準の便と等しい)。
 *
 * ctx を渡すと、到達圏を使う2つ(onlyServiceAtStop・restoresLostCells)も判定する(docs/interfaces-1105.md §7)。
 * - 対象は、feed が base で、ctx.date に基準で走る平日(weekdayServicesOf(plan) のどれか)の便だけ。ほかの便には2つを出さない
 * - weekdayOnlyRoute は、すべての組の入れ替えに使う service の便の系統の和集合で見る
 * - 乗れる行(pickup_type が 1 でなく、最後の行でない)の出発の時刻が入る時間帯(ctx.bands。地図の時間帯の幅の3時間ごとか
 *   1時間ごと)で数える(出発が空の行は数えない)。6〜24時の外は数えない
 * - 停留所ごとのまわりの外れたセルは ctx ごとに1回だけ探して覚えておくので、候補の一覧をまとめて調べても速い
 * - ctx は、edited から作った到達圏の比較を渡す(別の版の比較を渡すと、出発の数が合わない)
 *
 * ctx に施設(ctx.facilities)があれば、学校・病院の手がかり nearFacility も判定する(T19)。
 * - 対象は feed が base の便(停留所と時刻は基準の stop_times から取る)。比較の日付に走るかは問わない
 * - 便の乗るか降りるかできる停留所から施設ごとの徒歩圏(radiusM)の中にある施設を detail.facilities に入れ、そのうち施設ごとの
 *   時間帯の窓(facility.windows。調べた結果から読めなければ既定の FACILITY_WINDOWS)に当たる施設があれば nearFacility を付ける
 * - 停留所の徒歩圏の施設は、施設の並びごとに停留所ごとに1回だけ探して覚えておく
 */
export function createRestoreHinter(
  base: GtfsFeed,
  edited: GtfsFeed,
  plan: Form2Plan,
  baseWeekday: readonly TripBrief[],
  editedWeekday: readonly TripBrief[],
): (trip: TripBrief, ctx?: RestoreHintContext) => RestoreHintDetail {
  const replacements = new Set(pairsOf(plan).flatMap((p) => p.replacements))
  const weekdays = weekdayServicesOf(plan)
  const replacementRoutes = new Set<string>()
  // 基準の便の service_id(到達圏を使う手がかりで、比較の日付に走るかを調べる)
  const serviceOfTrip = new Map<string, string>()
  for (const t of base.tables.get('trips')?.rows ?? []) {
    if (replacements.has(trimmed(t.service_id))) replacementRoutes.add(trimmed(t.route_id))
    const id = trimmed(t.trip_id)
    if (!serviceOfTrip.has(id)) serviceOfTrip.set(id, trimmed(t.service_id))
  }
  const editedRoutes = new Set<string>()
  for (const t of edited.tables.get('trips')?.rows ?? []) editedRoutes.add(trimmed(t.route_id))

  const baseTimes = firstSecondsByRoute(baseWeekday)
  // 基準・編集後の平日便の、系統 × 始発の時間帯(3時間ごと。START_BANDS)の便数と、系統ごとの便数(A03)
  const baseBands = countByRouteBand(baseWeekday)
  const editedBands = countByRouteBand(editedWeekday)
  const baseRouteTrips = countByRoute(baseWeekday)
  const editedRouteTrips = countByRoute(editedWeekday)

  // 到達圏を使う手がかりの索引(ctx を渡されたときだけ作る)
  let groups: Map<string, GtfsRow[]> | null = null
  const boardingRows = new Map<string, BoardingRow[]>()
  const activeOn = new Map<string, Set<string>>()

  function boardingRowsOfTrip(tripId: string): BoardingRow[] {
    let rows = boardingRows.get(tripId)
    if (!rows) {
      groups ??= stopTimesByTrip(base.tables.get('stop_times')?.rows ?? [])
      rows = boardingRowsOf(groups.get(tripId) ?? [])
      boardingRows.set(tripId, rows)
    }
    return rows
  }

  function runsOn(tripId: string, date: string): boolean {
    const service = serviceOfTrip.get(tripId)
    if (service === undefined || !weekdays.has(service)) return false
    let active = activeOn.get(date)
    if (!active) {
      active = activeServiceIds(base, date)
      activeOn.set(date, active)
    }
    return active.has(service)
  }

  function reachHints(trip: TripBrief, ctx: RestoreHintContext): { onlyServiceAtStop: boolean; lostCells: RestoreHintDetail['lostCells'] } {
    const none = { onlyServiceAtStop: false, lostCells: null }
    if (trip.feed !== 'base' || !runsOn(trip.tripId, ctx.date)) return none
    const index = lostCellIndexOf(ctx)
    let onlyServiceAtStop = false
    const cells = new Set<number>()
    for (const row of boardingRowsOfTrip(trip.tripId)) {
      const b = bandOf(index, row.seconds)
      if (b < 0) continue
      if ((ctx.after.counts.get(row.stopId)?.[b] ?? 0) === 0) onlyServiceAtStop = true
      const lostInBand = index.lost[b]
      for (const i of index.near.get(row.stopId) ?? []) {
        if (lostInBand[i]) cells.add(i)
      }
    }
    if (cells.size === 0) return { onlyServiceAtStop, lostCells: null }
    let population = 0
    // 足す順を決めておく(推計人口は 0.25 人の倍数なので順によらないが、念のため)
    for (const i of [...cells].sort((a, b) => a - b)) population += ctx.beforeResult.cellPopulation[i] ?? 0
    return { onlyServiceAtStop, lostCells: { cells: cells.size, population } }
  }

  // 学校・病院の手がかり(T19)。停留所の位置と名前は基準の stops.txt から取る(終点だけの停留所は到達圏の起点に入らないため)
  let stopPlaces: Map<string, { name: string; lat: number; lon: number }> | null = null
  const facilityRows = new Map<string, FacilityRow[]>()
  const facilityIndexes = new WeakMap<readonly HintFacility[], FacilityIndex>()

  function stopPlaceOf(stopId: string): { name: string; lat: number; lon: number } | undefined {
    if (!stopPlaces) {
      stopPlaces = new Map()
      for (const s of toStops(base).stops) if (!stopPlaces.has(s.id)) stopPlaces.set(s.id, { name: s.name.trim(), lat: s.lat, lon: s.lon })
    }
    return stopPlaces.get(stopId)
  }

  function facilityIndexOf(facilities: readonly HintFacility[]): FacilityIndex {
    let idx = facilityIndexes.get(facilities)
    if (!idx) {
      const points = facilities.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && Number.isFinite(f.radiusM) && f.radiusM >= 0)
      let index: KDBush | null = null
      if (points.length > 0) {
        index = new KDBush(points.length)
        for (const p of points) index.add(p.lon, p.lat)
        index.finish()
      }
      idx = { index, points, maxRadius: Math.max(0, ...points.map((p) => p.radiusM)), byStop: new Map() }
      facilityIndexes.set(facilities, idx)
    }
    return idx
  }

  /** 停留所から、施設ごとの徒歩圏(radiusM)の中にある施設と距離。ちょうどの距離は届くとする */
  function facilitiesNear(idx: FacilityIndex, stopId: string): { facility: HintFacility; distance: number }[] {
    const cached = idx.byStop.get(stopId)
    if (cached) return cached
    const out: { facility: HintFacility; distance: number }[] = []
    const place = stopPlaceOf(stopId)
    if (place && idx.index) {
      const dLat = (idx.maxRadius / M_PER_DEG_LOWER) * BOX_MARGIN
      const north = Math.min(Math.abs(place.lat) + dLat, 89)
      const dLon = (idx.maxRadius / (M_PER_DEG_LOWER * Math.cos(north * RAD))) * BOX_MARGIN
      for (const k of idx.index.range(place.lon - dLon, place.lat - dLat, place.lon + dLon, place.lat + dLat)) {
        const facility = idx.points[k]
        const distance = distanceM(place, facility)
        if (distance <= facility.radiusM) out.push({ facility, distance })
      }
    }
    idx.byStop.set(stopId, out)
    return out
  }

  function nearFacilitiesOf(trip: TripBrief, facilities: readonly HintFacility[]): NearFacility[] {
    if (trip.feed !== 'base' || facilities.length === 0) return []
    let rows = facilityRows.get(trip.tripId)
    if (!rows) {
      groups ??= stopTimesByTrip(base.tables.get('stop_times')?.rows ?? [])
      rows = facilityRowsOf(groups.get(trip.tripId) ?? [])
      facilityRows.set(trip.tripId, rows)
    }
    const idx = facilityIndexOf(facilities)
    const found = new Map<string, NearFacility & { raw: number; rawMatch: Partial<Record<FacilityTiming, number>> }>()
    for (const row of rows) {
      // 乗ることも降りることもできない行(通過など)は、施設の最寄りの停留所にも窓にも使わない(使えない停留所を「最寄り」と書かないため)
      if (!row.usable) continue
      for (const { facility, distance } of facilitiesNear(idx, row.stopId)) {
        const stopName = stopPlaceOf(row.stopId)?.name ?? row.stopId
        let entry = found.get(facility.targetId)
        if (!entry) {
          entry = { facility, stopId: row.stopId, stopName, distanceM: Math.round(distance), raw: distance, matches: [], rawMatch: {} }
          found.set(facility.targetId, entry)
        } else if (distance < entry.raw) {
          Object.assign(entry, { stopId: row.stopId, stopName, distanceM: Math.round(distance), raw: distance })
        }
        for (const timing of TIMINGS) {
          const seconds = row[timing]
          if (seconds === null || !inWindow(seconds, facility.windows[timing])) continue
          // 同じ窓に当たる停留所が複数あれば、施設に最も近い停留所(同じ距離なら便の中で先の停留所)
          const prev = entry.rawMatch[timing]
          if (prev !== undefined && prev <= distance) continue
          entry.rawMatch[timing] = distance
          const match: FacilityMatch = { timing, stopId: row.stopId, stopName, time: clockOf(seconds), distanceM: Math.round(distance) }
          entry.matches = [...entry.matches.filter((m) => m.timing !== timing), match].sort((a, b) => TIMINGS.indexOf(a.timing) - TIMINGS.indexOf(b.timing))
        }
      }
    }
    return [...found.values()].sort(compareNear).map(({ facility, stopId, stopName, distanceM, matches }) => ({ facility, stopId, stopName, distanceM, matches }))
  }

  return (trip, ctx) => {
    const hints = new Set<RestoreHint>()
    if (!replacementRoutes.has(trip.routeId)) hints.add('weekdayOnlyRoute')
    if (!editedRoutes.has(trip.routeId)) hints.add('routeWouldVanish')
    const times = baseTimes.get(trip.routeId)
    if (trip.firstSeconds !== null && times && times.length > 0) {
      if (trip.firstSeconds === Math.min(...times)) hints.add('firstTripOfRoute')
      if (trip.firstSeconds === Math.max(...times)) hints.add('lastTripOfRoute')
    }
    const bandLabel = startBandOf(trip.firstSeconds)
    const bandKey = `${trip.routeId}\t${bandLabel}`
    let band: RestoreHintDetail['band'] = null
    if (bandLabel !== START_BAND_NO_TIME && (editedBands.get(bandKey) ?? 0) === 0) {
      hints.add('onlyTripInBand')
      band = { label: bandLabel, before: baseBands.get(bandKey) ?? 0, after: 0 }
    }
    const routeTrips = { before: baseRouteTrips.get(trip.routeId) ?? 0, after: editedRouteTrips.get(trip.routeId) ?? 0 }
    if (trip.firstSeconds !== null) {
      const h = trip.firstSeconds / 3600
      if (h >= MORNING.from && h < MORNING.to) hints.add('morning')
      if (h >= EVENING.from && h < EVENING.to) hints.add('evening')
    }
    let lostCells: RestoreHintDetail['lostCells'] = null
    if (ctx) {
      const reach = reachHints(trip, ctx)
      if (reach.onlyServiceAtStop) hints.add('onlyServiceAtStop')
      if (reach.lostCells) {
        hints.add('restoresLostCells')
        lostCells = reach.lostCells
      }
    }
    // 学校・病院は比較の日付によらない(便が施設の近くを窓の時刻に通るか)ので、比較の日付に走るかは問わない
    const near = ctx?.facilities ? nearFacilitiesOf(trip, ctx.facilities) : []
    if (near.some((n) => n.matches.length > 0)) hints.add('nearFacility')
    return {
      hints: HINT_ORDER.filter((h) => hints.has(h)),
      lostCells,
      ...(near.length > 0 ? { facilities: near } : {}),
      band,
      routeTrips,
    }
  }
}

/**
 * 1つの便の手がかり。多くの便を調べるときは createRestoreHinter で索引を1回だけ作る
 * (画面は diffWeekdayTrips の結果から、基準の平日 = removed + same、編集後の平日 = same + added を渡す)。
 * ctx の外れたセルの索引は ctx ごとに覚えておくが、便の索引は呼ぶたびに作り直す。
 */
export function restoreHints(
  base: GtfsFeed,
  edited: GtfsFeed,
  plan: Form2Plan,
  trip: TripBrief,
  ctx?: RestoreHintContext,
): RestoreHintDetail {
  const weekdays = weekdayServicesOf(plan)
  const weekdayOf = (feed: GtfsFeed, side: 'base' | 'edited') => {
    const brief = createTripBriefer(feed, side)
    return (feed.tables.get('trips')?.rows ?? []).filter((t) => weekdays.has(trimmed(t.service_id))).map(brief)
  }
  return createRestoreHinter(base, edited, plan, weekdayOf(base, 'base'), weekdayOf(edited, 'edited'))(trip, ctx)
}

/**
 * 候補の並びの既定:手がかりの多い順、同じなら窓に当たる学校・病院の重要拠点の優先順位の高い順(当たらない便は後ろ)、
 * 同じなら始発時刻の順(時刻の無い便は後ろ)、同じなら trip_id の順
 */
export function compareByHints(
  a: { trip: TripBrief; detail: RestoreHintDetail },
  b: { trip: TripBrief; detail: RestoreHintDetail },
): number {
  if (a.detail.hints.length !== b.detail.hints.length) return b.detail.hints.length - a.detail.hints.length
  const ra = bestFacilityRank(a.detail)
  const rb = bestFacilityRank(b.detail)
  if (ra !== rb) return ra < rb ? -1 : 1
  const ta = a.trip.firstSeconds
  const tb = b.trip.firstSeconds
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  }
  return a.trip.tripId < b.trip.tripId ? -1 : a.trip.tripId > b.trip.tripId ? 1 : 0
}
