import { Badge } from '@/components/ui/badge'
import { startBandOf, type TripBrief } from '@/gtfs/edit/diff'
import { RESTORE_HINT_LABELS, type RestoreHint, type RestoreHintDetail } from '@/gtfs/edit/restore'
import { lostCellsText } from '../editText'

/**
 * 判断材料の札の文。「時間帯の便がなくなる」には始発の時間帯(3時間ごと。例「6〜9時」)を添える。時間帯は判定(restore.ts)と同じ
 * startBandOf で始発の時刻から決めるので、RestoreHintDetail.band.label と等しい。「到達圏が戻る」には区画の数と推計人口を添える
 */
function hintLabel(trip: TripBrief, hint: RestoreHint, lostCells: RestoreHintDetail['lostCells'] | undefined): string {
  if (hint === 'restoresLostCells' && lostCells) return lostCellsText(lostCells)
  if (hint === 'onlyTripInBand') return `${RESTORE_HINT_LABELS.onlyTripInBand}(${startBandOf(trip.firstSeconds)})`
  return RESTORE_HINT_LABELS[hint]
}

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
              {hintLabel(trip, h, lostCells)}
            </Badge>
          ))}
        </span>
      )}
    </span>
  )
}
