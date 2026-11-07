import { CircleCheck, Info, Settings2, TriangleAlert, UserMinus } from 'lucide-react'
import { jumpToPremise, jumpToShortage } from '@/components/steps/stepIds'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LONG_DEPOT_DEADHEAD_MIN, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { formatDateJa } from '@/lib/dates'
import { useDriverComparison, useDriversStore, type DriverComparison } from '@/store/drivers'
import {
  assumptionsSummary,
  DRIVER_PANEL_TITLE,
  DRIVER_PANEL_LEAD,
  driverCaveats,
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  needBasisText,
  ROSTER_HINT,
  OPERATOR_RUNS_NOTE,
  PREMISE_JUMP,
  SERVICE_HOURS_NOTE,
  SHORTAGE_JUMP,
  supplyText,
  supplyWarningText,
  verdictText,
} from './driverText'
import { placesEffectText } from './places'

/**
 * 影響(到達圏)の手順の「要る運転士の数(目安)」の欄(指摘 24・18.1、docs/tasks-1105.md の D03)。結果だけを出す。
 * 比較する日付の、減便前・減便後の便の数・営業運行時間・勤務の数の目安と、入力の運用番号の数から出した要る勤務の数を表で出し、
 * 在籍の運転士の数を入れていれば、乗務できる運転士の数(目安。在籍 × 週の出勤日数 ÷ 7 − 欠員)と減便後に要る勤務の数を比べた
 * 目安を出す(減便前のままでの過不足も並べる)。置いた営業所があれば、置く前と後の勤務の数を表の下に出す。
 * 入力のうち、在籍の運転士の数・週の出勤日数・営業所の位置・仮定は運行の前提の手順の「運行の前提」の欄(research/OperationPremise.tsx)、
 * 欠員は減便の方針の手順の欠員の欄(policy/ShortageSection.tsx)で行い、この欄の「運行の前提で設定する」「欠員を入れる(減便の方針)」で
 * それぞれへ移る。計算は store/drivers.ts(compareDrivers)
 */
export default function DriverPanel() {
  const comparison = useDriverComparison()
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  if (!comparison) return null
  return <DriverView comparison={comparison} params={params} places={places} onOpenPremise={jumpToPremise} onOpenShortage={jumpToShortage} />
}

/** 欄の中身(store を使わない。テストでは値を直接渡す) */
export function DriverView({
  comparison,
  params,
  places,
  onOpenPremise,
  onOpenShortage,
}: {
  comparison: DriverComparison
  params: DutyParams
  places: readonly DutyPlace[]
  /** 「運行の前提で設定する」を押したとき */
  onOpenPremise: () => void
  /** 「欠員を入れる(減便の方針)」を押したとき */
  onOpenShortage: () => void
}) {
  const { verdict } = comparison
  return (
    <section className="flex flex-col gap-2 border-t pt-3 text-sm" aria-labelledby="driver-panel-title">
      <h3 id="driver-panel-title" className="font-medium">
        {DRIVER_PANEL_TITLE}
        {comparison.draft && (
          <Badge variant="outline" className="ml-1.5 border-dashed">
            下書き
          </Badge>
        )}
      </h3>
      <p className="text-xs text-muted-foreground">{DRIVER_PANEL_LEAD}</p>
      <VerdictAlert comparison={comparison} />
      {/* 判定の文が案内のとき(noRoster)は重ねない。減便後が無い・平日でないときも、在籍を入れる案内は出す */}
      {comparison.supply === null && verdict.kind !== 'noRoster' && (
        <p className="text-xs" data-testid="roster-hint">
          {ROSTER_HINT}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        比較する日付:<span className="text-foreground tabular-nums">{formatDateJa(comparison.date)}</span>
      </p>
      <DriverTable comparison={comparison} />
      <DutyWarning comparison={comparison} />
      <SupplyDetails comparison={comparison} />
      <AssumptionsList comparison={comparison} params={params} places={places} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onOpenPremise}>
          <Settings2 aria-hidden="true" />
          {PREMISE_JUMP}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onOpenShortage}>
          <UserMinus aria-hidden="true" />
          {SHORTAGE_JUMP}
        </Button>
      </div>
    </section>
  )
}

/** 判定の囲みの色。足りる目安は落ち着いた緑、足りない目安は警告色、判定なし(案内)は中立 */
const VERDICT_TONE = {
  enough: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
  short: 'border-destructive/40 bg-destructive/5',
  none: '',
} as const

/** 判定の文の囲み(見出しと説明のすぐ下、表より上)。data-tone は enough・short・none */
function VerdictAlert({ comparison }: { comparison: DriverComparison }) {
  const { verdict } = comparison
  const tone = verdict.kind === 'enough' ? 'enough' : verdict.kind === 'short' ? 'short' : 'none'
  const Icon = tone === 'enough' ? CircleCheck : tone === 'short' ? TriangleAlert : Info
  return (
    <Alert
      role="status"
      variant={tone === 'short' ? 'destructive' : 'default'}
      className={VERDICT_TONE[tone]}
      data-testid="driver-verdict"
      data-tone={tone}
    >
      <Icon aria-hidden="true" />
      <AlertDescription className={tone === 'none' ? 'text-foreground' : tone === 'enough' ? 'font-medium text-current' : 'font-medium'}>
        {verdictText(verdict, comparison.date)}
      </AlertDescription>
    </Alert>
  )
}

