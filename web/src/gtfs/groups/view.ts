/**
 * グループ分けを、減便の方針の手順・AI のツール・[画面の状態] の行で使う形にする(docs/design-service-groups.md §5.2・§5.3)。
 *
 * - groupedPolicyServices:画面と AI が「ダイヤ単位で選ぶ」かを決める。単純な GTFS で1組の形で足りる(道北バス)なら null
 *   (今の service の選び方のまま)。単純でない GTFS で確定していなければ unconfirmed
 * - groupSettings:policyServicesFor の値から PolicySettings を作る(notApplied は入れない)
 */
import type { Period, PolicyKind, PolicySettings, ServicePair } from '../edit/ops'
import { indexFeedServiceDays, runsAnyDay } from '../edit/services'
import type { GtfsFeed } from '../load'
import { policyServicesFor } from './policy'
import type { GroupProblem, PolicyServices, ServiceGroups } from './types'

/** 方針の種類ごとの、減便の方針に入れる service(notApplied を除いた値)。作れなければ error */
export type GroupChoice = Omit<PolicyServices, 'notApplied'> | { error: GroupProblem[] }

export type GroupedPolicyServices =
  | { status: 'unconfirmed' }
  | { status: 'confirmed'; byKind: Record<PolicyKind, GroupChoice> }

export const POLICY_KINDS: readonly PolicyKind[] = ['weekdayToSaturday', 'weekdayToSundayHoliday']

function choiceOf(groups: ServiceGroups, kind: PolicyKind): GroupChoice {
  const r = policyServicesFor(groups, kind)
  if ('error' in r) return r
  const out: Omit<PolicyServices, 'notApplied'> = { kind: r.kind, weekdayService: r.weekdayService, replacementService: r.replacementService }
  if (r.pairs !== undefined) {
    out.pairs = r.pairs.map((p) => ({ weekday: p.weekday, replacements: [...p.replacements] }))
    out.keptWeekdayServices = [...(r.keptWeekdayServices ?? [])]
  }
  return out
}

/**
 * グループ分けから、方針の種類ごとの service を作る。
 * - グループ分けが無い(祝日一覧を待っている間など)なら null
 * - 単純な GTFS:どちらの種類も1組の形(pairs 無し)で足りるなら null(今の選び方のまま)。
 *   組の表が要る(入れ替えに使う service が無い名士バス・羽幌町)ときだけ confirmed(単純な GTFS は読み込んだ時点で確定)
 * - 単純でない GTFS:確定していれば confirmed、していなければ unconfirmed
 */
export function groupedPolicyServices(groups: ServiceGroups | null, confirmed: boolean): GroupedPolicyServices | null {
  if (!groups) return null
  if (!groups.simple && !confirmed) return { status: 'unconfirmed' }
  const byKind = {
    weekdayToSaturday: choiceOf(groups, 'weekdayToSaturday'),
    weekdayToSundayHoliday: choiceOf(groups, 'weekdayToSundayHoliday'),
  }
  if (groups.simple && !POLICY_KINDS.some((k) => !('error' in byKind[k]) && (byKind[k] as PolicyServices).pairs !== undefined)) return null
  return { status: 'confirmed', byKind }
}

/** 組の表(pairs が無ければ1組) */
export function choicePairs(choice: Omit<PolicyServices, 'notApplied'>): ServicePair[] {
  if (choice.pairs !== undefined) return choice.pairs
  return [{ weekday: choice.weekdayService, replacements: choice.replacementService === '' ? [] : [choice.replacementService] }]
}

/** グループ分けの値から、減便の方針(PolicySettings)を作る。期間と除外する系統は画面(または AI のツール)の値 */
export function groupSettings(choice: Omit<PolicyServices, 'notApplied'>, period: Period, excludedRoutes: string[]): PolicySettings {
  const settings: PolicySettings = {
    kind: choice.kind,
    weekdayService: choice.weekdayService,
    replacementService: choice.replacementService,
    period,
    excludedRoutes,
  }
  if (choice.pairs !== undefined) {
    settings.pairs = choice.pairs.map((p) => ({ weekday: p.weekday, replacements: [...p.replacements] }))
    settings.keptWeekdayServices = [...(choice.keptWeekdayServices ?? [])]
  }
  return settings
}

/** 組の表を、入れ替える組(入れ替えに使う service がある)・なくす service・残す service に分ける */
export function splitPairs(settings: Pick<PolicySettings, 'weekdayService' | 'replacementService' | 'pairs' | 'keptWeekdayServices'>): {
  replaced: ServicePair[]
  erased: string[]
  kept: string[]
} {
  const pairs =
    settings.pairs ?? [{ weekday: settings.weekdayService, replacements: settings.replacementService === '' ? [] : [settings.replacementService] }]
  return {
    replaced: pairs.filter((p) => p.replacements.length > 0),
    erased: pairs.filter((p) => p.replacements.length === 0).map((p) => p.weekday),
    kept: settings.pairs !== undefined ? [...(settings.keptWeekdayServices ?? [])] : [],
  }
}

/**
 * 減便の期間に走らないため組ごと除く平日の service(承認の前に、組の内訳と文の数をそろえるため)。
 * checkPolicy の pairWeekdayNotActive と同じ規則:主でない組(2つ目から)の平日の service で、便があり、
 * 新しい有効期間(validity)に1日も走らないもの。pairs が無い・期間が決まらなければ空
 */
export function droppedPairWeekdays(
  feed: GtfsFeed,
  settings: Pick<PolicySettings, 'pairs'>,
  validity: { start: string; end: string } | null,
): Set<string> {
  const out = new Set<string>()
  if (!validity || settings.pairs === undefined || settings.pairs.length < 2) return out
  const withTrips = new Set((feed.tables.get('trips')?.rows ?? []).map((t) => (t.service_id ?? '').trim()))
  const index = indexFeedServiceDays(feed)
  settings.pairs.slice(1).forEach((p) => {
    const w = p.weekday.trim()
    if (withTrips.has(w) && !runsAnyDay(index.get(w), validity.start, validity.end)) out.add(w)
  })
  return out
}

/**
 * 減便の文と選択肢に出す service(groupSentence と同じ数え方)。期間に走らないため除く組(dropped)を引き、
 * 入れ替える組があればその平日の service と入れ替えに使う service、無ければなくす平日の service だけ
 */
export function sentenceServices(
  settings: Pick<PolicySettings, 'weekdayService' | 'replacementService' | 'pairs' | 'keptWeekdayServices'>,
  dropped: ReadonlySet<string> = new Set(),
): { weekdays: string[]; replacements: string[]; erased: string[]; replaced: ServicePair[] } {
  const split = splitPairs(settings)
  const replaced = split.replaced.filter((p) => !dropped.has(p.weekday))
  const erased = split.erased.filter((w) => !dropped.has(w))
  if (replaced.length === 0) return { weekdays: erased, replacements: [], erased, replaced }
  return { weekdays: replaced.map((p) => p.weekday), replacements: replaced.flatMap((p) => p.replacements), erased, replaced }
}
