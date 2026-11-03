import { Button } from '@/components/ui/button'
import type { AddBackItem } from '@/gtfs/edit/ops'
import type { Candidate } from './grouping'
import { TripLine } from './TripLine'

/**
 * 「AI に候補を聞く」の結果(Claude の足し戻しの下書き)にある便を、一覧の先頭にまとめて出す(指摘5)。
 * 下書きを承認するかやめると消える。ここで選んだ便は、系統の一覧で選んだ便と同じ扱い
 */
export function AiPicks({
  picks,
  selected,
  onSelect,
}: {
  /** 候補にある便と、Claude の下書きの項目(時刻の順) */
  picks: readonly { candidate: Candidate; item: AddBackItem }[]
  selected: ReadonlySet<string>
  onSelect: (tripId: string, checked: boolean) => void
}) {
  if (picks.length === 0) return null
  return (
    <section className="flex flex-col gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs" aria-label="AI のおすすめ">
      <h3 className="font-medium">AI のおすすめ({picks.length} 便)</h3>
      <p className="text-muted-foreground">
        AI の下書きにある便です。下書きをそのまま承認するか、ここで一部を選んで足し戻せます(選んで足し戻すと、AI の下書きは捨てます)。
      </p>
      <ul className="flex flex-col divide-y rounded-md border bg-background">
        {picks.map(({ candidate: c, item }) => (
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
                <TripLine trip={c.trip} hints={c.detail.hints} lostCells={c.detail.lostCells} />
                <span className="text-muted-foreground">
                  AI の理由:{item.reason === '' ? '(なし)' : item.reason}
                  {item.schoolDaysOnly && '(休校日運休(学))'}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 選んだ便と、便ごとの「休校日運休(学)」のチェック(GTFS には入れず、変更指示書と周知文に使う) */
export function SelectedTrips({
  trips,
  school,
  onSchool,
  onRemove,
}: {
  trips: readonly Candidate[]
  school: ReadonlySet<string>
  onSchool: (tripId: string, checked: boolean) => void
  onRemove: (tripId: string) => void
}) {
  if (trips.length === 0) return null
  return (
    <section className="flex flex-col gap-1 text-xs" aria-label="選んだ便">
      <h3 className="font-medium">選んだ便({trips.length} 便)</h3>
      <ul className="flex flex-col divide-y rounded-md border">
        {trips.map((c) => (
          <li key={c.trip.tripId} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 py-1">
            <span className="min-w-0 break-words">
              <span className="font-medium tabular-nums">{c.trip.firstDeparture ?? '—'}</span> {c.trip.routeName}:{c.trip.firstStopName} →{' '}
              {c.trip.lastStopName} <span className="font-mono text-[10px] text-muted-foreground">{c.trip.tripId}</span>
            </span>
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={school.has(c.trip.tripId)}
                  onChange={(e) => onSchool(c.trip.tripId, e.target.checked)}
                  aria-label={`${c.trip.tripId} を休校日運休(学)にする`}
                />
                休校日運休(学)
              </label>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onRemove(c.trip.tripId)} aria-label={`${c.trip.tripId} を選ぶのをやめる`}>
                外す
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">休校日運休(学)は、学校の休業日に走らせない便の印です。GTFS には入れず、変更指示書と周知文に使います。</p>
    </section>
  )
}
