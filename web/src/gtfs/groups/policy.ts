/**
 * グループ分けから、減便の方針(PolicySettings)に入れる service の値を作る(docs/design-service-groups.md §4.1・§5.2・§7.1・§7.5)。
 *
 * - 組:扱いが erase の平日だけの service ごとに1組。replacements はその service に割り当てた入れ替えに使う service
 *   (無ければ「なくす」)。残す service(weekdayOnly・unsupported の keep)は keptWeekdayServices
 * - 主の組:主の平日の service(mainWeekday)。それが erase でなければ、erase の組のうち便が一番多いもの(同数は service_id の昇順)
 * - 主の入れ替えに使う service:主の組の replacements のうち、basis が regular で便が一番多いもの。regular が無ければ便が一番多いもの
 * - 並び:主の組が先頭、あとは weekday の昇順。replacements は主の入れ替えに使う service が先頭、あとは昇順
 * - 1組・1つの入れ替えに使う service・残すもの無しなら pairs を入れない(今の1組の形。道北バスは今と同じ)
 * - multiService: false(第2段を外したとき):主の組の平日の service と主の入れ替えに使う service だけを pairs 無しで返し、
 *   ほかを notApplied に入れる
 */
import type { PolicyKind } from '../edit/ops'
import { compareStrings } from '../edit/signature'
import type { GroupProblem, PolicyServices, ServiceGroups, ServicePairValue } from './types'

export function policyServicesFor(
  groups: ServiceGroups,
  kind: PolicyKind,
  opts: { multiService?: boolean } = {},
): PolicyServices | { error: GroupProblem[] } {
  const multiService = opts.multiService ?? true
  const kg = groups.byKind[kind]
  const errors = kg.problems.filter((p) => p.severity === 'error')
  if (errors.length > 0) return { error: errors }

  const byId = new Map(groups.features.services.map((s) => [s.serviceId, s]))
  const trips = (id: string) => byId.get(id)?.tripCount ?? 0
  const regular = (id: string) => byId.get(id)?.basis === 'regular'
  const byTrips = (a: string, b: string) => trips(b) - trips(a) || compareStrings(a, b)

  const erased = kg.rows.filter((r) => r.side === 'weekdayOnly' && r.treatment === 'erase').map((r) => r.serviceId)
  const kept = kg.rows
    .filter((r) => (r.side === 'weekdayOnly' || r.side === 'unsupported') && r.treatment === 'keep')
    .map((r) => r.serviceId)
    .sort(compareStrings)
  if (erased.length === 0) {
    const nothing = kg.problems.filter((p) => p.code === 'nothingToChange')
    return {
      error:
        nothing.length > 0
          ? nothing
          : [{ severity: 'error', code: 'nothingToChange', serviceIds: [], message: '入れ替える便がありません。' }],
    }
  }

  const replacementsOf = new Map<string, string[]>(erased.map((w) => [w, []]))
  const seen = new Set<string>()
  for (const r of kg.rows) {
    if (r.side !== 'replacement' || r.into === null) continue
    const list = replacementsOf.get(r.into)
    // 割り当て先が erase でない(残す)ことは組み立てで起きないが、念のため組に入れない
    if (!list || seen.has(r.serviceId)) continue
    seen.add(r.serviceId)
    list.push(r.serviceId)
  }

  const main =
    kg.mainWeekday !== null && replacementsOf.has(kg.mainWeekday) ? kg.mainWeekday : [...erased].sort(byTrips)[0]
  const order = (ws: string[]): string[] => {
    if (ws.length === 0) return ws
    const regs = ws.filter(regular)
    const head = [...(regs.length > 0 ? regs : ws)].sort(byTrips)[0]
    return [head, ...ws.filter((w) => w !== head).sort(compareStrings)]
  }
  const pairs: ServicePairValue[] = [main, ...erased.filter((w) => w !== main).sort(compareStrings)].map((weekday) => ({
    weekday,
    replacements: order(replacementsOf.get(weekday)!),
  }))
  const mainPair = pairs[0]

  if (!multiService) {
    if (mainPair.replacements.length === 0) {
      return {
        error: [
          {
            severity: 'error',
            code: 'mainPairWithoutReplacement',
            serviceIds: [mainPair.weekday],
            message: `${mainPair.weekday} には入れ替えに使う service がないため、この版では減便の方針を適用できません。`,
          },
        ],
      }
    }
    const notApplied: ServicePairValue[] = []
    if (mainPair.replacements.length > 1) notApplied.push({ weekday: mainPair.weekday, replacements: mainPair.replacements.slice(1) })
    notApplied.push(...pairs.slice(1))
    notApplied.push(...kept.map((weekday) => ({ weekday, replacements: [] })))
    return {
      kind,
      weekdayService: mainPair.weekday,
      replacementService: mainPair.replacements[0],
      notApplied,
    }
  }

  const replacementService = mainPair.replacements[0] ?? ''
  if (pairs.length === 1 && mainPair.replacements.length === 1 && kept.length === 0) {
    return { kind, weekdayService: mainPair.weekday, replacementService }
  }
  return { kind, weekdayService: mainPair.weekday, replacementService, pairs, keptWeekdayServices: kept }
}
