/**
 * Jev に問う判断材料の組み立て(docs/design-service-groups.md §3.3・§7.3 の 8)。サーバーの中継(B)の上限に、送る前に収める。
 *
 * - target:平日だけの側(weekdayOnly・unsupported。方針の種類をまたいで1つ)を role weekday で、
 *   割り当てが決まった、または決まらない入れ替えに使う service を role saturday・sundayHoliday で問う。
 *   規則で「使わない」とした service(一部の日・特定の日だけ走るもの)は問わない
 * - 候補:その kind の平日だけの service。接尾辞の合うもの → 主の平日の service → 系統の重なりの大きい順(同じなら便の多い順)に 5 つまで
 * - 上限を超えたら、target を「境目に近いもの → 規則で決まらないもの → 便の多い順」で選び、残りを omitted に入れる
 * - GTFS のファイル・停留所・時刻表そのものは入れない。service ごとの集計だけ
 */
import { compareStrings } from '../edit/signature'
import { routeOverlap } from './features'
import { kindContext, replacementRole, type KindContext } from './rules'
import {
  POLICY_KINDS,
  type FeedFeatures,
  type JevJudgeRequest,
  type JevRole,
  type JevServiceWire,
  type JevTargetWire,
  type ServiceFeatures,
  type ServiceGroups,
} from './types'

/** サーバーの上限(§3.3)。本文はサーバーの 256 KB より少し小さくして余裕を持つ */
export const JEV_LIMITS = {
  services: 60,
  targets: 40,
  candidates: 5,
  routes: 20,
  headsigns: 5,
  idLength: 100,
  textLength: 100,
  agencyLength: 200,
  maxNumber: 1_000_000,
  bodyBytes: 250 * 1024,
} as const

function cut(s: string, n: number): string {
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n).join('')
}

function lengthOf(s: string): number {
  return [...s].length
}

function num(n: number): number {
  return Math.min(JEV_LIMITS.maxNumber, Math.max(0, Math.round(n)))
}

function ratio(n: number): number {
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

export function toWire(f: ServiceFeatures): JevServiceWire {
  return {
    serviceId: f.serviceId,
    tripCount: num(f.tripCount),
    routeCount: num(f.routeCount),
    runningDays: {
      weekday: num(f.runningDays.weekday),
      saturday: num(f.runningDays.saturday),
      sundayHoliday: num(f.runningDays.sundayHoliday),
      total: num(f.runningDays.total),
    },
    coverage: {
      weekday: ratio(f.coverage.weekday),
      saturday: ratio(f.coverage.saturday),
      sundayHoliday: ratio(f.coverage.sundayHoliday),
    },
    firstDeparture: f.firstDeparture,
    lastArrival: f.lastArrival,
    routes: f.routes.slice(0, JEV_LIMITS.routes).map((r) => ({ name: cut(r.name, JEV_LIMITS.textLength), trips: num(r.trips) })),
    headsigns: f.headsigns.slice(0, JEV_LIMITS.headsigns).map((h) => cut(h, JEV_LIMITS.textLength)),
    runningDates: f.runningDates === null ? null : [...f.runningDates],
  }
}

interface Candidate {
  target: JevTargetWire
  /** 並べ替えの材料 */
  near: boolean
  undecided: boolean
  trips: number
  /** target と候補の service_id */
  ids: string[]
}

const ROLE_ORDER: Record<JevRole, number> = { weekday: 0, saturday: 1, sundayHoliday: 2 }

function candidatesFor(ctx: KindContext, r: ServiceFeatures): { serviceId: string; routeOverlap: number }[] {
  const main = ctx.mainWeekday
  const rank = (w: ServiceFeatures) => (r.name.suffix !== '' && w.name.suffix === r.name.suffix ? 0 : w.serviceId === main ? 1 : 2)
  return ctx.weekdayOnly
    .filter((w) => lengthOf(w.serviceId) <= JEV_LIMITS.idLength)
    .map((w) => ({ w, overlap: routeOverlap(r, w) }))
    .sort(
      (a, b) =>
        rank(a.w) - rank(b.w) ||
        b.overlap - a.overlap ||
        b.w.tripCount - a.w.tripCount ||
        compareStrings(a.w.serviceId, b.w.serviceId),
    )
    .slice(0, JEV_LIMITS.candidates)
    .map(({ w, overlap }) => ({ serviceId: w.serviceId, routeOverlap: ratio(overlap) }))
}

function bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length
}

