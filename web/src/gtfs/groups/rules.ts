/**
 * 規則による区分と組の案(docs/design-service-groups.md §2.3〜§2.7)と、Jev の答え・利用者の直しを合わせた組み立て(§3.4)。
 *
 * 案は毎回、判断材料(features)・Jev の答え・利用者の直し(edits)の3つから組み立て直す。前の結果に積み上げないので、
 * Jev の答えを何回合わせても、捨てても、同じ入力からは同じ結果になる。
 *
 * - 役割(side):runs(§2.2)と方針の種類の区分 X・Y から決める
 * - 割り当て(into):接尾辞 → 主の平日の service → 使わない の順(§2.4)。系統の重なりは文と注意にだけ使う
 * - 扱い(treatment):割り当てがあれば erase、無ければ basis が regular なら erase(なくす)、それ以外は keep(§2.5)。
 *   unsupported の既定は null(エラー。利用者が keep を選べば消える)
 */
import type { PolicyKind } from '../edit/ops'
import { compareStrings } from '../edit/signature'
import { LEVEL_THRESHOLDS, routeOverlap } from './features'
import { JEV_CONFIDENCE, isConfident } from './jevConfidence'
import {
  DAY_KEYS,
  POLICY_KINDS,
  type Basis,
  type DayKey,
  type FeedFeatures,
  type GroupProblem,
  type JevTargetResult,
  type KindGroups,
  type KindRow,
  type Mark,
  type ServiceFeatures,
  type ServiceGroups,
  type Side,
  type Treatment,
} from './types'

/** しきい値(§6.1)。網羅率の水準・境目は features.ts、Jev の確信は jevConfidence.ts と同じ値 */
export const THRESHOLDS = {
  ...LEVEL_THRESHOLDS,
  /** 主の平日の service に入れたとき、系統の重なりがこれ未満なら注意を出す */
  lowOverlap: 0.2,
  jev: JEV_CONFIDENCE,
} as const

/** 方針の種類の、入れ替えに使う区分 X と残りの区分 Y */
export function kindDays(kind: PolicyKind): { x: DayKey; y: DayKey } {
  return kind === 'weekdayToSaturday' ? { x: 'saturday', y: 'sundayHoliday' } : { x: 'sundayHoliday', y: 'saturday' }
}

/** Jev に入れ替えに使う側として問うときの役割 */
export function replacementRole(kind: PolicyKind): 'saturday' | 'sundayHoliday' {
  return kind === 'weekdayToSaturday' ? 'saturday' : 'sundayHoliday'
}

const DAY_LABELS: Record<DayKey, string> = { weekday: '平日', saturday: '土曜', sundayHoliday: '日祝' }

export function sideOf(f: ServiceFeatures, kind: PolicyKind): Side {
  const { x, y } = kindDays(kind)
  const w = f.runs.weekday
  if (w && !f.runs[x]) return f.runs[y] ? 'unsupported' : 'weekdayOnly'
  if (!w && f.runs[x]) return 'replacement'
  if (w && f.runs[x]) return 'both'
  return 'unrelated'
}

/** 割り当ての決まり方:suffix(接尾辞)・main(主の平日の service)・unused(使わない)・ambiguous(決まらない) */
export type AssignHow = 'suffix' | 'main' | 'unused' | 'ambiguous'

export interface KindContext {
  kind: PolicyKind
  byId: Map<string, ServiceFeatures>
  sides: Map<string, Side>
  /** weekdayOnly の service(service_id の昇順) */
  weekdayOnly: ServiceFeatures[]
  mainWeekday: string | null
  /** replacement の service ごとの規則の割り当て */
  assignments: Map<string, { into: string | null; how: AssignHow; suffixCandidates: string[] }>
}

const isRegular = (b: Basis) => b === 'regular'

