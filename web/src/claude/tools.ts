/**
 * アプリ内の Claude のツールの実行(docs/interfaces-1104.md §10、docs/interfaces-1105.md §3.1・§6.3)。
 *
 * - ツールの名前と項目は server/src/dispatcher_server/claude_tools.json を正とする(tools.contract.test.ts で照らす。
 *   ブラウザのコードからはそのファイルを読み込まない)
 * - カスタムツールには strict が無いので、入力の型・必須の項目・知らない項目・範囲・長さ・件数は、すべてここで確かめる。
 *   外れたら is_error で、何が違うかを日本語で返す
 * - 編集のツール(apply_policy・add_back_trips・undo_edit)は、編集の store の下書きを作るだけ。利用者が画面で承認するまで
 *   GTFS は変わらない。読むだけのツールは、コードが出した数を返す(Claude は数えない)
 * - 結果(user.custom_tool_result の text)は JSON の文字列。失敗は status: "error" と日本語の message で、isError を付ける
 * - 編集の store・到達圏の store・画面の選択は deps で受け取る(テストでは差し替える)
 */
import { addBackRejections, describeRecord } from '@/components/steps/editText'
import { activeServiceIds, isValidGtfsDate } from '@/gtfs/calendar'
import { createTripBriefer, restoreTotals, type TripBrief, type WeekdayDiff } from '@/gtfs/edit/diff'
import { facilityAccess, type FacilityAccessEntry, type FacilityAccessWindow } from '@/gtfs/edit/facilityAccess'
import { formatMinutes, type FacilityWindow } from '@/gtfs/edit/facilityHours'
import type { DutyParams, DutyPlace } from '@/gtfs/edit/duties'
import { activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import {
  checkPolicy,
  keptServicesOf,
  planOf,
  weekdayServicesOf,
  type AddBackItem,
  type EditOp,
  type PolicyKind,
  type PolicyReason,
  type PolicySettings,
} from '@/gtfs/edit/ops'
import {
  choicePairs,
  droppedPairWeekdays,
  groupSettings,
  POLICY_KINDS,
  sentenceServices,
  skippedReplacements,
  splitPairs,
  type GroupedPolicyServices,
} from '@/gtfs/groups/view'
import {
  compareByHints,
  createRestoreHinter,
  RESTORE_HINT_LABELS,
  type HintFacility,
  type NearFacility,
  type RestoreHint,
  type RestoreHintContext,
  type RestoreHintDetail,
} from '@/gtfs/edit/restore'
import { ROUND_TRIP_PROBLEM_LABELS, roundTripCheck, type RoundTripSide, type RoundTripWindow } from '@/gtfs/edit/roundTrip'
import { feedValidity, policyValidity } from '@/gtfs/edit/services'
import type { HolidayList } from '@/gtfs/holidays'
import type { GtfsFeed } from '@/gtfs/load'
import { toStops } from '@/gtfs/parse'
import { timingNotices, validateEdit, type ValidationIssue } from '@/gtfs/validate/edit'
import { formatPercent } from '@/reach/summary'
import { compareDrivers, useDriversStore, type DriverComparison } from '@/store/drivers'
import { blockingIssues, diffOf, draftName, lastVersion, type Draft, type EditState } from '@/store/edit'
import type { ReachSnapshot, StepHours } from '@/store/reach'

// ---- ツールの名前と項目(claude_tools.json と同じ) ----

export const TOOL_NAMES = ['apply_policy', 'add_back_trips', 'undo_edit', 'summarize_impact', 'search_trips', 'run_validation'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** 下書きを作るツール。1回の返答で1つだけ使える */
export const EDIT_TOOLS: ReadonlySet<string> = new Set<ToolName>(['apply_policy', 'add_back_trips', 'undo_edit'])

/** ツールごとの入力の項目(すべて required。claude_tools.json の required と同じ並び)。ほかの項目は受け付けない */
export const TOOL_INPUT_KEYS: Record<ToolName, readonly string[]> = {
  apply_policy: ['kind', 'start_date', 'end_date', 'excluded_route_ids', 'reason_category', 'reason_note'],
  add_back_trips: ['items'],
  undo_edit: [],
  summarize_impact: ['date', 'step_hours'],
  search_trips: ['scope', 'route_ids', 'stop_name', 'depart_from', 'depart_to', 'limit', 'offset', 'hints'],
  run_validation: [],
}

/**
 * 調整役の版 3(offset・hints を知らない)が送らない項目。なければ null として読む(ant apply で版 4 に上げるまでと、
 * 版 3 のまま開いているセッションのため。claude_tools.json では required のまま)
 */
export const LEGACY_OPTIONAL_KEYS: Partial<Record<ToolName, readonly string[]>> = {
  search_trips: ['offset', 'hints'],
}

/** search_trips の hints に使える判断材料の識別子(restore.ts の RestoreHint。claude_tools.json の enum と同じ) */
export const RESTORE_HINT_KINDS = Object.keys(RESTORE_HINT_LABELS) as RestoreHint[]

/** add_back_trips の items の1件の項目 */
export const ADD_BACK_ITEM_KEYS = ['trip_id', 'reason', 'school_days_only'] as const

/** apply_policy の kind(API の名前 → web の名前) */
export const POLICY_KIND_NAMES: Record<string, PolicyKind> = {
  weekday_to_saturday: 'weekdayToSaturday',
  weekday_to_sunday_holiday: 'weekdayToSundayHoliday',
}

/** apply_policy の reason_category(API の名前 → web の名前) */
export const REASON_CATEGORY_NAMES: Record<string, NonNullable<PolicyReason['category']>> = {
  temporary_shortage: 'temporaryShortage',
  chronic_shortage: 'chronicShortage',
  demand_decline: 'demandDecline',
}

export const SEARCH_SCOPES = ['removed', 'added', 'same', 'added_back', 'base_weekday'] as const
type SearchScope = (typeof SEARCH_SCOPES)[number]

export const STEP_HOURS_VALUES: readonly StepHours[] = [1, 3]

/** 入力の上限(docs/interfaces-1105.md §6.3) */
export const INPUT_LIMITS = {
  /** 入力の全体(JSON の UTF-8 のバイト数) */
  totalBytes: 16 * 1024,
  /** reason_note・reason の文字数 */
  reasonChars: 200,
  /** stop_name の文字数 */
  stopNameChars: 100,
  /** route_ids・excluded_route_ids の件数 */
  routeIds: 200,
  /** add_back_trips の items の件数 */
  minItems: 1,
  maxItems: 50,
  /** search_trips の limit */
  minLimit: 1,
  maxLimit: 50,
  /** search_trips の offset */
  maxOffset: 100_000,
} as const

/** ツールの動きとして画面に出す文(docs/interfaces-1105.md §6.4) */
export const TOOL_LABELS: Record<ToolName, string> = {
  apply_policy: '減便の方針の下書きを作っています…',
  add_back_trips: '便を平日に戻す下書きを作っています…',
  undo_edit: '元に戻す下書きを作っています…',
  summarize_impact: '影響を計算しています…',
  search_trips: '便を探しています…',
  run_validation: '検証しています…',
}

/** サーバーが実行するツール(§3.2)の動きとして画面に出す文 */
export const SERVER_TOOL_LABELS: Record<string, string> = {
  get_research_targets: '調査の対象を読んでいます…',
  get_research_results: '調査の結果を読んでいます…',
  save_research: '調査の結果を保存しています…',
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/** ツールの動きの文(知らない名前は「{name} を使っています…」) */
export function toolLabel(name: string): string {
  if (isToolName(name)) return TOOL_LABELS[name]
  return SERVER_TOOL_LABELS[name] ?? `${name} を使っています…`
}

// ---- 依存 ----

/** 方針の手順で画面が推定・選択している service(決まっていないものは null) */
export interface PolicyServices {
  weekday: string | null
  saturday: string | null
  sundayHoliday: string | null
  /**
   * 読み込みの手順のダイヤのグループ分け(docs/design-service-groups.md §5.3)。confirmed(ダイヤ単位で選べる)なら apply_policy は
   * その組の表で減便の方針を作り、weekday などは使わない。unconfirmed(Jev の答えを待っている間)なら weekday などで作り、結果にその旨を書く。
   * 省く(単純な GTFS で1組の形で足りる、まだ計算していない)なら今のまま
   */
  groups?: GroupedPolicyServices
}

/** summarize_impact が読む、到達圏の store の状態(useReachStore.getState() をそのまま渡せる) */
export interface ReachView {
  date: string | null
  stepHours: StepHours
  computing: boolean
  error: string | null
  snapshot: ReachSnapshot | null
  setDate: (date: string) => string | null
  setStepHours: (step: StepHours) => void
}

/** 到達圏の store(useReachStore をそのまま渡せる) */
export interface ReachAccess {
  getState: () => ReachView
  subscribe: (listener: () => void) => () => void
}

export interface ToolDeps {
  /** 編集の store の今の状態(useEditStore.getState) */
  edit: () => EditState
  reach: ReachAccess
  /** 検証に使う祝日一覧(読めていなければ null) */
  holidays: () => HolidayList | null
  /** 日本時間の今日('YYYYMMDD') */
  today: () => string
  /**
   * 方針の手順で画面が推定・選択している service。validity は Claude が指定した期間から作った新しい有効期間
   * (画面の推定を同じ期間で作り直すときに使う。[画面の状態] の行では null)。GTFS がなければ null
   */
  policyServices: (validity: { start: string; end: string } | null) => PolicyServices | null
  /**
   * 到達圏を使う足し戻しの手がかり(onlyServiceAtStop・restoresLostCells)の ctx。editedFeed は search_trips が比べる
   * 編集後のフィード(到達圏の store の編集後と同じでなければ null を返すこと。buildRestoreHintContext がそうする)。
   * 比較ができていなければ null。search_trips は1回の呼び出しで1回だけ呼び、候補の一覧すべてに同じ ctx を使う
   */
  hintContext: (editedFeed: GtfsFeed) => RestoreHintContext | null
  /** summarize_impact が到達圏の計算を待つ上限(ミリ秒)。既定 120000 */
  reachTimeoutMs?: number
  /** search_trips が、到達圏の計算中に終わるのを待つ上限(ミリ秒)。既定 20000。過ぎたら到達圏を使う手がかりを出さずに返す */
  hintWaitMs?: number
  /**
   * 要る運転士の数(目安)の入力(手順「運行の前提」の在籍の運転士の数・仮定・営業所の位置と、手順「減便の方針」の欠員。D06)。
   * summarize_impact の drivers に使う。
   * 省けば要る運転士の数の store(useDriversStore)の今の値を読む
   */
  drivers?: () => DriverSettings
}

/** 要る運転士の数(目安)の推定の入力のうち、利用者が手順「運行の前提」と手順「減便の方針」(欠員)で決めるもの */
export interface DriverSettings {
  params: DutyParams
  places: readonly DutyPlace[]
  /** 欠員(その日に乗務できない運転士の数)。入れていなければ null */
  shortage: number | null
  /** 在籍の運転士の数。入れていなければ null(省けば null) */
  roster?: number | null
  /** 1人あたりの週の出勤日数(省けば既定の 5) */
  workDays?: number
}

export interface ToolOutcome {
  /** user.custom_tool_result の text(JSON の文字列) */
  content: string
  isError: boolean
  /** このツールが作った下書き(画面に「下書き {id} を作りました」と出し、行方を [画面の操作] で伝えるため) */
  draft?: { id: string; kind: 'op' | 'undo' }
}

// ---- 結果の形 ----

/** 1つの結果の上限(UTF-8 のバイト数) */
export const MAX_RESULT_BYTES = 20 * 1024

const DRAFT_NOTE = '利用者の承認待ちです。承認されるまで GTFS は変わりません。'
const NO_BASE = 'GTFS が読み込まれていません。利用者に、手順1「読み込み」で GTFS を読み込むよう伝えてください。'
const NO_SERVICES =
  '手順3「減便の方針」で、入れ替え元のダイヤ(平日)と入れ替えに使うダイヤ(土曜/日祝)の service を選んでください。'
const NO_POLICY = '減便の方針が承認されていないため、使えません。先に apply_policy の下書きを作り、利用者に承認してもらってください。'
const NO_EDIT =
  '減便の方針の下書きも承認済みの減便の方針もないため、比較する減便後の GTFS がありません。先に apply_policy を使ってください。'
const NO_REACH_HINTS = '到達圏の比較がまだないため、到達圏を使う判断材料は出していません。'
// offset 0 の結果だけに入れる項目の説明は、tool の説明(claude_tools.json)に無いことだけを短く書く(1回目の結果に便を多く入れるため)
const HINT_TEXTS_NOTE = '利用者には「唯一の便」とは書かず、hint_texts の言い方を使ってください。系統の便数は route_weekday_trips です。'
const REACH_BUSY_HINTS = '到達圏の計算が終わらなかったため、到達圏を使う判断材料は出していません。しばらくしてから探し直してください。'

const NO_FACILITY_HINTS_WITHOUT_REACH =
  '学校・病院の判断材料(nearFacility・nearby_facilities)も、到達圏の比較ができてから出します(徒歩圏の距離に到達圏の条件を使うため)。'
const NO_FACILITY_DATA =
  '手順5「平日便を戻す」の「判断材料を調べる」で使う学校・病院の参照データを読み込めていないため、学校・病院の判断材料(nearFacility・nearby_facilities)は出していません(該当がないという意味ではありません)。'
const FACILITY_NOTE =
  'nearby_facilities は、便の停留所の徒歩圏にあり施設ごとの時間帯の窓に当たる学校・病院の 1 件です。項目のない便は、窓に当たる施設が徒歩圏にありません。window のない施設は既定の窓です。'
const LOST_CELLS_NOTE = 'lost_cells は、ほかの便を平日に戻したときとの重なりを考えていません。'
const ORDER_NOTE = '到達圏の比較や学校・病院の読み込みが途中で変わると、判断材料と並びが変わります。'
const FEED_NOTE = '加わる便(feed が edited)は、なくなる便(feed が base)と同じ trip_id のことがあります。'
/** offset が 0 より大きいとき、項目の説明の notes の代わりに入れる文 */
const NOTES_ON_FIRST_PAGE = '項目の説明は offset 0 の結果の notes と同じです(省きました)。'

/** search_trips の便ごとに出す施設の数の上限(結果の大きさを抑える) */
const MAX_FACILITIES_PER_TRIP = 1
/** facility_research に入れる施設の数の上限 */
const MAX_RESEARCHED_FACILITIES = 5
/** facility_research の事実の数と、値の長さ(文字)の上限 */
const MAX_FACTS = 3
const MAX_FACT_CHARS = 40
/** search_trips の便ごとの via(通る主な停留所)の数 */
const MAX_VIA_STOPS = 2

/**
 * 施設の窓のうち調べた結果から決めたものがあれば、窓と根拠の短い文(T27)。どちらも既定なら null(既定の窓は tool の説明に書く)。
 * 着く・出る窓が同じ事実から決まっていれば根拠は1回だけ書く(「着 7:30〜11:30・発 11:30〜17:15(調べた外来の受付 8:00〜11:30)」)
 */
function windowSummary(f: HintFacility): string | null {
  const { arrive, depart } = f.windows
  if (arrive.source === 'default' && depart.source === 'default') return null
  const span = (w: FacilityWindow, mark: string) => `${mark} ${formatMinutes(w.from)}〜${formatMinutes(w.to)}`
  const why = (w: FacilityWindow) => (w.source === 'research' ? `調べた${w.basis ?? '結果'}` : '既定')
  if (arrive.source === 'research' && depart.source === 'research' && arrive.basis === depart.basis) {
    return `${span(arrive, '着')}・${span(depart, '発')}(${why(arrive)})`
  }
  return `${span(arrive, '着')}(${why(arrive)})・${span(depart, '発')}(${why(depart)})`
}

/** 窓に当たった停留所と時刻(「07:40着 学校前」の形。着は arrive、発は depart の窓) */
function matchTexts(n: NearFacility): string[] {
  return n.matches.map((m) => `${m.time}${m.timing === 'arrive' ? '着' : '発'} ${m.stopName}`)
}

/**
 * 便の近くの学校・病院(search_trips の nearby_facilities の1件)。結果の大きさを抑えるため、最寄りの停留所の名前・窓の名前・
 * 種類の英字は入れない(停留所は matches にある)。窓を調べた結果から決めた施設だけ window を付ける
 */
function nearFacilityJson(n: NearFacility): Record<string, unknown> {
  const f = n.facility
  const window = windowSummary(f)
  return {
    target_id: f.targetId,
    name: f.name,
    category: f.categoryLabel,
    priority_rank: f.rank,
    matches: matchTexts(n),
    ...(window !== null ? { window } : {}),
  }
}

/** 調べた施設の結果の要点(search_trips の facility_research の1件) */
function facilityResearchJson(f: HintFacility): Record<string, unknown> {
  const r = f.research!
  const clip = (v: string) => (v.length > MAX_FACT_CHARS ? `${v.slice(0, MAX_FACT_CHARS)}…` : v)
  return {
    target_id: f.targetId,
    name: f.name,
    status: r.status,
    checked_at: r.checkedAt,
    origin: r.origin,
    facts: r.facts.slice(0, MAX_FACTS).map((x) => ({ label: x.label, value: clip(x.value), source_url: x.url })),
    ...(r.facts.length > MAX_FACTS ? { facts_omitted: r.facts.length - MAX_FACTS } : {}),
  }
}

/** 数を桁区切りにする(判断材料の短い文に入れる) */
function count(n: number): string {
  return n.toLocaleString('ja-JP')
}

/**
 * 判断材料の短い文(search_trips の hint_texts。結果の大きさを抑えるため、画面の文 restore.ts の hintSentence より短くする。指摘18.4)。
 * 画面の判断材料の名前(RESTORE_HINT_LABELS)に、便ごとに違う数だけを括弧で添える。何についての判断材料か(時間帯・停留所・
 * 系統の全体)は名前と tool の説明で分かる。「唯一の便」とは書かない(指摘15.3)。系統の便数は route_weekday_trips に、
 * 学校・病院の名前と時刻は nearby_facilities にある
 */
export function shortHintText(hint: RestoreHint, detail: RestoreHintDetail): string {
  const label = RESTORE_HINT_LABELS[hint]
  switch (hint) {
    case 'onlyTripInBand':
      return detail.band ? `${label}(${detail.band.label})` : label
    case 'firstTripLater':
      return detail.firstLater ? `${label}(減便後 ${detail.firstLater.after} 発。${count(detail.firstLater.minutes)} 分遅い)` : label
    case 'nearFacility': {
      const matched = (detail.facilities ?? []).filter((n) => n.matches.length > 0).length
      return matched > 0 ? `${label}(${count(matched)} 施設)` : label
    }
    default:
      return label
  }
}

/** 'YYYYMMDD' → 'YYYY/MM/DD'(Claude に渡す文の日付) */
function slashDate(date: string): string {
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`
}

/** 到達圏を使う手がかりを、どの日付・どの時間帯の幅の比較から出したか */
function reachDateNote(date: string, stepHours: StepHours): string {
  return `到達圏を使う判断材料(onlyServiceAtStop・restoresLostCells)は、比較する日付 ${slashDate(date)} の減便前後の到達圏の比較から、画面の時間帯の幅(${stepHours} 時間ごと)で出しています。`
}

/** 比較の日付に平日の service が走らないので、どの便にも到達圏を使う手がかりが出ない(「該当なし」ではない) */
function reachNotRunningNote(date: string): string {
  return `比較する日付 ${slashDate(date)} は平日ダイヤの運行日ではないため、到達圏を使う判断材料(onlyServiceAtStop・restoresLostCells)は出していません(該当がないという意味ではありません)。利用者に、比較する日付を平日にするよう伝えてください。`
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 文字数(サロゲートペアは1字) */
function charLength(text: string): number {
  return [...text].length
}

/**
 * 結果を JSON にする。MAX_RESULT_BYTES を超えたら、lists に挙げた配列を後ろの項目から順に後ろから切り、
 * 切った件数を truncated に書く
 */
export function fitResult(result: Record<string, unknown>, lists: readonly string[] = []): string {
  let text = JSON.stringify(result)
  if (byteLength(text) <= MAX_RESULT_BYTES) return text
  const copy: Record<string, unknown> = { ...result }
  let cut = 0
  for (const key of [...lists].reverse()) {
    const value = copy[key]
    if (!Array.isArray(value)) continue
    const list = [...value]
    while (list.length > 0) {
      list.pop()
      cut++
      copy[key] = list
      copy.truncated = cut
      copy.truncated_note = `結果が 20KB を超えたため、一覧の後ろから ${cut} 件を省きました。条件を絞って探し直してください。`
      text = JSON.stringify(copy)
      if (byteLength(text) <= MAX_RESULT_BYTES) return text
    }
  }
  return text
}

function ok(result: Record<string, unknown>, lists: readonly string[] = [], draft?: ToolOutcome['draft']): ToolOutcome {
  return { content: fitResult(result, lists), isError: false, ...(draft ? { draft } : {}) }
}

function fail(message: string, extra: Record<string, unknown> = {}, draft?: ToolOutcome['draft']): ToolOutcome {
  return { content: JSON.stringify({ status: 'error', message, ...extra }), isError: true, ...(draft ? { draft } : {}) }
}

/** 失敗の結果(セッションの側で、実行しなかった呼び出しに答えるときにも使う) */
export function errorOutcome(message: string): ToolOutcome {
  return fail(message)
}

/** 下書きが承認待ちのときの文(docs/interfaces-1104.md §10) */
export function pendingDraftMessage(id: string): string {
  return `${draftName(id)} が承認待ちです。利用者が「承認する」か「やめる」を押すまで、次の編集はできません。`
}

// ---- 入力の確かめ(strict が無いので、すべてここで行う。§6.3) ----

class InputError extends Error {}

/** 入力がオブジェクトで、keys の項目がそろい、ほかの項目が無いこと */
function objectOf(input: unknown, keys: readonly string[], name = '入力'): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError(`${name}がオブジェクトではありません。`)
  const o = input as Record<string, unknown>
  const missing = keys.filter((k) => !Object.hasOwn(o, k))
  if (missing.length > 0) throw new InputError(`${name}に ${missing.join('・')} がありません。使わない項目も null か空の値で入れてください。`)
  const unknown = Object.keys(o).filter((k) => !keys.includes(k))
  if (unknown.length > 0) {
    const allowed = keys.length > 0 ? `使える項目は ${keys.join('・')} だけです` : '項目は入れないでください(空のオブジェクト)'
    throw new InputError(`${name}に知らない項目 ${unknown.join('・')} があります。${allowed}。`)
  }
  return o
}

function stringOf(value: unknown, name: string, maxChars?: number): string {
  if (typeof value !== 'string') throw new InputError(`${name} は文字列にしてください。`)
  if (maxChars !== undefined && charLength(value) > maxChars) {
    throw new InputError(`${name} は ${maxChars} 字までにしてください(${charLength(value)} 字でした)。`)
  }
  return value
}

function nullableStringOf(value: unknown, name: string, maxChars?: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new InputError(`${name} は文字列か null にしてください。`)
  return stringOf(value, name, maxChars)
}

/** 文字列の配列(件数の上限つき)。nullable なら null も受け付ける */
function stringArrayOf(value: unknown, name: string, maxItems: number, nullable: boolean): string[] | null {
  if (value === null && nullable) return null
  if (!Array.isArray(value) || value.some((r) => typeof r !== 'string')) {
    throw new InputError(nullable ? `${name} は文字列の配列か null にしてください。` : `${name} は文字列の配列にしてください(なければ空の配列)。`)
  }
  if (value.length > maxItems) throw new InputError(`${name} は ${maxItems} 件までにしてください(${value.length} 件でした)。`)
  return value as string[]
}

/** 'YYYYMMDD' の暦の上で正しい日付 */
function dateOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value) || !isValidGtfsDate(value)) {
    throw new InputError(`${name}(${JSON.stringify(value)})は、YYYYMMDD の正しい日付にしてください(例 20261109)。`)
  }
  return value
}

function nullableDateOf(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new InputError(`${name} は YYYYMMDD の文字列か null にしてください。`)
  return dateOf(value, name)
}

/** 'HH:MM'(時は 0〜47)を、0:00 からの秒にする */
function clockOf(value: unknown, name: string): number {
  const m = typeof value === 'string' ? /^(\d{2}):(\d{2})$/.exec(value) : null
  const h = m ? Number(m[1]) : NaN
  const mi = m ? Number(m[2]) : NaN
  if (!m || h > 47 || mi > 59) throw new InputError(`${name}(${JSON.stringify(value)})は、HH:MM の時刻にしてください(時は 00〜47)。`)
  return h * 3600 + mi * 60
}

function nullableClockOf(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new InputError(`${name} は HH:MM の文字列か null にしてください。`)
  return clockOf(value, name)
}

function integerIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${name}(${JSON.stringify(value)})は ${min}〜${max} の整数にしてください。`)
  }
  return value
}

/** 入力の全体の大きさ(JSON にしたときの UTF-8 のバイト数) */
function checkInputSize(input: unknown): void {
  let text: string | undefined
  try {
    text = JSON.stringify(input)
  } catch {
    throw new InputError('入力を JSON として読めません。')
  }
  if (text !== undefined && byteLength(text) > INPUT_LIMITS.totalBytes) {
    throw new InputError(`入力が大きすぎます(${INPUT_LIMITS.totalBytes / 1024}KB まで)。件数を減らしてください。`)
  }
}

// ---- 編集の状態 ----

/** 読むだけのツールが比べる編集後(承認待ちの下書きがあれば下書き、無ければ承認済みの最後の版) */
interface Basis {
  /** null は編集なし(読み込んだ GTFS のまま) */
  result: Form2Result | null
  kind: 'draft' | 'approved' | 'none'
  draftId: string | null
}

/** 到達圏の store に渡す編集後(store/edit.ts の editedNow)と同じ規則で選ぶ */
function basisOf(state: EditState): Basis {
  const { draft } = state
  if (draft?.kind === 'op' && draft.outcome.ok) return { result: draft.outcome.result, kind: 'draft', draftId: draft.id }
  if (draft?.kind === 'undo') return { result: draft.result, kind: 'draft', draftId: draft.id }
  const last = lastVersion(state)
  return last ? { result: last, kind: 'approved', draftId: null } : { result: null, kind: 'none', draftId: null }
}

function basisFields(b: Basis): Record<string, unknown> {
  return {
    basis: b.kind === 'draft' ? '承認待ちの下書き' : b.kind === 'approved' ? '承認済みの編集' : '編集なし',
    draft_id: b.draftId,
  }
}

function trimmed(v: string | undefined): string {
  return v === undefined ? '' : v.trim()
}

/** service の集合に入る便の trip_id */
function tripIdsOfServices(feed: GtfsFeed, services: ReadonlySet<string>): Set<string> {
  return new Set((feed.tables.get('trips')?.rows ?? []).filter((t) => services.has(trimmed(t.service_id))).map((t) => trimmed(t.trip_id)))
}

function hoursText(minutes: number): string {
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`
}

/** 足し戻した便の集計(docs/interfaces-1104.md §8)。「運転時間」とは書かない */
function totalsJson(base: GtfsFeed, accepted: readonly string[]): Record<string, unknown> {
  const t = restoreTotals(base, accepted)
  return {
    trips: t.trips,
    service_minutes: t.serviceMinutes,
    service_time: hoursText(t.serviceMinutes),
    unknown_duration: t.unknownDuration,
    earliest_start: t.earliestStart,
    latest_end: t.latestEnd,
    note: '営業運行時間は、各便の始発から終着までの合計です(回送・待機・点呼は含みません)。要る運転士の数(勤務の数の下限の目安)と欠員との比較は、summarize_impact の drivers で見られます。',
  }
}

function issueMessages(issues: readonly ValidationIssue[], severity: ValidationIssue['severity']): string[] {
  return issues
    .filter((i) => i.severity === severity)
    .map((i) => (i.exportOnly ? `${i.message}(出力だけを止めます。承認はできます)` : i.message))
}

/** 編集の下書きの summary(数はすべてコードが出す) */
function draftSummary(diff: WeekdayDiff, result: Form2Result, issues: readonly ValidationIssue[]): Record<string, unknown> {
  const { validity } = result.report
  return {
    weekday_trips_before: diff.removed.length + diff.same.length,
    weekday_trips_after: diff.same.length + diff.added.length,
    removed: diff.removed.length,
    added: diff.added.length,
    same: diff.same.length,
    validity: { start: validity.start, end: validity.end, days: validity.days },
    vanishing_routes: diff.byRoute.filter((r) => r.vanishes).map((r) => ({ route_id: r.routeId, name: r.routeName })),
    warnings: issueMessages(issues, 'warning'),
    errors: issueMessages(issues, 'error'),
    // 組が複数あるとき(グループ分けの組の表)だけ、組ごとのなくなる便・加わる便と、期間に走らないため組ごと除いた組、
    // 期間に走らないため加えなかった入れ替えに使う service を書く
    ...(result.report.pairs
      ? {
          pairs: result.report.pairs.map((p) => ({
            weekday: p.weekday,
            replacements: p.replacements.map((r) => r.serviceId),
            removed: p.removed,
            added: p.replacements.reduce((n, r) => n + r.added, 0),
            dropped_for_period: p.dropped,
            // 組ごと除いた組は、組の内訳の「除いた組」に出すだけで、加えない入れ替えに使う service には数えない(editText の skippedOfReport と同じ)
            replacements_not_added_for_period: p.dropped ? [] : p.replacements.filter((r) => r.notActive).map((r) => r.serviceId),
          })),
        }
      : {}),
  }
}

function draftNote(issues: readonly ValidationIssue[]): string {
  const blocking = blockingIssues(issues)
  if (blocking.length === 0) return DRAFT_NOTE
  return `${DRAFT_NOTE} ただし、検証でエラーがあるため、このままでは承認できません。利用者に、画面で下書きの「やめる」を押すよう伝えてください。`
}

/** 便の要約(始発の時刻・系統・始発 → 終着)。足し戻しの結果で、Claude が思っていた便か確かめるため */
function tripLine(t: TripBrief): Record<string, unknown> {
  return {
    trip_id: t.tripId,
    route_id: t.routeId,
    route_name: t.routeName,
    headsign: t.headsign,
    first_departure: t.firstDeparture,
    first_stop: t.firstStopName,
    last_stop: t.lastStopName,
  }
}

// ---- 系統の指定の読み替え ----

/** 利用者や Claude が書いた系統の指定(route_id・系統番号・系統名)を、どの規則で route_id に読み替えたか */
export interface RouteResolution {
  given: string
  route_id: string
  name: string
  by: 'route_id' | 'route_short_name' | 'route_long_name' | 'long_name_number' | 'route_id_without_zeros'
}

/** 頭の 0 を除いた数字(数字だけの文字列でなければ null) */
function numberKey(s: string): string | null {
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : null
}

/** route_long_name の頭の番号(「51-沼田深川線」の 51)。区切りはハイフン類・空白 */
function longNameNumber(longName: string): string | null {
  const m = /^(\d+)\s*[-‐‑–—ー－\s]/.exec(longName)
  return m ? numberKey(m[1]) : null
}

/**
 * 系統の指定を route_id に読み替える。決まった規則を順に当て、1つに決まった規則で読み替える(推測はしない)。
 * 規則:route_id と同じ → route_short_name と同じ → route_long_name と同じ → route_long_name の頭の番号と同じ
 * → 頭の 0 を除いた route_id と同じ。ある規則で2つ以上に当たったら、そこで「決まらない」にする
 */
export function resolveRouteRefs(
  feed: GtfsFeed,
  refs: readonly string[],
): { resolved: RouteResolution[]; problems: string[] } {
  const routes = (feed.tables.get('routes')?.rows ?? []).map((r) => ({
    id: trimmed(r.route_id),
    short: trimmed(r.route_short_name),
    long: trimmed(r.route_long_name),
  }))
  const nameOf = (r: (typeof routes)[number]) => r.long || r.short || r.id
  const rules: [RouteResolution['by'], (r: (typeof routes)[number], given: string) => boolean][] = [
    ['route_id', (r, g) => r.id === g],
    ['route_short_name', (r, g) => r.short !== '' && r.short === g],
    ['route_long_name', (r, g) => r.long !== '' && r.long === g],
    ['long_name_number', (r, g) => numberKey(g) !== null && longNameNumber(r.long) === numberKey(g)],
    ['route_id_without_zeros', (r, g) => numberKey(g) !== null && numberKey(r.id) === numberKey(g)],
  ]
  const resolved: RouteResolution[] = []
  const problems: string[] = []
  for (const given of refs) {
    let done = false
    for (const [by, match] of rules) {
      const hits = routes.filter((r) => match(r, given))
      if (hits.length === 1) {
        resolved.push({ given, route_id: hits[0].id, name: nameOf(hits[0]), by })
        done = true
        break
      }
      if (hits.length > 1) {
        problems.push(
          `「${given}」に当たる系統が ${hits.length} つあります(${hits.slice(0, 5).map((r) => `${r.id}:${nameOf(r)}`).join('、')})。route_id で指定してください。`,
        )
        done = true
        break
      }
    }
    if (!done) problems.push(`「${given}」に当たる系統がありません(route_id・系統番号・系統名のどれとも合いません)。`)
  }
  return { resolved, problems }
}

// ---- ツール ----

function applyPolicy(input: unknown, deps: ToolDeps): ToolOutcome {
  const o = objectOf(input, TOOL_INPUT_KEYS.apply_policy)
  const kind = POLICY_KIND_NAMES[stringOf(o.kind, 'kind')]
  if (!kind || !Object.hasOwn(POLICY_KIND_NAMES, o.kind as string)) {
    throw new InputError(`kind(${JSON.stringify(o.kind)})は weekday_to_saturday か weekday_to_sunday_holiday にしてください。`)
  }
  const start = dateOf(o.start_date, 'start_date')
  const end = nullableDateOf(o.end_date, 'end_date')
  if (end !== null && end < start) throw new InputError(`end_date(${end})が start_date(${start})より前です。`)
  const excludedRaw = stringArrayOf(o.excluded_route_ids, 'excluded_route_ids', INPUT_LIMITS.routeIds, false)!
  const excluded = [...new Set(excludedRaw.map((r) => r.trim()).filter((r) => r !== ''))]
  let category: PolicyReason['category'] = null
  if (o.reason_category !== null) {
    const name = stringOf(o.reason_category, 'reason_category')
    category = Object.hasOwn(REASON_CATEGORY_NAMES, name) ? REASON_CATEGORY_NAMES[name] : null
    if (category === null) {
      throw new InputError('reason_category は temporary_shortage・chronic_shortage・demand_decline か null にしてください。')
    }
  }
  const note = stringOf(o.reason_note, 'reason_note', INPUT_LIMITS.reasonChars).trim()

  const state = deps.edit()
  const base = state.base
  if (!base) return fail(NO_BASE)
  if (state.draft) return fail(pendingDraftMessage(state.draft.id))

  const input0 = feedValidity(base.feed)
  const validity = input0 ? (policyValidity(input0, { start, end }) ?? input0) : null
  const services = deps.policyServices(validity ? { start: validity.start, end: validity.end } : null)
  const grouped = services?.groups
  const groupChoice = grouped?.status === 'confirmed' ? grouped.byKind[kind] : null
  if (groupChoice && 'error' in groupChoice) {
    return fail(
      `今のダイヤのグループ分けでは、この減便の方針を作れません。${groupChoice.error.map((p) => p.message).join(' ')} 利用者に、手順「減便の方針」の詳しい設定で、入れ替えるダイヤを「手動で選ぶ」にして直すよう伝えてください。下書きは作っていません。`,
    )
  }
  const weekday = groupChoice ? groupChoice.weekdayService : (services?.weekday ?? null)
  const replacement = groupChoice ? groupChoice.replacementService : ((kind === 'weekdayToSaturday' ? services?.saturday : services?.sundayHoliday) ?? null)
  if (!groupChoice && (!weekday || !replacement)) return fail(NO_SERVICES)

  // 系統の指定は、決まった規則で route_id に読み替える。決まらないものがあれば、誤った下書きを作らずに返す
  const routeRefs = resolveRouteRefs(base.feed, excluded)
  if (routeRefs.problems.length > 0) {
    return fail(`入れ替えから外す系統を決められませんでした。${routeRefs.problems.join(' ')} 利用者に確かめてください。`, {
      resolved_routes: routeRefs.resolved,
    })
  }
  const excludedIds = [...new Set(routeRefs.resolved.map((r) => r.route_id))]

  const settings: PolicySettings = groupChoice
    ? groupSettings(groupChoice, { start, end }, excludedIds)
    : { kind, weekdayService: weekday!, replacementService: replacement!, period: { start, end }, excludedRoutes: excludedIds }
  const periodValidity = input0 ? policyValidity(input0, { start, end }) : null
  const servicesJson = { weekday, replacement, ...(groupChoice ? { groups: groupsJson(base.feed, settings, periodValidity) } : {}) }
  // 適用できない方針は下書きにしない(承認できない下書きが残ると、次の編集ができなくなるため)
  const problems = checkPolicy(base.feed, settings)
  const errors = problems.filter((p) => p.severity === 'error')
  if (errors.length > 0) {
    return fail(`この減便の方針は適用できません。${errors.map((p) => p.message).join(' ')}`, {
      services: servicesJson,
    })
  }

  const op: EditOp = { type: 'applyPolicy', settings, reason: { category, note } }
  const proposed = state.propose(op, 'claude')
  if (!proposed.ok) return fail(proposed.message)
  return draftResult(base.feed, proposed.draft, {
    services: servicesJson,
    ...(grouped?.status === 'unconfirmed' ? { groups_note: groupsUnconfirmedNote(weekday!) } : {}),
    // どの指定をどの系統と読んだか(利用者が「系統51」と言ったときなどに、Claude が確かめて伝えるため)
    excluded_routes: routeRefs.resolved,
  })
}

/**
 * apply_policy の結果の services.groups(docs/design-service-groups.md §5.3)。画面の文と組の内訳(sentenceServices)と同じ数え方:
 * - pairs:入れ替える組(主の組が先頭)。replacements は期間に走るため加える入れ替えに使う service だけ
 * - erased:期間の間便をなくす平日の service(入れ替えに使うダイヤが無い組と、入れ替えに使う service がすべて期間に走らない組)
 * - kept:平日のまま残す平日の service
 * - dropped_for_period:期間に走らないため組ごと除いた平日の service(主でない組だけ)
 * - not_added_for_period:期間に走らないため加えない入れ替えに使う service(組ごと除いた組のものは入れない)
 */
function groupsJson(
  feed: GtfsFeed,
  settings: PolicySettings,
  validity: { start: string; end: string } | null,
): {
  pairs: { weekday: string; replacements: string[] }[]
  kept: string[]
  erased: string[]
  dropped_for_period: string[]
  not_added_for_period: string[]
} {
  const dropped = droppedPairWeekdays(feed, settings, validity)
  const skipped = skippedReplacements(feed, settings, validity)
  const { replaced, erased } = sentenceServices(settings, dropped, skipped)
  const { replaced: all, kept } = splitPairs(settings)
  const notAdded = all.filter((p) => !dropped.has(p.weekday)).flatMap((p) => p.replacements.filter((r) => skipped.has(r)))
  return {
    pairs: replaced.map((p) => ({ weekday: p.weekday, replacements: [...p.replacements] })),
    kept,
    erased,
    dropped_for_period: [...dropped],
    not_added_for_period: [...new Set(notAdded)],
  }
}

/** グループ分けが Jev の答えを待っている間(unconfirmed)に作った下書きの断り書き。グループ分けを確定する操作は無い(指摘19) */
function groupsUnconfirmedNote(weekday: string): string {
  return `ダイヤのグループ分けが Jev の答えを待っているため、平日の service ${weekday} だけを入れ替える下書きにしました。ほかの平日の service の便は平日のまま残ります。ダイヤ単位で入れ替えるには、Jev の答えが届いてから(または利用者が手順「読み込み」で Jev への問い合わせをやめてから)、apply_policy を使い直してください。`
}

/** 編集の下書き(kind 'op')の結果 */
function draftResult(baseFeed: GtfsFeed, draft: Draft, extra: Record<string, unknown> = {}, summaryExtra: Record<string, unknown> = {}): ToolOutcome {
  const info = { id: draft.id, kind: draft.kind }
  if (draft.kind !== 'op') throw new Error('編集の下書きではありません。')
  if (!draft.outcome.ok) {
    return fail(
      `${draftName(draft.id)} を作りましたが、適用できませんでした(${draft.outcome.message})。この下書きは承認できないため、利用者に、画面で下書きの「やめる」を押すよう伝えてください。`,
      { draft_id: draft.id },
      info,
    )
  }
  const diff = draft.diff ?? diffOf(baseFeed, draft.outcome.result)
  return ok(
    {
      status: 'draft',
      draft_id: draft.id,
      ...extra,
      summary: { ...draftSummary(diff, draft.outcome.result, draft.issues), ...summaryExtra },
      note: draftNote(draft.issues),
    },
    [],
    info,
  )
}

function addBackTrips(input: unknown, deps: ToolDeps): ToolOutcome {
  const o = objectOf(input, TOOL_INPUT_KEYS.add_back_trips)
  if (!Array.isArray(o.items)) throw new InputError('items は配列にしてください。')
  if (o.items.length < INPUT_LIMITS.minItems || o.items.length > INPUT_LIMITS.maxItems) {
    throw new InputError(`items は ${INPUT_LIMITS.minItems}〜${INPUT_LIMITS.maxItems} 件にしてください(${o.items.length} 件でした)。`)
  }
  const items: AddBackItem[] = []
  const seen = new Set<string>()
  let merged = 0
  o.items.forEach((raw, i) => {
    const item = objectOf(raw, ADD_BACK_ITEM_KEYS, `items[${i}]`)
    const tripId = stringOf(item.trip_id, `items[${i}].trip_id`).trim()
    if (tripId === '') throw new InputError(`items[${i}].trip_id が空です。`)
    const reason = stringOf(item.reason, `items[${i}].reason`, INPUT_LIMITS.reasonChars).trim()
    if (typeof item.school_days_only !== 'boolean') throw new InputError(`items[${i}].school_days_only は true か false にしてください。`)
    // 同じ trip_id は1つにまとめる(最初の理由を使う)
    if (seen.has(tripId)) {
      merged++
      return
    }
    seen.add(tripId)
    items.push({ tripId, reason, schoolDaysOnly: item.school_days_only })
  })

  const state = deps.edit()
  const base = state.base
  if (!base) return fail(NO_BASE)
  if (state.draft) return fail(pendingDraftMessage(state.draft.id))
  const plan = planOf(state.history)
  if (!plan) return fail(NO_POLICY)

  // 基準の平日の便(feed が base。すべての組の平日の service の便)の trip_id だけを受け付ける
  const weekdayIds = tripIdsOfServices(base.feed, weekdayServicesOf(plan))
  const invalid = items.filter((i) => !weekdayIds.has(i.tripId)).map((i) => i.tripId)
  if (invalid.length > 0) {
    // グループ分けで平日のまま残す service の便は、戻す必要がない(期間の間も平日ダイヤで走る)
    const keptIds = tripIdsOfServices(base.feed, new Set(keptServicesOf(plan)))
    const kept = invalid.filter((id) => keptIds.has(id))
    const other = invalid.filter((id) => !keptIds.has(id))
    // 残す service の便と、それ以外の便を分けて書く(残す便を「平日の便ではない」と言わないため)
    const keptText =
      kept.length > 0 ? `${kept.join('、')} は、グループ分けで平日のまま残す service の便です。期間の間も平日ダイヤで走るため、平日に戻す必要がありません。` : ''
    const otherText =
      other.length > 0
        ? `減便前の GTFS(feed が base)の平日の便ではない trip_id があります(${other.join('、')})。search_trips の scope removed か base_weekday で、feed が base の便の trip_id を使ってください。`
        : ''
    return fail(`${keptText}${otherText}下書きは作っていません。`)
  }

  const before = new Set(lastVersion(state)?.report.addBack.accepted ?? [])
  const proposed = state.propose({ type: 'addBack', items }, 'claude')
  if (!proposed.ok) return fail(proposed.message)
  const draft = proposed.draft
  if (draft.kind !== 'op' || !draft.outcome.ok) return draftResult(base.feed, draft)

  const report = draft.outcome.result.report
  const requested = new Set(items.map((i) => i.tripId))
  const briefOf = createTripBriefer(base.feed, 'base')
  const tripRows = new Map((base.feed.tables.get('trips')?.rows ?? []).map((t) => [trimmed(t.trip_id), t]))
  const acceptedNow = report.addBack.accepted.filter((id) => requested.has(id) && !before.has(id))
  const already = report.addBack.accepted.filter((id) => requested.has(id) && before.has(id))
  const rejected = addBackRejections(report.addBack, plan.kind).filter((r) => requested.has(r.tripId))
  return draftResult(
    base.feed,
    draft,
    merged > 0 ? { merged_duplicates: merged } : {},
    {
      add_back: {
        accepted: acceptedNow.map((id) => tripLine(briefOf(tripRows.get(id)!))),
        already_added_back: already,
        not_accepted: rejected.map((r) => ({ trip_id: r.tripId, reason: r.reason })),
        totals: totalsJson(base.feed, report.addBack.accepted),
      },
    },
  )
}

function undoEdit(input: unknown, deps: ToolDeps): ToolOutcome {
  objectOf(input, TOOL_INPUT_KEYS.undo_edit)
  const state = deps.edit()
  const base = state.base
  if (!base) return fail(NO_BASE)
  if (state.draft) return fail(pendingDraftMessage(state.draft.id))
  const last = state.history[state.history.length - 1]
  if (!last) return fail('元に戻す承認済みの編集がありません。')
  const proposed = state.proposeUndo('claude')
  if (!proposed.ok) return fail(proposed.message)
  const draft = proposed.draft
  if (draft.kind !== 'undo') throw new Error('元に戻す下書きではありません。')
  const summary: Record<string, unknown> = { undoes: describeRecord(last) }
  if (draft.result && draft.diff) {
    Object.assign(summary, draftSummary(draft.diff, draft.result, []))
    delete summary.warnings
    delete summary.errors
  } else {
    summary.after = '編集なし(読み込んだ GTFS のまま)'
  }
  return ok({ status: 'draft', draft_id: draft.id, summary, note: DRAFT_NOTE }, [], { id: draft.id, kind: 'undo' })
}

class ReachTimeout extends Error {}

/** 到達圏の計算が終わるのを待つ(終わっていればすぐ返す)。timeoutMs を過ぎたら ReachTimeout で reject する */
function waitForReach(reach: ReachAccess, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('止めました', 'AbortError'))
  if (!reach.getState().computing) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new DOMException('止めました', 'AbortError'))
    const timer = setTimeout(() => finish(new ReachTimeout('到達圏の計算が終わりませんでした。しばらくしてから、もう一度使ってください。')), timeoutMs)
    signal?.addEventListener('abort', onAbort)
    unsubscribe = reach.subscribe(() => {
      if (!reach.getState().computing) finish()
    })
    // subscribe の前に終わっていたとき
    if (!reach.getState().computing) finish()
  })
}

async function summarizeImpact(input: unknown, deps: ToolDeps, signal?: AbortSignal): Promise<ToolOutcome> {
  const o = objectOf(input, TOOL_INPUT_KEYS.summarize_impact)
  const date = nullableDateOf(o.date, 'date')
  let step: StepHours | null = null
  if (o.step_hours !== null) {
    if (o.step_hours !== 1 && o.step_hours !== 3) throw new InputError(`step_hours(${JSON.stringify(o.step_hours)})は 1 か 3 か null にしてください。`)
    step = o.step_hours
  }

  const state = deps.edit()
  if (!state.base) return fail(NO_BASE)
  const basis = basisOf(state)
  if (basis.kind === 'none') return fail(NO_EDIT)

  const notes: string[] = []
  const reach = deps.reach
  const now = reach.getState()
  if (date !== null && date !== now.date) {
    const err = now.setDate(date)
    if (err) return fail(err)
    notes.push(`画面の比較する日付を ${date} にしました。`)
  }
  if (step !== null && step !== reach.getState().stepHours) {
    reach.getState().setStepHours(step)
    notes.push(`画面の時間帯の幅を ${step} 時間にしました。`)
  }
  try {
    await waitForReach(reach, deps.reachTimeoutMs ?? 120_000, signal)
  } catch (e) {
    if (e instanceof ReachTimeout) return fail(e.message)
    throw e
  }

  const s = reach.getState()
  if (s.error) return fail(`到達圏を計算できませんでした(${s.error})。`)
  const snap = s.snapshot
  if (!snap || !snap.baseline || !snap.comparison) {
    return fail('到達圏の減便前後の比較がまだできていません。利用者に、手順4「影響(到達圏)」で減便の前後を確かめるよう伝えてください。')
  }

  const total = snap.baseline.summary.coverableCells
  const totalPop = snap.baseline.summary.coverablePopulation
  const bands = snap.bands.map((band, i) => {
    const b = snap.baseline!.summary.bands[i]
    const a = snap.summary.bands[i]
    const c = snap.comparison!.bands[i]
    return {
      band: band.label,
      before: {
        unreachable_cells: b.unreachableCells,
        unreachable_percent: formatPercent(b.unreachableCells, total),
        unreachable_population: Math.round(b.unreachablePopulation),
      },
      after: {
        unreachable_cells: a.unreachableCells,
        unreachable_percent: formatPercent(a.unreachableCells, total),
        unreachable_population: Math.round(a.unreachablePopulation),
      },
      lost_cells: c.lostCells,
      lost_population: Math.round(c.lostPopulation),
      gained_cells: c.gainedCells,
      gained_population: Math.round(c.gainedPopulation),
    }
  })
  const zeroStops = snap.zeroStops ?? []
  const result = basis.result
  // 往復と学校・病院に着く便(A07)は、比較する日付の減便前と、今の減便後(元に戻す下書きで編集がなくなるなら減便前のまま)を比べる。
  // 平日ダイヤの service は、元に戻す下書きで減便前に戻るときも、承認済みの最後の版の方針から取る(画面の平日便を戻す手順の
  // RestoreStep.tsx の checkWeekdayResult と同じ)。比較する日付に平日ダイヤが走らないことを、該当なしと取り違えないため
  const editedFeed = result?.feed ?? state.base.feed
  const weekdayResult = result ?? lastVersion(state)
  const weekdays = weekdayResult ? activeWeekdayServicesOf(weekdayResult) : undefined
  const roundTrip = roundTripJson(roundTripCheck(state.base.feed, editedFeed, snap.date, { weekdayServices: weekdays }))
  const access = facilityAccessJson(state.base.feed, editedFeed, snap.date, weekdays, deps.hintContext(editedFeed))
  const drivers = driversJson(
    compareDrivers({
      base: state.base.feed,
      // 画面の欄(useDriverComparison)と同じく、到達圏の store に渡している減便後(元に戻す下書きで減便前に戻るなら減便前)と比べる
      edited: { feed: editedFeed, draft: basis.kind === 'draft' },
      date: snap.date,
      // 要る運転士の数の欄(store/drivers.ts の weekdayServicesOfEdit)と同じく、方針が分からないとき(元に戻す下書きで減便前に戻る)は null
      weekdayServices: result ? activeWeekdayServicesOf(result) : null,
      ...(deps.drivers ?? defaultDriverSettings)(),
    }),
  )
  const body: Record<string, unknown> = {
    status: 'ok',
    ...basisFields(basis),
    date: snap.date,
    step_hours: snap.stepHours,
    coverable_cells: total,
    coverable_population: Math.round(totalPop),
    bands,
    day_lost_cells: snap.comparison.dayLostCells,
    day_lost_population: Math.round(snap.comparison.dayLostPopulation),
    zero_service_stops: {
      count: zeroStops.length,
      feed_scope_count: zeroStops.filter((z) => z.scope === 'feed').length,
      top: zeroStops.slice(0, 20).map((z) => ({ stop_id: z.stopId, name: z.name, before_departures: z.beforeDepartures, scope: z.scope })),
    },
    zero_service_routes: (snap.zeroRoutes ?? []).map((r) => ({ route_id: r.routeId, name: r.name, before_trips: r.beforeTrips, scope: r.scope })),
    add_back: result && result.report.addBack.accepted.length > 0 ? totalsJson(state.base.feed, result.report.addBack.accepted) : null,
    round_trip: roundTrip,
    facility_access: access.json,
    ...(access.unavailable !== null ? { facility_access_unavailable: access.unavailable } : {}),
    drivers,
    notes: [
      ...notes,
      '区画(セル)は 125m 四方です。到達圏から外れる割合の分母は、減便前の GTFS で徒歩圏に停留所・駅がある区画(coverable_cells)です。',
      '推計人口は令和2年国勢調査のメッシュ人口から推計した値です。',
      'scope が feed の停留所・系統は、出力のどの日にも便が来ません。day はこの日だけ便がなくなります。',
      ROUND_TRIP_NOTE,
      FACILITY_ACCESS_TOOL_NOTE,
      DRIVERS_NOTE,
    ],
  }
  return ok(fitImpactLists(body), ['zero_service_routes'])
}

/** summarize_impact の round_trip.problems・facility_access.facilities に入れる件数の上限 */
export const MAX_IMPACT_ITEMS = 20

const ROUND_TRIP_NOTE =
  'round_trip は、比較する日付の減便前と減便後を、系統の方向(始発 → 終着の停留所名)ごとに比べた往復の確かめです。problems は、方向の便がなくなる(directionVanishes)・帰りの便がない(noReturn。行きの方向に朝の窓の便があり、逆向きに帰りの窓の便が 0)・終発が早まる(lastEarlier)・始発が遅くなる(firstLater)の順で、上位 20 件まで(省いた数は problems_omitted)。counts は種類ごとの全体の件数です。逆向きが見つからない系統(循環・片道)は no_reverse の数だけで、problems には入りません。'

const FACILITY_ACCESS_TOOL_NOTE =
  'facility_access は、学校・病院ごとに、徒歩圏の停留所で降りられて着く窓の中に着く便と、乗れて出る窓の中に出る便を、比較する日付に走る便だけ減便前と減便後で数えたものです。facilities は、着く便か出る便が減便後に 0 便になる施設だけを、重要拠点の優先順位(priority_rank)・距離の順に上位 20 件まで(省いた数は facilities_omitted)。窓は始業・外来の受付などに間に合う時間帯の目安で、source が research なら調べた結果(basis に読んだ時刻、source_url に出典)、default なら既定の窓です。乗車人数・混み具合・鉄道との乗り継ぎは判定していません。'

const DRIVERS_NOTE =
  'drivers は、比較する日付の便を時刻順に勤務へつなぎ、改善基準告示の上限で区切った勤務の数(duties。要る運転士の数の下限の目安)と営業運行時間を、減便前と減便後で比べたものです(画面の手順4「影響(到達圏)」の「要る運転士の数(目安)」と同じ計算)。在籍の運転士の数・週の出勤日数・営業所の位置・仮定は利用者が画面の手順2「運行の前提」で、欠員は手順3「減便の方針」で入れた値です。判定(verdict)は、乗務できる運転士の数(目安。supply.available = 在籍 × 週の出勤日数 ÷ 7 − 欠員。小数は切り捨て。欠員が未入力なら 0 として数える)と、減便後に要る勤務の数(needed_duties.after)の比較です。needed_duties.basis が operator_runs なら、減便前は入力の運用番号の数、減便後はそれに推定した勤務の数の比(duties.after / duties.before)を掛けた数(四捨五入)、estimate なら推定した勤務の数のままです。verdict の kind は enough(足りる目安。spare が余り)・short(足りない目安。missing が足りない数)・no_roster(在籍の運転士の数が未入力で判定なし)・not_weekday(比較する日付に平日ダイヤが走らない)・no_edited(減便後の GTFS がない)で、before_margin は減便前のままでの過不足(負なら足りない数)です。目安であって、休息期間・休日・予備の要員・実際の仕業と交番は事業者が判断します。'

function sideJson(s: RoundTripSide): Record<string, unknown> {
  return { trips: s.trips, first: s.first, last: s.last }
}

function windowText(w: RoundTripWindow): string {
  return `${formatMinutes(w.startMin)}〜${formatMinutes(w.endMin)}`
}

/** summarize_impact の round_trip(A04 の roundTripCheck の結果を、Claude に渡す形にする) */
function roundTripJson(r: ReturnType<typeof roundTripCheck>): Record<string, unknown> {
  const top = r.problems.slice(0, MAX_IMPACT_ITEMS)
  return {
    date: r.date,
    empty_reason: r.emptyReason?.message ?? null,
    windows: { morning: windowText(r.windows.morning), evening: windowText(r.windows.evening), shift_min: r.windows.shiftMin },
    counts: {
      direction_vanishes: r.counts.directionVanishes,
      no_return: r.counts.noReturn,
      last_earlier: r.counts.lastEarlier,
      first_later: r.counts.firstLater,
    },
    routes: {
      with_reverse: r.routes.withReverse,
      same_route: r.routes.sameRoute,
      other_route: r.routes.otherRoute,
      no_reverse: r.routes.noReverse,
      after_only: r.routes.afterOnly,
    },
    problems: top.map((p) => ({
      kind: p.kind,
      label: ROUND_TRIP_PROBLEM_LABELS[p.kind],
      route_id: p.routeId,
      route_name: p.routeName,
      from: p.fromName,
      to: p.toName,
      before: sideJson(p.before),
      after: sideJson(p.after),
      ...(p.shiftMin !== null ? { shift_min: p.shiftMin } : {}),
      ...(p.returnTrips
        ? { return_trips: { route_ids: p.returnTrips.routeIds, evening_before: p.returnTrips.eveningBefore, evening_after: p.returnTrips.eveningAfter } }
        : {}),
    })),
    problems_omitted: r.problems.length - top.length,
  }
}

const FACILITY_PROBLEM_LABELS = { arriveLost: '着く便がなくなる', departLost: '出る便がなくなる' } as const

function accessWindowJson(w: FacilityAccessWindow): Record<string, unknown> {
  return {
    window: `${w.from}〜${w.to}`,
    source: w.source,
    ...(w.source === 'research' ? { basis: w.basis, source_url: w.url } : {}),
    before: { trips: w.before.trips, time: w.before.time },
    after: { trips: w.after.trips, time: w.after.time },
  }
}

function accessEntryJson(e: FacilityAccessEntry): Record<string, unknown> {
  const nearest = e.stops[0]
  return {
    target_id: e.targetId,
    name: e.name,
    category: e.categoryLabel,
    priority_rank: e.rank,
    nearest_stop: nearest?.stopName ?? null,
    distance_m: e.distanceM,
    problems: e.problems.map((p) => FACILITY_PROBLEM_LABELS[p]),
    arrive: accessWindowJson(e.arrive),
    depart: accessWindowJson(e.depart),
  }
}

/**
 * summarize_impact の facility_access(A05 の facilityAccess の結果)。施設を読めていない・比較する日付に平日ダイヤが走らない
 * ときは json を null にし、unavailable に理由を書く(「該当なし」と取り違えないように)
 */
function facilityAccessJson(
  base: GtfsFeed,
  edited: GtfsFeed,
  date: string,
  weekdays: ReadonlySet<string> | undefined,
  ctx: RestoreHintContext | null,
): { json: Record<string, unknown> | null; unavailable: string | null } {
  if (!ctx) return { json: null, unavailable: '到達圏の比較と今の減便後の GTFS が合っていないため、学校・病院に着く便は確かめていません(該当がないという意味ではありません)。' }
  if (!ctx.facilities) {
    return {
      json: null,
      unavailable: '手順5「平日便を戻す」の「判断材料を調べる」で使う学校・病院の参照データを読み込めていないため、学校・病院に着く便は確かめていません(該当がないという意味ではありません)。',
    }
  }
  if (weekdays !== undefined) {
    const active = activeServiceIds(base, date)
    if (![...weekdays].some((s) => active.has(s.trim()))) {
      return {
        json: null,
        unavailable: `比較する日付 ${slashDate(date)} は平日ダイヤの運行日ではないため、学校・病院に着く便は確かめていません(該当がないという意味ではありません)。利用者に、比較する日付を平日にするよう伝えてください。`,
      }
    }
  }
  const r = facilityAccess(base, edited, date, ctx.facilities, toStops(base).stops)
  if (r.reason !== null) return { json: null, unavailable: r.reason }
  const lost = r.facilities.filter((f) => f.problems.length > 0)
  const top = lost.slice(0, MAX_IMPACT_ITEMS)
  return {
    json: {
      date: r.date,
      counts: { arrive_lost: r.counts.arriveLost, depart_lost: r.counts.departLost },
      facilities_with_stops: r.facilities.length,
      facilities_without_stops: r.withoutStops.length,
      facilities: top.map(accessEntryJson),
      facilities_omitted: lost.length - top.length,
    },
    unavailable: null,
  }
}

/** 要る運転士の数の欄の今の値(ToolDeps.drivers を省いたとき) */
function defaultDriverSettings(): DriverSettings {
  const s = useDriversStore.getState()
  return { params: s.params, places: s.places, shortage: s.shortage, roster: s.roster, workDays: s.workDays }
}

/**
 * summarize_impact の drivers(D06。指摘24)。数は store/drivers.ts の compareDrivers(画面の DriverPanel と同じ計算)。
 * verdict の kind は、no_edited(減便後の GTFS がない)・not_weekday(比較する日付に平日ダイヤが走らない)・no_roster(在籍の
 * 運転士の数を入れていない)・enough(乗務できる運転士の数 ≥ 減便後に要る勤務の数。spare が余り)・short(足りない。missing が
 * 足りない数)。意味は notes の DRIVERS_NOTE で伝える
 */
function driversJson(c: DriverComparison): Record<string, unknown> {
  const v = c.verdict
  const kind = { noEdited: 'no_edited', notWeekday: 'not_weekday', noRoster: 'no_roster', enough: 'enough', short: 'short' }[v.kind]
  return {
    date: c.date,
    draft: c.draft,
    service_hours: {
      before_min: c.before.hours.serviceMinutes,
      after_min: c.after?.hours.serviceMinutes ?? null,
      reduction_min: c.hours?.reduction.serviceMinutes ?? null,
      before_trips: c.before.hours.trips,
      after_trips: c.after?.hours.trips ?? null,
    },
    duties: { before: c.before.duties.dutyCount, after: c.after?.duties.dutyCount ?? null, diff: c.dutyDiff },
    operator_runs_before: c.operatorRuns,
    shortage: c.shortage,
    needed_duties: {
      basis: c.need.basis === 'operatorRuns' ? 'operator_runs' : 'estimate',
      before: c.need.before,
      after: c.need.after,
    },
    supply: c.supply
      ? {
          roster: c.supply.roster,
          work_days_per_week: c.supply.workDays,
          on_duty: c.supply.onDuty,
          available: c.supply.available,
          shortage_over_on_duty: c.supply.shortageOverOnDuty,
        }
      : null,
    verdict: {
      kind,
      ...(v.kind === 'enough' ? { spare: v.spare } : {}),
      ...(v.kind === 'short' ? { missing: v.missing } : {}),
      ...(v.kind === 'enough' || v.kind === 'short' ? { before_margin: v.beforeMargin } : {}),
    },
    places: c.placesEffect?.count ?? 0,
    assumptions: c.assumptions,
  }
}

/**
 * summarize_impact の結果が 20KB を超えるとき、ほかの一覧(zero_service_routes。fitResult が省く)より先に、
 * facility_access.facilities → round_trip.problems の順に後ろから省き、省いた数を facilities_omitted・problems_omitted に足し、
 * notes に書く。収まれば省かない
 */
export function fitImpactLists(body: Record<string, unknown>): Record<string, unknown> {
  const over = (o: Record<string, unknown>) => byteLength(JSON.stringify(o)) > MAX_RESULT_BYTES
  if (!over(body)) return body
  const copy: Record<string, unknown> = { ...body }
  const notes = Array.isArray(body.notes) ? [...(body.notes as unknown[])] : []
  const targets: readonly (readonly [string, string, string])[] = [
    ['facility_access', 'facilities', 'facilities_omitted'],
    ['round_trip', 'problems', 'problems_omitted'],
  ]
  for (const [key, listKey, omittedKey] of targets) {
    const parent = copy[key]
    if (typeof parent !== 'object' || parent === null) continue
    const original = parent as Record<string, unknown>
    if (!Array.isArray(original[listKey])) continue
    const list = [...(original[listKey] as unknown[])]
    const omitted0 = typeof original[omittedKey] === 'number' ? (original[omittedKey] as number) : 0
    const message = (cut: number) =>
      `結果が 20KB を超えたため、${key}.${listKey} の後ろから ${cut} 件を省きました(省いた数は ${omittedKey} に含めています)。`
    let cut = 0
    while (list.length > 0 && over(copy)) {
      list.pop()
      cut++
      copy[key] = { ...original, [listKey]: list, [omittedKey]: omitted0 + cut }
      copy.notes = [...notes, message(cut)]
    }
    if (cut > 0) notes.push(message(cut))
    if (!over(copy)) break
  }
  return copy
}

/** 便の時刻順(時刻の無い便は後ろ)、同じなら系統、trip_id の順 */
function byTime(a: TripBrief, b: TripBrief): number {
  if (a.firstSeconds !== b.firstSeconds) {
    if (a.firstSeconds === null) return 1
    if (b.firstSeconds === null) return -1
    return a.firstSeconds - b.firstSeconds
  }
  const r = a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0
  return r || (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0)
}

/** 施設や乗り換えの目印になりやすい停留所の名前(via で先に選ぶ) */
const MAIN_STOP_PATTERN = /学校|高校|中学|小学|大学|高専|病院|医院|医療|クリニック|駅|役場|役所|支所|ターミナル|センター/

/**
 * 便が通る主な停留所(始発・終着を除き、MAX_VIA_STOPS 個まで。通る順)。stop_name で絞ったときはその停留所を先に、
 * 次に施設や駅の名前を含む停留所を、足りなければ途中の停留所を等間隔に選ぶ(結果の大きさを抑えるため。指摘18.4)
 */
function viaStopsOf(names: readonly string[], stopName: string | null): string[] {
  const middle = names.slice(1, -1)
  const picked = new Set<number>()
  const take = (pred: (n: string) => boolean) => {
    middle.forEach((n, i) => {
      if (picked.size < MAX_VIA_STOPS && pred(n) && ![...picked].some((j) => middle[j] === n)) picked.add(i)
    })
  }
  if (stopName !== null) take((n) => n.includes(stopName))
  take((n) => MAIN_STOP_PATTERN.test(n))
  for (let k = 1; picked.size < MAX_VIA_STOPS && k <= MAX_VIA_STOPS; k++) {
    const i = Math.floor((middle.length * k) / (MAX_VIA_STOPS + 1))
    if (i < middle.length && ![...picked].some((j) => middle[j] === middle[i])) picked.add(i)
  }
  return [...picked].sort((a, b) => a - b).map((i) => middle[i])
}

/**
 * 到達圏を使う手がかりの ctx。到達圏の計算中なら、終わるのを hintWaitMs まで待ってから読む
 * (方針を承認した直後は、到達圏の store が編集後を計算し直しているため)
 */
async function hintContextOf(deps: ToolDeps, feed: GtfsFeed, signal?: AbortSignal): Promise<{ ctx: RestoreHintContext | null; note: string | null }> {
  let busy = false
  try {
    await waitForReach(deps.reach, deps.hintWaitMs ?? 20_000, signal)
  } catch (e) {
    if (!(e instanceof ReachTimeout)) throw e
    busy = true
  }
  const ctx = busy ? null : deps.hintContext(feed)
  return { ctx, note: ctx ? null : busy ? REACH_BUSY_HINTS : NO_REACH_HINTS }
}

/** 入力に無い項目を null にする(調整役の版 3 が送らない項目。LEGACY_OPTIONAL_KEYS) */
function withLegacyDefaults(input: unknown, name: ToolName): unknown {
  const keys = LEGACY_OPTIONAL_KEYS[name]
  if (!keys || typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const o = input as Record<string, unknown>
  const missing = keys.filter((k) => !Object.hasOwn(o, k))
  return missing.length === 0 ? input : { ...o, ...Object.fromEntries(missing.map((k) => [k, null])) }
}

/** search_trips の hints(判断材料の識別子の配列か null。空の配列は null と同じ) */
function hintFilterOf(value: unknown): Set<RestoreHint> | null {
  const list = stringArrayOf(value, 'hints', RESTORE_HINT_KINDS.length, true)
  if (list === null) return null
  const unknown = list.filter((h) => !(RESTORE_HINT_KINDS as readonly string[]).includes(h))
  if (unknown.length > 0) throw new InputError(`hints の ${unknown.join('・')} は判断材料の名前ではありません。使えるのは ${RESTORE_HINT_KINDS.join('・')} です。`)
  return list.length > 0 ? new Set(list as RestoreHint[]) : null
}

async function searchTrips(input: unknown, deps: ToolDeps, signal?: AbortSignal): Promise<ToolOutcome> {
  const o = objectOf(withLegacyDefaults(input, 'search_trips'), TOOL_INPUT_KEYS.search_trips)
  const scope = stringOf(o.scope, 'scope') as SearchScope
  if (!SEARCH_SCOPES.includes(scope)) throw new InputError(`scope は ${SEARCH_SCOPES.join('・')} のどれかにしてください。`)
  let routeIds: Set<string> | null = null
  const rawRoutes = stringArrayOf(o.route_ids, 'route_ids', INPUT_LIMITS.routeIds, true)
  if (rawRoutes !== null) {
    const ids = rawRoutes.map((r) => r.trim()).filter((r) => r !== '')
    if (ids.length > 0) routeIds = new Set(ids)
  }
  const stopName = nullableStringOf(o.stop_name, 'stop_name', INPUT_LIMITS.stopNameChars)?.trim() || null
  const from = nullableClockOf(o.depart_from, 'depart_from')
  const to = nullableClockOf(o.depart_to, 'depart_to')
  if (from !== null && to !== null && to <= from) throw new InputError('depart_to は depart_from より後の時刻にしてください。')
  const limit = integerIn(o.limit, 'limit', INPUT_LIMITS.minLimit, INPUT_LIMITS.maxLimit)
  const offset = o.offset === null ? 0 : integerIn(o.offset, 'offset', 0, INPUT_LIMITS.maxOffset)
  const hintFilter = hintFilterOf(o.hints)
  if (hintFilter !== null && scope !== 'removed' && scope !== 'base_weekday') {
    throw new InputError('hints で絞れるのは、scope が removed か base_weekday のときだけです(ほかの scope の便には判断材料を出しません)。')
  }

  const state = deps.edit()
  const base = state.base
  if (!base) return fail(NO_BASE)
  // 系統の指定は apply_policy と同じ規則で route_id に読み替える(決まらなければ探さずに返す)
  let resolvedRoutes: RouteResolution[] = []
  if (routeIds !== null) {
    const refs = resolveRouteRefs(base.feed, [...routeIds])
    if (refs.problems.length > 0) return fail(`探す系統を決められませんでした。${refs.problems.join(' ')}`)
    resolvedRoutes = refs.resolved
    routeIds = new Set(refs.resolved.map((r) => r.route_id))
  }
  const basis = basisOf(state)
  const result = basis.result
  if (!result && scope !== 'base_weekday') return fail(`${NO_EDIT} scope が base_weekday なら、減便前の平日の便を探せます。`)
  if (!result && hintFilter !== null) return fail(`${NO_EDIT} 判断材料は減便の方針があるときだけ出すため、hints では絞れません。`)

  const plan = result?.plan ?? null
  const diff = result ? diffOf(base.feed, result) : null
  const baseTrips = base.feed.tables.get('trips')?.rows ?? []
  const briefBase = createTripBriefer(base.feed, 'base')

  let trips: TripBrief[]
  if (scope === 'removed') trips = [...diff!.removed]
  else if (scope === 'added') trips = [...diff!.added]
  else if (scope === 'same') trips = [...diff!.same]
  else if (scope === 'added_back') {
    const accepted = new Set(result!.report.addBack.accepted)
    trips = baseTrips.filter((t) => accepted.has(trimmed(t.trip_id))).map(briefBase).sort(byTime)
  } else {
    // 減便の方針があれば、そのすべての組の平日の service(期間に走らないため組ごと除いた service は除く)。
    // 無ければ、自動の入れ替えの案のグループ分けの平日の service(土曜・日祝のどちらかで組になるもの)、それも無ければ画面の平日の service
    let weekdays: Set<string> | null = result ? activeWeekdayServicesOf(result) : null
    if (weekdays === null) {
      const input0 = feedValidity(base.feed)
      const ps = deps.policyServices(input0)
      if (ps?.groups?.status === 'confirmed') {
        const byKind = ps.groups.byKind
        weekdays = new Set(POLICY_KINDS.flatMap((k) => {
          const c = byKind[k]
          return 'error' in c ? [] : choicePairs(c).map((p) => p.weekday)
        }))
      } else if (ps?.weekday) {
        weekdays = new Set([ps.weekday.trim()])
      }
    }
    if (!weekdays || weekdays.size === 0) return fail(NO_SERVICES)
    const wk = weekdays
    trips = baseTrips.filter((t) => wk.has(trimmed(t.service_id))).map(briefBase).sort(byTime)
  }

  // 絞り込みを先に行い、手がかりは残った候補だけに出す
  let filtered = trips.filter(
    (t) =>
      (routeIds === null || routeIds.has(t.routeId)) &&
      (stopName === null || t.stopNames.some((n) => n.includes(stopName))) &&
      (from === null || (t.firstSeconds !== null && t.firstSeconds >= from)) &&
      (to === null || (t.firstSeconds !== null && t.firstSeconds < to)),
  )

  // 手がかり(足し戻しの候補になる基準の便だけ)。索引と ctx は1回だけ作り、候補の一覧すべてに使う。
  // offset で続きを読むときも、並びと hints の絞り込みが同じになるよう、ページの前の便も含めて全部に出す
  const stateNotes: string[] = []
  const explainNotes: string[] = []
  const details = new Map<TripBrief, RestoreHintDetail>()
  // 学校・病院の手がかりを出したか(出したときだけ、便ごとの nearby_facilities を入れる)
  let facilityHints = false
  if (plan && result && diff && (scope === 'removed' || scope === 'base_weekday') && filtered.length > 0) {
    const hinter = createRestoreHinter(base.feed, result.feed, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    const { ctx, note } = await hintContextOf(deps, result.feed, signal)
    if (note) stateNotes.push(note)
    if (ctx) {
      // 比較の日付に平日の便が走らなければ、どの便にも2つは出ない。Claude が「調べていない」と「該当なし」を取り違えないよう書く
      stateNotes.push(
        activeServiceIds(base.feed, ctx.date).has(plan.weekdayService.trim())
          ? reachDateNote(ctx.date, deps.reach.getState().stepHours)
          : reachNotRunningNote(ctx.date),
      )
      facilityHints = ctx.facilities !== undefined
      if (facilityHints) explainNotes.push(FACILITY_NOTE)
      else stateNotes.push(NO_FACILITY_DATA)
    } else {
      stateNotes.push(NO_FACILITY_HINTS_WITHOUT_REACH)
    }
    for (const t of filtered) details.set(t, hinter(t, ctx ?? undefined))
    if (hintFilter !== null) filtered = filtered.filter((t) => details.get(t)!.hints.some((h) => hintFilter.has(h)))
    if (scope === 'removed') {
      filtered = filtered
        .map((trip) => ({ trip, detail: details.get(trip)! }))
        .sort(compareByHints)
        .map((c) => c.trip)
    }
  } else if (hintFilter !== null) {
    filtered = []
  }

  const shown = filtered.slice(offset, offset + limit)
  // 調べた施設の結果は、返す便の近くの施設の分だけ、施設ごとに1回入れる(便ごとに繰り返さない)
  const researched = new Map<string, HintFacility>()
  const list = shown.map((t) => {
    const detail = details.get(t)
    const trip: Record<string, unknown> = {
      feed: t.feed,
      trip_id: t.tripId,
      route_id: t.routeId,
      route_name: t.routeName,
      headsign: t.headsign,
      first_stop: t.firstStopName,
      first_departure: t.firstDeparture,
      last_stop: t.lastStopName,
      last_arrival: t.lastArrival,
      stop_count: t.stopNames.length,
      via: viaStopsOf(t.stopNames, stopName),
    }
    if (!detail) return trip
    trip.hints = detail.hints
    // 判断材料の短い文(hints と同じ並び)。時間帯・停留所・系統の全体のどれについての判断材料かと、数はコードが書く(指摘15.3)
    trip.hint_texts = detail.hints.map((h) => shortHintText(h, detail))
    if (detail.band) trip.band = detail.band
    if (detail.firstLater) trip.first_later = detail.firstLater
    trip.route_weekday_trips = { before: detail.routeTrips.before, after: detail.routeTrips.after }
    if (detail.lostCells) trip.lost_cells = { cells: detail.lostCells.cells, population: Math.round(detail.lostCells.population) }
    if (facilityHints) {
      // 窓に当たる施設だけを返す(手がかりにならない施設で結果が 20KB を超え、便が省かれないように)
      const matched = (detail.facilities ?? []).filter((n) => n.matches.length > 0)
      const picked = matched.slice(0, MAX_FACILITIES_PER_TRIP)
      if (picked.length > 0) trip.nearby_facilities = picked.map(nearFacilityJson)
      for (const n of picked) {
        if (n.facility.research && researched.size < MAX_RESEARCHED_FACILITIES) researched.set(n.facility.targetId, n.facility)
      }
    }
    return trip
  })
  if ((scope === 'removed' || scope === 'base_weekday') && details.size > 0) explainNotes.push(HINT_TEXTS_NOTE, LOST_CELLS_NOTE)
  explainNotes.push(ORDER_NOTE, FEED_NOTE)
  if (offset > 0 && offset >= filtered.length) stateNotes.push(`offset(${offset})が対象の便の数(${filtered.length})以上のため、返す便はありません。`)
  const notes = [...stateNotes, ...(offset === 0 ? explainNotes : [NOTES_ON_FIRST_PAGE])]
  const nextOffset = offset + list.length < filtered.length ? offset + list.length : null
  const body: Record<string, unknown> = {
    status: 'ok',
    scope,
    ...basisFields(basis),
    total: filtered.length,
    offset,
    // 20KB に収めるために便を省いたら、省いた後の数に直す(fitTrips)
    returned: list.length,
    omitted_over_limit: Math.max(0, filtered.length - offset - list.length),
    next_offset: nextOffset,
    ...(resolvedRoutes.length > 0 ? { routes: resolvedRoutes } : {}),
    notes,
    ...(facilityHints ? { facility_research: [...researched.values()].map(facilityResearchJson) } : {}),
    trips: list,
  }
  return { content: fitTrips(body), isError: false }
}

/** 便の項目を1つ除いた写し(便でなければそのまま) */
function withoutKey(t: unknown, key: string): unknown {
  if (typeof t !== 'object' || t === null || !(key in t)) return t
  const rest: Record<string, unknown> = { ...(t as Record<string, unknown>) }
  delete rest[key]
  return rest
}

/** trip_id を断り書きに入れるときの長さの上限(字) */
const MAX_NOTE_TRIP_ID_CHARS = 64

/**
 * search_trips の結果を 20KB に収める。収まれば何も省かない。超えたら、収まるまで次の順に省く(指摘18.4。波5のレビュー)。
 * 判断材料の多い便が並ぶ1回目の結果にも便を多く入れるため、便を省く前に、ほかから読み取れる項目を省く。
 * 1〜4 で省いたものは、notes の1文(「結果を 20KB に収めるため、次を省きました:…」)にまとめて書く(省くたびに文を足さない)。
 * 1. facility_research(調べた施設の結果)を後ろから。省いた数は facility_research_omitted(get_research_results で読める)
 * 2. 同じ結果の前の便に出た施設の nearby_facilities を、target_id と matches だけにする(名前・種類・優先順位・window は前の便にある)
 * 3. hint_texts(名前は tool の説明の hints の識別子との対応、時間帯は band.label にある。nearFacility の施設の数は失う)。
 *    notes の HINT_TEXTS_NOTE(hint_texts の言い方を使うこと)も外す
 * 4. via(通る停留所は stop_name で探せる)
 * 5. trips を後ろから。returned を省いた後の便の数に直し、省いた便の数を truncated に、続きの位置を next_offset に書く
 *    (offset + returned + truncated + omitted_over_limit = total)。fitResult に任せると returned が省く前の数のまま残り、
 *    Claude が受け取った便の数と続きの位置を読み違えるため、ここで数え直す。
 *    先頭の1便だけで 20KB を超えるときは、その便を返さずに next_offset を1つ進める(同じ offset を読み続けないように)
 */
export function fitTrips(body: Record<string, unknown>): string {
  const over = (o: Record<string, unknown>) => byteLength(JSON.stringify(o)) > MAX_RESULT_BYTES
  if (!over(body) || !Array.isArray(body.trips)) return JSON.stringify(body)
  let baseNotes = Array.isArray(body.notes) ? [...(body.notes as unknown[])] : []
  const omittedParts: string[] = []
  /** 省いたものの断り書きを notes の最後の1文にした body */
  const withNote = (o: Record<string, unknown>, parts: readonly string[]) =>
    parts.length === 0 ? o : { ...o, notes: [...baseNotes, `結果を 20KB に収めるため、次を省きました:${parts.join('、')}。`] }
  let current: Record<string, unknown> = { ...body }

  // 1. 調べた施設の結果
  const research = Array.isArray(body.facility_research) ? (body.facility_research as unknown[]) : []
  if (research.length > 0) {
    const kept = [...research]
    const part = () => `facility_research の後ろから ${research.length - kept.length} 件(get_research_results で読めます)`
    const make = () => withNote({ ...current, facility_research: kept, facility_research_omitted: research.length - kept.length }, [part()])
    while (kept.length > 0 && over(make())) kept.pop()
    if (kept.length < research.length) {
      current = { ...current, facility_research: [...kept], facility_research_omitted: research.length - kept.length }
      omittedParts.push(part())
    }
  }
  if (!over(withNote(current, omittedParts))) return JSON.stringify(withNote(current, omittedParts))

  // 2. 前の便と同じ施設の nearby_facilities
  const seen = new Set<unknown>()
  let deduped = false
  const trips2 = (current.trips as unknown[]).map((t) => {
    if (typeof t !== 'object' || t === null || !Array.isArray((t as Record<string, unknown>).nearby_facilities)) return t
    const trip = t as Record<string, unknown>
    const list = (trip.nearby_facilities as Record<string, unknown>[]).map((f) => {
      if (!seen.has(f.target_id)) {
        seen.add(f.target_id)
        return f
      }
      deduped = true
      return { target_id: f.target_id, matches: f.matches }
    })
    return { ...trip, nearby_facilities: list }
  })
  if (deduped) {
    current = { ...current, trips: trips2 }
    omittedParts.push('前の便に出た施設の nearby_facilities の target_id・matches 以外(前の便にあります)')
    if (!over(withNote(current, omittedParts))) return JSON.stringify(withNote(current, omittedParts))
  }

  // 3. hint_texts
  const trips3 = current.trips as unknown[]
  if (trips3.some((t) => typeof t === 'object' && t !== null && 'hint_texts' in t)) {
    current = {
      ...current,
      trips: trips3.map((t) => withoutKey(t, 'hint_texts')),
    }
    // 無い hint_texts の言い方を使うよう求める項目の説明は外す(「唯一の便」と書かないことは tool の説明にある)
    baseNotes = baseNotes.filter((n) => n !== HINT_TEXTS_NOTE)
    omittedParts.push('hint_texts(名前は tool の説明の hints の「」、時間帯は band.label。施設の数は省略)')
    if (!over(withNote(current, omittedParts))) return JSON.stringify(withNote(current, omittedParts))
  }

  // 4. via
  const trips4 = current.trips as unknown[]
  if (trips4.some((t) => typeof t === 'object' && t !== null && 'via' in t)) {
    current = { ...current, trips: trips4.map((t) => withoutKey(t, 'via')) }
    omittedParts.push('via(stop_name で通る停留所を探せます)')
    if (!over(withNote(current, omittedParts))) return JSON.stringify(withNote(current, omittedParts))
  }

  // 5. 便を後ろから
  const trips = current.trips as unknown[]
  const offset = typeof body.offset === 'number' ? body.offset : 0
  const omittedOverLimit = typeof body.omitted_over_limit === 'number' ? body.omitted_over_limit : 0
  const total = typeof body.total === 'number' ? body.total : offset + trips.length + omittedOverLimit
  const kept = [...trips]
  let text = JSON.stringify(withNote(current, omittedParts))
  while (kept.length > 0) {
    kept.pop()
    const cut = trips.length - kept.length
    let next: number | null = offset + kept.length
    let note = `結果が 20KB を超えたため、trips の後ろから ${cut} 件を省きました(returned は trips に入れた ${kept.length} 件)。続きは、同じ条件で offset を ${next} にして読んでください。`
    if (kept.length === 0) {
      // 先頭の1便だけで 20KB を超える。同じ offset を読み続けないよう、その便を飛ばして続きの位置を進める
      next = offset + 1 < total ? offset + 1 : null
      const head = trips[0] as Record<string, unknown> | null
      const id = typeof head?.trip_id === 'string' ? [...head.trip_id].slice(0, MAX_NOTE_TRIP_ID_CHARS).join('') : null
      note =
        `offset ${offset} の便${id !== null ? `(trip_id ${id})` : ''}は1便だけで 20KB を超えるため、返せませんでした。trips の ${cut} 件をすべて省きました(returned は 0)。` +
        (next !== null ? `この便を飛ばして続きを読むには、同じ条件で offset を ${next} にしてください。` : 'この便のほかに続きはありません。')
    }
    text = JSON.stringify(withNote({ ...current, returned: kept.length, next_offset: next, truncated: cut, truncated_note: note, trips: kept }, omittedParts))
    if (byteLength(text) <= MAX_RESULT_BYTES) return text
  }
  return text
}

function issueJson(i: ValidationIssue): Record<string, unknown> {
  return {
    code: i.code,
    file: i.file,
    message: i.message,
    count: i.count,
    examples: i.examples,
    export_only: i.exportOnly ?? false,
    inherited: i.inherited ?? false,
  }
}

function runValidation(input: unknown, deps: ToolDeps): ToolOutcome {
  objectOf(input, TOOL_INPUT_KEYS.run_validation)
  const state = deps.edit()
  const base = state.base
  if (!base) return fail(NO_BASE)
  const basis = basisOf(state)
  if (!basis.result) return fail(basis.kind === 'draft' ? '元に戻す下書きを承認すると編集がなくなるため、検証するものがありません。' : NO_EDIT)
  const draft = state.draft
  const issues =
    draft?.kind === 'op' && draft.outcome.ok && draft.outcome.result === basis.result
      ? draft.issues
      : validateEdit(base.feed, basis.result, deps.holidays())
  const timing = timingNotices(basis.result, deps.today())
  const errors = issues.filter((i) => i.severity === 'error')
  const notes: string[] = []
  if (basis.kind === 'draft') notes.push(`${draftName(basis.draftId ?? '')} を検証しました。承認待ちの下書きがある間は出力できません。利用者が承認してから出力します。`)
  return ok(
    {
      status: 'ok',
      ...basisFields(basis),
      can_export: errors.length === 0,
      counts: { errors: errors.length, warnings: issues.filter((i) => i.severity === 'warning').length, infos: issues.filter((i) => i.severity === 'info').length },
      notes,
      errors: errors.map(issueJson),
      warnings: issues.filter((i) => i.severity === 'warning').map(issueJson),
      timing: timing.map((i) => ({ severity: i.severity, code: i.code, message: i.message })),
      infos: issues.filter((i) => i.severity === 'info').map(issueJson),
    },
    ['errors', 'warnings', 'timing', 'infos'],
  )
}

/**
 * ツールを1つ実行する。入力が違えば isError で、何が違うかを日本語で返す。
 * 失敗しても例外は投げない(止めた(signal)ときの到達圏の待ちだけは AbortError で reject する)
 */
export async function runTool(name: string, input: unknown, deps: ToolDeps, signal?: AbortSignal): Promise<ToolOutcome> {
  try {
    if (!isToolName(name)) return fail(`${name} というツールはありません。`)
    checkInputSize(input)
    switch (name) {
      case 'apply_policy':
        return applyPolicy(input, deps)
      case 'add_back_trips':
        return addBackTrips(input, deps)
      case 'undo_edit':
        return undoEdit(input, deps)
      case 'summarize_impact':
        return await summarizeImpact(input, deps, signal)
      case 'search_trips':
        return await searchTrips(input, deps, signal)
      case 'run_validation':
        return runValidation(input, deps)
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    if (e instanceof InputError) return fail(e.message)
    return fail(`ツールを実行できませんでした(${e instanceof Error && e.message ? e.message : String(e)})。`)
  }
}
