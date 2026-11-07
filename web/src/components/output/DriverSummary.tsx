import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { compareDrivers, useDriverComparison, useDriversStore, type DriverComparison } from '@/store/drivers'
import {
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  needBasisText,
  ROSTER_WHERE,
  SERVICE_HOURS_NOTE,
  supplyText,
  supplyWarningText,
  verdictText,
} from '@/components/steps/reach/driverText'

/**
 * 変更指示書と平日便を戻す手順に出す、要る運転士の数(目安)のまとめ(指摘 24・18.1、docs/tasks-1105.md の D04)。
 * 数はすべて store/drivers.ts の compareDrivers が出し、ここでは並べるだけ。在籍の運転士の数・週の出勤日数・仮定・場所は、
 * 運行の前提の手順の「運行の前提」の欄(steps/research/OperationPremise.tsx)で、欠員は減便の方針の手順(steps/policy/ShortageSection.tsx)で入れる。判定(乗務できる運転士の数(目安)と
 * 減便後に要る勤務の数の比較)は、在籍の運転士の数を入れたときだけ出す
 */

/** まとまりの見出し */
export const DRIVER_SUMMARY_TITLE = '要る運転士の数(目安)'

/** 変更指示書の比較する日付が、影響(到達圏)の手順の日付と違いうることの断り(画面だけ) */
export const SUMMARY_DATE_NOTE =
  '変更指示書では、減便の期間の中のふつうの平日で、承認済みの減便後と比べています。手順「影響(到達圏)」の欄は地図の比較する日付と下書きで数えるので、数が違うことがあります。'

/**
 * 変更指示書の「要る運転士の数(目安)」。減便前の GTFS と承認済みの最後の版を、比較する平日(date)で比べる。
 * 下書きは使わない(変更指示書は承認した内容だけを載せる)。欠員・仮定・営業所は store/drivers の値を使う。
 * date が null(比較する平日が見つからない)なら、出さない理由を1行出す
 */
export default function DriverSummary({ base, version, date }: { base: GtfsFeed; version: Form2Result; date: string | null }) {
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  const shortage = useDriversStore((s) => s.shortage)
  const roster = useDriversStore((s) => s.roster)
  const workDays = useDriversStore((s) => s.workDays)
  const comparison = useMemo(
    () =>
      date === null
        ? null
        : compareDrivers({
            base,
            edited: { feed: version.feed, draft: false },
            date,
            weekdayServices: activeWeekdayServicesOf(version),
            params,
            places,
            shortage,
            roster,
            workDays,
          }),
    [base, version, date, params, places, shortage, roster, workDays],
  )
  if (!comparison) {
    return (
      <div className="break-inside-avoid" data-testid="driver-summary">
        <p className="font-medium">{DRIVER_SUMMARY_TITLE}</p>
        <p>比較する平日が見つからないため、出していません。減便後の GTFS に平日ダイヤの運行日があるか確かめてください。</p>
      </div>
    )
  }
  return <DriverSummaryView comparison={comparison} note={SUMMARY_DATE_NOTE} />
}

/**
 * まとまりの中身(store を使わない。テストでは値を直接渡す)。営業運行時間の前・後・削減量、勤務の数の前・後・差、
 * 判定(在籍の運転士の数を入れたときだけ)と乗務できる運転士の数(目安)の数え方・要る勤務の数の出し方、使った仮定を1つのまとまりで出す。印刷で途中から紙を分けない(break-inside-avoid)
 */
