import type { WeekdayDiff } from '@/gtfs/edit/diff'
import type { GtfsFeed } from '@/gtfs/load'

export interface RouteStat {
  routeId: string
  name: string
  weekday: number
  replacement: number
}

/** 平日便のある系統ごとの、平日の便数と写す元の便数。写す元の便数が 0 の系統を先に、あとは route_id の順 */
export function routeTripCounts(feed: GtfsFeed, weekday: string | null, replacement: string | null): RouteStat[] {
  if (!weekday) return []
  const names = new Map<string, string>()
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = r.route_id?.trim() ?? ''
    if (id !== '' && !names.has(id)) names.set(id, r.route_short_name?.trim() || r.route_long_name?.trim() || id)
  }
  const stats = new Map<string, RouteStat>()
  for (const t of feed.tables.get('trips')?.rows ?? []) {
    const sid = t.service_id?.trim() ?? ''
    const routeId = t.route_id?.trim() ?? ''
    if (sid !== weekday && sid !== replacement) continue
    let s = stats.get(routeId)
    if (!s) stats.set(routeId, (s = { routeId, name: names.get(routeId) ?? routeId, weekday: 0, replacement: 0 }))
    if (sid === weekday) s.weekday++
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