/**
 * Jev に送る判断材料。単純な GTFS、有効期間を決められない GTFS、問う target が無いときは null。
 * omitted は上限のために問わなかった target の service_id(重ねず、昇順。同じ service をほかの役割では問うていることがある)
 */
export function buildJevRequest(
  features: FeedFeatures,
  groups: ServiceGroups,
): { request: JevJudgeRequest; omitted: string[] } | null {
  if (groups.simple) return null
  if (features.validity.start === '' || features.validity.end === '') return null
  const byId = new Map(features.services.map((s) => [s.serviceId, s]))
  const all: Candidate[] = []
  const tooLong: string[] = []

  // 平日だけの側(方針の種類をまたいで1つ)
  const weekdaySide = new Set<string>()
  for (const kind of POLICY_KINDS) {
    for (const row of groups.proposal[kind].rows) {
      if (row.side === 'weekdayOnly' || row.side === 'unsupported') weekdaySide.add(row.serviceId)
    }
  }
  for (const id of [...weekdaySide].sort(compareStrings)) {
    const f = byId.get(id)!
    if (lengthOf(id) > JEV_LIMITS.idLength) {
      tooLong.push(id)
      continue
    }
    all.push({ target: { serviceId: id, role: 'weekday', candidates: [] }, near: f.nearThreshold.length > 0, undecided: false, trips: f.tripCount, ids: [id] })
  }

  // 入れ替えに使う側
  for (const kind of POLICY_KINDS) {
    const role = replacementRole(kind)
    const ctx = kindContext(features, kind)
    for (const row of groups.proposal[kind].rows) {
      if (row.side !== 'replacement') continue
      if (row.into === null && row.intoMark !== 'undecided') continue
      const f = byId.get(row.serviceId)!
      if (lengthOf(row.serviceId) > JEV_LIMITS.idLength) {
        tooLong.push(row.serviceId)
        continue
      }
      const candidates = candidatesFor(ctx, f)
      if (candidates.length === 0) continue
      all.push({
        target: { serviceId: row.serviceId, role, candidates },
        near: f.nearThreshold.length > 0,
        undecided: row.intoMark === 'undecided',
        trips: f.tripCount,
        ids: [row.serviceId, ...candidates.map((c) => c.serviceId)],
      })
    }
  }
  if (all.length === 0) return null

  all.sort(
    (a, b) =>
      Number(b.near) - Number(a.near) ||
      Number(b.undecided) - Number(a.undecided) ||
      b.trips - a.trips ||
      compareStrings(a.target.serviceId, b.target.serviceId) ||
      ROLE_ORDER[a.target.role] - ROLE_ORDER[b.target.role],
  )

  const chosen: Candidate[] = []
  const omitted = new Set<string>(tooLong)
  const serviceIds = new Set<string>()
  for (const c of all) {
    const added = c.ids.filter((id) => !serviceIds.has(id))
    if (chosen.length >= JEV_LIMITS.targets || serviceIds.size + added.length > JEV_LIMITS.services) {
      omitted.add(c.target.serviceId)
      continue
    }
    chosen.push(c)
    for (const id of added) serviceIds.add(id)
  }

  const make = (list: Candidate[]): JevJudgeRequest => {
    const ids = new Set(list.flatMap((c) => c.ids))
    return {
      feed: {
        agency: features.agency === null ? null : cut(features.agency, JEV_LIMITS.agencyLength),
        period: { ...features.validity },
        daysInPeriod: { ...features.daysInPeriod },
      },
      services: [...ids].sort(compareStrings).map((id) => toWire(byId.get(id)!)),
      targets: list.map((c) => c.target),
    }
  }

  let request = make(chosen)
  while (chosen.length > 0 && bytes(request) > JEV_LIMITS.bodyBytes) {
    omitted.add(chosen.pop()!.target.serviceId)
    request = make(chosen)
  }
  if (chosen.length === 0) return null
  return { request, omitted: [...omitted].sort(compareStrings) }
}
