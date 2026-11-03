import { useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { periodText, REASON_LABELS, REPLACEMENT_LABELS } from '@/components/steps/editText'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  alternativesFor,
  buildAnnouncement,
  buildStopNotices,
  excludedAtStop,
  NOTICE_DISCLAIMER,
  NOTICE_LEAD_DAYS,
  pickNoticeDate,
  schoolTripIdsOf,
  underLeadTime,
  type Alternatives,
  type LineNotice,
  type NoticeSegment,
  type RemainingLine,
  type StopNotice,
  type StopNotices,
} from '@/gtfs/edit/notice'
import { policyReasonOf } from '@/gtfs/edit/ops'
import { diffOf, lastVersion, useEditStore } from '@/store/edit'
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
    <li className="flex flex-col gap-0.5 border-b border-neutral-300 py-1.5 last:border-b-0">
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

/** 代替手段の案内(同じ停留所・近くの停留所に期間中も残る自社の便) */
function AlternativesBlock({ alt, radiusLabel }: { alt: Alternatives; radiusLabel: string }) {
  return (
    <div data-testid="alternatives" className="flex flex-col gap-1 text-sm">
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
              <li key={n.stopId}>
                {n.stopName}(約{n.distanceM}m):{n.lines.map(remainingText).join('、')}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface SheetInput {
  agencyName: string
  stop: StopNotice
  alt: Alternatives
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

/** 停留所ごとの掲示(印刷する1枚) */
function StopSheet({ sheet }: { sheet: SheetInput }) {
  const { stop } = sheet
  const excluded = excludedAtStop(stop, sheet.excludedRoutes)
  return (
    <article className="print-area flex flex-col gap-3 rounded-lg border border-neutral-400 bg-white p-4 text-black" aria-label={`${stop.stopName}の掲示`}>
      <header className="flex flex-col gap-1 border-b-2 border-black pb-2">
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
        <h4 className="text-sm font-bold">期間中の発車時刻(平日ダイヤが走る日)</h4>
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
          <h4 className="text-sm font-bold">運休する時刻(期間中)</h4>
          <ul className="text-sm">
            {stop.removedLines.map((l) => (
              <li key={`${l.routeId}-${l.headsign}`}>
                系統 {l.routeName}
                {l.headsign !== '' && ` ${l.headsign} 行き`}:<span className="font-mono tabular-nums">{l.times.join('、')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="代わりにご利用いただける便" className="flex flex-col gap-1">
        <h4 className="text-sm font-bold">代わりにご利用いただける便</h4>
        <AlternativesBlock alt={sheet.alt} radiusLabel="半径300m" />
        {sheet.freeNote.trim() !== '' && <p className="whitespace-pre-wrap text-sm">{sheet.freeNote}</p>}
      </section>

      <footer className="flex flex-col gap-1 border-t border-neutral-400 pt-2 text-sm">
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
          hasDraft={draft !== null}
        />
      )}
    </StepSection>
  )
}

function NoticeBody({
  base,
  history,
  result,
  hasDraft,
}: {
  base: NonNullable<ReturnType<typeof useEditStore.getState>['base']>['feed']
  history: ReturnType<typeof useEditStore.getState>['history']
  result: NonNullable<ReturnType<typeof lastVersion>>
  hasDraft: boolean
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

  const date = useMemo(() => pickNoticeDate(base, result.plan, result.report.validity), [base, result])
  const school = useMemo(() => schoolTripIdsOf(history, result.report.addBack.accepted), [history, result])
  const notices = useMemo<StopNotices | null>(
    () => (date ? buildStopNotices(base, result.feed, date, school) : null),
    [base, result, date, school],
  )
  const weekday = useMemo(() => diffOf(base, result), [base, result])

  const agencyName = (base.tables.get('agency')?.rows[0]?.agency_name ?? '').trim()
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
  const alt = useMemo(() => (selectedStop ? alternativesFor(selectedStop, stops) : null), [selectedStop, stops])

  const lateWarning = under7 === true

  return (
    <>
      {hasDraft && (
        <p className="print-hide rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
          承認前の下書きがあります。周知文は承認済みの内容で作っています。
        </p>
      )}
      {date === null ? (
        <p className="text-sm text-destructive">期間の中に平日ダイヤが走る日がないため、掲示の時刻を出せません。減便の方針の期間を確かめてください。</p>
      ) : (
        <>
          <p className="print-hide text-sm">
            時刻を数える日:<span className="font-medium">{formatDateJa(date)}</span>
            <span className="text-xs text-muted-foreground">
              (期間の中で、平日ダイヤが走る最初の日です。この日と同じダイヤで走る日は同じ時刻になります)
            </span>
          </p>

          <div className="print-hide flex flex-col gap-1.5">
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

          <div className="print-hide grid gap-3 sm:grid-cols-2">
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
              <p role="status" className="rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
                公示から実施まで{NOTICE_LEAD_DAYS}日を切っています(運輸規則第6条第1項)。緊急やむを得ない理由を書いてください。扱いは運輸支局に確認してください。
              </p>
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
              <div className="print-hide flex flex-col gap-1.5">
                <Label htmlFor="notice-stop-query">停留所を選ぶ(名前の一部か stop_id)</Label>
                <Input
                  id="notice-stop-query"
                  type="search"
                  value={query}
                  placeholder="例:駅前"
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
                    <Label htmlFor="notice-stop-note">代わりに使える交通の自由記入(他事業者のバス・鉄道・タクシーなど。この停留所の掲示に載ります)</Label>
                    <Textarea
                      id="notice-stop-note"
                      value={stopNotes[selectedStop.stopId] ?? ''}
                      onChange={(e) => setStopNotes((prev) => ({ ...prev, [selectedStop.stopId]: e.target.value }))}
                    />
                  </div>
                  <StopSheet
                    sheet={{
                      agencyName,
                      stop: selectedStop,
                      alt,
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
                  <Button className="print-hide self-start" onClick={() => window.print()}>
                    この掲示を印刷する
                  </Button>
                </>
              ) : (
                <p className="print-hide text-sm text-muted-foreground">停留所を選ぶと、その停留所の掲示を1枚ずつ表示して印刷できます。</p>
              )}
            </>
          ) : (
            <>
              <div className="print-hide grid gap-3">
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
                この告知文を印刷する
              </Button>
            </>
          )}
          <p className="print-hide text-xs text-muted-foreground">
            この文案は、運輸規則第17条の公示事項を雛形にしたもので、法定の様式ではありません。Dispatcher は届出・公示の要否を判定しません。運輸支局に確認してください。時刻・本数・距離はコードが数えた値で、AI は書いていません。
          </p>
        </>
      )}
    </>
  )
}
