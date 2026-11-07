/**
 * service_id のグループ分けの型(docs/design-service-groups.md §7.5)。
 *
 * - ServiceFeatures・FeedFeatures:service ごとの判断材料(§2.1・§2.2)
 * - KindGroups・ServiceGroups:減便の方針の種類ごとの役割・割り当て・扱いの案(§2.3〜§2.7)と、Jev の答えとの合わせ(§3.4)
 * - PolicyServices:減便の方針(PolicySettings)に入れる service の値(§4.1。C の ops.ts の同じ名前の項目と同じ形)
 * - JevJudgeRequest・JevJudgeResponse:サーバーの中継(B)との取り決め(§3.3)
 */
import type { PolicyKind } from '../edit/ops'

export type DayKey = 'weekday' | 'saturday' | 'sundayHoliday'
export const DAY_KEYS: readonly DayKey[] = ['weekday', 'saturday', 'sundayHoliday']

/** 区分ごとの水準。regular は網羅率 0.7 以上、partial は 0.15 以上、rare は 0 より大きい、none は 0(§2.2) */
export type Level = 'regular' | 'partial' | 'rare' | 'none'
/** service の基本の形。regular の区分がある → regular、partial がある → partial、運行日がある → special、無い → noDays */
export type Basis = 'regular' | 'partial' | 'special' | 'noDays'
/**
 * 方針の種類ごとの役割(§2.3)。X は入れ替えに使う区分(土曜または日祝)、Y は残りの1つ。
 * weekdayOnly:平日を含み X・Y を含まない(入れ替え元)。replacement:平日を含まず X を含む(入れ替えに使う)。
 * both:平日と X を含む(手を付けない)。unsupported:平日と Y を含み X を含まない(形2で表せない)。
 * unrelated:平日も X も含まない
 */
export type Side = 'weekdayOnly' | 'replacement' | 'both' | 'unrelated' | 'unsupported'
/** 平日だけの service の扱い。erase は期間の間便をなくす(入れ替えに使う service があれば入れ替える)、keep は平日のまま残す */
export type Treatment = 'erase' | 'keep'
/**
 * 値の出どころの印(§3.4)。agreed:規則と Jev が一致。rule:規則。jev:規則で決まらず Jev の値。
 * conflict:規則と Jev が食い違う(値は規則)。undecided:決まらない(選んでもらう)。edited:利用者が直した
 */
export type Mark = 'agreed' | 'rule' | 'jev' | 'conflict' | 'undecided' | 'edited'

export interface DayCounts {
  weekday: number
  saturday: number
  sundayHoliday: number
}

export interface ServiceFeatures {
  serviceId: string
  /** service_id を最初の '_' で分けた頭と接尾辞('_' が無ければ接尾辞は空) */
  name: { head: string; suffix: string }
  tripCount: number
  routeCount: number
  /** route_id ごとの便数と表示名(便数の多い順、同数は route_id の昇順) */
  routes: { routeId: string; name: string; trips: number }[]
  /** route_id の集合(昇順)。系統の重なりの計算に使う。Jev には送らない */
  routeIds: string[]
  /** trip_headsign の上位5つ(便数の多い順、同数は文字列の昇順。空は数えない) */
  headsigns: string[]
  /** 便の最初の発時刻('HH:MM'。24 時を超える時刻はそのまま)。時刻が無ければ null */
  firstDeparture: string | null
  /** 便の最後の着時刻('HH:MM') */
  lastArrival: string | null
  /** 有効期間の中の運行日の数(区分ごとと全体) */
  runningDays: DayCounts & { total: number }
  /** 区分ごとの網羅率(その区分の運行日 ÷ 有効期間の中のその区分の日数。日数が 0 なら 0) */
  coverage: DayCounts
  levels: Record<DayKey, Level>
  basis: Basis
  /** 走る区分(§2.2 の runs) */
  runs: Record<DayKey, boolean>
  /** 運行日が 10 日以下のときだけ、その日の一覧('YYYYMMDD' の昇順) */
  runningDates: string[] | null
  /** 網羅率がしきい値(0.7・0.15)から ±0.05 にある区分(網羅率 0 は入れない) */
  nearThreshold: DayKey[]
}