export function DriverSummaryView({ comparison, note }: { comparison: DriverComparison; note?: string }) {
  const { before, after, hours, dutyDiff, verdict, supply, need, date } = comparison
  // 判定は、在籍の運転士の数を入れたとき(と平日ダイヤが走らない日)だけ出す
  const judged = verdict.kind === 'enough' || verdict.kind === 'short'
  const showVerdict = judged || (verdict.kind === 'notWeekday' && supply !== null)
  const warning = supply ? supplyWarningText(supply) : null
  return (
    <div className="flex break-inside-avoid flex-col gap-0.5" data-testid="driver-summary" aria-label={DRIVER_SUMMARY_TITLE} role="group">
      <p>
        <span className="font-medium">{DRIVER_SUMMARY_TITLE}</span>
        <span className="ml-1">({formatDateJa(date)}の便で比べた数)</span>
      </p>
      <table className="w-full max-w-md border-collapse text-right tabular-nums" aria-label="減便の前後の営業運行時間と勤務の数">
        <thead>
          <tr className="border-b border-foreground/40">
            <th scope="col" className="py-0.5 text-left font-medium" />
            <th scope="col" className="py-0.5 font-medium">
              減便前
            </th>
            {after && (
              <th scope="col" className="py-0.5 font-medium">
                減便後
              </th>
            )}
            {after && (
              <th scope="col" className="py-0.5 font-medium">
                差
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-foreground/15">
            <th scope="row" className="py-0.5 text-left font-normal print:py-0">
              営業運行時間
            </th>
            <td className="py-0.5 print:py-0">{formatHours(before.hours.serviceMinutes)}</td>
            {after && <td className="py-0.5 print:py-0">{formatHours(after.hours.serviceMinutes)}</td>}
            {after && hours && (
              <td className="py-0.5 print:py-0">
                {formatHoursDiff(hours.reduction.serviceMinutes)}
                {hours.reduction.ratio !== null && hours.reduction.serviceMinutes !== 0 && `(${formatRatioDiff(hours.reduction.ratio)})`}
              </td>
            )}
          </tr>
          <tr className="border-b border-foreground/15">
            <th scope="row" className="py-0.5 text-left font-normal print:py-0">
              勤務の数(目安)
            </th>
            <td className="py-0.5 print:py-0">{before.duties.dutyCount}</td>
            {after && <td className="py-0.5 print:py-0">{after.duties.dutyCount}</td>}
            {after && dutyDiff !== null && <td className="py-0.5 font-semibold print:py-0">{formatDiff(dutyDiff)}</td>}
          </tr>
          {need.basis === 'operatorRuns' && (
            <tr className="border-b border-foreground/15">
              <th scope="row" className="py-0.5 text-left font-normal print:py-0">
                要る勤務の数(入力の運用番号の数から)
              </th>
              <td className="py-0.5 print:py-0">{need.before}</td>
              {after && <td className="py-0.5 print:py-0">{need.after ?? '―'}</td>}
              {after && (
                <td className="py-0.5 font-semibold print:py-0">{need.after === null ? '―' : formatDiff(need.before - need.after)}</td>
              )}
            </tr>
          )}
        </tbody>
      </table>
      {showVerdict && (
        <p className={verdict.kind === 'short' ? 'font-semibold' : 'font-medium'} data-testid="driver-summary-verdict">
          {verdict.kind === 'short' && <span aria-hidden="true">⚠ </span>}
          {verdictText(verdict, date)}
        </p>
      )}
      {supply && (
        <p data-testid="driver-summary-supply">
          {supplyText(supply)}
          {warning && (
            <span className="ml-1 font-semibold">
              <span aria-hidden="true">⚠ </span>
              {warning}
            </span>
          )}
          {judged && <span className="ml-1 text-muted-foreground print:text-black">{needBasisText(need)}</span>}
        </p>
      )}
      <p className="text-muted-foreground print:text-black">{SERVICE_HOURS_NOTE}</p>
      <div>
        <p className="text-muted-foreground print:text-black">使った仮定:</p>
        <ul
          className="list-disc pl-4 text-muted-foreground print:columns-2 print:gap-x-3 print:text-black"
          aria-label="要る運転士の数の仮定"
        >
          {comparison.assumptions.map((line) => (
            <li key={line} className="break-inside-avoid">
              {line}
            </li>
          ))}
        </ul>
      </div>
      {note && <p className="print-hide text-muted-foreground">{note}</p>}
    </div>
  )
}

/**
 * 平日便を戻す手順の1行。勤務の数の目安の今の値(減便前 → 減便後)と、乗務できる運転士の数(目安)との比較。
 * 影響(到達圏)の手順の欄と同じ比較(useDriverComparison。地図の比較する日付と、下書きを含む減便後)なので、便を戻すたびに変わる。
 * GTFS か比較する日付が無ければ出さない
 */
export function DriverLine() {
  const comparison = useDriverComparison()
  if (!comparison) return null
  return <DriverLineView comparison={comparison} />
}

/** 判定の短い名前(平日便を戻す手順の1行の先頭に出す)。在籍を入れていない・減便後が無い・平日でないときは「判定なし」 */
function verdictBadgeText(verdict: DriverComparison['verdict']): string {
  if (verdict.kind === 'enough') return `足りる目安(余り ${verdict.spare})`
  if (verdict.kind === 'short') return `あと ${verdict.missing} 足りない目安`
  return '判定なし'
}

const BADGE_TONE = {
  enough: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
  short: '',
  none: 'text-muted-foreground',
} as const

/**
 * 1行の中身(store を使わない)。先頭に見出しと判定のバッジ(足りる目安は緑系、足りない目安は警告色、判定なしは中立)を出し、
 * 勤務の数の前後・要る勤務の数・判定の文(または在籍を入れる場所)はその下に小さな文字で出す
 */
export function DriverLineView({ comparison }: { comparison: DriverComparison }) {
  const { before, after, dutyDiff, verdict, date } = comparison
  const tone = verdict.kind === 'enough' ? 'enough' : verdict.kind === 'short' ? 'short' : 'none'
  const counts =
    after && dutyDiff !== null
      ? `勤務の数(目安):減便前 ${before.duties.dutyCount} → 減便後${comparison.draft ? '(下書き)' : ''} ${after.duties.dutyCount}(${formatDiff(dutyDiff)}、${formatDateJa(date)})。`
      : `勤務の数(目安):減便前 ${before.duties.dutyCount}(${formatDateJa(date)})。`
  // 運用番号の数から出したときは、判定に使う要る勤務の数も並べる(推定の数と違うため)
  const { need } = comparison
  const needed =
    need.basis === 'operatorRuns' && need.after !== null
      ? `要る勤務の数(入力の運用番号の数から):減便前 ${need.before} → 減便後 ${need.after}。`
      : ''
  return (
    <div className="flex flex-col gap-1 rounded-md border px-2 py-1.5" aria-live="polite" data-testid="driver-line">
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">{DRIVER_SUMMARY_TITLE}</span>
        <Badge
          variant={tone === 'short' ? 'destructive' : 'outline'}
          className={BADGE_TONE[tone]}
          data-testid="driver-line-badge"
          data-tone={tone}
        >
          {verdictBadgeText(verdict)}
        </Badge>
      </p>
      <p className="text-xs text-muted-foreground" data-testid="driver-line-details">
        {counts}
        {needed}
        {verdict.kind === 'noRoster' ? ROSTER_WHERE : verdictText(verdict, date)}
      </p>
    </div>
  )
}
