import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDateJa } from '@/lib/dates'
import type { ServiceDay } from '@/lib/serviceDay'
import type { StepHours } from '@/store/reach'

/**
 * 比較する日付と時間帯の幅の部品の置き場(手順の部品としては使わない。docs/tasks-1103b.md の T31)。
 * 以前は影響(到達圏)の手順の上部に置いていたが、指摘11で地図の下の操作盤(map/BandControl.tsx)にまとめた。
 * 手順の側には、今の設定を1行で出す(ReachStep.tsx の ReachSettingLine)。
 */

/**
 * 運行日が無い(選べる日付が無い)ときの注意。操作盤と影響(到達圏)の手順の両方に同じ文を出す。
 * comparing は、減便後の GTFS と比べている(選べる日付は減便後の GTFS の運行期間)か
 */
export function NoServiceDaysMessage({ comparing }: { comparing: boolean }) {
  return comparing
    ? '減便後の GTFS に運行日がありません。減便の期間を確かめてください。'
    : 'この GTFS には運行日がありません。calendar.txt・calendar_dates.txt を確かめてください。'
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
        <p className="text-amber-900 dark:text-amber-300">
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

/** 時間帯の幅(3時間ごと/1時間ごと)の切り替え。labelId は見出しの要素の id(読み上げの名前に使う) */
export function StepPicker({
  value,
  onChange,
  labelId,
}: {
  value: StepHours
  onChange: (v: StepHours) => void
  labelId: string
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      aria-labelledby={labelId}
      value={String(value)}
      onValueChange={(v) => {
        // もう一度押して選択が外れたとき('')は、そのままにする
        if (v === '3' || v === '1') onChange(Number(v) as StepHours)
      }}
    >
      <ToggleGroupItem value="3" className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
        3時間ごと
      </ToggleGroupItem>
      <ToggleGroupItem value="1" className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
        1時間ごと
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