export interface FeedFeatures {
  /** agency.txt の agency_name(複数なら「、」でつなぐ)。無ければ null */
  agency: string | null
  /** 入力の有効期間(feedValidity)。決められなければ空文字の組 */
  validity: { start: string; end: string }
  /** 有効期間の中の区分ごとの日数 */
  daysInPeriod: DayCounts
  /** 祝日一覧を当てたか。missing のときは日曜だけを日祝として数えた */
  holidays: 'loaded' | 'missing'
  /** service_id の昇順。便のある service だけ */
  services: ServiceFeatures[]
}

export interface KindRow {
  serviceId: string
  side: Side
  /** replacement の行:便を入れる平日の service。null は使わない、または決まらない(intoMark で分ける) */
  into: string | null
  /** replacement の行だけ */
  intoMark: Mark | null
  /** weekdayOnly・unsupported の行:扱い。unsupported の既定は null(エラー) */
  treatment: Treatment | null
  /** weekdayOnly・unsupported の行だけ(Jev の service_kind との合わせ)。利用者が扱いを直すと edited */
  basisMark: Mark | null
  /** 規則の理由の文(定型)と、Jev の答えの文 */
  reasons: string[]
}

export type GroupProblemCode =
  | 'unsupportedService'
  | 'undecidedReplacement'
  | 'keptHasReplacements'
  | 'nothingToChange'
  | 'lowRouteOverlap'
  /** policyServicesFor の multiService: false で、主の組に入れ替えに使う service が無い(名士バス・羽幌町)。設計の §7.5 の一覧に足した */
  | 'mainPairWithoutReplacement'

export interface GroupProblem {
  severity: 'error' | 'warning' | 'info'
  code: GroupProblemCode
  serviceIds: string[]
  message: string
}

export interface KindGroups {
  kind: PolicyKind
  /** 主の平日の service:weekdayOnly のうち basis が regular で便が一番多いもの(同数は service_id の昇順)。無ければ null */
  mainWeekday: string | null
  /** service_id の昇順。noDays の service は入れない */
  rows: KindRow[]
  problems: GroupProblem[]
}

export interface ServiceGroups {
  features: FeedFeatures
  /** 単純な GTFS(§2.7)。単純なら Jev を呼ばない */
  simple: boolean
  byKind: Record<PolicyKind, KindGroups>
  /** 規則の案(「案に戻す」に使う) */
  proposal: Record<PolicyKind, KindGroups>
  /** Jev の答え(合わせたもの)。Jev を使わなかった・捨てたときは null */
  jev: JevTargetResult[] | null
}

export type GroupEdit =
  | { kind: PolicyKind; serviceId: string; into: string | null }
  | { kind: PolicyKind; serviceId: string; treatment: Treatment }
  | { kind: PolicyKind; serviceId: string; acceptConflict: true }

// ---- A と C の間(§7.5) ----

export interface ServicePairValue {
  weekday: string
  replacements: string[]
}

/**
 * 減便の方針に入れる service(C の ops.ts の PolicySettings の同じ名前の項目と同じ形)。
 *
 * - 主の組:主の平日の service(mainWeekday。扱いが erase でなければ、erase の組のうち便が一番多いもの)と、
 *   主の入れ替えに使う service(その組の入れ替えに使う service のうち、basis が regular で便が一番多いもの。
 *   regular が無ければ便が一番多いもの。同数は service_id の昇順)
 * - pairs の並び:主の組が先頭、あとは weekday の昇順。replacements は主の入れ替えに使う service が先頭、あとは昇順
 * - 1組・1つの入れ替えに使う service・残すもの無しのときは pairs と keptWeekdayServices を入れない(今の1組の形)。
 *   pairs を入れるときは keptWeekdayServices も入れる(空でも)
 */
