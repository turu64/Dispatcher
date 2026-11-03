import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TimeBand } from '@/gtfs/departures'
import { bandIndexForHour } from '@/reach/input'

/**
 * 地図の上の時間帯の切り替え(地図の下の端の中央)。
 * 押すと地図の塗り分けと、影響(到達圏)の表の強調行が切り替わるだけで、到達圏は計算し直さない
 * (日付と時間帯の幅は、影響(到達圏)の手順の上部で選ぶ。そちらは計算し直す)。
 * 帯は 3時間ごと(6つ)か 1時間ごと(18)で、数が多いときは折り返す。選んでいる時刻を含む帯を主色で塗る。
 */
export default function BandControl({
  bands,
  selectedHour,
  onSelect,
}: {
  bands: TimeBand[]
  selectedHour: number
  onSelect: (hour: number) => void
}) {
  const index = bandIndexForHour(bands, selectedHour)
  const value = index >= 0 ? String(bands[index].startHour) : ''
  return (
    <section
      aria-label="地図に出す時間帯"
      className="absolute bottom-9 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-1 rounded-lg bg-background/95 px-2 py-1.5 text-xs shadow-md ring-1 ring-foreground/10"
    >
      <span id="map-band-label" className="font-medium">
        地図に出す時間帯
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-labelledby="map-band-label"
        className="flex-wrap justify-center"
        value={value}
        onValueChange={(v) => {
          // もう一度押して選択が外れたとき('')は、そのままにする
          if (v !== '') onSelect(Number(v))
        }}
      >
        {bands.map((b) => (
          <ToggleGroupItem
            key={b.startHour}
            value={String(b.startHour)}
            className={`h-7 px-2 text-xs tabular-nums ${SELECTED_TOGGLE_CLASS}`}
          >
            {b.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  )
}
