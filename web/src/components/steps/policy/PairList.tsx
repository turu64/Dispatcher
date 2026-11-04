import type { Form2Report } from '@/gtfs/edit/form2'
import type { PolicySettings } from '@/gtfs/edit/ops'
import { splitPairs } from '@/gtfs/groups/view'
import { REPLACEMENT_LABELS, SKIPPED_REPLACEMENT_NOTE, skippedOfReport } from '../editText'

/**
 * 組の内訳(docs/design-service-groups.md §5.2・§5.3)。入れ替える組(平日の service ← 入れ替えに使う service)、なくす service、
 * 残す service、期間に走らないため組ごと除いた service を並べる。期間に1日も走らないため加えない入れ替えに使う service には
 * 「期間に走らないため加えません」と添える。減便の方針の手順(入力・対象便の確認・承認したあと)と変更指示書で同じ形にする。
 * 数は、版の report があればその数(なくなる便・加わる便)、無ければ tripCounts(service ごとの便数)
 */
export function PairList({
  settings,
  report,
  tripCounts,
  dropped: droppedBefore,
  skipped: skippedBefore,
  className,
}: {
  settings: Pick<PolicySettings, 'kind' | 'weekdayService' | 'replacementService' | 'pairs' | 'keptWeekdayServices'>
  report?: Pick<Form2Report, 'pairs'> | null
  tripCounts?: ReadonlyMap<string, number>
  /** 承認の前に、期間に走らないため組ごと除くと分かっている平日の service(droppedPairWeekdays)。report の除いた組に足す */
  dropped?: ReadonlySet<string>
  /** 承認の前に、期間に走らないため加えないと分かっている入れ替えに使う service(skippedReplacements)。report の分に足す */
  skipped?: ReadonlySet<string>
  className?: string
}) {
  const label = REPLACEMENT_LABELS[settings.kind]
  const { replaced, erased, kept } = splitPairs(settings)
  const pairReports = new Map((report?.pairs ?? []).map((p) => [p.weekday, p]))
  const dropped = new Set([...(droppedBefore ?? []), ...(report?.pairs ?? []).filter((p) => p.dropped).map((p) => p.weekday)])
  const skipped = new Set([...(skippedBefore ?? []), ...skippedOfReport(report)])
  const trips = (id: string) => tripCounts?.get(id)
  const n = (v: number) => v.toLocaleString('ja-JP')

  const pairCounts = (weekday: string): string | null => {
    const r = pairReports.get(weekday)
    if (r) {
      const added = r.replacements.reduce((s, x) => s + x.added, 0)
      return `なくなる便 ${n(r.removed)}・加わる便 ${n(added)}`
    }
    const w = trips(weekday)
    return w === undefined ? null : `平日 ${n(w)} 便`
  }

  return (
    <ul className={className ?? 'flex flex-col gap-0.5 text-xs'} aria-label="組の内訳">
      {replaced
        .filter((p) => !dropped.has(p.weekday))
        .map((p) => {
          const counts = pairCounts(p.weekday)
          return (
            <li key={p.weekday} className="break-words">
              平日 <span className="font-mono">{p.weekday}</span> <span aria-hidden="true">←</span>
              <span className="sr-only">に入れる便:</span> {label}{' '}
              {p.replacements.map((r, i) => (
                <span key={r}>
                  {i > 0 && '・'}
                  <span className={skipped.has(r) ? 'font-mono line-through' : 'font-mono'}>{r}</span>
                  {skipped.has(r) && <span className="text-amber-900 dark:text-amber-300 print:text-black">({SKIPPED_REPLACEMENT_NOTE})</span>}
                </span>
              ))}
              {counts && `(${counts})`}
            </li>
          )
        })}
      {erased.filter((id) => !dropped.has(id)).length > 0 && (
        <li className="break-words">
          なくす(入れ替えに使うダイヤがない):
          {erased.filter((id) => !dropped.has(id)).map((id, i) => {
            const r = pairReports.get(id)
            const count = r ? r.removed : trips(id)
            return (
              <span key={id}>
                {i > 0 && '、'}
                <span className="font-mono">{id}</span>
                {count !== undefined && `(${n(count)} 便)`}
              </span>
            )
          })}
        </li>
      )}
      {kept.length > 0 && (
        <li className="break-words">
          平日のまま残す:
          {kept.map((id, i) => (
            <span key={id}>
              {i > 0 && '、'}
              <span className="font-mono">{id}</span>
            </span>
          ))}
        </li>
      )}
      {dropped.size > 0 && (
        <li className="break-words text-muted-foreground print:text-black">
          減便の期間に走らないため除いた組:
          {[...dropped].map((id, i) => (
            <span key={id}>
              {i > 0 && '、'}
              <span className="font-mono">{id}</span>
            </span>
          ))}
        </li>
      )}
    </ul>
  )
}