/**
 * 上限を超えた勤務・回送が長すぎる勤務の注意の文。どちらも無ければ null。
 * 営業所が路線から遠いと、回送だけで上限に近づいて勤務が細かく分かれ、勤務の数が跳ね上がる
 * (道北バスで遠い営業所を1つ置くと 79 → 400 超。回送 30km/h)ので、数を出して置いた場所を確かめてもらう
 */
function dutyWarningText(comparison: DriverComparison): { text: string; overLimit: boolean } | null {
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
  // 回送が長い勤務だけなら(営業所を置くとふつうに出る)補足にとどめ、上限を超える勤務があるときだけ注意にする
  return { text: `${over.any ? '注意' : '補足'}:${parts.join('、')}。${hint}`, overLimit: over.any }
}

/**
 * 上限を超えた勤務・回送が長すぎる勤務の文(どちらも無ければ出さない)。
 * 上限を超える勤務があるときだけ警告色にし、回送が長い勤務だけのときは目立たない補足の文にする
 */
function DutyWarning({ comparison }: { comparison: DriverComparison }) {
  const warning = dutyWarningText(comparison)
  if (warning === null) return null
  // 回送が長い勤務だけの補足は、「断り書きと数え方…」の開閉の中に出す(AssumptionsList)
  if (!warning.overLimit) return null
  return (
    <p className="text-xs font-medium text-destructive" data-testid="duty-warning">
      <span aria-hidden="true">⚠ </span>
      {warning.text}
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
  const { before, after, hours, dutyDiff, operatorRuns, need } = comparison
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
          {operatorRuns !== null && need.basis === 'operatorRuns' && (
            <TableRow>
              <TableHead scope="row" className={ROW_HEAD}>要る勤務の数(入力の運用番号の数から)</TableHead>
              <TableCell className={NUM}>{need.before}</TableCell>
              {after && <TableCell className={NUM}>{need.after ?? '―'}</TableCell>}
              {after && (
                <TableCell className={`${NUM} font-medium`}>{need.after === null ? '―' : formatDiff(need.before - need.after)}</TableCell>
              )}
            </TableRow>
          )}
        </TableBody>
      </Table>
      {(unknown > 0 || !after) && (
        <p className="text-xs text-muted-foreground">
          {unknown > 0 && `時刻が読めない便 ${unknown} 便は、勤務の数に入れていません。`}
          {!after && '減便後の GTFS ができると、減便後と差の列を足します。'}
        </p>
      )}
    </>
  )
}

/** 乗務できる運転士の数(目安)の数え方と、要る勤務の数の出し方(判定の下)。在籍を入れていなければ数え方は出さない */
function SupplyDetails({ comparison }: { comparison: DriverComparison }) {
  const { supply, need, verdict } = comparison
  const warning = supply ? supplyWarningText(supply) : null
  const judged = verdict.kind === 'enough' || verdict.kind === 'short'
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="driver-supply">
      {/* 乗務できる数は判定の文に出ているので、画面には式だけを出し、読み上げには数え方の1文を渡す */}
      {supply && (
        <>
          <p className="text-muted-foreground tabular-nums" aria-hidden="true">
            乗務できる {supply.available} = 在籍 {supply.roster} × {supply.workDays} ÷ 7 − 欠員 {supply.shortage ?? 0}
          </p>
          <p className="sr-only">{supplyText(supply)}</p>
        </>
      )}
      {warning && (
        <p className="font-medium text-destructive" data-testid="supply-warning">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </p>
      )}
      {(judged || need.basis === 'operatorRuns') && <p className="text-muted-foreground">{needBasisText(need)}</p>}
    </div>
  )
}

/** 回送が長い勤務だけのときの補足(開閉の中に出す。上限を超える勤務があるときは DutyWarning で外に出す) */
function DutyNote({ comparison }: { comparison: DriverComparison }) {
  const warning = dutyWarningText(comparison)
  if (warning === null || warning.overLimit) return null
  return <p data-testid="duty-warning">{warning.text}</p>
}

/** 使った仮定のバッジと、開閉の中の断り書き・数え方・詳しい仮定の一覧 */
function AssumptionsList({ comparison, params, places }: { comparison: DriverComparison; params: DutyParams; places: readonly DutyPlace[] }) {
  const summary = assumptionsSummary(params, places)
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">使った仮定</span>
        {/* 読み上げには1つの文で渡し、バッジは目で見る用 */}
        <span className="sr-only" data-testid="assumptions-summary">
          {summary.join('・')}
        </span>
        {summary.map((line) => (
          <Badge key={line} variant="secondary" className="tabular-nums" aria-hidden="true">
            {line}
          </Badge>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-muted-foreground">断り書きと数え方・使った仮定をすべて見る</summary>
        <div className="mt-1 flex flex-col gap-1 text-muted-foreground">
          {comparison.placesEffect && <p data-testid="places-effect">{placesEffectText(comparison.placesEffect)}</p>}
          <DutyNote comparison={comparison} />
          <ul className="flex list-disc flex-col gap-0.5 pl-4" aria-label="要る運転士の数の断り書き">
            {driverCaveats(params, places).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            {SERVICE_HOURS_NOTE}
            {comparison.operatorRuns !== null && OPERATOR_RUNS_NOTE}
          </p>
          <ul className="flex list-disc flex-col gap-0.5 pl-4" aria-label="使った仮定">
            {comparison.assumptions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  )
}
