import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { NOTICE47_BANDS, type RouteDiff, type TripBrief, type WeekdayDiff } from '@/gtfs/edit/diff'
import type { Form2Result } from '@/gtfs/edit/form2'
import { FromTo } from '../editParts'
import { addBackRejections } from '../editText'
import type { RouteStat } from './stats'
import { totals } from './stats'

/** 入れ替えから外す系統(§3)。除外は推定しない(既定はどれも外さない) */
export function ExcludedRoutes({
  stats,
  excluded,
  onChange,
  replacementLabel,
  open,
  onOpenChange,
}: {
  stats: RouteStat[]
  excluded: string[]
  onChange: (v: string[]) => void
  replacementLabel: string
  /** 開いているか(渡せば呼ぶ側が開け閉めを持つ。減便の方針の確認の結果の「詳しい設定を開く」から開くため) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const weekdayOnly = stats.filter((s) => s.replacement === 0).length
  return (
    <details className="text-sm" open={open} onToggle={onOpenChange ? (e) => onOpenChange(e.currentTarget.open) : undefined}>
      <summary className="cursor-pointer">
        入れ替えから外す系統{excluded.length > 0 ? `(${excluded.length} 系統を外す)` : '(既定はどれも外さない)'}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {weekdayOnly > 0 && (
          <p className="rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
            <span aria-hidden="true">! </span>
            {replacementLabel}の便がない系統({weekdayOnly} 系統。表の先頭)は、入れ替えると全曜日で便がなくなります。路線の休止の届出に当たるかを運輸支局に確認してください。除外すると平日の便がそのまま残ります。
          </p>
        )}
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-6 px-1">
                <span className="sr-only">外す</span>
              </TableHead>
              <TableHead className="px-1">系統</TableHead>
              <TableHead className="px-1 text-right">平日</TableHead>
              <TableHead className="px-1 text-right">{replacementLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.map((s) => {
              const checked = excluded.includes(s.routeId)
              return (
                <TableRow key={s.routeId}>
                  <TableCell className="px-1">
                    <input
                      type="checkbox"
                      aria-label={`${s.name}(${s.routeId})を入れ替えから外す`}
                      checked={checked}
                      onChange={(e) => onChange(e.target.checked ? [...excluded, s.routeId] : excluded.filter((r) => r !== s.routeId))}
                      className="size-4 accent-primary"
                    />
                  </TableCell>
                  <TableCell className="px-1 whitespace-normal break-words">
                    {s.name}
                    {s.name !== s.routeId && <span className="ml-1 font-mono text-muted-foreground">{s.routeId}</span>}
                  </TableCell>
                  <TableCell className="px-1 text-right tabular-nums">{s.weekday}</TableCell>
                  <TableCell className="px-1 text-right tabular-nums">
                    {s.replacement === 0 ? (
                      <span className="font-semibold">
                        0<span aria-hidden="true"> !</span>
                      </span>
                    ) : (
                      s.replacement
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">外した系統は平日の便をそのまま残し、{replacementLabel}の便は加わりません。</p>
      </div>
    </details>
  )
}

/** 比べる棒の1本分(前または後)。残る便は灰色、消える便は赤、入る便は主の色。全体の幅は前後で大きい方を 100% にそろえる */
function CompareBar({ label, same, other, otherKind, scale }: { label: string; same: number; other: number; otherKind: 'removed' | 'added'; scale: number }) {
  const pct = (n: number) => (scale > 0 ? (n / scale) * 100 : 0)
  return (
    <div className="flex items-center gap-2">
      <span className="w-11 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
        <div className="bg-muted-foreground/50" style={{ width: `${pct(same)}%` }} />
        <div className={otherKind === 'removed' ? 'bg-destructive' : 'bg-primary'} style={{ width: `${pct(other)}%` }} />
      </div>
    </div>
  )
}

/** 便数の表示(3桁ごとに区切る。組の内訳と同じ) */
function num(n: number): string {
  return n.toLocaleString('ja-JP')
}

/**
 * 件数(§6 の 1)。先頭に平日の便数の前 → 後を大きく出し、消える・入る・残るの便数を並べる。
 * 全曜日で便がなくなる系統があれば、その名前を目立つ枠で出す(最も重い影響なので見落とさせない)
 */
export function DiffCounts({ diff, result }: { diff: WeekdayDiff; result: Form2Result }) {
  const { before, after } = totals(diff)
  const excludedCount = diff.byRoute.filter((r) => r.excluded).length
  const addBack = result.report.addBack
  const rejected = addBackRejections(addBack, result.plan.kind)
  const vanishing = diff.byRoute.filter((r) => r.vanishes)
  const delta = after - before
  const percent = before > 0 ? Math.round((Math.abs(delta) / before) * 100) : null
  const scale = Math.max(before, after, 1)
  const removed = diff.removed.length
  const added = diff.added.length
  const same = diff.same.length
  return (
    <div role="group" aria-label="平日便の件数" className="flex flex-col gap-2 text-sm">
      <div className="rounded-md border bg-card px-3 py-2">
        <p className="text-xs text-muted-foreground">平日の便数(減便前 → 減便後)</p>
        <p className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
          <span className="text-2xl font-semibold">{num(before)}</span>
          <span aria-hidden="true" className="text-lg text-muted-foreground">
            →
          </span>
          <span className="sr-only">から</span>
          <span className={`text-2xl font-semibold ${delta < 0 ? 'text-destructive' : ''}`}>{num(after)}</span>
          <span className="text-sm">便</span>
          {delta !== 0 && (
            <span className={`ml-1 text-sm ${delta < 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
              {delta < 0 && <span aria-hidden="true">▼ </span>}
              {delta < 0 ? '−' : '+'}
              {num(Math.abs(delta))} 便{percent !== null && `(${percent}%)`}
              {delta < 0 && <span className="sr-only">減る</span>}
            </span>
          )}
        </p>
        <p className="mt-1 tabular-nums" aria-label="なくなる便・加わる便・同じ便の内訳">
          <span className={removed > 0 ? 'font-semibold text-destructive' : undefined}>なくなる便 {num(removed)} 便</span>
          <span aria-hidden="true">・</span>
          <span className={added > 0 ? 'font-semibold text-primary' : undefined}>加わる便 {num(added)} 便</span>
          <span aria-hidden="true">・</span>
          <span>同じ便 {num(same)} 便</span>
        </p>
        <div className="mt-1.5 flex flex-col gap-1" role="img" aria-label={`減便前 ${num(before)} 便(同じ便 ${num(same)}・なくなる便 ${num(removed)})、減便後 ${num(after)} 便(同じ便 ${num(same)}・加わる便 ${num(added)})`}>
          <CompareBar label="減便前" same={same} other={removed} otherKind="removed" scale={scale} />
          <CompareBar label="減便後" same={same} other={added} otherKind="added" scale={scale} />
        </div>
      </div>
      {vanishing.length > 0 && (
        <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-destructive" data-vanishing-banner="true">
          <p className="font-semibold">
            <span aria-hidden="true">⚠ </span>全曜日で便がなくなる系統が {vanishing.length} 系統あります
          </p>
          <ul className="mt-0.5 list-disc pl-5 text-xs">
            {vanishing.map((r) => (
              <li key={r.routeId}>
                {r.routeName}(平日 {r.before} 便 → {r.after} 便)
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-xs">路線の休止の届出に当たるかを運輸支局に確認してください。除外すると平日の便がそのまま残ります。</p>
        </div>
      )}
      <dl className="flex flex-col gap-0.5">
        <div>
          <dt className="inline">除外した系統:</dt>
          <dd className="inline tabular-nums">{excludedCount} 系統</dd>
        </div>
        <div className={diff.vanishingRoutes > 0 ? 'font-semibold text-destructive' : undefined}>
          <dt className="inline">
            {diff.vanishingRoutes > 0 && <span aria-hidden="true">⚠ </span>}全曜日で便がなくなる系統:
          </dt>
          <dd className="inline tabular-nums">{diff.vanishingRoutes} 系統</dd>
        </div>
        {addBack.requested > 0 && (
          <div>
            <dt className="inline">平日に戻す便:</dt>
            <dd className="inline tabular-nums">
              選んだ {addBack.requested} 便のうち、受け付け {addBack.accepted.length} 便
              {rejected.length > 0 && `、受け付けなかった便 ${rejected.length} 便(理由は手順「平日便を戻す」に出ています)`}
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

const EARLIER = (r: RouteDiff) =>
  r.lastDepartureBefore !== null && r.lastDepartureAfter !== null && r.lastDepartureAfter < r.lastDepartureBefore

/** 系統ごとの表(§6 の 2)。系統を開くと、消える便と入る便を始発の時刻順に並べる(§6 の 5) */
export function RouteDiffList({ diff }: { diff: WeekdayDiff }) {
  const earlier = diff.byRoute.filter(EARLIER).length
  const vanishing = diff.byRoute.filter((r) => r.vanishes).length
  // 全曜日で便がなくなる系統を先頭に(あとは今の並び=route_id の順)
  const routes = [...diff.byRoute.filter((r) => r.vanishes), ...diff.byRoute.filter((r) => !r.vanishes)]
  return (
    <details open className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">
        系統ごと({diff.byRoute.length} 系統{vanishing > 0 && `。全曜日で便なし ${vanishing}`}{earlier > 0 && `。終発が早まる系統 ${earlier}`})
      </summary>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2 border-b pb-1 text-[11px] text-muted-foreground">
        <span>系統</span>
        <span className="text-right">平日便</span>
        <span className="text-right">始発</span>
        <span className="text-right">終発</span>
      </div>
      <ul className="flex flex-col">
        {routes.map((r) => (
          <RouteDiffRow key={r.routeId} route={r} diff={diff} />
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        記号:除=入れ替えから外した系統、⚠=全曜日で便がなくなる系統、▼=減る・早まる。始発・終発は平日の始発便・終発便の発車時刻(減便前 → 減便後)。
      </p>
    </details>
  )
}

function RouteDiffRow({ route: r, diff }: { route: RouteDiff; diff: WeekdayDiff }) {
  const earlier = EARLIER(r)
  const removed = diff.removed.filter((t) => t.routeId === r.routeId)
  const added = diff.added.filter((t) => t.routeId === r.routeId)
  const clock = (v: string | null) => v ?? '—'
  return (
    <li className={`border-b py-0.5 ${r.vanishes ? 'rounded-sm border-l-2 border-l-destructive bg-destructive/10 pl-1' : ''}`} data-route={r.routeId}>
      <details>
        <summary className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-2">
          {/* 印は系統名の下の行に置く(380px の幅で系統名が3行に折れないように) */}
          <span className="min-w-0">
            <span className="block break-words">{r.routeName}</span>
            {(r.excluded || r.vanishes) && (
              <span className="mt-0.5 flex flex-wrap gap-1">
                {r.excluded && (
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    除
                  </Badge>
                )}
                {r.vanishes && (
                  <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                    ⚠ 全曜日で便なし
                  </Badge>
                )}
              </span>
            )}
          </span>
          <FromTo before={r.before} after={r.after} emphasizeDecrease={r.after < r.before} />
          <span className="text-right tabular-nums">
            {clock(r.firstDepartureBefore)}→{clock(r.firstDepartureAfter)}
          </span>
          <span className={`text-right tabular-nums ${earlier ? 'font-semibold text-destructive' : ''}`}>
            {clock(r.lastDepartureBefore)}→{clock(r.lastDepartureAfter)}
            {earlier && (
              <>
                <span aria-hidden="true">▼</span>
                <span className="sr-only">(終発が早まる)</span>
              </>
            )}
          </span>
        </summary>
        <div className="flex flex-col gap-1 py-1 pl-2">
          <TripList title={`なくなる便(${removed.length} 便)`} trips={removed} />
          <TripList title={`加わる便(${added.length} 便)`} trips={added} />
          {added.length > 0 && (
            <p className="text-[11px] text-amber-900">
              入れ替えに使うダイヤに、季節によって走らなくなった便が残っていることがあります。加わる便の系統と時刻を確かめてください。
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

/** 便の一覧(始発時刻、始発 → 終着、行き先、trip_id) */
function TripList({ title, trips }: { title: string; trips: readonly TripBrief[] }) {
  if (trips.length === 0) return null
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="flex flex-col">
        {trips.map((t) => (
          <li key={`${t.feed}-${t.tripId}`} className="break-words">
            <span className="tabular-nums">{t.firstDeparture ?? '—'}</span> {t.firstStopName} → {t.lastStopName}
            {t.headsign && `(${t.headsign})`}{' '}
            <span className="font-mono text-[10px] text-muted-foreground">
              {t.tripId}
              {t.feed === 'base' ? '(減便前)' : '(減便後)'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 始発の時間帯ごとの表(§6 の 3) */
export function StartBandTable({ diff }: { diff: WeekdayDiff }) {
  const rows = diff.byStartBand.filter((b) => b.before + b.after + b.removed + b.added > 0)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">始発の時間帯ごと</summary>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="px-1">始発の時間帯</TableHead>
            <TableHead className="px-1 text-right">平日便</TableHead>
            <TableHead className="px-1 text-right">なくなる</TableHead>
            <TableHead className="px-1 text-right">加わる</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((b) => (
            <TableRow key={b.label}>
              <TableCell className="px-1">{b.label}</TableCell>
              <TableCell className="px-1 text-right">
                <FromTo before={b.before} after={b.after} emphasizeDecrease={b.after < b.before} />
              </TableCell>
              <TableCell className="px-1 text-right tabular-nums">{b.removed}</TableCell>
              <TableCell className="px-1 text-right tabular-nums">{b.added}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  )
}

/** 公示の表の見出し(北海道運輸局 公示第47号の時間帯の区分で数える) */
export const NOTICE47_HEADING = '届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)'

/** 公示第46号の表の下限を下回る系統(平日の回数が 11〜15 回の系統が 10 回以下になる。例 main の 0031 は 11 → 4 回) */
function belowNotice46(r: RouteDiff): boolean {
  return r.before >= 11 && r.before <= 15 && r.after <= 10
}

/**
 * 届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)(§6 の 4)。系統 × 帯の前後の便数。0 回になる系統 × 帯に ✕、
 * 公示第46号の表の下限を下回る系統(系統の平日の回数で判定)に ▼ を付ける。運行管理者向けの補助情報なので、既定で折りたたむ
 */
export function Notice47Table({ diff }: { diff: WeekdayDiff }) {
  const routes = diff.byRoute.filter((r) => r.before + r.after > 0)
  const cell = (routeId: string, band: string) => diff.byNotice47Band.find((c) => c.routeId === routeId && c.band === band)
  const zeroCount = diff.byNotice47Band.filter((c) => c.before > 0 && c.after === 0).length
  const below = diff.byRoute.filter(belowNotice46)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">
        {NOTICE47_HEADING}
        {zeroCount > 0 && `(0 回になる系統 × 帯 ${zeroCount})`}
        {below.length > 0 && (
          <span className="ml-1 font-normal text-destructive">
            <span aria-hidden="true">▼</span>第46号の下限を下回る系統 {below.length}
          </span>
        )}
      </summary>
      <p className="mt-1 text-muted-foreground">
        「▼」は、平日の回数が 11〜15 回の系統が 10 回以下になり、公示第46号の表の下限を下回ることを示す目安です。届出の区分は運輸支局に確認してください。
      </p>
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow>
            <TableHead className="px-1">系統</TableHead>
            {NOTICE47_BANDS.map((b) => (
              <TableHead key={b} className="px-1 text-right whitespace-normal">
                {b}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {routes.map((r) => {
            const low = belowNotice46(r)
            return (
              <TableRow key={r.routeId} data-below-notice46={low ? 'true' : undefined}>
                <TableCell className={`px-1 whitespace-normal break-words ${low ? 'font-semibold text-destructive' : ''}`}>
                  {r.routeName}
                  {low && (
                    <>
                      <span aria-hidden="true">▼</span>
                      <span className="sr-only">(公示第46号の表の下限を下回る)</span>
                    </>
                  )}
                </TableCell>
                {NOTICE47_BANDS.map((b) => {
                  const c = cell(r.routeId, b)
                  if (!c) return <TableCell key={b} className="px-1" />
                  const zero = c.before > 0 && c.after === 0
                  return (
                    <TableCell
                      key={b}
                      className={`px-1 text-right tabular-nums ${zero ? 'font-semibold text-destructive' : ''}`}
                      data-zero={zero ? 'true' : undefined}
                    >
                      {c.before}→{c.after}
                      {zero && (
                        <>
                          <span aria-hidden="true">✕</span>
                          <span className="sr-only">(0 回になる)</span>
                        </>
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {below.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-destructive">
          {below.map((r) => (
            <li key={r.routeId}>
              {r.routeName}:{r.before} → {r.after} 回。公示第46号の表の下限を下回ります。
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-muted-foreground">
        記号:✕=0 回になる、▼=公示第46号の表の下限を下回る。時間帯は始発停留所の発車時刻で数えています。回数の単位と届出の区分は判定しません。
      </p>
    </details>
  )
}
