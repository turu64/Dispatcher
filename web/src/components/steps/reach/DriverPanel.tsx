import { useState } from 'react'
import NumberField from '@/components/NumberField'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BOUND_LIMIT_MIN, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { formatDateJa } from '@/lib/dates'
import { MAX_SHORTAGE, useDriverComparison, useDriversStore, type DriverComparison } from '@/store/drivers'
import {
  DEADHEAD_KMH_RANGE,
  DRIVER_PANEL_LEAD,
  DRIVER_PANEL_TITLE,
  driverCaveats,
  formatDiff,
  formatHours,
  formatHoursDiff,
  formatRatioDiff,
  MAX_CHECK_MIN,
  OPERATOR_RUNS_NOTE,
  parseCheckMinutes,
  parseDeadheadKmh,
  parseShortage,
  SERVICE_HOURS_NOTE,
  SHORTAGE_LABEL,
  verdictText,
} from './driverText'

/**
 * 影響(到達圏)の手順の「要る運転士の数(目安)」の欄(指摘 24・18.1、docs/tasks-1105.md の D03)。
 * 比較する日付の、減便前・減便後の便の数・営業運行時間・勤務の数の目安と、入力の運用番号の数(参考)を表で出し、
 * 欠員を入れると、減便で減る勤務の数と比べた目安を出す。仮定は「仮定を変える」の開閉の中で変えられる。
 * 計算は store/drivers.ts(compareDrivers)
 */
export default function DriverPanel() {
  const comparison = useDriverComparison()
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  if (!comparison) return null
  const store = useDriversStore.getState
  return (
    <DriverView
      comparison={comparison}
      params={params}
      places={places}
      onShortage={(v) => store().setShortage(v)}
      onParams={(patch) => store().setParams(patch)}
      onResetParams={() => store().resetParams()}
    />
  )
}

/** 欄の中身(store を使わない。テストでは値を直接渡す) */
export function DriverView({
  comparison,
  params,
  places,
  onShortage,
  onParams,
  onResetParams,
}: {
  comparison: DriverComparison
  params: DutyParams
  places: readonly DutyPlace[]
  onShortage: (value: number | null) => void
  onParams: (patch: Partial<DutyParams>) => void
  onResetParams: () => void
}) {
  const { verdict } = comparison
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
      <ShortageField value={comparison.shortage} onCommit={onShortage} />
      <p className={tone} role="status" data-testid="driver-verdict">
        {verdict.kind === 'short' && <span aria-hidden="true">⚠ </span>}
        {verdictText(verdict, comparison.date)}
      </p>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground" aria-label="要る運転士の数の断り書き">
        {driverCaveats(params, places).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <AssumptionFields comparison={comparison} params={params} onParams={onParams} onReset={onResetParams} />
    </section>
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

/** 欠員の入力欄。空にすると「入れていない」(null)。打っている途中の値で store を壊さないよう、文字は手元に持つ */
export function ShortageField({ value, onCommit }: { value: number | null; onCommit: (value: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== committed) {
    setCommitted(value)
    setText(value === null ? '' : String(value))
    setError(null)
  }
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="driver-shortage" className="text-xs">
        {SHORTAGE_LABEL}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id="driver-shortage"
          type="text"
          inputMode="numeric"
          placeholder="例:20"
          value={text}
          aria-invalid={error !== null}
          className="h-7 w-24 tabular-nums"
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            const r = parseShortage(t)
            if (!r.ok) {
              setError(r.message)
              return
            }
            setError(null)
            setCommitted(r.value)
            onCommit(r.value)
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground">人(0〜{MAX_SHORTAGE})</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** 「仮定を変える」の開閉。拘束の上限・点呼の分・回送の速さを変えると、store の値が変わって計算し直す */
export function AssumptionFields({
  comparison,
  params,
  onParams,
  onReset,
}: {
  comparison: DriverComparison
  params: DutyParams
  onParams: (patch: Partial<DutyParams>) => void
  onReset: () => void
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">
        <span className="font-medium">仮定を変える</span>
        <span className="text-muted-foreground">
          (拘束 {params.maxBoundMin / 60} 時間・点呼 {params.preCheckMin}/{params.postCheckMin} 分・回送 時速 {params.deadheadKmh}km)
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span id="driver-bound-label" className="text-xs">
            拘束時間の上限
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-labelledby="driver-bound-label"
            value={String(params.maxBoundMin)}
            onValueChange={(v) => {
              const n = Number(v)
              if (n === BOUND_LIMIT_MIN.standard || n === BOUND_LIMIT_MIN.extended) onParams({ maxBoundMin: n })
            }}
          >
            <ToggleGroupItem value={String(BOUND_LIMIT_MIN.standard)} className={SELECTED_TOGGLE_CLASS}>
              13 時間(原則)
            </ToggleGroupItem>
            <ToggleGroupItem value={String(BOUND_LIMIT_MIN.extended)} className={SELECTED_TOGGLE_CLASS}>
              15 時間(延長の上限)
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid grid-cols-2 items-end gap-2">
          <NumberField
            id="driver-pre-check"
            label="出庫前の点呼"
            value={params.preCheckMin}
            unit="分"
            max={MAX_CHECK_MIN}
            integer
            parse={parseCheckMinutes}
            onCommit={(v) => onParams({ preCheckMin: v })}
          />
          <NumberField
            id="driver-post-check"
            label="入庫後の点呼"
            value={params.postCheckMin}
            unit="分"
            max={MAX_CHECK_MIN}
            integer
            parse={parseCheckMinutes}
            onCommit={(v) => onParams({ postCheckMin: v })}
          />
          <NumberField
            id="driver-deadhead"
            label="回送の速さ"
            value={params.deadheadKmh}
            unit="km/h"
            max={DEADHEAD_KMH_RANGE.max}
            integer
            parse={parseDeadheadKmh}
            onCommit={(v) => onParams({ deadheadKmh: v })}
          />
        </div>
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground" aria-label="使った仮定">
          {comparison.assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onReset}>
          既定値に戻す
        </Button>
      </div>
    </details>
  )
}
