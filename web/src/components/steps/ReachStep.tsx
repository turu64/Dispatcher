import NumberField from '@/components/NumberField'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDateJa } from '@/lib/dates'
import {
  bandIndexForHour,
  MAX_WALK_MINUTES,
  parseDensityThreshold,
  parseWalkMinutes,
  REGION_CLASSES,
  REGION_LABELS,
} from '@/reach/input'
import type { ReachParams, RegionClass } from '@/reach/reach'
import { formatCount, formatPercent } from '@/reach/summary'
import { useGtfsStore } from '@/store/gtfs'
import { useReachStore, type ReachSnapshot, type RefState } from '@/store/reach'

/** 手順3:到達圏。条件の入力と、時間帯ごとの結果の表。地図の色分けは map/ReachLayers.tsx */
export default function ReachStep() {
  const feed = useGtfsStore((s) => s.feed)
  const invalidStops = useGtfsStore((s) => s.invalidStops)
  const ref = useReachStore((s) => s.ref)
  const snapshot = useReachStore((s) => s.snapshot)
  const computing = useReachStore((s) => s.computing)
  const error = useReachStore((s) => s.error)
  const selectedHour = useReachStore((s) => s.selectedHour)
  const params = useReachStore((s) => s.params)
  const fallbackClass = useReachStore((s) => s.fallbackClass)
  const store = useReachStore.getState

  return (
    <StepSection title="3. 到達圏">
      {!feed ? (
        <p className="text-sm text-muted-foreground">手順1で GTFS を読み込むと、選んだ日付・時間帯の到達圏を計算します。</p>
      ) : (
        <>
          <RefStatus
            refState={ref}
            fallbackClass={fallbackClass}
            onRetry={() => store().retryRef()}
            onFallbackChange={(c) => store().setFallbackClass(c)}
          />
          {computing && (
            <p className="text-sm" role="status">
              計算中…
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {snapshot && <ReachSummaryTable snapshot={snapshot} selectedHour={selectedHour} invalidStops={invalidStops} />}
          {snapshot && <ReachNotes snapshot={snapshot} invalidStops={invalidStops} />}
          <ReachConditions
            params={params}
            onThreshold={(v) => store().setDensityThreshold(v)}
            onMinutes={(c, k, v) => store().setWalkMinutes(c, k, v)}
            onReset={() => store().resetParams()}
          />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        鉄道駅は時刻表データが無いため、6〜24時のすべての時間帯で使えるものとみなしています。
      </p>
    </StepSection>
  )
}

/** 参照データ(人口・人口集中地区・鉄道駅)の読み込みの状態。読めなければ注意と、区分の選択を出す */
export function RefStatus({
  refState,
  fallbackClass,
  onRetry,
  onFallbackChange,
}: {
  refState: RefState
  fallbackClass: RegionClass
  onRetry: () => void
  onFallbackChange: (c: RegionClass) => void
}) {
  if (refState.status === 'idle') return null
  if (refState.status === 'loading') {
    return <p className="text-sm text-muted-foreground">参照データ(人口・人口集中地区・鉄道駅)を読み込み中…</p>
  }
  const r = refState.result
  if (r.ok) {
    return (
      <p className="text-xs text-muted-foreground">
        参照データ:1次メッシュ {r.mesh1s.join('・')}({r.mesh1s.length} 件)、鉄道駅 {r.stations.length} 駅
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Alert className="border-amber-400 bg-amber-50 text-amber-950">
        <AlertDescription className="text-amber-950">
          <p>{r.message}</p>
          <p>
            参照データが無いため、すべてのセルを下で選ぶ区分とみなし、鉄道駅は無いものとして計算しています。推計人口は出せません。
          </p>
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium" id="reach-fallback-label">
          参照データが無いときの区分
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-labelledby="reach-fallback-label"
          value={fallbackClass}
          onValueChange={(v) => {
            if (REGION_CLASSES.includes(v as RegionClass)) onFallbackChange(v as RegionClass)
          }}
        >
          {REGION_CLASSES.map((c) => (
            <ToggleGroupItem key={c} value={c} className={SELECTED_TOGGLE_CLASS}>
              {REGION_LABELS[c]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRetry}>
        参照データを読み込み直す
      </Button>
    </div>
  )
}

/**
 * 表の数の欄。左パネルの幅(380px)に収まるよう、余白を詰め、割合は小さい文字で数のあとに続ける。
 * 欄が狭いとき(人口が7桁になるときなど)は、割合が次の行に折り返る(横にはみ出して切れない)。
 */
const CELL_CLASS = 'px-1.5 text-right tabular-nums whitespace-normal'

function Percent({ value }: { value: string }) {
  return <span className="ml-0.5 inline-block text-xs text-muted-foreground">({value})</span>
}

/**
 * 時間帯ごとの「徒歩圏から外れるセル」と推計人口。地図に出している時間帯の行を強調する。
 * 割合の分母は到達できる見込みのあるセル。ダイヤと関係なく外れるセルは、表の最後の別の行に出す(docs/interfaces-1103.md の追記2)
 */
export function ReachSummaryTable({
  snapshot,
  selectedHour,
  invalidStops,
}: {
  snapshot: ReachSnapshot
  selectedHour: number
  /** stops.txt の緯度経度が読めず、toStops で除いた停留所の数 */
  invalidStops: number
}) {
  const { summary, bands, result, origin } = snapshot
  const hasPopulation = !result.usedFallback
  const selected = bandIndexForHour(bands, selectedHour)
  const { cellsByClass } = summary
  const popText = (n: number) => (hasPopulation ? <>、推計人口 {formatCount(n)} 人</> : null)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {formatDateJa(snapshot.date)}、{snapshot.stepHours}時間ごと。起点の停留所{' '}
        <span className="tabular-nums">{formatCount(origin.origins)}</span> 件(stop_times.txt に出てこない{' '}
        {formatCount(origin.unused)} 件
        {origin.nonStop > 0 && <>と、駅舎・出入口などの {formatCount(origin.nonStop)} 件</>}
        は除く)。除いた停留所 {formatCount(invalidStops + result.excludedStops)} 件。
      </p>
      <dl className="flex flex-col gap-0.5 text-sm" aria-label="調べたセルの内訳">
        <div>
          <dt className="inline">調べたセル(125m):</dt>
          <dd className="inline tabular-nums">
            {formatCount(summary.totalCells)}(都市部 {formatCount(cellsByClass.urban)}・郊外 {formatCount(cellsByClass.suburban)}
            ・中山間・地方 {formatCount(cellsByClass.rural)}){popText(summary.totalPopulation)}
          </dd>
        </div>
        <div className="pl-3">
          <dt className="inline">到達できる見込みのあるセル:</dt>
          <dd className="inline tabular-nums">
            {formatCount(summary.coverableCells)}
            {popText(summary.coverablePopulation)}(表の割合の分母)
          </dd>
        </div>
        <div className="pl-3">
          <dt className="inline">ダイヤと関係なく外れるセル:</dt>
          <dd className="inline tabular-nums">
            {formatCount(summary.nonCoverableCells)}
            {popText(summary.nonCoverablePopulation)}
          </dd>
        </div>
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-1.5">時間帯</TableHead>
            <TableHead className="px-1.5 text-right">外れるセル</TableHead>
            {hasPopulation && <TableHead className="px-1.5 text-right">推計人口</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {bands.map((b, i) => {
            const s = summary.bands[i]
            const isSelected = i === selected
            return (
              <TableRow
                key={b.startHour}
                data-selected={isSelected ? 'true' : undefined}
                aria-current={isSelected ? 'true' : undefined}
                className={isSelected ? 'bg-primary/10 font-medium hover:bg-primary/15' : undefined}
              >
                <TableCell className="px-1.5 tabular-nums">{b.label}</TableCell>
                <TableCell className={CELL_CLASS}>
                  {formatCount(s.unreachableCells)}
                  <Percent value={formatPercent(s.unreachableCells, summary.coverableCells)} />
                </TableCell>
                {hasPopulation && (
                  <TableCell className={CELL_CLASS}>
                    {formatCount(s.unreachablePopulation)}人
                    <Percent value={formatPercent(s.unreachablePopulation, summary.coverablePopulation)} />
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
        <TableFooter className="bg-transparent font-normal">
          <TableRow data-non-coverable="true">
            <TableCell className="px-1.5 whitespace-normal">ダイヤと関係なく外れる</TableCell>
            <TableCell className={CELL_CLASS}>{formatCount(summary.nonCoverableCells)}</TableCell>
            {hasPopulation && <TableCell className={CELL_CLASS}>{formatCount(summary.nonCoverablePopulation)}人</TableCell>}
          </TableRow>
        </TableFooter>
      </Table>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          外れるセル:到達できる見込みのあるセルのうち、その時間帯に出発がある停留所と鉄道駅のどれも、区分ごとの徒歩圏に無いセル。
          割合の分母は、到達できる見込みのあるセル(区分ごとの徒歩圏に、停留所(出発の有無は問わない)か鉄道駅があるセル)です。
        </p>
        <p>
          ダイヤと関係なく外れるセル:停留所から調べる範囲には入るものの、そのセルの区分の徒歩圏に停留所も鉄道駅も無いセル。
          どの時間帯でも外れるので、時間帯ごとの数と割合には含めず、地図にも塗りません。
        </p>
        {hasPopulation && <p>推計人口は 250m メッシュの人口を 4 等分した値です。</p>}
      </div>
    </div>
  )
}

/** 計算から除いたもの・数えなかったものの注意 */
export function ReachNotes({ snapshot, invalidStops }: { snapshot: ReachSnapshot; invalidStops: number }) {
  const { departures, result } = snapshot
  const notes: string[] = []
  if (invalidStops > 0) notes.push(`stops.txt の緯度経度が読めない停留所 ${formatCount(invalidStops)} 件を除きました。`)
  if (result.excludedStops > 0) {
    notes.push(`緯度経度が地域メッシュの範囲外((0, 0) など)の停留所 ${formatCount(result.excludedStops)} 件を除きました。`)
  }
  if (departures.skippedBlankTime > 0) {
    notes.push(`departure_time が空の行 ${formatCount(departures.skippedBlankTime)} 件は、出発として数えていません(補間はしません)。`)
  }
  if (departures.skippedInvalidTime > 0) {
    notes.push(`departure_time が時刻として読めない行 ${formatCount(departures.skippedInvalidTime)} 件は、出発として数えていません。`)
  }
  if (departures.hasFrequencies) {
    notes.push('frequencies.txt があります。運行間隔で表した便は展開せず、stop_times.txt の時刻だけで数えています。')
  }
  if (departures.counts.size === 0) notes.push('この日に出発がある停留所はありません。')
  if (notes.length === 0) return null
  return (
    <Alert className="border-amber-400 bg-amber-50 text-amber-950">
      <AlertDescription className="text-amber-950">
        <ul className="list-disc pl-4">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** しきい値と、区分 × バス停・駅の徒歩の分数 */
export function ReachConditions({
  params,
  onThreshold,
  onMinutes,
  onReset,
}: {
  params: ReachParams
  onThreshold: (v: number) => void
  onMinutes: (c: RegionClass, kind: 'bus' | 'rail', v: number) => void
  onReset: () => void
}) {
  return (
    <details className="rounded-lg border px-3 py-2 text-sm">
      <summary className="cursor-pointer">
        <span className="font-medium">徒歩圏の条件</span>
        <span className="text-xs text-muted-foreground">
          (バス停/鉄道駅:
          {REGION_CLASSES.map((c) => `${REGION_LABELS[c]} ${params.walkMinutes[c].bus}/${params.walkMinutes[c].rail}分`).join('、')}
          。人口密度 {params.densityThreshold.toLocaleString('ja-JP')}人/km²)
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <NumberField
          id="reach-threshold"
          label="郊外と中山間・地方を分ける人口密度(人口集中地区の外)"
          value={params.densityThreshold}
          unit="人/km²"
          step={100}
          parse={parseDensityThreshold}
          onCommit={onThreshold}
        />
        <div className="grid grid-cols-[auto_1fr_1fr] items-end gap-x-2 gap-y-2">
          {REGION_CLASSES.map((c) => (
            <div key={c} className="contents">
              <span className="pb-1.5 text-xs">{REGION_LABELS[c]}</span>
              <NumberField
                id={`reach-${c}-bus`}
                label="バス停"
                value={params.walkMinutes[c].bus}
                unit="分"
                max={MAX_WALK_MINUTES}
                integer
                parse={parseWalkMinutes}
                onCommit={(v) => onMinutes(c, 'bus', v)}
              />
              <NumberField
                id={`reach-${c}-rail`}
                label="鉄道駅"
                value={params.walkMinutes[c].rail}
                unit="分"
                max={MAX_WALK_MINUTES}
                integer
                parse={parseWalkMinutes}
                onCommit={(v) => onMinutes(c, 'rail', v)}
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          徒歩は分速 {params.speedMPerMin}m、距離は直線で測ります。分数は 0〜{MAX_WALK_MINUTES} 分の整数。
        </p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onReset}>
          既定値に戻す
        </Button>
      </div>
    </details>
  )
}
