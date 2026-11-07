import { PrinterIcon, TriangleAlertIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { periodText, REASON_LABELS, REPLACEMENT_LABELS } from '@/components/steps/editText'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import MovementQuoteView from './MovementQuote'
import {
  alternativesFor,
  buildAnnouncement,
  buildStopNotices,
  excludedAtStop,
  movementQuoteOf,
  NOTICE_DISCLAIMER,
  NOTICE_LEAD_DAYS,
  pickNoticeDate,
  schoolTripIdsOf,
  underLeadTime,
  type Alternatives,
  type LineNotice,
  type MovementQuote,
  type NoticeSegment,
  type RemainingLine,
  type StopNotice,
  type StopNotices,
} from '@/gtfs/edit/notice'
import { policyReasonOf } from '@/gtfs/edit/ops'
import { excludeOwnOperators, type OtherStop } from '@/ref/busstops'
import { diffOf, draftName, lastVersion, useEditStore } from '@/store/edit'
import { useResearchStore } from '@/store/research'
import { formatDateJa, fromInputDate, toInputDate } from '@/lib/dates'

/** 停留所の選択肢を1回に出す数(停留所は千を超えることがあるため。「さらに表示」で足す) */
const PAGE_SIZE = 50

const NO_STOPS: readonly StopNotice[] = []

type View = 'stop' | 'announce'

function dateText(date: string): string {
  return date === '' ? '　　年　　月　　日' : formatDateJa(date)
}

function SegmentText({ segment }: { segment: NoticeSegment }) {
  if (segment.kind === 'interval') {
    const gap = segment.minGapMin === segment.maxGapMin ? `約${segment.minGapMin}分` : `${segment.minGapMin}〜${segment.maxGapMin}分`
    return (
      <span data-testid="segment-interval">
        {segment.first}〜{segment.last} {gap}間隔({segment.count}本)
      </span>
    )
  }
  return (
    <span data-testid="segment-single">
      {segment.time}
      {segment.school && <span className="ml-0.5 font-medium">(学)</span>}
    </span>
  )
}

function LineRow({ line }: { line: LineNotice }) {
  return (
    <li className="flex break-inside-avoid flex-col gap-0.5 border-b border-neutral-300 py-1.5 last:border-b-0">
      <p className="text-sm font-semibold">
        系統 {line.routeName}
        {line.headsign !== '' && <span className="ml-1 font-normal">{line.headsign} 行き</span>}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-base tabular-nums">
        {line.segments.map((s, i) => (
          <SegmentText key={`${s.kind}-${s.seconds}-${i}`} segment={s} />
        ))}
      </p>
    </li>
  )
}

function remainingText(line: RemainingLine): string {
  const range = line.count === 1 ? line.first : `${line.first}〜${line.last}`
  return `系統 ${line.routeName}${line.headsign !== '' ? `(${line.headsign} 行き)` : ''} ${line.count}本(${range})`
}

/** 国土数値情報の停留所に時刻が無いことの断り。印刷する掲示にも載せる */
export const OTHER_OPERATOR_TIMETABLE_NOTE = '時刻は各事業者の時刻表で確かめてください。'

/** 他の事業者の停留所の参照データ(国土数値情報 P11)の年度。データの出典の欄(dataSourceRows.ts の FACILITY_SOURCES)と同じ */
export const OTHER_OPERATOR_DATA_YEAR = '2022年度'

/**
 * 他の事業者の停留所と系統が古いかもしれないことの断り。印刷する掲示にも載せる
 * (P11 は 2022年度の版で、その後に廃止・変更された停留所・系統を、乗客向けの掲示で代わりの手段として案内しないように)
 */
export const OTHER_OPERATOR_STALE_NOTE = `ほかの事業者の停留所と系統は、${OTHER_OPERATOR_DATA_YEAR}の国土数値情報によるもので、廃止・変更されていることがあります。`

/** 近くにある他の事業者の停留所と系統。時刻は無いので、時刻表で確かめるよう添える */
function OtherOperatorsBlock({
  alt,
  radiusLabel,
  quotes,
}: {
  alt: Alternatives
  radiusLabel: string
  quotes: ReadonlyMap<string, MovementQuote>
}) {
  const others = alt.otherOperators
  if (others === null) {
    return (
      <p className="print-hide text-xs text-muted-foreground" data-testid="other-operators-missing">
        周辺の事業者の停留所は、参照データを読み込むと表示します(読み込めないときは、手順「平日便を戻す」の「判断材料を調べる」で読み込み直せます)。
      </p>
    )
  }
  if (alt.noCoordinates) return null
  if (others.length === 0) {
    return (
      <p data-testid="other-operators">{radiusLabel}以内に、ほかの事業者の停留所はありません(国土数値情報に載る停留所のみ)。</p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="other-operators">
      <p className="font-medium">{radiusLabel}以内の、ほかの事業者の停留所:</p>
      <ul className="flex flex-col gap-0.5">
        {others.map((o) => (
          <li key={o.targetId} data-testid={`other-operator-${o.targetId}`} className="break-inside-avoid">
            <span className="font-medium">{o.name}</span>:{o.stops.map((s) => `${s.name}(約${s.distanceM}m)`).join('、')}
            <span className="block">系統:{o.routes.length > 0 ? o.routes.join('、') : '系統名の記載なし'}</span>
          </li>
        ))}
      </ul>
      <p>{OTHER_OPERATOR_TIMETABLE_NOTE}</p>
      <p data-testid="other-operators-stale">{OTHER_OPERATOR_STALE_NOTE}</p>
      <p className="print-hide text-xs text-muted-foreground">
        国土数値情報の停留所には時刻がないため、本数や時間帯は分かりません。停留所の位置と系統名は、国土数値情報のバス停留所データ(P11、{OTHER_OPERATOR_DATA_YEAR})を加工して作成しています。
      </p>
      <p className="hidden text-[10px] print:block" data-testid="other-operators-print-source">
        出典:国土数値情報(バス停留所データ、{OTHER_OPERATOR_DATA_YEAR})を加工して作成
      </p>
      {others
        .map((o) => quotes.get(o.targetId))
        .filter((q): q is MovementQuote => q !== undefined)
        .map((q) => (
          <MovementQuoteView key={q.targetId} quote={q} />
        ))}
    </div>
  )
}

/** 代替手段の案内(同じ停留所・近くの停留所に期間中も残る自社の便と、近くの他の事業者の停留所) */
function AlternativesBlock({
  alt,
  radiusLabel,
  quotes,
}: {
  alt: Alternatives
  radiusLabel: string
  quotes: ReadonlyMap<string, MovementQuote>
}) {
  return (
    <div data-testid="alternatives" className="flex flex-col gap-1 text-sm print:text-xs">
      {alt.sameStop.length > 0 && (
        <p>
          <span className="font-medium">この停留所に残る便:</span>
          {alt.sameStop.map(remainingText).join('、')}
        </p>
      )}
      {alt.noCoordinates ? (
        <p>この停留所の座標が stops.txt にないため、近くの停留所を探せません。</p>
      ) : alt.nearby.length === 0 ? (
        <p>{radiusLabel}以内に、期間中も発車がある別の停留所はありません。</p>
      ) : (
        <>
          <p className="font-medium">{radiusLabel}以内の、期間中も発車がある停留所:</p>
          <ul className="flex flex-col gap-0.5">
            {alt.nearby.map((n) => (
              <li key={n.stopId} className="break-inside-avoid">
                {n.stopName}(約{n.distanceM}m):{n.lines.map(remainingText).join('、')}
              </li>
            ))}
          </ul>
        </>
      )}
      <OtherOperatorsBlock alt={alt} radiusLabel={radiusLabel} quotes={quotes} />
    </div>
  )
}

interface SheetInput {
  agencyName: string
  stop: StopNotice
  alt: Alternatives
  /** 近くの他の事業者について調べた減便の動き(target_id ごと。調べていない・記載が無い事業者は入らない) */
  quotes: ReadonlyMap<string, MovementQuote>
  validityStart: string
  periodEnd: string | null
  replacementLabel: string
  reasonText: string
  announceDate: string
  effectiveDate: string
  under7: boolean | null
  lateReason: string
  freeNote: string
  /** 方針で除外した系統(平日ダイヤのまま走る)の route_id */
  excludedRoutes: readonly string[]
}

/**
 * 停留所ごとの掲示(印刷する1枚)。
 * 印刷では画面の枠と余白を外し(紙の余白は index.css の @page)、代わりの便の案内を 12px にする(時刻の表は小さくしない)。
 * 系統の多い停留所は1枚に収まらないので、系統ごとの時刻・運休する時刻・近くの停留所・他の事業者の行の途中では紙を分けず、見出しは中身と離さない
 */
function StopSheet({ sheet }: { sheet: SheetInput }) {
  const { stop } = sheet
  const excluded = excludedAtStop(stop, sheet.excludedRoutes)
  return (
    <article
      className="print-area flex flex-col gap-3 rounded-lg border border-neutral-400 bg-white p-4 text-black print:gap-2 print:rounded-none print:border-0 print:p-0"
      aria-label={`${stop.stopName}の掲示`}
    >
      <header className="flex break-inside-avoid flex-col gap-1 border-b-2 border-black pb-2">
        <p className="text-xs">{sheet.agencyName}</p>
        {excluded.all ? (
          // この停留所の系統はすべて方針で除外した系統(平日ダイヤのまま走る)。時刻が変わると書かない
          <>
            <h3 className="text-xl font-bold">{stop.stopName} のバスの時刻は変わりません</h3>
            <p className="text-sm" data-testid="sheet-lead">
              {periodText(sheet.validityStart, sheet.periodEnd)}も、この停留所の系統({excluded.names.map((n) => `系統 ${n}`).join('、')}
              )は平日ダイヤのまま運行します。
            </p>
          </>
        ) : (
          <>
            <h3 className="text-xl font-bold">{stop.stopName} のバスの時刻が変わります</h3>
            <p className="text-sm" data-testid="sheet-lead">
              {periodText(sheet.validityStart, sheet.periodEnd)}の平日ダイヤは、{sheet.replacementLabel}ダイヤの時刻で運行します。
              {excluded.names.length > 0 && `ただし、${excluded.names.map((n) => `系統 ${n}`).join('、')}は平日ダイヤのまま運行します。`}
              {sheet.reasonText !== '' && `(${sheet.reasonText})`}
            </p>
          </>
        )}
      </header>

      <section aria-label="期間中の時刻" className="flex flex-col gap-1">
        <h4 className="text-sm font-bold break-after-avoid">期間中の発車時刻(平日ダイヤが走る日)</h4>
        {stop.lines.length === 0 ? (
          <p className="text-base font-semibold" data-testid="no-departure">
            期間中は、この停留所からの発車はありません。
          </p>
        ) : (
          <ul>
            {stop.lines.map((l) => (
              <LineRow key={`${l.routeId}-${l.headsign}`} line={l} />
            ))}
          </ul>
        )}
        {stop.lines.some((l) => l.schoolCount > 0) && <p className="text-xs">(学)の印の便は、学校の休業日は運休します。</p>}
        <p className="text-xs">時刻は発車の時刻です。24時を超える時刻は、翌日の早朝の運行です。</p>
      </section>

      {stop.removedLines.length > 0 && (
        <section aria-label="運休する時刻" className="flex flex-col gap-0.5">
          <h4 className="text-sm font-bold break-after-avoid">運休する時刻(期間中)</h4>
          <ul className="text-sm">
            {stop.removedLines.map((l) => (
              <li key={`${l.routeId}-${l.headsign}`} className="break-inside-avoid">
                系統 {l.routeName}
                {l.headsign !== '' && ` ${l.headsign} 行き`}:<span className="font-mono tabular-nums">{l.times.join('、')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="代わりにご利用いただける便" className="flex flex-col gap-1">
        <h4 className="text-sm font-bold break-after-avoid">代わりにご利用いただける便</h4>
        <AlternativesBlock alt={sheet.alt} radiusLabel="半径300m" quotes={sheet.quotes} />
        {sheet.freeNote.trim() !== '' && <p className="whitespace-pre-wrap text-sm">{sheet.freeNote}</p>}
      </section>

      <footer className="flex break-inside-avoid flex-col gap-1 border-t border-neutral-400 pt-2 text-sm">
        <p>
          公示日:<span data-testid="sheet-announce">{dateText(sheet.announceDate)}</span>
          <span className="mx-3" />
          実施日:<span data-testid="sheet-effective">{dateText(sheet.effectiveDate)}</span>
        </p>
        <p>
          公示から実施まで{NOTICE_LEAD_DAYS}日を切る場合の理由:
          <span data-testid="sheet-late-reason">
            {sheet.lateReason.trim() !== '' ? sheet.lateReason : sheet.under7 === false ? '(不要)' : '　　　　　　　　　　　　　　　　'}
          </span>
        </p>
        <p className="text-[10px] text-neutral-600">
          停留所 ID:{stop.stopId}。
          <span data-testid="sheet-repost">
            {excluded.all ? 'この停留所の時刻は変わらないため、時刻の掲示の差し替えは不要です。' : 'この掲示は、減便前の時刻の掲示と差し替えてください。'}
          </span>
        </p>
      </footer>
    </article>
  )
}

/** 告知文(運輸規則第17条の5項目の雛形) */
function AnnouncementSheet({
  items,
  agencyName,
  announceDate,
  effectiveDate,
  lateReason,
  under7,
}: {
  items: ReturnType<typeof buildAnnouncement>
  agencyName: string
  announceDate: string
  effectiveDate: string
  lateReason: string
  under7: boolean | null
}) {
  return (
    <article className="print-area flex flex-col gap-3 rounded-lg border border-neutral-400 bg-white p-4 text-black" aria-label="告知文">
      <header className="flex flex-col gap-1 border-b-2 border-black pb-2">
        <p className="text-xs">{agencyName}</p>
        <h3 className="text-xl font-bold">運行ダイヤの変更について</h3>
      </header>
      <ol className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.no} className="flex flex-col gap-0.5" data-testid={`announce-item-${item.no}`}>
            <p className="text-sm font-bold">
              {item.no}. {item.label}
              {item.legalLabel && (
                // 第17条の項目名は画面だけに出す(欠員を「事故」と掲げないため)
                <span className="print-hide ml-1.5 text-xs font-normal text-neutral-600">(第17条の「{item.legalLabel}」に当たる項目)</span>
              )}
            </p>
            <p className="whitespace-pre-wrap text-sm">{item.text}</p>
          </li>
        ))}
      </ol>
      <footer className="flex flex-col gap-1 border-t border-neutral-400 pt-2 text-sm">
        <p>
          公示日:<span data-testid="announce-date">{dateText(announceDate)}</span>
          <span className="mx-3" />
          実施日:<span data-testid="announce-effective">{dateText(effectiveDate)}</span>
        </p>
        <p>
          公示から実施まで{NOTICE_LEAD_DAYS}日を切る場合の理由:
          <span data-testid="announce-late-reason">
            {lateReason.trim() !== '' ? lateReason : under7 === false ? '(不要)' : '　　　　　　　　　　　　　　　　'}
          </span>
        </p>
        <p className="text-[10px] text-neutral-600">{NOTICE_DISCLAIMER}</p>
      </footer>
    </article>
  )
}

/** 出力の手順のタブ「周知文」。停留所ごとの掲示と、運輸規則第17条の5項目を雛形にした告知文 */
export default function NoticeDraft() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const last = lastVersion({ versions })

  return (
    <StepSection title="周知文">
      {!base ? (
        <p className="text-sm text-muted-foreground">GTFS を読み込み、減便の方針を承認すると、停留所ごとの掲示の文案を出します。</p>
      ) : !last ? (
        <p className="text-sm text-muted-foreground">減便の方針を承認すると、停留所ごとの掲示と告知文の文案を出します。</p>
      ) : (
        <NoticeBody
          base={base.feed}
          history={history}
          result={last}
          draftId={draft ? draft.id : null}
        />
      )}
    </StepSection>
  )
}

function NoticeBody({
  base,
  history,
  result,
  draftId,
}: {
  base: NonNullable<ReturnType<typeof useEditStore.getState>['base']>['feed']
  history: ReturnType<typeof useEditStore.getState>['history']
  result: NonNullable<ReturnType<typeof lastVersion>>
  /** 承認待ちの下書きの番号(無ければ null) */
  draftId: string | null
}) {
  const [view, setView] = useState<View>('stop')
  const [query, setQuery] = useState('')
  const [changedOnly, setChangedOnly] = useState(true)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [selected, setSelected] = useState<string | null>(null)
  const [announceDate, setAnnounceDate] = useState('')
  // 実施日を利用者が直したときの値。承認済みの版が変わったら(result が別のもの)使わず、新しい有効期間の開始日に戻す
  const [effectiveEdit, setEffectiveEdit] = useState<{ result: typeof result; value: string } | null>(null)
  const effectiveDate = effectiveEdit && effectiveEdit.result === result ? effectiveEdit.value : result.report.validity.start
  const [lateReason, setLateReason] = useState('')
  const [place, setPlace] = useState('')
  const [announceNote, setAnnounceNote] = useState('')
  const [stopNotes, setStopNotes] = useState<Record<string, string>>({})

  const date = useMemo(() => pickNoticeDate(base, result), [base, result])
  const school = useMemo(() => schoolTripIdsOf(history, result.report.addBack.accepted), [history, result])
  const notices = useMemo<StopNotices | null>(
    () => (date ? buildStopNotices(base, result.feed, date, school) : null),
    [base, result, date, school],
  )
  const weekday = useMemo(() => diffOf(base, result), [base, result])

  const agencyName = (base.tables.get('agency')?.rows[0]?.agency_name ?? '').trim()
  const agencyNames = useMemo(
    () => (base.tables.get('agency')?.rows ?? []).map((r) => (r.agency_name ?? '').trim()).filter((n) => n !== ''),
    [base],
  )
  const reason = policyReasonOf(history)
  const reasonLabel = reason?.category ? REASON_LABELS[reason.category] : ''
  const replacementLabel = REPLACEMENT_LABELS[result.plan.kind]
  const excludedRouteNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const r of base.tables.get('routes')?.rows ?? []) {
      const id = (r.route_id ?? '').trim()
      if (!names.has(id)) names.set(id, (r.route_short_name ?? '').trim() || (r.route_long_name ?? '').trim() || id)
    }
    return result.plan.excludedRoutes.map((id) => names.get(id.trim()) ?? id.trim())
  }, [base, result])
  const under7 = underLeadTime(announceDate, effectiveDate)

  const announcement = useMemo(
    () =>
      buildAnnouncement({
        agencyName,
        effectiveDate,
        periodEnd: result.plan.period.end,
        replacementLabel,
        reasonLabel,
        reasonNote: reason?.note ?? '',
        weekdayBefore: weekday.removed.length + weekday.same.length,
        weekdayAfter: weekday.same.length + weekday.added.length,
        removedTrips: weekday.removed.length,
        addedTrips: weekday.added.length,
        addedBackTrips: result.report.addBack.accepted.length,
        schoolTrips: school.size,
        vanishingRoutes: weekday.byRoute.filter((r) => r.vanishes).map((r) => r.routeName),
        excludedRouteNames,
        place,
        alternativesNote: announceNote,
      }),
    [agencyName, effectiveDate, result, replacementLabel, reasonLabel, reason, weekday, school, excludedRouteNames, place, announceNote],
  )

  const stops = notices ? notices.stops : NO_STOPS
  const rows = useMemo(() => {
    const q = query.trim()
    return stops.filter((s) => (!changedOnly || s.needsRepost) && (q === '' || s.stopName.includes(q) || s.stopId.includes(q)))
  }, [stops, changedOnly, query])
  const shown = rows.slice(0, limit)
  const selectedStop = selected === null ? null : (stops.find((s) => s.stopId === selected) ?? null)
  // 近くの他の事業者の停留所(GTFS を読み込むと読む参照データ。自社の事業者は除く)と、調べた減便の動き
  const busstops = useResearchStore((s) => (s.facilities.status === 'ready' ? (s.facilities.busstops ?? null) : null))
  const researched = useResearchStore((s) => s.results)
  const otherStops = useMemo<OtherStop[] | null>(
    () => (busstops ? excludeOwnOperators(busstops, agencyNames) : null),
    [busstops, agencyNames],
  )
  const [now] = useState(() => Date.now())
  const alt = useMemo(
    () => (selectedStop ? alternativesFor(selectedStop, stops, undefined, otherStops) : null),
    [selectedStop, stops, otherStops],
  )
  const quotes = useMemo(() => {
    const map = new Map<string, MovementQuote>()
    for (const o of alt?.otherOperators ?? []) {
      const r = researched.get(o.targetId)
      const q = r ? movementQuoteOf(r, now) : null
      if (q) map.set(o.targetId, q)
    }
    return map
  }, [alt, researched, now])

  const lateWarning = under7 === true

  return (
    <>
      {draftId !== null && (
        <Alert role="status" className="print-hide border-amber-400 bg-amber-50 text-amber-950">
          <AlertDescription className="text-xs text-amber-950">
            承認待ちの{draftName(draftId)} があります。周知文は承認済みの内容で作っています。
          </AlertDescription>
        </Alert>
      )}
      {date === null ? (
        <p className="text-sm text-destructive">期間の中に平日ダイヤが走る日がないため、掲示の時刻を出せません。減便の期間を確かめてください。</p>
      ) : (
        <>
          <p className="print-hide flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-xs text-muted-foreground">時刻を集計する日</span>
            <Badge variant="outline" className="tabular-nums">
              {formatDateJa(date)}
            </Badge>
            <span className="text-xs text-muted-foreground">期間の中で平日ダイヤが走る最初の日</span>
          </p>

          <div className="print-hide flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-sm font-medium" id="notice-view-label">
              文案の種類
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-labelledby="notice-view-label"
              value={view}
              onValueChange={(v) => {
                if (v === 'stop' || v === 'announce') setView(v)
              }}
            >
              <ToggleGroupItem value="stop" className={SELECTED_TOGGLE_CLASS}>
                停留所ごとの掲示
              </ToggleGroupItem>
              <ToggleGroupItem value="announce" className={SELECTED_TOGGLE_CLASS}>
                告知文(第17条の雛形)
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="print-hide grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notice-announce-date">公示日</Label>
              <Input
                id="notice-announce-date"
                type="date"
                value={toInputDate(announceDate)}
                onChange={(e) => setAnnounceDate(fromInputDate(e.target.value) ?? '')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notice-effective-date">実施日</Label>
              <Input
                id="notice-effective-date"
                type="date"
                value={toInputDate(effectiveDate)}
                onChange={(e) => setEffectiveEdit({ result, value: fromInputDate(e.target.value) ?? '' })}
              />
            </div>
          </div>
          <div className="print-hide flex flex-col gap-1.5">
            <Label htmlFor="notice-late-reason">公示から実施まで{NOTICE_LEAD_DAYS}日を切るときの理由</Label>
            {lateWarning && (
              <Alert role="status" className="border-amber-400 bg-amber-50 text-amber-950">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertDescription className="text-xs text-amber-950">
                  公示から実施まで{NOTICE_LEAD_DAYS}日を切っています(運輸規則第6条第1項)。緊急やむを得ない理由を書いてください。扱いは運輸支局に確認してください。
                </AlertDescription>
              </Alert>
            )}
            <Textarea
              id="notice-late-reason"
              value={lateReason}
              placeholder="例:運転士の急な欠員で、実施日の7日前までに公示できないため"
              onChange={(e) => setLateReason(e.target.value)}
            />
          </div>

          {view === 'stop' ? (
            <>
              <div className="print-hide flex flex-col gap-1.5 border-t pt-3">
                <Label htmlFor="notice-stop-query">停留所を選ぶ</Label>
                <Input
                  id="notice-stop-query"
                  type="search"
                  value={query}
                  placeholder="名前の一部か stop_id(例:駅前)"
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setLimit(PAGE_SIZE)
                  }}
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={changedOnly}
                    onChange={(e) => {
                      setChangedOnly(e.target.checked)
                      setLimit(PAGE_SIZE)
                    }}
                  />
                  掲示を差し替える停留所だけ
                </label>
                <p className="text-xs text-muted-foreground" role="status">
                  {rows.length}件{rows.length > shown.length ? `のうち先頭の${shown.length}件を表示` : ''}
                </p>
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">条件に合う停留所はありません。</p>
                ) : (
                  <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="停留所の選択">
                    {shown.map((s) => (
                      <li key={s.stopId}>
                        <Button
                          variant={selected === s.stopId ? 'default' : 'outline'}
                          size="sm"
                          className="h-auto w-full justify-start py-1 text-left whitespace-normal"
                          aria-pressed={selected === s.stopId}
                          onClick={() => setSelected(s.stopId)}
                        >
                          <span>
                            {s.stopName}
                            <span className="ml-1 font-mono text-[10px] opacity-70">{s.stopId}</span>
                            {s.losesAll && <span className="ml-1 text-xs">(発車なし)</span>}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {rows.length > shown.length && (
                  <Button variant="outline" size="sm" className="self-start" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                    さらに表示(残り{rows.length - shown.length}件)
                  </Button>
                )}
              </div>

              {selectedStop && alt ? (
                <>
                  <div className="print-hide flex flex-col gap-1.5">
                    <Label htmlFor="notice-stop-note">代わりに使える交通の自由記入</Label>
                    <Textarea
                      id="notice-stop-note"
                      placeholder="他事業者のバス・鉄道・タクシーなど。この停留所の掲示に載ります"
                      value={stopNotes[selectedStop.stopId] ?? ''}
                      onChange={(e) => setStopNotes((prev) => ({ ...prev, [selectedStop.stopId]: e.target.value }))}
                    />
                  </div>
                  <StopSheet
                    sheet={{
                      agencyName,
                      stop: selectedStop,
                      alt,
                      quotes,
                      validityStart: result.report.validity.start,
                      periodEnd: result.plan.period.end,
                      replacementLabel,
                      reasonText: reasonLabel,
                      announceDate,
                      effectiveDate,
                      under7,
                      lateReason,
                      freeNote: stopNotes[selectedStop.stopId] ?? '',
                      excludedRoutes: result.plan.excludedRoutes,
                    }}
                  />
                  <div className="print-hide flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Button onClick={() => window.print()}>
                      <PrinterIcon aria-hidden="true" />
                      この掲示を印刷する
                    </Button>
                    <p className="text-xs text-muted-foreground" data-testid="sheet-pages-note">
                      系統や近くの停留所が多いときは、A4 縦で2枚以上に続きます。
                    </p>
                  </div>
                </>
              ) : (
                <p className="print-hide text-sm text-muted-foreground">停留所を選ぶと、その停留所の掲示を1枚ずつ表示して印刷できます。</p>
              )}
            </>
          ) : (
            <>
              <div className="print-hide grid gap-3 border-t pt-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="notice-place">場所(対象の地域・路線)</Label>
                  <Input id="notice-place" value={place} placeholder="例:○○市内の全路線" onChange={(e) => setPlace(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="notice-announce-note">代わりに使える運行系統・他の運送事業(自由記入)</Label>
                  <Textarea id="notice-announce-note" value={announceNote} onChange={(e) => setAnnounceNote(e.target.value)} />
                </div>
              </div>
              <AnnouncementSheet
                items={announcement}
                agencyName={agencyName}
                announceDate={announceDate}
                effectiveDate={effectiveDate}
                lateReason={lateReason}
                under7={under7}
              />
              <Button className="print-hide self-start" onClick={() => window.print()}>
                <PrinterIcon aria-hidden="true" />
                この告知文を印刷する
              </Button>
            </>
          )}
          <p className="print-hide border-t pt-3 text-xs text-muted-foreground">
            この文案は、運輸規則第17条の公示事項を雛形にしたもので、法定の様式ではありません。Dispatcher は届出・公示の要否を判定しません。運輸支局に確認してください。時刻・本数・距離はコードが出した値で、AI は書いていません。
          </p>
        </>
      )}
    </>
  )
}
