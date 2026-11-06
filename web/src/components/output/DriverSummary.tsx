import { useMemo } from 'react'
import { activeWeekdayServicesOf, type Form2Result } from '@/gtfs/edit/form2'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { compareDrivers, useDriverComparison, useDriversStore, type DriverComparison } from '@/store/drivers'
import {
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  rosterCaveatText,
  rosterCheckText,
  rosterWarningText,
  SERVICE_HOURS_NOTE,
  SHORTAGE_WHERE,
  verdictText,
} from '@/components/steps/reach/driverText'

/**
 * 変更指示書と平日便を戻す手順に出す、要る運転士の数(目安)のまとめ(指摘 24・18.1、docs/tasks-1105.md の D04)。
 * 数はすべて store/drivers.ts の compareDrivers が出し、ここでは並べるだけ。欠員・在籍の運転士の数・仮定・場所は、前提情報の手順の
 * 「運行の前提」の欄(steps/research/OperationPremise.tsx)で入れる。在籍の運転士の数は、入れたときだけ参考の数を足す
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
          }),
    [base, version, date, params, places, shortage, roster],
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
 * 欠員(入れたときだけ)と判定、使った仮定を1つのまとまりで出す。印刷で途中から紙を分けない(break-inside-avoid)
 */
export function DriverSummaryView({ comparison, note }: { comparison: DriverComparison; note?: string }) {
  const { before, after, hours, dutyDiff, verdict, shortage, date } = comparison
  // 欠員と判定は、欠員を入れたとき(と平日ダイヤが走らない日)だけ出す
  const showVerdict = verdict.kind === 'enough' || verdict.kind === 'short' || (verdict.kind === 'notWeekday' && shortage !== null)
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
        </tbody>
      </table>
      {showVerdict && (
        <p className={verdict.kind === 'short' ? 'font-semibold' : 'font-medium'} data-testid="driver-summary-verdict">
          {shortage !== null && <span className="mr-1">欠員 {shortage} 人:</span>}
          {verdict.kind === 'short' && <span aria-hidden="true">⚠ </span>}
          {verdictText(verdict, date)}
        </p>
      )}
      {comparison.rosterCheck && (
        <p data-testid="driver-summary-roster">
          {rosterCheckText(comparison.rosterCheck)}
          {rosterWarningText(comparison.rosterCheck) && (
            <span className="ml-1 font-semibold">
              <span aria-hidden="true">⚠ </span>
              {rosterWarningText(comparison.rosterCheck)}
            </span>
          )}
          <span className="ml-1 text-muted-foreground print:text-black">{rosterCaveatText(comparison.operatorRuns)}</span>
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
 * 平日便を戻す手順の1行。勤務の数の目安の今の値(減便前 → 減便後)と、欠員との比較。
 * 影響(到達圏)の手順の欄と同じ比較(useDriverComparison。地図の比較する日付と、下書きを含む減便後)なので、便を戻すたびに変わる。
 * GTFS か比較する日付が無ければ出さない
 */
export function DriverLine() {
  const comparison = useDriverComparison()
  if (!comparison) return null
  return <DriverLineView comparison={comparison} />
}

/** 1行に足す、在籍の運転士の数の参考(在籍を入れたときだけ) */
function RosterLine({ comparison }: { comparison: DriverComparison }) {
  const check = comparison.rosterCheck
  if (!check) return null
  const warning = rosterWarningText(check)
  return (
    <span className="block" data-testid="driver-line-roster">
      {rosterCheckText(check)}
      {warning && (
        <span className="font-medium text-destructive">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </span>
      )}
    </span>
  )
}

/** 1行の中身(store を使わない) */
export function DriverLineView({ comparison }: { comparison: DriverComparison }) {
  const { before, after, dutyDiff, verdict, date } = comparison
  const counts =
    after && dutyDiff !== null
      ? `勤務の数(目安):減便前 ${before.duties.dutyCount} → 減便後${comparison.draft ? '(下書き)' : ''} ${after.duties.dutyCount}(${formatDiff(dutyDiff)}、${formatDateJa(date)})。`
      : `勤務の数(目安):減便前 ${before.duties.dutyCount}(${formatDateJa(date)})。`
  return (
    <p className={`text-xs ${verdict.kind === 'short' ? 'font-medium text-destructive' : ''}`} aria-live="polite" data-testid="driver-line">
      {verdict.kind === 'short' && <span aria-hidden="true">⚠ </span>}
      {counts}
      {verdictText(verdict, date)}
      {verdict.kind === 'noShortage' && SHORTAGE_WHERE}
      {comparison.rosterCheck && <RosterLine comparison={comparison} />}
    </p>
  )
}