export function kindContext(features: FeedFeatures, kind: PolicyKind): KindContext {
  const services = features.services.filter((s) => s.basis !== 'noDays')
  const byId = new Map(services.map((s) => [s.serviceId, s]))
  const sides = new Map(services.map((s) => [s.serviceId, sideOf(s, kind)]))
  const weekdayOnly = services.filter((s) => sides.get(s.serviceId) === 'weekdayOnly')
  const mainCandidates = weekdayOnly
    .filter((s) => s.basis === 'regular')
    .sort((a, b) => b.tripCount - a.tripCount || compareStrings(a.serviceId, b.serviceId))
  const main = mainCandidates[0] ?? null
  const assignments: KindContext['assignments'] = new Map()
  for (const r of services) {
    if (sides.get(r.serviceId) !== 'replacement') continue
    const suffix = r.name.suffix
    let candidates =
      suffix === ''
        ? []
        : weekdayOnly.filter((w) => w.name.suffix === suffix && isRegular(w.basis) === isRegular(r.basis))
    const suffixCandidates = candidates.map((c) => c.serviceId)
    if (candidates.length > 1 && main !== null) {
      const narrowed = candidates.filter((c) => c.name.head === main.name.head)
      if (narrowed.length === 1) candidates = narrowed
      else {
        assignments.set(r.serviceId, { into: null, how: 'ambiguous', suffixCandidates })
        continue
      }
    } else if (candidates.length > 1) {
      assignments.set(r.serviceId, { into: null, how: 'ambiguous', suffixCandidates })
      continue
    }
    if (candidates.length === 1) {
      assignments.set(r.serviceId, { into: candidates[0].serviceId, how: 'suffix', suffixCandidates })
    } else if (r.basis === 'regular' && main !== null) {
      assignments.set(r.serviceId, { into: main.serviceId, how: 'main', suffixCandidates })
    } else {
      assignments.set(r.serviceId, { into: null, how: 'unused', suffixCandidates })
    }
  }
  return { kind, byId, sides, weekdayOnly, mainWeekday: main?.serviceId ?? null, assignments }
}

// ---- 利用者の直し ----

/** 利用者の直し。into は replacement の行、treatment は weekdayOnly・unsupported の行(null は「既定の扱いのまま受け入れた」) */
export interface KindEdits {
  into: Map<string, string | null>
  treatment: Map<string, Treatment | null>
  /** 直しを受け付けなかった「残す」(割り当てがあるため)。問題 keptHasReplacements に出す */
  rejectedKeep: string[]
}

export type Edits = Record<PolicyKind, KindEdits>

export function emptyEdits(): Edits {
  return {
    weekdayToSaturday: { into: new Map(), treatment: new Map(), rejectedKeep: [] },
    weekdayToSundayHoliday: { into: new Map(), treatment: new Map(), rejectedKeep: [] },
  }
}

/** 今の案から、利用者の直し(印が edited の行)を取り出す */
export function editsOf(groups: ServiceGroups): Edits {
  const edits = emptyEdits()
  for (const kind of POLICY_KINDS) {
    for (const row of groups.byKind[kind].rows) {
      if (row.intoMark === 'edited') edits[kind].into.set(row.serviceId, row.into)
      if (row.basisMark === 'edited') edits[kind].treatment.set(row.serviceId, row.treatment)
    }
  }
  return edits
}

// ---- Jev の答えとの合わせ(§3.4) ----

const KIND_TO_BASIS: Record<string, Basis> = {
  regular_weekday: 'regular',
  limited_weekdays: 'partial',
  specific_dates: 'special',
}

