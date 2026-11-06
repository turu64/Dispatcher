import { jumpToPremise } from '@/components/steps/stepIds'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LONG_DEPOT_DEADHEAD_MIN, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { formatDateJa } from '@/lib/dates'
import { useDriverComparison, useDriversStore, type DriverComparison } from '@/store/drivers'
import {
  assumptionsSummary,
  DRIVER_PANEL_LEAD,
  DRIVER_PANEL_TITLE,
  driverCaveats,
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  OPERATOR_RUNS_NOTE,
  PREMISE_JUMP,
  rosterCaveatText,
  rosterCheckText,
  rosterWarningText,
  SERVICE_HOURS_NOTE,
  SHORTAGE_HINT,
  verdictText,
} from './driverText'
import { placesEffectText } from './places'

/**
 * 影響(到達圏)の手順の「要る運転士の数(目安)」の欄(指摘 24・18.1、docs/tasks-1105.md の D03)。結果だけを出す。
 * 比較する日付の、減便前・減便後の便の数・営業運行時間・勤務の数の目安と、入力の運用番号の数(参考)を表で出し、
 * 欠員を入れていれば、減便で減る勤務の数と比べた目安を出す。在籍の運転士の数を入れていれば、乗務できる運転士(在籍 − 欠員)と
 * 減便後に要る勤務の数を参考に並べる。置いた営業所があれば、置く前と後の勤務の数を表の下に出す。
 * 入力(欠員・在籍の運転士の数・営業所の位置・仮定)は、前提情報の手順の「運行の前提」の欄(research/OperationPremise.tsx)で行い、
 * この欄の「前提情報で設定する」でそこへ移る。計算は store/drivers.ts(compareDrivers)
 */
export default function DriverPanel() {
  const comparison = useDriverComparison()
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  if (!comparison) return null
  return <DriverView comparison={comparison} params={params} places={places} onOpenPremise={jumpToPremise} />
}

/** 欄の中身(store を使わない。テストでは値を直接渡す) */
export function DriverView({
  comparison,
  params,
  places,
  onOpenPremise,
}: {
  comparison: DriverComparison
  params: DutyParams
  places: readonly DutyPlace[]
  /** 「前提情報で設定する」を押したとき */
  onOpenPremise: () => void
}) {
  const { verdict, rosterCheck } = comparison
  const tone =
    verdict.kind === 'short' ? 'font-medium text-destructive' : verdict.kind === 'enough' ? 'font-medium' : 'text-muted-foreground'
  return (
    <section className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm" aria-labelledby="driver-panel-title">
      <h3 id="driver-panel-title" className="font-medium">
        {DRIVER_PANEL_TITLE}
        {comparison.draft && (
          <Badge variant="outline" className="ml-1.5 border-dashed">
            下書き
          </Badge>
        )}
      </h3>
      <p className="text-xs text-muted-foreground">{DRIVER_PANEL_LEAD}</p>
      <p className="text-xs">比較する日付:{formatDateJa(comparison.date)}</p>
      <DriverTable comparison={comparison} />
      {comparison.placesEffect && (
        <p className="text-xs" data-testid="places-effect">
          {placesEffectText(comparison.placesEffect)}
        </p>
      )}
      <DutyWarning comparison={comparison} />
      <p className={tone} role="status" data-testid="driver-verdict">
        {verdict.kind === 'short' && <span aria-hidden="true">⚠ </span>}
        {verdictText(verdict, comparison.date)}
      </p>
      {comparison.shortage === null && (
        <p className="text-xs" data-testid="shortage-hint">
          {SHORTAGE_HINT}
        </p>
      )}
      {rosterCheck && <RosterReference comparison={comparison} />}
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground" aria-label="要る運転士の数の断り書き">
        {driverCaveats(params, places).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <AssumptionsList comparison={comparison} params={params} places={places} />
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onOpenPremise}>
        {PREMISE_JUMP}
      </Button>
      <p className="text-xs text-muted-foreground">欠員・在籍の運転士の数・営業所の位置・推定の仮定は、手順「前提情報」の「運行の前提」の欄で変えられます。</p>
    </section>
  )
}

/**
 * 上限を超えた勤務・回送が長すぎる勤務の注意の文。どちらも無ければ null。
 * 営業所が路線から遠いと、回送だけで上限に近づいて勤務が細かく分かれ、勤務の数が跳ね上がる
 * (道北バスで遠い営業所を1つ置くと 79 → 400 超。回送 30km/h)ので、数を出して置いた場所を確かめてもらう
 */
function dutyWarningText(comparison: DriverComparison): string | null {
  const { before, after, placesEffect } = comparison
  const counts = (pick: (d: DriverComparison['before']['duties']) => number) => {
    const b = pick(before.duties)
    const a = after ? pick(after.duties) : 0
    return { any: b > 0 || a > 0, text: after ? `減便前 ${b}・減便後 ${a}` : `${b}` }
  }
  const over = counts((d) => d.overLimitDuties)
  const long = counts((d) => d.longDeadheadDuties)
  if (!over.any && !long.any) return null
  const parts: string[] = []
  if (over.any) parts.push(`1便だけで改善基準告示の上限を超える勤務 ${over.text}(その便だけで1つの勤務に数えています)`)
  if (long.any) parts.push(`出庫か入庫の回送が片道 ${LONG_DEPOT_DEADHEAD_MIN} 分を超える勤務 ${long.text}`)
  const hint =
    placesEffect || long.any
      ? '営業所が路線から遠いと、回送だけで上限に近づいて勤務が細かく分かれ、勤務の数が大きく増えます。置いた場所が正しいか、ほかの営業所も置いたかを確かめてください。'
      : '長い便は途中の交代を数えていないため、勤務の数が多めに出ることがあります。'
  return `注意:${parts.join('、')}。${hint}`
}

