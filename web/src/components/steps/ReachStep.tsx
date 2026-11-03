import type { ReactNode } from 'react'
import NumberField from '@/components/NumberField'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { formatCount, formatPercent, formatPointChange } from '@/reach/summary'
import { useGtfsStore } from '@/store/gtfs'
import { useReachStore, type ReachSnapshot, type RefState } from '@/store/reach'

/**
 * 手順4:到達圏(減便の前後)。条件の入力と、時間帯ごとの結果の表。減便後の GTFS があれば前後の比較と、運行がゼロになる場所を出す。
 * 地図の色分けは map/ReachLayers.tsx
 */
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
    <StepSection title="4. 到達圏(減便の前後)">
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
          {snapshot && <ReachNotes snapshot={snapshot} />}
          {snapshot && <ZeroServiceSummary snapshot={snapshot} />}
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
 * 表の数の欄。左パネルの幅(380px)に収まるよう、余白を詰める。
 * 割合・推計人口は数の下の行に小さい文字で出す(数の桁によって折り返す行と折り返さない行が混ざらないよう、いつも次の行にする)。
 */
const CELL_CLASS = 'px-1.5 text-right align-top tabular-nums whitespace-normal'

function Sub({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-muted-foreground">{children}</span>
}

function Percent({ value }: { value: string }) {
  return <Sub>({value})</Sub>
}

/** 起点の停留所の数と、除いた停留所の内訳(何を除いたのかを分けて書く) */
export function OriginSummary({ snapshot, invalidStops }: { snapshot: ReachSnapshot; invalidStops: number }) {
  const { origin, result } = snapshot
  const excluded: string[] = []
  if (origin.unused > 0) excluded.push(`stop_times.txt に出てこない ${formatCount(origin.unused)} 件`)
  if (origin.noBoarding > 0) excluded.push(`乗れる行が無い(すべて終点か pickup_type が 1。降車専用)${formatCount(origin.noBoarding)} 件`)
  if (origin.nonStop > 0) excluded.push(`駅舎・出入口など(location_type が 0・空以外)${formatCount(origin.nonStop)} 件`)
  if (invalidStops > 0) excluded.push(`stops.txt の緯度経度が読めない ${formatCount(invalidStops)} 件`)
  return (
    <div className="flex flex-col gap-0.5 text-sm" aria-label="起点の停留所">
      <p>
        {formatDateJa(snapshot.date)}、{snapshot.stepHours}時間ごと。起点の停留所{' '}
        <span className="tabular-nums">{formatCount(origin.origins)}</span> 件
        {result.excludedStops > 0 && (
          <>(うち、緯度経度が地域メッシュの範囲外((0, 0) など)で計算から除いた {formatCount(result.excludedStops)} 件)</>
        )}
        。
      </p>
      <p className="text-xs text-muted-foreground">
        {excluded.length > 0 ? <>起点にしなかった停留所:{excluded.join('、')}。</> : '起点にしなかった停留所はありません。'}
      </p>
    </div>
  )
}

/**
 * 時間帯ごとの「徒歩圏から外れるセル」と推計人口。地図に出している時間帯の行を強調する。
 * 割合の分母は到達できる見込みのあるセル。ダイヤと関係なく外れるセルは、表の最後の別の行に出す(docs/interfaces-1103.md の追記2)。
 * 参照データが無い(fallback)ときは、調べるセルがすべて見込みのあるセルになるので、ダイヤと関係なく外れるセルの行は出さない。
 * 減便後の GTFS があるときは、前後の比較の表にする(docs/interfaces-1104.md §7。分母はどちらも基準の見込みのあるセル)。
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
  const { summary, result } = snapshot
  const hasPopulation = !result.usedFallback
  const { cellsByClass } = summary
  const popText = (n: number) => (hasPopulation ? <>、推計人口 {formatCount(n)} 人</> : null)

  return (
    <div className="flex flex-col gap-2">
      <OriginSummary snapshot={snapshot} invalidStops={invalidStops} />
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
        {hasPopulation && (
          <div className="pl-3">
            <dt className="inline">ダイヤと関係なく外れるセル:</dt>
            <dd className="inline tabular-nums">
              {formatCount(summary.nonCoverableCells)}
              {popText(summary.nonCoverablePopulation)}
            </dd>
          </div>
        )}
      </dl>
      {snapshot.baseline && snapshot.comparison ? (
        <CompareTable snapshot={snapshot} selectedHour={selectedHour} />
      ) : (
        <SingleTable snapshot={snapshot} selectedHour={selectedHour} />
      )}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          外れるセル:到達できる見込みのあるセルのうち、その時間帯に出発がある停留所と鉄道駅のどれも、区分ごとの徒歩圏に無いセル。
          割合の分母は、到達できる見込みのあるセル(区分ごとの徒歩圏に、停留所(出発の有無は問わない)か鉄道駅があるセル)です。
        </p>
        {hasPopulation && (
          <p>
            ダイヤと関係なく外れるセル:停留所から調べる範囲には入るものの、そのセルの区分の徒歩圏に停留所も鉄道駅も無いセル。
            どの時間帯でも外れるので、時間帯ごとの数と割合には含めず、地図にも塗りません。
          </p>
        )}
        {hasPopulation && <p>推計人口は 250m メッシュの人口を 4 等分した値です。</p>}
      </div>
    </div>
  )
}

function rowProps(isSelected: boolean) {
  return {
    'data-selected': isSelected ? 'true' : undefined,
    'aria-current': isSelected ? ('true' as const) : undefined,
    className: isSelected ? 'bg-primary/10 font-medium hover:bg-primary/15' : undefined,
  }
}

/** 基準だけの表(減便後の GTFS が無いとき) */
function SingleTable({ snapshot, selectedHour }: { snapshot: ReachSnapshot; selectedHour: number }) {
  const { summary, bands, result } = snapshot
  const hasPopulation = !result.usedFallback
  const selected = bandIndexForHour(bands, selectedHour)
  return (
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
          return (
            <TableRow key={b.startHour} {...rowProps(i === selected)}>
              <TableCell className="px-1.5 align-top tabular-nums">{b.label}</TableCell>
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
      {hasPopulation && (
        <TableFooter className="bg-transparent font-normal">
          <TableRow data-non-coverable="true">
            <TableCell className="px-1.5 whitespace-normal">ダイヤと関係なく外れる</TableCell>
            <TableCell className={CELL_CLASS}>{formatCount(summary.nonCoverableCells)}</TableCell>
            <TableCell className={CELL_CLASS}>{formatCount(summary.nonCoverablePopulation)}人</TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  )
}

/**
 * 減便の前後の表。割合はセルの数で、分母はどちらも基準(減便前)の到達できる見込みのあるセル。
 * 増減は表に並べた割合(小数1桁)の差(ポイント)。
 */
function CompareTable({ snapshot, selectedHour }: { snapshot: ReachSnapshot; selectedHour: number }) {
  const { summary, bands, result } = snapshot
  const baseline = snapshot.baseline!
  const comparison = snapshot.comparison!
  const hasPopulation = !result.usedFallback
  const selected = bandIndexForHour(bands, selectedHour)
  const denominator = baseline.summary.coverableCells
  const pop = (n: number) => (hasPopulation ? <Sub>({formatCount(n)}人)</Sub> : null)
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">
        減便の前後{snapshot.draft && <Badge variant="outline" className="ml-1.5 border-dashed">下書き</Badge>}
      </h3>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="px-1 align-bottom whitespace-nowrap">時間帯</TableHead>
            <TableHead className="px-1 text-right align-bottom whitespace-normal">減便前の外れる割合</TableHead>
            <TableHead className="px-1 text-right align-bottom whitespace-normal">減便後の外れる割合</TableHead>
            <TableHead className="px-1 text-right align-bottom whitespace-normal">増減(ポイント)</TableHead>
            <TableHead className="px-1 text-right align-bottom whitespace-normal">減便で外れたセル{hasPopulation && '(推計人口)'}</TableHead>
            <TableHead className="px-1 text-right align-bottom whitespace-normal">新たに到達{hasPopulation && '(推計人口)'}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bands.map((b, i) => {
            const before = baseline.summary.bands[i].unreachableCells
            const after = summary.bands[i].unreachableCells
            const c = comparison.bands[i]
            return (
              <TableRow key={b.startHour} {...rowProps(i === selected)}>
                <TableCell className="px-1 align-top tabular-nums whitespace-nowrap">{b.label}</TableCell>
                <TableCell className={CELL_CLASS}>{formatPercent(before, denominator)}</TableCell>
                <TableCell className={CELL_CLASS}>{formatPercent(after, denominator)}</TableCell>
                <TableCell className={CELL_CLASS}>{formatPointChange(before, after, denominator)}</TableCell>
                <TableCell className={CELL_CLASS}>
                  {formatCount(c.lostCells)}
                  {pop(c.lostPopulation)}
                </TableCell>
                <TableCell className={CELL_CLASS}>
                  {formatCount(c.gainedCells)}
                  {pop(c.gainedPopulation)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        割合はセルの数で数え、分母はどちらも減便前の到達できる見込みのあるセル({formatCount(denominator)})です。同じ日付の、減便前(読み込んだ
        GTFS)と減便後{snapshot.draft ? '(承認前の下書き)' : ''}を比べています。
      </p>
    </div>
  )
}

/** 一日を通して乗れなくなる場所、運行がゼロになる停留所・系統(減便後の GTFS があるときだけ) */
export function ZeroServiceSummary({ snapshot }: { snapshot: ReachSnapshot }) {
  const { comparison, zeroStops, zeroRoutes, result } = snapshot
  if (!comparison || !zeroStops || !zeroRoutes) return null
  const hasPopulation = !result.usedFallback
  const feedStops = zeroStops.filter((s) => s.scope === 'feed').length
  const feedRoutes = zeroRoutes.filter((r) => r.scope === 'feed').length
  return (
    <section className="flex flex-col gap-2 text-sm" aria-label="運行がゼロになる場所">
      <p className={comparison.dayLostCells > 0 ? 'font-medium text-destructive' : undefined}>
        {comparison.dayLostCells > 0 && <span aria-hidden="true">⚠ </span>}
        一日を通して乗れなくなる場所:<span className="tabular-nums">{formatCount(comparison.dayLostCells)}</span> セル
        {hasPopulation && <>(推計人口 {formatCount(comparison.dayLostPopulation)} 人)</>}
        <span className="block text-xs font-normal text-muted-foreground">
          減便前はこの日のどれかの時間帯に到達でき、減便後はどの時間帯にも到達できないセル。
        </span>
      </p>
      <div>
        <p className="font-medium">
          運行がゼロになる停留所:<span className="tabular-nums">{formatCount(zeroStops.length)}</span> 件
          {zeroStops.length > 0 && <>(うち、出力のどの日にも便が来ない停留所 {formatCount(feedStops)} 件)</>}
        </p>
        {feedStops > 0 && (
          <p className="text-xs text-destructive">
            <span aria-hidden="true">⚠ </span>
            「全日」の停留所は、出力のどの日にも便が来ません。掲示の撤去と、休止の届出に当たるかを確かめてください。
          </p>
        )}
        {zeroStops.length > 0 && (
          <ul className="mt-1 flex flex-col text-xs">
            {zeroStops.slice(0, MAX_ZERO_STOPS).map((s) => (
              <li key={s.stopId} className="break-words">
                <ScopeMark scope={s.scope} /> {s.name}
                <span className="ml-1 font-mono text-muted-foreground">{s.stopId}</span>(減便前のこの日の出発 {s.beforeDepartures} 本)
              </li>
            ))}
            {zeroStops.length > MAX_ZERO_STOPS && <li className="text-muted-foreground">ほか {zeroStops.length - MAX_ZERO_STOPS} 件</li>}
          </ul>
        )}
      </div>
      <div>
        <p className="font-medium">
          運行がゼロになる系統:<span className="tabular-nums">{formatCount(zeroRoutes.length)}</span> 系統
          {zeroRoutes.length > 0 && <>(うち、全曜日で便がなくなる系統 {formatCount(feedRoutes)})</>}
        </p>
        {zeroRoutes.length > 0 && (
          <>
            <p className="text-xs text-destructive">
              <span aria-hidden="true">⚠ </span>
              運行がゼロになります。路線の休止の届出に当たるかを運輸支局に確認してください。
            </p>
            <ul className="mt-1 flex flex-col text-xs">
              {zeroRoutes.map((r) => (
                <li key={r.routeId} className="break-words">
                  <ScopeMark scope={r.scope} /> {r.name}
                  {r.name !== r.routeId && <span className="ml-1 font-mono text-muted-foreground">{r.routeId}</span>}(
                  {r.scope === 'feed' ? `基準の全便 ${r.beforeTrips} 本` : `減便前のこの日の便 ${r.beforeTrips} 本`})
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        記号:全日=出力のどの日にも便が無い、この日=選んだ日だけ便が 0。Dispatcher は届出の要否を判定しません。
      </p>
    </section>
  )
}

const MAX_ZERO_STOPS = 20

function ScopeMark({ scope }: { scope: 'day' | 'feed' }) {
  return scope === 'feed' ? (
    <Badge variant="destructive" className="px-1 py-0 text-[10px]">
      全日
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1 py-0 text-[10px]">
      この日
    </Badge>
  )
}

/** 計算から除いたもの・数えなかったものの注意 */
export function ReachNotes({ snapshot }: { snapshot: ReachSnapshot }) {
  const { departures, result, summary } = snapshot
  const notes: string[] = []
  if (departures.skippedBlankTime > 0) {
    notes.push(`departure_time が空の行 ${formatCount(departures.skippedBlankTime)} 件は、出発として数えていません(補間はしません)。`)
  }
  if (departures.skippedInvalidTime > 0) {
    notes.push(`departure_time が時刻として読めない行 ${formatCount(departures.skippedInvalidTime)} 件は、出発として数えていません。`)
  }
  if (departures.hasFrequencies) {
    notes.push('frequencies.txt があります。運行間隔で表した便は展開せず、stop_times.txt の時刻だけで数えています。')
  }
  if (!result.usedFallback && summary.totalCells === 0) {
    notes.push(
      '参照データは読めましたが、停留所のまわりの 250m メッシュの人口がすべて 0 人(または参照データの範囲の外)のため、調べるセルがありません(人口が 1 人以上のセルだけを調べます)。停留所の緯度経度と、参照データの範囲(1次メッシュ)を確かめてください。',
    )
  }
  if (departures.counts.size === 0) notes.push(snapshot.baseline ? '減便後のこの日に出発がある停留所はありません。' : 'この日に出発がある停留所はありません。')
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
