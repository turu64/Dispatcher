import { useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { makeBands, type TimeBand } from '@/gtfs/departures'
import { formatDateJa, fromInputDate, toInputDate } from '@/lib/dates'
import { describeServiceDay, type ServiceDay } from '@/lib/serviceDay'
import { bandIndexForHour } from '@/reach/input'
import { useGtfsStore } from '@/store/gtfs'
import { selectablePeriod, useReachStore, type StepHours } from '@/store/reach'

/**
 * 手順3:日付と時間帯。選んだ条件は useReachStore に入り、到達圏の計算と地図の表示に使われる。
 * 選べる日付の範囲は到達圏の store から読む(減便後の GTFS があれば、その有効期間の中だけ。docs/interfaces-1104.md §7)
 */
export default function DateBandStep() {
  const feed = useGtfsStore((s) => s.feed)
  const period = useReachStore(selectablePeriod)
  const comparing = useReachStore((s) => s.edited !== null)
  const date = useReachStore((s) => s.date)
  const stepHours = useReachStore((s) => s.stepHours)
  const selectedHour = useReachStore((s) => s.selectedHour)
  const day = useMemo(() => (feed && date ? describeServiceDay(feed, date) : null), [feed, date])
  const bands = useMemo(() => makeBands(stepHours), [stepHours])

  return (
    <StepSection title="3. 日付と時間帯">
      {!feed ? (
        <p className="text-sm text-muted-foreground">手順1で GTFS を読み込むと選べます。</p>
      ) : !period || !date ? (
        <Alert variant="destructive">
          <AlertDescription>
            {comparing
              ? '減便後の GTFS に運行日がありません(方針の期間を確かめてください)。'
              : 'この GTFS には運行日がありません(calendar.txt・calendar_dates.txt を確かめてください)。'}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <DateField date={date} period={period} comparing={comparing} onCommit={(d) => useReachStore.getState().setDate(d)} />
          {day && <ServiceDayInfo day={day} />}
          <StepPicker value={stepHours} onChange={(v) => useReachStore.getState().setStepHours(v)} />
          <BandPicker bands={bands} selectedHour={selectedHour} onSelect={(h) => useReachStore.getState().selectHour(h)} />
        </>
      )}
    </StepSection>
  )
}

/**
 * 日付の入力。打っている途中の値(年の桁を打ち直している間など)で選択が戻らないよう、入力欄の文字は手元に持ち、
 * 正しい日付になったときだけ store に渡す。store の日付が外から変わったら(GTFS を読み直したときなど)、入力欄も合わせる。
 */
export function DateField({
  date,
  period,
  comparing,
  onCommit,
}: {
  date: string
  period: { start: string; end: string }
  /** 減便後の GTFS と比べている(範囲は出力の有効期間) */
  comparing: boolean
  onCommit: (date: string) => string | null
}) {
  const [text, setText] = useState(toInputDate(date))
  const [shown, setShown] = useState(date)
  const [error, setError] = useState<string | null>(null)
  if (date !== shown) {
    setShown(date)
    setText(toInputDate(date))
    setError(null)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="reach-date">日付</Label>
      <Input
        id="reach-date"
        type="date"
        min={toInputDate(period.start)}
        max={toInputDate(period.end)}
        value={text}
        aria-invalid={error !== null}
        aria-describedby="reach-date-help"
        onChange={(e) => {
          const value = e.target.value
          setText(value)
          const d = fromInputDate(value)
          if (!d) {
            setError('日付を選んでください。')
            return
          }
          const message = onCommit(d)
          setError(message)
          if (!message) setShown(d)
        }}
      />
      <p id="reach-date-help" className="text-xs text-muted-foreground">
        {comparing
          ? `比べられるのは出力の有効期間(${formatDateJa(period.start)}〜${formatDateJa(period.end)})です`
          : `運行期間:${formatDateJa(period.start)}〜${formatDateJa(period.end)}`}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
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

/** 表示する時間帯。地図の色を切り替えるだけで、計算し直さない */
export function BandPicker({
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
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id="reach-band-label">
        地図に出す時間帯
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-labelledby="reach-band-label"
        className="flex-wrap"
        value={value}
        onValueChange={(v) => {
          if (v !== '') onSelect(Number(v))
        }}
      >
        {bands.map((b) => (
          <ToggleGroupItem key={b.startHour} value={String(b.startHour)} className={`tabular-nums ${SELECTED_TOGGLE_CLASS}`}>
            {b.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
