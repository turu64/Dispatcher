import { Badge } from '@/components/ui/badge'
import type { TripBrief } from '@/gtfs/edit/diff'
import { RESTORE_HINT_LABELS, type RestoreHint, type RestoreHintDetail } from '@/gtfs/edit/restore'
import { lostCellsText } from '../editText'

/** 便の1行(始発時刻、系統、始発 → 終着、行き先、trip_id、手がかり) */
export function TripLine({
  trip,
  hints,
  lostCells,
  showRoute = true,
}: {
  trip: TripBrief
  hints?: readonly RestoreHint[]
  /** 外れた場所が戻る手がかりの、戻るセルの数と推計人口 */
  lostCells?: RestoreHintDetail['lostCells']
  /** 系統の名前を出すか(系統のまとまりの中では、見出しにあるので出さない) */
  showRoute?: boolean
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words">
        <span className="font-medium tabular-nums">{trip.firstDeparture ?? '—'}</span> {showRoute && `${trip.routeName}:`}
        {trip.firstStopName} → {trip.lastStopName}
        {trip.headsign && `(${trip.headsign})`}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {trip.tripId}
        {trip.feed === 'base' ? '(減便前)' : '(減便後)'}
      </span>
      {hints && hints.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {hints.map((h) => (
            <Badge key={h} variant="secondary" className="px-1 py-0 text-[10px]">
              {h === 'restoresLostCells' && lostCells ? lostCellsText(lostCells) : RESTORE_HINT_LABELS[h]}
            </Badge>
          ))}
        </span>
      )}
    </span>
  )
}
