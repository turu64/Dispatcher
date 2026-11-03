import { useMemo, useState } from 'react'
import HolidayCalendar from '@/components/HolidayCalendar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { HolidayList } from '@/gtfs/holidays'
import { formatDateJa } from '@/lib/dates'
import { describeServiceDay, type ServiceDay } from '@/lib/serviceDay'
import { useGtfsStore } from '@/store/gtfs'
import { useHolidayStore } from '@/store/holidays'
import { selectablePeriod, useReachStore, type StepHours } from '@/store/reach'

/**
 * 影響(到達圏)の手順の上部に置く、日付と時間帯の幅の入力(以前は手順「日付と時間帯」だった。docs/tasks-1103.md の指摘7)。
 * 選んだ条件は useReachStore に入り、変えると到達圏を計算し直す。計算の結果は表・足し戻しの手がかり・AI の影響の要約にも使われる。
 * 地図に出す時間帯の切り替えは計算を変えないので、ここではなく地図の上(map/BandControl.tsx)に置く。
 * 選べる日付の範囲は到達圏の store から読む(減便後の GTFS があれば、その有効期間の中だけ。docs/interfaces-1104.md §7)
 */
export default function DateBandStep() {
  const feed = useGtfsStore((s) => s.feed)
  const period = useReachStore(selectablePeriod)
  const comparing = useReachStore((s) => s.edited !== null)
  const date = useReachStore((s) => s.date)
  const stepHours = useReachStore((s) => s.stepHours)
  const holidayState = useHolidayStore((s) => s.holidays)
  const holidays = holidayState.status === 'ready' ? holidayState.list : null
  const day = useMemo(() => (feed && date ? describeServiceDay(feed, date) : null), [feed, date])
  if (!feed) return null

  return (
    <DateBandPanel
      period={period}
      comparing={comparing}
      date={date}
      day={day}
      holidays={holidays}
      stepHours={stepHours}
      onDate={(d) => useReachStore.getState().setDate(d)}
      onStepHours={(v) => useReachStore.getState().setStepHours(v)}
    />
  )
}

/** DateBandStep の表示の部分(store を使わない。値を直接渡して確かめられる) */
export function DateBandPanel({
  period,
  comparing,
  date,
  day,
  holidays,
  stepHours,
  onDate,
  onStepHours,
}: {
  /** 選べる日付の範囲。運行日が無いときは null */
  period: { start: string; end: string } | null
  /** 減便後の GTFS と比べている(範囲は出力の有効期間) */
  comparing: boolean
  date: string | null
  day: ServiceDay | null
  holidays: HolidayList | null
  stepHours: StepHours
  /** 日付を選んだとき。選べない日なら理由を返す(カレンダーは範囲の外を選べないので、ふつうは null) */
  onDate: (date: string) => string | null
  onStepHours: (v: StepHours) => void
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <details open className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        比べる日と時間帯の幅
        {date && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({formatDateJa(date)}、{stepHours}時間ごと)
          </span>
        )}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {!period || !date ? (
          <Alert variant="destructive">
            <AlertDescription>
              {comparing
                ? '減便後の GTFS に運行日がありません(方針の期間を確かめてください)。'
                : 'この GTFS には運行日がありません(calendar.txt・calendar_dates.txt を確かめてください)。'}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">比べる日</span>
              <HolidayCalendar
                value={date}
                min={period.start}
                max={period.end}
                holidays={holidays}
                onChange={(d) => setError(onDate(d))}
              />
              <p className="text-xs text-muted-foreground">
                {comparing
                  ? `比べられるのは出力の有効期間(${formatDateJa(period.start)}〜${formatDateJa(period.end)})です`
                  : `運行期間:${formatDateJa(period.start)}〜${formatDateJa(period.end)}`}
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            {day && <ServiceDayInfo day={day} />}
            <StepPicker value={stepHours} onChange={onStepHours} />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          日付と時間帯の幅を変えると、表・足し戻しの手がかり・AI の影響の要約も計算し直します。
          地図に出す時間帯は、地図の上のボタンで切り替えます(こちらは計算し直しません)。
        </p>
      </div>
    </details>
  )
}

/** 選んだ日の曜日、走る service_id、calendar_dates.txt が効いているか */
export function ServiceDayInfo({ day }: { day: ServiceDay }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm">
      <p>
        <span className="font-medium">{formatDateJa(day.date)}</span>
      </p>
      {day.serviceIds.length > 0 ? (
        <p>
          走る service_id:<span className="font-mono">{day.serviceIds.join('、')}</span>
        </p>
      ) : (
        <p className="text-destructive">この日に走る便はありません。</p>
      )}
      {day.exceptionApplied ? (
        <p className="text-amber-900">
          calendar_dates.txt が効いています(祝日などの特別ダイヤ)。
          {day.added.length > 0 && <>追加:<span className="font-mono">{day.added.join('、')}</span>。</>}
          {day.removed.length > 0 && <>運休:<span className="font-mono">{day.removed.join('、')}</span>。</>}
        </p>
      ) : (
        <p className="text-muted-foreground">calendar_dates.txt による変更はありません(calendar.txt のとおり)。</p>
      )}
      <p className="text-xs text-muted-foreground">前日の便の 24時を超える出発も、この日の早朝として数えます。</p>
    </div>
  )
}

function StepPicker({ value, onChange }: { value: StepHours; onChange: (v: StepHours) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id="reach-step-label">
        時間帯の刻み
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-labelledby="reach-step-label"
        value={String(value)}
        onValueChange={(v) => {
          // もう一度押して選択が外れたとき('')は、そのままにする
          if (v === '3' || v === '1') onChange(Number(v) as StepHours)
        }}
      >
        <ToggleGroupItem value="3" className={SELECTED_TOGGLE_CLASS}>
          3時間ごと
        </ToggleGroupItem>
        <ToggleGroupItem value="1" className={SELECTED_TOGGLE_CLASS}>
          1時間ごと
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
