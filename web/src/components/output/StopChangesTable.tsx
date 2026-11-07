import { TriangleAlertIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { stopDiff, type StopChange, type StopDeparture, type StopDiffResult, type StopSide } from '@/gtfs/edit/stopDiff'
import { formatDateJa } from '@/lib/dates'
import { useReachStore } from '@/store/reach'
import { filterStops, losesAll, sortStops, type StopSort } from './stopSort'

/** 1回に表に出す行の数(停留所は千を超えることがあるため。「さらに表示」で足す) */
const PAGE_SIZE = 100

const SORT_LABELS: Record<StopSort, string> = {
  change: '変化の大きい順',
  gap: '最大間隔が広がった順',
  name: '停留所名順',
}

function show(value: string | number | null, unit = ''): string {
  return value === null ? '—' : `${value}${unit}`
}

/** 「前 → 後」。前後が同じなら変化なしとして薄く出す */
function Change({ before, after, unit = '' }: { before: string | number | null; after: string | number | null; unit?: string }) {
  const changed = before !== after
  return (
    <span className={changed ? 'font-medium' : 'text-muted-foreground'}>
      {show(before, unit)} → {show(after, unit)}
    </span>
  )
}

/** 系統の名前(前後の側から探す) */
function routeNameOf(stop: StopChange, routeId: string): string {
  for (const side of [stop.before, stop.after] as StopSide[]) {
    const found = side.byRoute.find((r) => r.routeId === routeId)
    if (found) return found.routeName
  }
  return routeId
}

/** 発車を系統ごとにまとめる(系統は route_id の順、時刻は元の並び) */
function groupByRoute(stop: StopChange, list: readonly StopDeparture[]): { routeId: string; name: string; times: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const d of list) {
    const times = groups.get(d.routeId)
    if (times) times.push(d.time)
    else groups.set(d.routeId, [d.time])
  }
  return [...groups.keys()]
    .sort()
    .map((routeId) => ({ routeId, name: routeNameOf(stop, routeId), times: groups.get(routeId) ?? [] }))
}

function DepartureList({ stop, list, empty }: { stop: StopChange; list: readonly StopDeparture[]; empty: string }) {
  if (list.length === 0) return <p className="text-muted-foreground">{empty}</p>
  return (
    <ul className="flex flex-col gap-0.5">
      {groupByRoute(stop, list).map((g) => (
        <li key={g.routeId}>
          <span className="font-medium">系統 {g.name}:</span> <span className="font-mono tabular-nums">{g.times.join('、')}</span>
        </li>
      ))}
    </ul>
  )
}

/** 出力の手順のタブ「停留所の一覧」。比べる日の、停留所ごとの本数・始発・最終便・最大間隔の前後 */
export default function StopChangesTable() {
  const base = useReachStore((s) => s.source?.feed ?? null)
  const edited = useReachStore((s) => s.edited)
  const date = useReachStore((s) => s.date)

  const result = useMemo<StopDiffResult | null>(
    () => (base && edited && date ? stopDiff(base, edited.feed, date) : null),
    [base, edited, date],
  )

  return (
    <StepSection title="停留所の一覧">
      {!base ? (
        <p className="text-sm text-muted-foreground">GTFS を読み込み、減便の方針を承認すると、停留所ごとの変化を出します。</p>
      ) : !edited ? (
        <p className="text-sm text-muted-foreground">減便の方針を承認すると、停留所ごとの本数・最終便・最大間隔の変化を出します。</p>
      ) : !result ? (
        <p className="text-sm text-destructive">比較する日付を決められません。減便後の GTFS に運行日があるか確かめてください。</p>
      ) : (
        <StopChangesBody result={result} draft={edited.draft} />
      )}
    </StepSection>
  )
}