function findResult(jev: readonly JevTargetResult[] | null, serviceId: string, role: JevTargetResult['role']) {
  return jev?.find((r) => r.serviceId === serviceId && r.role === role) ?? null
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function choiceText(choice: { choice: string; probabilities: Record<string, number>; confidence: number | null }): string {
  const p = choice.probabilities[choice.choice]
  const parts = [p === undefined ? null : `確率 ${fmt(p)}`, choice.confidence === null ? null : `確信度 ${fmt(choice.confidence)}`]
  const detail = parts.filter((x) => x !== null).join('、')
  return detail === '' ? '' : `(${detail})`
}

const BASIS_LABELS: Record<Basis, string> = {
  regular: 'ほぼ毎回',
  partial: '一部の日',
  special: '特定の日',
  noDays: '運行日なし',
}

// ---- 組み立て ----

function pct(c: number): string {
  const p = Math.round(c * 100)
  return p === 0 && c > 0 ? '1% 未満' : `${p}%`
}

function formatDate(d: string): string {
  return `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`
}

function extraDaysText(f: ServiceFeatures): string | null {
  const extra = DAY_KEYS.filter((k) => !f.runs[k] && f.coverage[k] > 0)
  if (extra.length === 0) return null
  return `ほかに一部の日・まれに走る区分:${extra.map((k) => `${DAY_LABELS[k]} ${pct(f.coverage[k])}`).join('、')}。`
}

function nearText(f: ServiceFeatures): string | null {
  if (f.nearThreshold.length === 0) return null
  return `網羅率が境目に近い区分があります(${f.nearThreshold.map((k) => `${DAY_LABELS[k]} ${pct(f.coverage[k])}`).join('、')})。`
}

function overlapText(r: ServiceFeatures, w: ServiceFeatures): string {
  const shared = r.routeIds.filter((id) => w.routeIds.includes(id)).length
  return `${r.serviceId} の系統 ${r.routeIds.length} のうち ${shared} が ${w.serviceId} にもあります。`
}

function buildKind(features: FeedFeatures, kind: PolicyKind, jev: readonly JevTargetResult[] | null, edits: KindEdits): KindGroups {
  const ctx = kindContext(features, kind)
  const { x, y } = kindDays(kind)
  const role = replacementRole(kind)
  const weekdayOnlyIds = new Set(ctx.weekdayOnly.map((w) => w.serviceId))
  const ids = [...ctx.byId.keys()].sort(compareStrings)
  const problems: GroupProblem[] = []

  // 1. replacement の行の割り当て
  const intoOf = new Map<string, { into: string | null; mark: Mark; jevText: string | null }>()
  for (const id of ids) {
    if (ctx.sides.get(id) !== 'replacement') continue
    const rule = ctx.assignments.get(id)!
    if (edits.into.has(id)) {
      intoOf.set(id, { into: edits.into.get(id)!, mark: 'edited', jevText: null })
      continue
    }
    const answer = findResult(jev, id, role)?.weekdayCounterpart
    const jevValue =
      answer === undefined ? undefined : answer.choice === 'none' ? null : weekdayOnlyIds.has(answer.choice) ? answer.choice : undefined
    if (answer === undefined || jevValue === undefined) {
      intoOf.set(id, { into: rule.into, mark: rule.how === 'ambiguous' ? 'undecided' : 'rule', jevText: null })
      continue
    }
    const high = isConfident(answer)
    const label = jevValue === null ? '「使わない」' : jevValue
    if (rule.how === 'ambiguous') {
      if (high) intoOf.set(id, { into: jevValue, mark: 'jev', jevText: `規則で決まらないため、Jev の判断 ${label}${choiceText(answer)}を使いました。` })
      else intoOf.set(id, { into: null, mark: 'undecided', jevText: `Jev は ${label} を選びましたが、確信が低いため使っていません${choiceText(answer)}。` })
    } else if (jevValue === rule.into) {
      intoOf.set(id, { into: rule.into, mark: high ? 'agreed' : 'rule', jevText: high ? `Jev も ${label} を選びました${choiceText(answer)}。` : null })
    } else {
      intoOf.set(id, {
        into: rule.into,
        mark: high ? 'conflict' : 'rule',
        jevText: high ? `Jev は ${label} を選びました${choiceText(answer)}。規則の値と食い違っています。確かめてください。` : null,
      })
    }
  }

  // 2. weekdayOnly・unsupported の行の印と扱い
  const assignedTo = (w: string) =>
    ids.filter((id) => intoOf.get(id)?.into === w).sort((a, b) => compareStrings(a, b))
  const rows: KindRow[] = []
  for (const id of ids) {
    const f = ctx.byId.get(id)!
    const side = ctx.sides.get(id)!
    const reasons: string[] = []
    let into: string | null = null
    let intoMark: Mark | null = null
    let treatment: Treatment | null = null
    let basisMark: Mark | null = null

    if (side === 'weekdayOnly' || side === 'unsupported') {
      const answer = findResult(jev, id, 'weekday')
      const kindAnswer = answer?.serviceKind
      const jevBasis = kindAnswer === undefined ? undefined : KIND_TO_BASIS[kindAnswer.choice]
      let mergedMark: Mark = 'rule'
      let jevBasisText: string | null = null
      if (kindAnswer !== undefined && jevBasis !== undefined) {
        const high = isConfident(kindAnswer)
        if (jevBasis === f.basis) {
          mergedMark = high ? 'agreed' : 'rule'
          if (high) jevBasisText = `Jev も「${BASIS_LABELS[jevBasis]}」とみました${choiceText(kindAnswer)}。`
        } else {
          mergedMark = high ? 'conflict' : 'rule'
          if (high) {
            jevBasisText = `Jev は「${BASIS_LABELS[jevBasis]}」とみました${choiceText(kindAnswer)}。規則の「${BASIS_LABELS[f.basis]}」と食い違っています。扱いは規則のまま決めています。`
          }
        }
      }
      const assigned = side === 'weekdayOnly' ? assignedTo(id) : []
      const defaultTreatment: Treatment | null =
        side === 'unsupported' ? null : assigned.length > 0 || f.basis === 'regular' ? 'erase' : 'keep'
      treatment = defaultTreatment
      basisMark = mergedMark
      if (edits.treatment.has(id)) {
        const edited = edits.treatment.get(id)!
        const usable =
          edited === null ||
          (side === 'unsupported' ? edited === 'keep' : edited === 'erase' || assigned.length === 0)
        if (usable) {
          treatment = edited ?? defaultTreatment
          basisMark = 'edited'
        }
      }

      const X = DAY_LABELS[x]
      const Y = DAY_LABELS[y]
      if (side === 'unsupported') {
        reasons.push(`平日と${Y}に走り、${X}に走りません。形2では平日の日だけ便を外せないため、そのままでは減便の方針を適用できません。`)
        if (treatment === 'keep') reasons.push('平日も走らせたまま残します。')
        else reasons.push('「残す」を選ぶと進めます。')
      } else if (treatment === 'erase' && assigned.length > 0) {
        reasons.push(`${X}の ${assigned.join('、')} の便に入れ替えます。`)
      } else if (treatment === 'erase') {
        reasons.push(`${X}に走る service が割り当たらないため、期間の間はなくします。`)
      } else if (f.basis === 'partial') {
        reasons.push(`平日の ${pct(f.coverage.weekday)} の日だけ走ります。通学など特定の需要の便とみて残します。`)
      } else if (f.basis === 'special') {
        const dates = f.runningDates === null ? '' : `:${f.runningDates.map(formatDate).join('、')}`
        reasons.push(`特定の日だけ走ります(有効期間の運行日 ${f.runningDays.total} 日${dates})。平日のダイヤのまま残します。`)
      } else {
        reasons.push('平日のダイヤのまま残します。')
      }
      if (basisMark === 'edited') reasons.push('利用者が扱いを直しました。')
      if (jevBasisText !== null) reasons.push(jevBasisText)
      const school = answer?.schoolService?.probability
      if (side === 'weekdayOnly' && school !== undefined && school >= JEV_CONFIDENCE.school) {
        reasons.push(`行き先・系統名が学校を指しているとの判断(Jev、確率 ${fmt(school)})があります。`)
      }
    } else if (side === 'replacement') {
      const rule = ctx.assignments.get(id)!
      const v = intoOf.get(id)!
      into = v.into
      intoMark = v.mark
      if (v.mark === 'edited') {
        reasons.push(into === null ? '利用者が「使わない」にしました。' : `利用者が ${into} に便を入れるようにしました。`)
      } else if (v.mark === 'jev') {
        // 文は jevText
      } else if (rule.how === 'suffix') {
        reasons.push(`接尾辞が同じ ${rule.into} に便を入れます。`)
      } else if (rule.how === 'main') {
        const w = ctx.byId.get(rule.into!)!
        reasons.push(`主の平日の service ${rule.into} に便を入れます。${overlapText(f, w)}`)
        if (routeOverlap(f, w) < THRESHOLDS.lowOverlap) reasons.push('系統の重なりが小さいため、確かめてください。')
      } else if (rule.how === 'ambiguous') {
        reasons.push(`接尾辞が同じ平日の service が ${rule.suffixCandidates.length} 個(${rule.suffixCandidates.join('、')})あり、決められません。選んでください。`)
      } else if (ctx.mainWeekday === null && f.basis === 'regular') {
        reasons.push('ほぼ毎回走る平日だけの service がないため、平日には加えません。')
      } else {
        reasons.push('一部の日・特定の日だけ走る service のため、平日には加えません。')
      }
      if (v.jevText !== null) reasons.push(v.jevText)
    } else if (side === 'both') {
      reasons.push(`平日にも${DAY_LABELS[x]}にも走るため、手を付けません。`)
    } else {
      reasons.push(`平日にも${DAY_LABELS[x]}にも走らないため、関係しません。`)
    }
    const extra = extraDaysText(f)
    if (extra !== null) reasons.push(extra)
    const near = nearText(f)
    if (near !== null) reasons.push(near)
    rows.push({ serviceId: id, side, into, intoMark, treatment, basisMark, reasons })
  }

  // 3. 問題
  const unsupported = rows.filter((r) => r.side === 'unsupported' && r.treatment === null).map((r) => r.serviceId)
  if (unsupported.length > 0) {
    problems.push({
      severity: 'error',
      code: 'unsupportedService',
      serviceIds: unsupported,
      message: `形2で表せない service が ${unsupported.length} つあります(${unsupported.join('、')})。平日と${DAY_LABELS[y]}に走り、${DAY_LABELS[x]}に走りません。「残す」を選ぶと進めます。`,
    })
  }
  const undecided = rows.filter((r) => r.intoMark === 'undecided').map((r) => r.serviceId)
  if (undecided.length > 0) {
    problems.push({
      severity: 'error',
      code: 'undecidedReplacement',
      serviceIds: undecided,
      message: `便を入れる平日の service が決まらない service があります(${undecided.join('、')})。選んでください。`,
    })
  }
  const rejected = edits.rejectedKeep.filter((id) => ctx.sides.get(id) === 'weekdayOnly')
  if (rejected.length > 0) {
    problems.push({
      severity: 'error',
      code: 'keptHasReplacements',
      serviceIds: rejected,
      message: `入れ替えに使う service が割り当たっているため、残せません(${rejected.join('、')})。先に割り当てを外してください。`,
    })
  }
  const weekdayRows = rows.filter((r) => r.side === 'weekdayOnly')
  if (weekdayRows.length === 0) {
    problems.push({
      severity: 'info',
      code: 'nothingToChange',
      serviceIds: [],
      message: `平日と${DAY_LABELS[x]}で同じダイヤのため、入れ替える便がありません。`,
    })
  } else if (weekdayRows.every((r) => r.treatment === 'keep')) {
    problems.push({
      severity: 'info',
      code: 'nothingToChange',
      serviceIds: weekdayRows.map((r) => r.serviceId),
      message: '平日だけの service をすべて残すため、入れ替える便がありません。',
    })
  }
  const low = rows
    .filter((r) => {
      if (r.side !== 'replacement' || r.into === null || r.intoMark === 'edited') return false
      if (ctx.assignments.get(r.serviceId)!.how !== 'main' || r.into !== ctx.mainWeekday) return false
      return routeOverlap(ctx.byId.get(r.serviceId)!, ctx.byId.get(r.into)!) < THRESHOLDS.lowOverlap
    })
    .map((r) => r.serviceId)
  if (low.length > 0) {
    problems.push({
      severity: 'warning',
      code: 'lowRouteOverlap',
      serviceIds: low,
      message: `主の平日の service ${ctx.mainWeekday} に入れた service のうち、系統の重なりが小さいものがあります(${low.join('、')})。確かめてください。`,
    })
  }

  return { kind, mainWeekday: ctx.mainWeekday, rows, problems }
}

/** 判断材料・Jev の答え・利用者の直しから、方針の種類ごとの案を組み立てる */
export function buildByKind(
  features: FeedFeatures,
  jev: readonly JevTargetResult[] | null,
  edits: Edits,
): Record<PolicyKind, KindGroups> {
  return {
    weekdayToSaturday: buildKind(features, 'weekdayToSaturday', jev, edits.weekdayToSaturday),
    weekdayToSundayHoliday: buildKind(features, 'weekdayToSundayHoliday', jev, edits.weekdayToSundayHoliday),
  }
}

/** 単純な GTFS(§2.7)。規則の案で判定する */
export function isSimple(features: FeedFeatures, proposal: Record<PolicyKind, KindGroups>): boolean {
  const byId = new Map(features.services.map((s) => [s.serviceId, s]))
  return POLICY_KINDS.every((kind) => {
    const rows = proposal[kind].rows
    const weekdayOnly = rows.filter((r) => r.side === 'weekdayOnly')
    if (weekdayOnly.length > 1) return false
    if (weekdayOnly.length === 1 && byId.get(weekdayOnly[0].serviceId)!.basis !== 'regular') return false
    const assigned = rows.filter((r) => r.side === 'replacement' && r.into !== null)
    if (assigned.length > 1) return false
    if (assigned.some((r) => byId.get(r.serviceId)!.basis !== 'regular')) return false
    if (rows.some((r) => r.intoMark === 'undecided')) return false
    return !rows.some((r) => r.side === 'unsupported')
  })
}

/** 規則だけの案(Jev の答えも利用者の直しも無い) */
export function proposeGroups(features: FeedFeatures): ServiceGroups {
  const proposal = buildByKind(features, null, emptyEdits())
  return { features, simple: isSimple(features, proposal), byKind: proposal, proposal, jev: null }
}