export interface PolicyServices {
  kind: PolicyKind
  weekdayService: string
  /** 主の組に入れ替えに使う service が無ければ '' */
  replacementService: string
  pairs?: ServicePairValue[]
  keptWeekdayServices?: string[]
  /**
   * multiService: false のときだけ。入れ替えなかった組・なくさなかった service・残す service(画面の「入れ替えていない」に出す)。
   * 主の組のほかの入れ替えに使う service は {weekday: 主の平日の service, replacements: [...]} で入れる。
   * なくす service と残す service は replacements が空(どちらかは groups の treatment で分かる)
   */
  notApplied?: ServicePairValue[]
}

// ---- A と B の間(§3.3・§7.5) ----

export type JevRole = 'weekday' | 'saturday' | 'sundayHoliday'

export interface JevJudgeRequest {
  feed: { agency: string | null; period: { start: string; end: string }; daysInPeriod: DayCounts }
  /** 60 個まで。targets とその候補だけ */
  services: JevServiceWire[]
  /** 40 個まで */
  targets: JevTargetWire[]
}

export interface JevServiceWire {
  serviceId: string
  tripCount: number
  routeCount: number
  runningDays: DayCounts & { total: number }
  /** 小数2桁に丸める */
  coverage: DayCounts
  /** 'HH:MM' */
  firstDeparture: string | null
  lastArrival: string | null
  /** 便数の多い順に 20 まで */
  routes: { name: string; trips: number }[]
  /** 5 つまで */
  headsigns: string[]
  /** 運行日 10 日以下のときだけ。'YYYYMMDD' */
  runningDates: string[] | null
}

export interface JevTargetWire {
  serviceId: string
  role: JevRole
  /** role が weekday なら空。それ以外は 1〜5 個(その kind の平日だけの service。接尾辞の合うもの → 主の平日の service → 重なりの大きい順) */
  candidates: { serviceId: string; routeOverlap: number }[]
}

export type JevFailureKind = 'timeout' | 'rate_limited' | 'upstream' | 'invalid_answer' | 'budget'

export interface JevFailure {
  serviceId: string
  role: JevRole
  error: JevFailureKind
  sent?: JevTargetResult['sent']
}

export interface JevJudgeResponse {
  /** 上流の応答の model('typesafe-ai/jev') */
  model: string
  results: JevTargetResult[]
  /**
   * 答えを得られなかった target。上流に送った後の失敗(timeout・rate_limited・upstream・invalid_answer)には、送った本文 sent がある
   * (画面の「送った情報を見る」で、外に出た判断材料を全部見せるため)。送る前の失敗(budget など)には無い
   */
  failures: JevFailure[]
  usage: { inputTokens: number; costUsd: number | null }
}

export interface JevChoice {
  choice: string
  probabilities: Record<string, number>
  confidence: number | null
}

export interface JevTargetResult {
  serviceId: string
  role: JevRole
  /** gateway.routing.finalProvider */
  provider: string | null
  /** サーバーが上流に送った本文 */
  sent: { state: unknown; questions: unknown }
  /** role が weekday。choice は regular_weekday・limited_weekdays・specific_dates */
  serviceKind?: JevChoice
  /** role が weekday */
  schoolService?: { probability: number }
  /** role が saturday・sundayHoliday。choice は candidates の serviceId か 'none' */
  weekdayCounterpart?: JevChoice
}

/** GET /api/service-groups の応答(§3.3)。unavailable はブラウザが足す(404・接続できない) */
export interface JevStatus {
  available: boolean
  provider: string | null
  via: string | null
  reason: 'noKey' | 'badUrl' | 'dailyLimit' | 'unavailable' | null
}

export type JevErrorKind = 'noKey' | 'rateLimited' | 'tooLarge' | 'invalid' | 'upstream' | 'network' | 'aborted' | 'unavailable'

export type JevOutcome =
  | { ok: true; response: JevJudgeResponse }
  | { ok: false; error: JevErrorKind; message: string }

export const POLICY_KINDS: readonly PolicyKind[] = ['weekdayToSaturday', 'weekdayToSundayHoliday']
