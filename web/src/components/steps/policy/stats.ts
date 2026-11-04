import type { WeekdayDiff } from '@/gtfs/edit/diff'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { sameTimetable } from '@/gtfs/edit/services'
import { choicePairs, type GroupChoice } from '@/gtfs/groups/view'
import type { GtfsFeed } from '@/gtfs/load'

export interface RouteStat {
  routeId: string
  name: string
  weekday: number
  replacement: number
}

/**
 * 平日便のある系統ごとの、平日の便数と写す元の便数。写す元の便数が 0 の系統を先に、あとは route_id の順。
 * 平日・写す元は1つの service か、service の並び(グループ分けの組の平日の service・入れ替えに使う service)
 */
export function routeTripCounts(
  feed: GtfsFeed,
  weekdayServices: string | readonly string[] | null,
  replacementServices: string | readonly string[] | null,
): RouteStat[] {
  const toSet = (v: string | readonly string[] | null) => new Set(v === null ? [] : typeof v === 'string' ? [v] : v)
  const weekdays = toSet(weekdayServices)
  const replacements = toSet(replacementServices)
  if (weekdays.size === 0) return []
  const names = new Map<string, string>()
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = r.route_id?.trim() ?? ''
    if (id !== '' && !names.has(id)) names.set(id, r.route_short_name?.trim() || r.route_long_name?.trim() || id)
  }
  const stats = new Map<string, RouteStat>()
  for (const t of feed.tables.get('trips')?.rows ?? []) {
    const sid = t.service_id?.trim() ?? ''
    const routeId = t.route_id?.trim() ?? ''
    if (!weekdays.has(sid) && !replacements.has(sid)) continue
    let s = stats.get(routeId)
    if (!s) stats.set(routeId, (s = { routeId, name: names.get(routeId) ?? routeId, weekday: 0, replacement: 0 }))
    if (weekdays.has(sid)) s.weekday++
    else s.replacement++
  }
  return [...stats.values()]
    .filter((s) => s.weekday > 0)
    .sort((a, b) => (a.replacement === 0) !== (b.replacement === 0) ? (a.replacement === 0 ? -1 : 1) : a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0)
}

export function totals(diff: WeekdayDiff): { before: number; after: number } {
  let before = 0
  let after = 0
  for (const r of diff.byRoute) {
    before += r.before
    after += r.after
  }
  return { before, after }
}

/**
 * 土曜に変えても日祝に変えても同じ結果になるか(すべての組で同じとき。docs/design-service-groups.md §5.2)。
 * 両方の組の平日の service が同じ並びで、入れ替えに使う service が組ごとに同じか同じ時刻表
 */
export function sameGroupTimetable(feed: GtfsFeed, byKind: Record<PolicyKind, GroupChoice>): boolean {
  const sat = byKind.weekdayToSaturday
  const sun = byKind.weekdayToSundayHoliday
  if ('error' in sat || 'error' in sun) return false
  const a = choicePairs(sat)
  const b = choicePairs(sun)
  if (a.length !== b.length) return false
  let differs = false
  for (let i = 0; i < a.length; i++) {
    if (a[i].weekday !== b[i].weekday || a[i].replacements.length !== b[i].replacements.length) return false
    for (let j = 0; j < a[i].replacements.length; j++) {
      const x = a[i].replacements[j]
      const y = b[i].replacements[j]
      if (x === y) continue
      if (!sameTimetable(feed, x, y)) return false
      differs = true
    }
  }
  // 同じ service だけで入れ替えるとき(土日祝の service)は、今の文と同じく出さない
  return differs
}