function StopChangesBody({ result, draft }: { result: StopDiffResult; draft: boolean }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<StopSort>('change')
  const [changedOnly, setChangedOnly] = useState(true)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  const total = result.stops.length
  const rows = useMemo(() => {
    const candidates = changedOnly ? result.stops.filter((s) => s.needsRepost) : result.stops
    return sortStops(filterStops(candidates, query), sort)
  }, [result, changedOnly, query, sort])
  const shown = rows.slice(0, limit)
  const skippedBlank = result.skippedBlankTime.base + result.skippedBlankTime.edited
  const skippedInvalid = result.skippedInvalidTime.base + result.skippedInvalidTime.edited

  const toggle = (stopId: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(stopId)) next.delete(stopId)
      else next.add(stopId)
      return next
    })

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-xs text-muted-foreground">比較する日付</span>
        <Badge variant="outline" className="tabular-nums">
          {formatDateJa(result.date)}
        </Badge>
        <span className="text-xs text-muted-foreground">手順「影響(到達圏)」の地図で選んでいる日付</span>
      </p>
      {draft && (
        <Alert role="status" className="border-amber-400 bg-amber-50 text-amber-950">
          <AlertDescription className="text-xs text-amber-950">承認待ちの下書きで比べています。承認すると確定します。</AlertDescription>
        </Alert>
      )}

      <dl className="grid grid-cols-2 gap-2 text-sm" aria-label="停留所の変化の件数">
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">掲示を差し替える停留所</dt>
          <dd className="text-base font-semibold tabular-nums">
            {result.repostCount}件<span className="text-xs font-normal text-muted-foreground">(全{total}件中)</span>
          </dd>
        </div>
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">発車がすべてなくなる停留所</dt>
          <dd className="text-base font-semibold tabular-nums">{result.stopsLosingAll}件</dd>
        </div>
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">新しく加わる発車時刻がある停留所</dt>
          <dd className="text-base font-semibold tabular-nums">{result.stopsWithAdded}件</dd>
        </div>
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">なくなる発車時刻がある停留所</dt>
          <dd className="text-base font-semibold tabular-nums">{result.stopsWithRemoved}件</dd>
        </div>
      </dl>

      {result.stopsWithAdded > 0 && (
        <Alert className="border-amber-400 bg-amber-50 text-amber-950">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-amber-950">
            新しく加わる発車時刻がある停留所では、減便前の掲示にない時刻に便が発車します。掲示より早い発車は早発になりえます。掲示を差し替えるまでは、利用者に古い時刻を案内しないでください。
          </AlertDescription>
        </Alert>
      )}
      {result.stopsLosingAll > 0 && (
        <p className="text-xs text-muted-foreground">
          発車がすべてなくなる停留所は、この日は便が来ません。掲示の撤去と、休止の届出に当たるかを確かめてください。
        </p>
      )}
      {(skippedBlank > 0 || skippedInvalid > 0) && (
        <p className="text-xs text-muted-foreground">
          発車の時刻が空または読めない行は数えていません({skippedBlank + skippedInvalid}行)。stop_times.txt の departure_time を確かめてください。
        </p>
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t pt-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor="stop-changes-query">停留所名(一部)</Label>
          <Input
            id="stop-changes-query"
            type="search"
            value={query}
            placeholder="例:駅前"
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE_SIZE)
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="stop-changes-sort-label">
            並べ方
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-labelledby="stop-changes-sort-label"
            className="flex-wrap"
            value={sort}
            onValueChange={(v) => {
              // もう一度押して選択が外れたとき('')は、そのままにする
              if (v === 'change' || v === 'gap' || v === 'name') setSort(v)
            }}
          >
            {(Object.keys(SORT_LABELS) as StopSort[]).map((k) => (
              <ToggleGroupItem key={k} value={k} className={SELECTED_TOGGLE_CLASS}>
                {SORT_LABELS[k]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <label className="flex h-8 items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(e) => {
              setChangedOnly(e.target.checked)
              setLimit(PAGE_SIZE)
            }}
          />
          発車時刻が変わる停留所だけ
        </label>
      </div>

      <p className="text-xs text-muted-foreground" role="status">
        {rows.length}件{query.trim() !== '' || changedOnly ? `(全${total}件中)` : ''}
        {rows.length > shown.length ? `のうち先頭の${shown.length}件を表示` : ''}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">条件に合う停留所はありません。</p>
      ) : (
        <Table aria-label="停留所ごとの前後の比較">
          <TableHeader>
            <TableRow>
              <TableHead>停留所</TableHead>
              <TableHead>本数</TableHead>
              <TableHead>始発</TableHead>
              <TableHead>最終便</TableHead>
              <TableHead>最大間隔</TableHead>
              <TableHead>発車時刻</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((stop) => {
              const isOpen = open.has(stop.stopId)
              const detailId = `stop-changes-detail-${stop.stopId}`
              return (
                <StopRows key={stop.stopId} stop={stop} isOpen={isOpen} detailId={detailId} onToggle={() => toggle(stop.stopId)} />
              )
            })}
          </TableBody>
        </Table>
      )}
      {rows.length > shown.length && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
          さらに表示(残り{rows.length - shown.length}件)
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        本数はその日の停留所での発車の数で(各便の終点は数えません)、最大間隔は始発から最終便までの隣り合う発車の間隔の最大です(系統をまとめて数えます)。
      </p>
    </>
  )
}

function StopRows({ stop, isOpen, detailId, onToggle }: { stop: StopChange; isOpen: boolean; detailId: string; onToggle: () => void }) {
  const { before, after } = stop
  return (
    <>
      <TableRow data-stop-id={stop.stopId}>
        <TableCell className="whitespace-normal">
          <span className="font-medium" data-testid="stop-name">
            {stop.stopName}
          </span>
          {losesAll(stop) && <span className="ml-1 rounded bg-destructive/10 px-1 text-xs text-destructive">発車なし</span>}
          {/* 同じ名前の停留所(道路の両側の標柱など)を見分けるため、stop_id を添える */}
          <span className="block font-mono text-[10px] text-muted-foreground" data-testid="stop-id">
            {stop.stopId}
          </span>
        </TableCell>
        <TableCell className="tabular-nums">
          <Change before={before.count} after={after.count} />
        </TableCell>
        <TableCell className="tabular-nums">
          <Change before={before.first} after={after.first} />
        </TableCell>
        <TableCell className="tabular-nums">
          <Change before={before.last} after={after.last} />
        </TableCell>
        <TableCell className="tabular-nums">
          <Change before={before.maxGapMin} after={after.maxGapMin} unit="分" />
        </TableCell>
        <TableCell>
          {stop.needsRepost ? (
            <Button
              variant="outline"
              size="xs"
              aria-expanded={isOpen}
              aria-controls={detailId}
              aria-label={`${stop.stopName}(${stop.stopId})の発車時刻の入れ替えを${isOpen ? '閉じる' : '見る'}`}
              onClick={onToggle}
              className="tabular-nums"
            >
              加わる {stop.added.length}・なくなる {stop.removed.length}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">変化なし</span>
          )}
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow id={detailId}>
          <TableCell colSpan={6} className="whitespace-normal bg-muted/30 text-xs">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <p className="font-medium">新しく加わる発車時刻({stop.added.length}本)</p>
                <DepartureList stop={stop} list={stop.added} empty="ありません" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-medium">なくなる発車時刻({stop.removed.length}本)</p>
                <DepartureList stop={stop} list={stop.removed} empty="ありません" />
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
