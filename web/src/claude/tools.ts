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
import type { Form2Result } from '@/gtfs/edit/form2'
import { checkPolicy, planOf, type AddBackItem, type EditOp, type PolicyKind, type PolicyReason, type PolicySettings } from '@/gtfs/edit/ops'
import { compareByHints, createRestoreHinter, type RestoreHintContext, type RestoreHintDetail } from '@/gtfs/edit/restore'
import { feedValidity, policyValidity } from '@/gtfs/edit/services'
import type { HolidayList } from '@/gtfs/holidays'
import type { GtfsFeed } from '@/gtfs/load'
import { timingNotices, validateEdit, type ValidationIssue } from '@/gtfs/validate/edit'
import { formatPercent } from '@/reach/summary'
import { blockingIssues, diffOf, lastVersion, type Draft, type EditState } from '@/store/edit'
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
  search_trips: ['scope', 'route_ids', 'stop_name', 'depart_from', 'depart_to', 'limit'],
  run_validation: [],
}

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
} as const

/** ツールの動きとして画面に出す文(docs/interfaces-1105.md §6.4) */
export const TOOL_LABELS: Record<ToolName, string> = {
  apply_policy: '方針の下書きを作っています…',
  add_back_trips: '足し戻しの下書きを作っています…',
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
   * (画面の推定を同じ期間で作り直すときに使う。[画面の状態] の行では null)。GTFS が無ければ null
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
const NO_BASE = 'GTFS が読み込まれていません。利用者に、手順1で GTFS を読み込むよう伝えてください。'
const NO_SERVICES = '画面の方針の欄で、平日と土曜(日祝)の service を選んでください'
const NO_POLICY = '減便の方針が承認されていないので、使えません。先に apply_policy の下書きを作り、利用者に承認してもらってください。'
const NO_EDIT = '方針の下書きも承認済みの方針も無いので、比べる編集後の GTFS がありません。先に apply_policy を使ってください。'
const NO_REACH_HINTS = '到達圏の比較がまだ無いので、到達圏を使う手がかりは出していません'
const REACH_BUSY_HINTS = '到達圏の計算が終わらなかったので、到達圏を使う手がかりは出していません。しばらくしてから探し直してください'

/** 'YYYYMMDD' → 'YYYY/MM/DD'(Claude に渡す文の日付) */
function slashDate(date: string): string {
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`
}

/** 到達圏を使う手がかりを、どの日付の比較から出したか */
function reachDateNote(date: string): string {
  return `到達圏を使う手がかり(onlyServiceAtStop・restoresLostCells)は、比較の日付 ${slashDate(date)} の到達圏の前後の比較から出しています`
}

/** 比較の日付に平日の service が走らないので、どの便にも到達圏を使う手がかりが出ない(「該当なし」ではない) */
function reachNotRunningNote(date: string): string {
  return `比較の日付 ${slashDate(date)} は平日ダイヤの運行日ではないので、到達圏を使う手がかり(onlyServiceAtStop・restoresLostCells)は出していません(該当が無いという意味ではありません)。利用者に、到達圏を比べる日を平日にするよう伝えてください`
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
      copy.truncated_note = `結果が 20KB を超えたので、一覧の後ろから ${cut} 件を省きました。条件を絞って探し直してください。`
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
  return `下書き ${id} が承認待ちです。利用者が承認するか、やめるまで、次の編集はできません`
}

// ---- 入力の確かめ(strict が無いので、すべてここで行う。§6.3) ----

class InputError extends Error {}

/** 入力がオブジェクトで、keys の項目がそろい、ほかの項目が無いこと */
function objectOf(input: unknown, keys: readonly string[], name = '入力'): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError(`${name}がオブジェクトではありません。`)
  const o = input as Record<string, unknown>
  const missing = keys.filter((k) => !Object.hasOwn(o, k))
  if (missing.length > 0) throw new InputError(`${name}に ${missing.join('・')} がありません(使わない項目も null か空の値で入れてください)。`)
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
    throw new InputError(nullable ? `${name} は文字列の配列か null にしてください。` : `${name} は文字列の配列にしてください(無ければ空の配列)。`)
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
    note: '営業運行時間は、各便の始発から終着までの合計です(回送・待機・点呼は含まず、必要な運転士の人数ではありません)。',
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
  }
}

function draftNote(issues: readonly ValidationIssue[]): string {
  const blocking = blockingIssues(issues)
  if (blocking.length === 0) return DRAFT_NOTE
  return `${DRAFT_NOTE} ただし、検証でエラーがあるため、このままでは承認できません。利用者に、画面で下書きを「やめる」よう伝えてください。`
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
  const weekday = services?.weekday ?? null
  const replacement = (kind === 'weekdayToSaturday' ? services?.saturday : services?.sundayHoliday) ?? null
  if (!weekday || !replacement) return fail(NO_SERVICES)

  // 系統の指定は、決まった規則で route_id に読み替える。決まらないものがあれば、誤った下書きを作らずに返す
  const routeRefs = resolveRouteRefs(base.feed, excluded)
  if (routeRefs.problems.length > 0) {
    return fail(`入れ替えから外す系統を決められませんでした。${routeRefs.problems.join(' ')} 利用者に確かめてください。`, {
      resolved_routes: routeRefs.resolved,
    })
  }
  const excludedIds = [...new Set(routeRefs.resolved.map((r) => r.route_id))]

  const settings: PolicySettings = {
    kind,
    weekdayService: weekday,
    replacementService: replacement,
    period: { start, end },
    excludedRoutes: excludedIds,
  }
  // 適用できない方針は下書きにしない(承認できない下書きが残ると、次の編集ができなくなるため)
  const problems = checkPolicy(base.feed, settings)
  const errors = problems.filter((p) => p.severity === 'error')
  if (errors.length > 0) {
    return fail(`この方針は適用できません。${errors.map((p) => p.message).join(' ')}`, {
      services: { weekday, replacement },
    })
  }

  const op: EditOp = { type: 'applyPolicy', settings, reason: { category, note } }
  const proposed = state.propose(op, 'claude')
  if (!proposed.ok) return fail(proposed.message)
  return draftResult(base.feed, proposed.draft, {
    services: { weekday, replacement },
    // どの指定をどの系統と読んだか(利用者が「系統51」と言ったときなどに、Claude が確かめて伝えるため)
    excluded_routes: routeRefs.resolved,
  })
}

/** 編集の下書き(kind 'op')の結果 */
function draftResult(baseFeed: GtfsFeed, draft: Draft, extra: Record<string, unknown> = {}, summaryExtra: Record<string, unknown> = {}): ToolOutcome {
  const info = { id: draft.id, kind: draft.kind }
  if (draft.kind !== 'op') throw new Error('編集の下書きではありません。')
  if (!draft.outcome.ok) {
    return fail(
      `下書き ${draft.id} を作りましたが、適用できませんでした(${draft.outcome.message})。この下書きは承認できないので、利用者に、画面で下書きを「やめる」よう伝えてください。`,
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

  // 基準の平日の便(feed が base)の trip_id だけを受け付ける
  const weekdayIds = new Set(
    (base.feed.tables.get('trips')?.rows ?? []).filter((t) => trimmed(t.service_id) === plan.weekdayService.trim()).map((t) => trimmed(t.trip_id)),
  )
  const invalid = items.filter((i) => !weekdayIds.has(i.tripId)).map((i) => i.tripId)
  if (invalid.length > 0) {
    return fail(
      `基準の GTFS の平日の便(feed が base)ではない trip_id があります(${invalid.join('、')})。search_trips の scope removed か base_weekday で、feed が base の便の trip_id を使ってください。下書きは作っていません。`,
    )
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
    notes.push(`画面の比べる日を ${date} にしました。`)
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
  if (!snap || !snap.baseline || !snap.comparison) return fail('到達圏の前後の比較がまだできていません。利用者に、手順4の到達圏を確かめるよう伝えてください。')

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
  return ok(
    {
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
      notes: [
        ...notes,
        'セルは 125m 四方。外れる割合の分母は、基準の GTFS で到達できる見込みのあるセル(coverable_cells)です。',
        '推計人口は令和2年国勢調査のメッシュ人口から推計した値です。',
        'scope が feed の停留所・系統は、出力のどの日にも便が来ません。day はこの日だけ便が無くなります。',
      ],
    },
    ['zero_service_routes'],
  )
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

/** stop_names は 20 個を超えたら、最初の 10 個と最後の 10 個にする */
function stopNamesOf(names: readonly string[]): { names: string[]; omitted: number } {
  if (names.length <= 20) return { names: [...names], omitted: 0 }
  return { names: [...names.slice(0, 10), ...names.slice(-10)], omitted: names.length - 20 }
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

async function searchTrips(input: unknown, deps: ToolDeps, signal?: AbortSignal): Promise<ToolOutcome> {
  const o = objectOf(input, TOOL_INPUT_KEYS.search_trips)
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
  if (!result && scope !== 'base_weekday') return fail(`${NO_EDIT}(scope base_weekday なら、基準の平日の便を探せます)`)

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
    let weekday = plan?.weekdayService ?? null
    if (weekday === null) {
      const input0 = feedValidity(base.feed)
      weekday = deps.policyServices(input0)?.weekday ?? null
    }
    if (!weekday) return fail(NO_SERVICES)
    const wk = weekday.trim()
    trips = baseTrips.filter((t) => trimmed(t.service_id) === wk).map(briefBase).sort(byTime)
  }

  // 絞り込みを先に行い、手がかりは残った候補だけに出す
  let filtered = trips.filter(
    (t) =>
      (routeIds === null || routeIds.has(t.routeId)) &&
      (stopName === null || t.stopNames.some((n) => n.includes(stopName))) &&
      (from === null || (t.firstSeconds !== null && t.firstSeconds >= from)) &&
      (to === null || (t.firstSeconds !== null && t.firstSeconds < to)),
  )

  // 手がかり(足し戻しの候補になる基準の便だけ)。索引と ctx は1回だけ作り、候補の一覧すべてに使う
  const notes: string[] = []
  const details = new Map<TripBrief, RestoreHintDetail>()
  if (plan && result && diff && (scope === 'removed' || scope === 'base_weekday') && filtered.length > 0) {
    const hinter = createRestoreHinter(base.feed, result.feed, plan, [...diff.removed, ...diff.same], [...diff.same, ...diff.added])
    const { ctx, note } = await hintContextOf(deps, result.feed, signal)
    if (note) notes.push(note)
    if (ctx) {
      // 比較の日付に平日の便が走らなければ、どの便にも2つは出ない。Claude が「調べていない」と「該当なし」を取り違えないよう書く
      notes.push(activeServiceIds(base.feed, ctx.date).has(plan.weekdayService.trim()) ? reachDateNote(ctx.date) : reachNotRunningNote(ctx.date))
    }
    for (const t of filtered) details.set(t, hinter(t, ctx ?? undefined))
    if (scope === 'removed') {
      filtered = filtered
        .map((trip) => ({ trip, detail: details.get(trip)! }))
        .sort(compareByHints)
        .map((c) => c.trip)
    }
  }

  const shown = filtered.slice(0, limit)
  const list = shown.map((t) => {
    const detail = details.get(t)
    const names = stopNamesOf(t.stopNames)
    return {
      feed: t.feed,
      trip_id: t.tripId,
      route_id: t.routeId,
      route_name: t.routeName,
      headsign: t.headsign,
      first_stop: t.firstStopName,
      last_stop: t.lastStopName,
      first_departure: t.firstDeparture,
      last_arrival: t.lastArrival,
      stop_names: names.names,
      stop_names_omitted: names.omitted,
      hints: detail?.hints ?? [],
      lost_cells: detail?.lostCells ?? null,
      nearby_facilities: null,
    }
  })
  if (scope === 'removed' || scope === 'base_weekday') {
    notes.push('lost_cells は、この便だけを足し戻したときに戻るセルの数と推計人口です(ほかの便の足し戻しとの重なりは考えていません)。')
  }
  notes.push('trip_id は feed とあわせて読んでください(写した便は、消える基準の便と同じ trip_id のことがあります)。')
  return ok(
    {
      status: 'ok',
      scope,
      ...basisFields(basis),
      total: filtered.length,
      returned: list.length,
      omitted_over_limit: filtered.length - list.length,
      ...(resolvedRoutes.length > 0 ? { routes: resolvedRoutes } : {}),
      notes,
      trips: list,
    },
    ['trips'],
  )
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
  if (!basis.result) return fail(basis.kind === 'draft' ? '元に戻す下書きを承認すると編集が無くなるので、検証するものがありません。' : NO_EDIT)
  const draft = state.draft
  const issues =
    draft?.kind === 'op' && draft.outcome.ok && draft.outcome.result === basis.result
      ? draft.issues
      : validateEdit(base.feed, basis.result, deps.holidays())
  const timing = timingNotices(basis.result, deps.today())
  const errors = issues.filter((i) => i.severity === 'error')
  const notes: string[] = []
  if (basis.kind === 'draft') notes.push(`下書き ${basis.draftId} を検証しました。下書きがある間は出力できません。利用者が承認してから出力します。`)
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
