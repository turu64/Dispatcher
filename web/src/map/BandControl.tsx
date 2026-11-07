import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import HolidayCalendar from '@/components/HolidayCalendar'
import { NoServiceDaysMessage, ServiceDayInfo, StepPicker } from '@/components/steps/DateBandStep'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TimeBand } from '@/gtfs/departures'
import type { HolidayList } from '@/gtfs/holidays'
import { formatDateJa } from '@/lib/dates'
import type { ServiceDay } from '@/lib/serviceDay'
import { bandIndexForHour } from '@/reach/input'
import type { StepHours } from '@/store/reach'

export interface BandControlProps {
  /** 選べる日付の範囲。運行日が無いときは null */
  period: { start: string; end: string } | null
  /** 減便後の GTFS と比べている(選べる範囲は減便後の GTFS の運行期間) */
  comparing: boolean
  /** 比較する日付('YYYYMMDD')。運行日が無いときは null */
  date: string | null
  /** 比較する日付の運行の説明(走る service_id など)。無ければ出さない */
  day: ServiceDay | null
  holidays: HolidayList | null
  stepHours: StepHours
  /** 地図に出せる時間帯。到達圏の計算の結果がまだ無いときは null(時間帯の切り替えを出さない) */
  bands: TimeBand[] | null
  selectedHour: number
  /** 日付を選んだとき。選べない日なら理由を返す(カレンダーは範囲の外を選べないので、ふつうは null) */
  onDate: (date: string) => string | null
  onStepHours: (v: StepHours) => void
  /** 地図に出す時間帯を選んだとき(計算し直さない) */
  onSelect: (hour: number) => void
}

/**
 * 地図の操作盤(地図の下の端の中央。docs/tasks-1103b.md の T31、指摘11)。
 * 比較する日付・時間帯の幅・地図に出す時間帯を1つの盤にまとめる。
 * - 比較する日付と時間帯の幅は到達圏を計算し直す(地図のほか、影響(到達圏)の表・便を平日に戻す判断材料・AI による影響の要約に効く)
 * - 地図に出す時間帯は、地図の塗り分けと影響(到達圏)の表の強調行を切り替えるだけで、計算し直さない
 * 日付はボタンで Popover のカレンダーを開いて選び、同じ Popover に運行日の説明(走る service_id など)を出す。
 * 日を選んでも Popover は閉じない(選んだ日の運行の説明を見られるように)。
 * 盤は store を使わない(値を直接渡して確かめられる)。store とのつなぎは ReachLayers.tsx。
 * 項目名(「比較する日付」など)は折り返さない(狭い地図で1文字ずつ縦に並ばないように)。中身は項目ごとに折り返すので、狭い地図でも左上の凡例・右上の施設の凡例と重ならない(盤は下から上へ伸びる)。
 */
export default function BandControl({
  period,
  comparing,
  date,
  day,
  holidays,
  stepHours,
  bands,
  selectedHour,
  onDate,
  onStepHours,
  onSelect,
}: BandControlProps) {
  const hasDays = period !== null && date !== null
  return (
    <section
      aria-label="地図の操作盤"
      className="absolute bottom-9 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-1.5 rounded-lg bg-background/95 px-2 py-1.5 text-xs shadow-md ring-1 ring-foreground/10"
    >
      {hasDays ? (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          <div className="flex items-center gap-1.5">
            <span id="map-date-label" className="font-medium whitespace-nowrap">
              比較する日付
            </span>
            <DatePopover
              period={period}
              comparing={comparing}
              date={date}
              day={day}
              holidays={holidays}
              onDate={onDate}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span id="map-step-label" className="font-medium whitespace-nowrap">
              時間帯の幅
            </span>
            <StepPicker value={stepHours} onChange={onStepHours} labelId="map-step-label" />
          </div>
        </div>
      ) : (
        <p role="alert" className="max-w-80 text-center text-destructive">
          <NoServiceDaysMessage comparing={comparing} />
        </p>
      )}
      {bands && <BandPicker bands={bands} selectedHour={selectedHour} onSelect={onSelect} />}
    </section>
  )
}

/** 日付のボタンと、開いたときのカレンダー・運行日の説明 */
function DatePopover({
  period,
  comparing,
  date,
  day,
  holidays,
  onDate,
}: {
  period: { start: string; end: string }
  comparing: boolean
  date: string
  day: ServiceDay | null
  holidays: HolidayList | null
  onDate: (date: string) => string | null
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <Popover onOpenChange={() => setError(null)}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs tabular-nums">
          {/* 読み上げでは「比較する日付 2026年11月9日(月)」と、何の日付かも伝える */}
          <span className="sr-only">比較する日付 </span>
          <span aria-hidden="true">{formatDateJa(date).replace(/^\d+年/, '')}</span>
          <span className="sr-only">{formatDateJa(date)}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        collisionPadding={8}
        // 窓が低く、上にも下にも収まらないときは、入る高さに縮めて中をスクロールする(月の見出しと月の移動が画面の外に出ないように)
        className="max-h-(--radix-popover-content-available-height) w-auto max-w-[calc(100vw-1rem)] gap-2 overflow-y-auto p-2"
        aria-label="比較する日付を選ぶ"
      >
        <HolidayCalendar
          value={date}
          min={period.start}
          max={period.end}
          holidays={holidays}
          onChange={(d) => setError(onDate(d))}
        />
        <p className="px-2 text-xs text-muted-foreground">
          {comparing
            ? `選べるのは減便後の GTFS の運行期間(${formatDateJa(period.start)}〜${formatDateJa(period.end)})です。`
            : `運行期間:${formatDateJa(period.start)}〜${formatDateJa(period.end)}`}
        </p>
        {error && <p className="px-2 text-sm text-destructive">{error}</p>}
        {day && <ServiceDayInfo day={day} />}
        <p className="max-w-72 px-2 text-xs text-muted-foreground">
          比較する日付と時間帯の幅を変えると、到達圏の表・便を平日に戻す判断材料・AI による影響の要約も計算し直します。
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * 地図に出す時間帯の切り替え。帯は 3時間ごと(6つ)か 1時間ごと(18)で、数が多いときは折り返す。
 * 選んでいる時刻を含む帯を主色で塗る
 */
function BandPicker({ bands, selectedHour, onSelect }: { bands: TimeBand[]; selectedHour: number; onSelect: (hour: number) => void }) {
  const index = bandIndexForHour(bands, selectedHour)
  const value = index >= 0 ? String(bands[index].startHour) : ''
  return (
    <div className="flex flex-col items-center gap-1">
      <span id="map-band-label" className="font-medium whitespace-nowrap">
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
    </div>
  )
}
