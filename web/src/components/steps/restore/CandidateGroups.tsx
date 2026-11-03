import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { DirectionGroup, RouteGroup } from './grouping'
import { TripLine } from './TripLine'

/** 方向の見出しに添える、編集後の便の様子 */
function editedText(dir: DirectionGroup): string | null {
  const edited = dir.edited
  if (edited === undefined) return null
  if (edited === null) return '編集後はこの方向の便がありません'
  if (edited.maxGapMin === null) return `編集後は ${edited.trips.length} 便`
  return `編集後の最大間隔 ${edited.maxGapMin} 分`
}

/** 編集後に残る(入る)便の始発の時刻を並べた文 */
function editedTimes(dir: DirectionGroup): string | null {
  if (!dir.edited || dir.edited.trips.length === 0) return null
  return dir.edited.trips.map((t) => t.departure ?? '時刻なし').join('・')
}

/**
 * 足し戻しの候補を、系統ごとに折りたたんで出す(docs/tasks-1103.md の指摘5)。
 * 系統を開くと方向ごとに時刻の順に並べ、編集後の最大間隔を添える。最初は手がかりのある便だけを出し、
 * 残りは「ほかの便を見る」で開く。並べ方は grouping.ts のとおり
 */
export function CandidateGroups({
  groups,
  isOpen,
  onToggle,
  showsAll,
  onShowAll,
  selected,
  onSelect,
  aiIds,
}: {
  groups: readonly RouteGroup[]
  isOpen: (routeId: string) => boolean
  onToggle: (routeId: string) => void
  showsAll: (routeId: string) => boolean
  onShowAll: (routeId: string) => void
  selected: ReadonlySet<string>
  onSelect: (tripId: string, checked: boolean) => void
  /** AI のおすすめに入っている便 */
  aiIds: ReadonlySet<string>
}) {
  if (groups.length === 0) return <p className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">当てはまる便がありません。</p>
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="足し戻す便の候補">
      {groups.map((g, i) => {
        const open = isOpen(g.routeId)
        const all = showsAll(g.routeId)
        const picked = g.candidates.filter((c) => selected.has(c.trip.tripId)).length
        const hidden = g.candidates.length - g.hinted
        const panelId = `restore-route-${i}`
        return (
          <section key={g.routeId} className="rounded-md border text-xs" aria-label={`系統 ${g.routeName}`}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-muted/50"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => onToggle(g.routeId)}
            >
              <span aria-hidden="true" className="w-3 text-muted-foreground">
                {open ? '▾' : '▸'}
              </span>
              <span className="font-medium">{g.routeName}</span>
              {g.vanishes && (
                <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                  全曜日で便がなくなる
                </Badge>
              )}
              <span className="text-muted-foreground">
                消える {g.candidates.length} 便(手がかりあり {g.hinted} 便)
              </span>
              {picked > 0 && <span className="font-medium text-primary">選択 {picked} 便</span>}
            </button>
            {open && (
              <div id={panelId} className="flex flex-col gap-2 border-t px-2 py-1.5">
                {g.directions.map((dir) => {
                  const trips = all ? dir.trips : dir.trips.filter((c) => c.detail.hints.length > 0)
                  if (trips.length === 0) return null
                  const gap = editedText(dir)
                  const times = editedTimes(dir)
                  const name = `${dir.firstStopName} → ${dir.lastStopName}`
                  return (
                    <div key={dir.key} className="flex flex-col gap-1">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{name}</span>
                        {gap && <span className="text-muted-foreground">{gap}</span>}
                      </p>
                      {times && <p className="break-words text-[10px] text-muted-foreground">編集後の便:{times}</p>}
                      <ul className="flex flex-col divide-y rounded-md border" aria-label={`${g.routeName} ${name} の候補`}>
                        {trips.map((c) => (
                          <li key={c.trip.tripId} className="px-2 py-1">
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                className="mt-0.5 size-4 shrink-0 accent-primary"
                                checked={selected.has(c.trip.tripId)}
                                onChange={(e) => onSelect(c.trip.tripId, e.target.checked)}
                                aria-label={`${c.trip.firstDeparture ?? '時刻なし'} ${c.trip.routeName} ${c.trip.tripId} を選ぶ`}
                              />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <TripLine trip={c.trip} hints={c.detail.hints} lostCells={c.detail.lostCells} showRoute={false} />
                                {aiIds.has(c.trip.tripId) && <span className="text-[10px] font-medium text-primary">AI のおすすめ</span>}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
                {g.hinted === 0 && !all && <p className="text-muted-foreground">手がかりのある便はありません。</p>}
                {hidden > 0 && !all && (
                  <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onShowAll(g.routeId)}>
                    ほかの便を見る(残り {hidden} 便)
                  </Button>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