/** 上限を超えた勤務・回送が長すぎる勤務の注意(どちらも無ければ出さない) */
function DutyWarning({ comparison }: { comparison: DriverComparison }) {
  const text = dutyWarningText(comparison)
  if (text === null) return null
  return (
    <p className="text-xs font-medium text-destructive" data-testid="duty-warning">
      <span aria-hidden="true">⚠ </span>
      {text}
    </p>
  )
}

// 左の欄は狭いので、行の見出しは折り返し、数の列は詰める
const ROW_HEAD = 'min-w-[5.5em] px-1.5 font-normal whitespace-normal'
const NUM = 'px-1.5 text-right align-top'
// 営業運行時間の列は「400時間」と「44分」の間でだけ折り返す
const HOURS = `${NUM} whitespace-normal break-keep`

/** 「400時間44分」を、時間と分の間でだけ折り返せる形にする */
function Hours({ text }: { text: string }) {
  const i = text.indexOf('時間')
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i + 2)}
      <wbr />
      {text.slice(i + 2)}
    </>
  )
}

/** 減便前・減便後(・差)の表。減便後が無ければ減便前だけ */
export function DriverTable({ comparison }: { comparison: DriverComparison }) {
  const { before, after, hours, dutyDiff, operatorRuns } = comparison
  const unknown = before.unknownTrips + (after?.unknownTrips ?? 0)
  return (
    <>
      <Table aria-label="減便の前後の便・営業運行時間・勤務の数" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="px-1.5" />
            <TableHead className={`${NUM} whitespace-normal`}>減便前</TableHead>
            {after && <TableHead className={`${NUM} whitespace-normal`}>減便後{comparison.draft ? '(下書き)' : ''}</TableHead>}
            {after && <TableHead className={`${NUM} whitespace-normal`}>差</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          <TableRow>
            <TableHead scope="row" className={ROW_HEAD}>便の数</TableHead>
            <TableCell className={NUM}>{before.hours.trips.toLocaleString('ja-JP')} 便</TableCell>
            {after && hours && <TableCell className={NUM}>{after.hours.trips.toLocaleString('ja-JP')} 便</TableCell>}
            {after && hours && <TableCell className={NUM}>{formatDiff(hours.reduction.trips, ' 便')}</TableCell>}
          </TableRow>
          <TableRow>
            <TableHead scope="row" className={ROW_HEAD}>営業運行時間</TableHead>
            <TableCell className={HOURS}>
              <Hours text={formatHours(before.hours.serviceMinutes)} />
            </TableCell>
            {after && hours && (
              <TableCell className={HOURS}>
                <Hours text={formatHours(after.hours.serviceMinutes)} />
              </TableCell>
            )}
            {after && hours && (
              <TableCell className={HOURS}>
                <Hours text={formatHoursDiff(hours.reduction.serviceMinutes)} />
                {hours.reduction.ratio !== null && hours.reduction.serviceMinutes !== 0 && (
                  <span className="block text-xs text-muted-foreground">{formatRatioDiff(hours.reduction.ratio)}</span>
                )}
              </TableCell>
            )}
          </TableRow>
          <TableRow>
            <TableHead scope="row" className={ROW_HEAD}>勤務の数(目安)</TableHead>
            <TableCell className={NUM}>{before.duties.dutyCount}</TableCell>
            {after && <TableCell className={NUM}>{after.duties.dutyCount}</TableCell>}
            {after && dutyDiff !== null && <TableCell className={`${NUM} font-medium`}>{formatDiff(dutyDiff)}</TableCell>}
          </TableRow>
          {operatorRuns !== null && (
            <TableRow>
              <TableHead scope="row" className={ROW_HEAD}>入力の運用番号の数(参考)</TableHead>
              <TableCell className={NUM}>{operatorRuns}</TableCell>
              {after && <TableCell className={`${NUM} text-muted-foreground`}>―</TableCell>}
              {after && <TableCell className={`${NUM} text-muted-foreground`}>―</TableCell>}
            </TableRow>
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        {SERVICE_HOURS_NOTE}
        {operatorRuns !== null && OPERATOR_RUNS_NOTE}
        {unknown > 0 && `時刻が読めない便 ${unknown} 便は、勤務の数に入れていません。`}
        {!after && '減便後の GTFS ができると、減便後と差の列を足します。'}
      </p>
    </>
  )
}

/** 在籍の運転士の数を入れたときの参考(乗務できる運転士と要る勤務の数)。要る勤務の数が上回れば注意にする */
function RosterReference({ comparison }: { comparison: DriverComparison }) {
  const check = comparison.rosterCheck
  if (!check) return null
  const warning = rosterWarningText(check)
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="roster-check">
      <p>{rosterCheckText(check)}</p>
      {warning && (
        <p className="font-medium text-destructive" data-testid="roster-warning">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </p>
      )}
      <p className="text-muted-foreground">{rosterCaveatText(comparison.operatorRuns)}</p>
    </div>
  )
}

/** 使った仮定の短い一覧と、開閉の中の詳しい一覧 */
function AssumptionsList({ comparison, params, places }: { comparison: DriverComparison; params: DutyParams; places: readonly DutyPlace[] }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p>
        <span className="text-muted-foreground">使った仮定:</span>
        <span data-testid="assumptions-summary">{assumptionsSummary(params, places).join('・')}</span>
      </p>
      <details>
        <summary className="cursor-pointer text-muted-foreground">使った仮定をすべて見る</summary>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground" aria-label="使った仮定">
          {comparison.assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}
