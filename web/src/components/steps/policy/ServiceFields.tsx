import { Label } from '@/components/ui/label'
import { activeDaysIn, type ServiceInfo } from '@/gtfs/edit/services'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { daysPattern, ROLE_LABELS } from '../editText'
import type { Override } from './types'

function serviceLabel(s: ServiceInfo): string {
  return `${s.serviceId}:${ROLE_LABELS[s.role]}・${s.tripCount} 便`
}

export function ServiceSelect({
  id,
  label,
  services,
  value,
  guess,
  override,
  onChange,
}: {
  id: string
  label: string
  services: readonly ServiceInfo[]
  value: string | null
  guess: string | null
  override: Override | undefined
  onChange: (v: string) => void
}) {
  const options = services.filter((s) => s.tripCount > 0)
  const changedGuess = override && guess !== null && guess !== override.guessAtPick && guess !== override.value
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {value === null && <option value="">選んでください</option>}
        {options.map((s) => (
          <option key={s.serviceId} value={s.serviceId}>
            {serviceLabel(s)}
          </option>
        ))}
      </select>
      {!override && guess !== null && <p className="text-xs text-muted-foreground">曜日の列から推定しました。</p>}
      {changedGuess && <p className="text-xs text-amber-900 dark:text-amber-300">期間を変えたため、推定は {guess} になりました。</p>}
    </div>
  )
}

/** service ごとの材料(曜日の並び、便数、calendar の期間、新しい有効期間の中で走る日数、祝日に追加されるか) */
export function ServiceDetails({
  feed,
  services,
  validity,
}: {
  feed: GtfsFeed
  services: readonly ServiceInfo[]
  validity: { start: string; end: string } | null
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">service の一覧({services.length} 件)</summary>
      <ul className="mt-1 flex flex-col gap-1">
        {services.map((s) => (
          <li key={s.serviceId} className="break-words">
            <span className="font-mono">{s.serviceId}</span> {ROLE_LABELS[s.role]}({daysPattern(s.days)})、{s.tripCount} 便
            {s.calendarRange && `、calendar ${formatDateJa(s.calendarRange.start)}〜${formatDateJa(s.calendarRange.end)}`}
            {validity && `、新しい有効期間に走る日 ${activeDaysIn(feed, s.serviceId, validity.start, validity.end)} 日`}
            {s.addedOnHolidays === null ? '、祝日の追加:判定できません' : s.addedOnHolidays ? '、祝日に追加されます' : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}
