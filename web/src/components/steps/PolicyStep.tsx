import { useEffect, useMemo, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { NOTICE47_BANDS, type RouteDiff, type TripBrief, type WeekdayDiff } from '@/gtfs/edit/diff'
import type { Form2Result } from '@/gtfs/edit/form2'
import {
  checkPolicy,
  planOf,
  policyReasonOf,
  type EditRecord,
  type Form2Plan,
  type PolicyKind,
  type PolicyReason,
  type PolicySettings,
} from '@/gtfs/edit/ops'
import {
  activeDaysIn,
  describeServices,
  feedValidity,
  guessServiceChoice,
  policyValidity,
  sameTimetable,
  type ServiceChoice,
  type ServiceInfo,
} from '@/gtfs/edit/services'
import { holidaysBetween, uncoveredRanges, type HolidayList } from '@/gtfs/holidays'
import type { GtfsFeed } from '@/gtfs/load'
import { form2Texts, timingNotices, type ValidationIssue } from '@/gtfs/validate/edit'
import { formatDateJa, fromInputDate, toInputDate, todayInJapan } from '@/lib/dates'
import { blockingIssues, diffOf, lastVersion, useEditStore, type BaseGtfs, type Draft } from '@/store/edit'
import { setChatToolProviders } from '@/store/chat'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { draftActor, proposeAsUser, replaceClaudeDraftMessage } from './editActions'
import { FromTo, InlineConfirm, IssueList, NoteList } from './editParts'
import { STEP_IDS } from './stepIds'
import {
  ACTOR_LABELS,
  addBackRejections,
  daysPattern,
  describeRecord,
  periodText,
  POLICY_KIND_LABELS,
  REASON_LABELS,
  REPLACEMENT_LABELS,
  ROLE_LABELS,
  shortDateTime,
  UNDO_NOTE,
} from './editText'

type OpDraft = Extract<Draft, { kind: 'op' }>
type ChoiceRole = 'weekday' | 'saturday' | 'sundayHoliday'

// 読み込んだ基準ごとに、方針の入力欄を作り直すための番号
const baseKeys = new WeakMap<BaseGtfs, number>()
let nextBaseKey = 1
function baseKeyOf(base: BaseGtfs): number {
  let k = baseKeys.get(base)
  if (k === undefined) baseKeys.set(base, (k = nextBaseKey++))
  return k
}

/**
 * 手順2:減便の方針(docs/interfaces-1104.md §3・§6)。
 * 方針を入れて「対象便を確かめる」で下書きにし、対象便を確かめて「この内容で進める」で承認する。
 * 承認したあとは、適用した方針と件数を出し、「方針を変える」で入力に戻る。編集の履歴(元に戻す・すべて戻す)もここに出す。
 */
export default function PolicyStep() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const [editing, setEditing] = useState(false)
  const plan = useMemo(() => planOf(history), [history])
  const reason = useMemo(() => policyReasonOf(history), [history])
  const version = lastVersion({ versions })
  const reviewing: OpDraft | null = draft?.kind === 'op' && draft.record.op.type === 'applyPolicy' ? draft : null
  const showForm = base !== null && (plan === null || editing)

  return (
    <StepSection title="2. 減便の方針" id={STEP_IDS.policy}>
      {!base ? (
        <p className="text-sm text-muted-foreground">手順1で GTFS を読み込むと、減便の方針を選べます。</p>
      ) : (
        <>
          {showForm && (
            // 確かめている間も入力は残す(「やめる」で戻ったときに、入れた値のまま直せるように)
            <div hidden={reviewing !== null}>
              <PolicyForm
                key={`${baseKeyOf(base)}-${editing ? history.length : 0}`}
                base={base}
                initial={editing ? plan : null}
                initialReason={editing ? reason : null}
                onCancel={plan && editing ? () => setEditing(false) : undefined}
              />
            </div>
          )}
          {reviewing && <PolicyReview draft={reviewing} onCommitted={() => setEditing(false)} />}
          {plan && version && !editing && !reviewing && (
            <PolicySummary base={base} plan={plan} reason={reason} version={version} onChange={() => setEditing(true)} />
          )}
          <EditHistoryPanel />
        </>
      )}
    </StepSection>
  )
}

// ---- 方針の入力 ----

interface Override {
  value: string
  /** 選んだときの推定(期間を変えて推定が変わったら知らせるため) */
  guessAtPick: string | null
}

function holidayListOf(state: HolidayState): HolidayList | null {
  return state.status === 'ready' ? state.list : null
}

function PolicyForm({
  base,
  initial,
  initialReason,
  onCancel,
}: {
  base: BaseGtfs
  /** 「方針を変える」のときの今の方針 */
  initial: Form2Plan | null
  initialReason: PolicyReason | null
  onCancel?: () => void
}) {
  const feed = base.feed
  const holidayState = useHolidayStore((s) => s.holidays)
  const holidays = holidayListOf(holidayState)
  const input = useMemo(() => feedValidity(feed), [feed])
  const services = useMemo(() => describeServices(feed, holidays), [feed, holidays])

  const [kind, setKind] = useState<PolicyKind>(initial?.kind ?? 'weekdayToSaturday')
  const [startText, setStartText] = useState(() => {
    if (initial) return toInputDate(initial.period.start)
    // 既定の開始日:今日が入力の有効期間の中なら今日、そうでなければ入力の開始日
    const today = todayInJapan(new Date())
    return toInputDate(input && input.start <= today && today <= input.end ? today : (input?.start ?? ''))
  })
  const [indefinite, setIndefinite] = useState(initial ? initial.period.end === null : true)
  const [endText, setEndText] = useState(toInputDate(initial?.period.end ?? input?.end ?? ''))
  const [overrides, setOverrides] = useState<Partial<Record<ChoiceRole, Override>>>(() => {
    if (!initial) return {}
    const replacementRole: ChoiceRole = initial.kind === 'weekdayToSaturday' ? 'saturday' : 'sundayHoliday'
    return {
      weekday: { value: initial.weekdayService, guessAtPick: initial.weekdayService },
      [replacementRole]: { value: initial.replacementService, guessAtPick: initial.replacementService },
    }
  })
  const [excluded, setExcluded] = useState<string[]>(initial?.excludedRoutes ?? [])
  const [category, setCategory] = useState<PolicyReason['category']>(initialReason?.category ?? null)
  const [note, setNote] = useState(initialReason?.note ?? '')
  const [message, setMessage] = useState<string | null>(null)
  // Claude の下書きを捨ててよいかを確かめている間の、その下書きの番号
  const [confirmDraftId, setConfirmDraftId] = useState<string | null>(null)
  const draft = useEditStore((s) => s.draft)
  const confirmingReplace = confirmDraftId !== null && draft !== null && draftActor(draft) === 'claude' && draft.id === confirmDraftId

  const start = fromInputDate(startText)
  const end = indefinite ? null : fromInputDate(endText)
  const period = useMemo(() => (start && (indefinite || end) ? { start, end } : null), [start, end, indefinite])
  const validity = useMemo(() => (input && period ? policyValidity(input, period) : null), [input, period])
  // 期間を変えるたびに推定し直す(利用者が選び直した役割は overrides が優先する)
  const guess: ServiceChoice | null = useMemo(
    () => (validity ? guessServiceChoice(feed, services, validity) : null),
    [feed, services, validity],
  )

  const replacementRole: ChoiceRole = kind === 'weekdayToSaturday' ? 'saturday' : 'sundayHoliday'
  const weekday = overrides.weekday?.value ?? guess?.weekday ?? null
  const saturday = overrides.saturday?.value ?? guess?.saturday ?? null
  const sundayHoliday = overrides.sundayHoliday?.value ?? guess?.sundayHoliday ?? null
  const replacement = replacementRole === 'saturday' ? saturday : sundayHoliday

  // 画面で選んでいる service を、チャットのツール(apply_policy など)と [画面の状態] の行に渡す。
  // 利用者が選び直した役割はその値、そうでない役割は(ツールが指す期間で)推定し直した値。入力欄を閉じたら既定(承認済みの方針)に戻る
  useEffect(() => {
    setChatToolProviders({
      policyServices: (v) => {
        const g = v ? guessServiceChoice(feed, services, v) : guess
        return {
          weekday: overrides.weekday?.value ?? g?.weekday ?? null,
          saturday: overrides.saturday?.value ?? g?.saturday ?? null,
          sundayHoliday: overrides.sundayHoliday?.value ?? g?.sundayHoliday ?? null,
        }
      },
    })
    return () => setChatToolProviders({ policyServices: null })
  }, [feed, services, guess, overrides])

  const settings: PolicySettings | null = useMemo(
    () =>
      weekday && replacement && period
        ? { kind, weekdayService: weekday, replacementService: replacement, period, excludedRoutes: excluded }
        : null,
    [kind, weekday, replacement, period, excluded],
  )
  const problems = useMemo(() => (settings ? checkPolicy(feed, settings) : []), [feed, settings])
  const sameSatSun = useMemo(
    () => (saturday && sundayHoliday && saturday !== sundayHoliday ? sameTimetable(feed, saturday, sundayHoliday) : false),
    [feed, saturday, sundayHoliday],
  )
  const routeStats = useMemo(() => routeTripCounts(feed, weekday, replacement), [feed, weekday, replacement])

  const pick = (role: ChoiceRole, value: string) => {
    setOverrides((o) => ({ ...o, [role]: { value, guessAtPick: guess?.[role] ?? null } }))
  }
  const hasError = problems.some((p) => p.severity === 'error')
  const periodMessage = !start ? '開始日を選んでください。' : !indefinite && !end ? '終了日を選んでください。' : null

  function submit(replaceClaudeDraft = false) {
    if (!settings) return
    setMessage(null)
    const r = proposeAsUser({ type: 'applyPolicy', settings, reason: { category, note: note.trim() } }, { replaceClaudeDraft })
    if (r.status === 'needsConfirm') {
      // Claude の下書きを捨てることになる。画面の中で確かめてから進める
      setConfirmDraftId(r.draft.id)
      return
    }
    setConfirmDraftId(null)
    if (r.status === 'failed') setMessage(r.message)
  }

  if (!input) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          入力の有効期間(feed_info の feed_start_date・feed_end_date、calendar の期間)が分からないため、方針を選べません。
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="減便の方針"
      // ブラウザ標準の範囲検証(日付の min・max)で送信を止めない。範囲の外の日付は、checkPolicy の警告
      // (periodStartClamped・periodEndClamped。入力の端にそろえる)でアプリ側が知らせる。min・max はカレンダーの案内として残す
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-medium">方針の種類</legend>
        {(['weekdayToSaturday', 'weekdayToSundayHoliday'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="radio" name="policy-kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="size-4 accent-primary" />
            {POLICY_KIND_LABELS[k]}
          </label>
        ))}
        {sameSatSun && (
          <p className="text-xs text-muted-foreground">この GTFS では土曜と日祝が同じ時刻表のため、2つの方針は同じ結果になります。</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">期間</legend>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="policy-start" className="text-xs">
              開始日
            </Label>
            <Input
              id="policy-start"
              type="date"
              min={toInputDate(input.start)}
              max={toInputDate(input.end)}
              value={startText}
              onChange={(e) => setStartText(e.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="policy-end" className="text-xs">
              終了日
            </Label>
            <Input
              id="policy-end"
              type="date"
              min={toInputDate(input.start)}
              max={toInputDate(input.end)}
              value={indefinite ? '' : endText}
              disabled={indefinite}
              onChange={(e) => setEndText(e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={indefinite}
            onChange={(e) => setIndefinite(e.target.checked)}
            className="size-4 accent-primary"
          />
          当面の間(終わりを決めない)
        </label>
        <p className="text-xs text-muted-foreground">
          選べる範囲は入力の GTFS の有効期間({formatDateJa(input.start)}〜{formatDateJa(input.end)})です。
          {validity && <>出力の有効期間は {formatDateJa(validity.start)}〜{formatDateJa(validity.end)}({validity.days}日)になります。</>}
        </p>
        {periodMessage && <p className="text-sm text-destructive">{periodMessage}</p>}
        <HolidaysInPeriod state={holidayState} validity={validity} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">入れ替える service</legend>
        <ServiceSelect
          id="policy-weekday"
          label="平日のダイヤ(入れ替える側)"
          services={services}
          value={weekday}
          guess={guess?.weekday ?? null}
          override={overrides.weekday}
          onChange={(v) => pick('weekday', v)}
        />
        <ServiceSelect
          id="policy-replacement"
          label={`${REPLACEMENT_LABELS[kind]}のダイヤ(写す元)`}
          services={services}
          value={replacement}
          guess={guess?.[replacementRole] ?? null}
          override={overrides[replacementRole]}
          onChange={(v) => pick(replacementRole, v)}
        />
        {guess && guess.notes.length > 0 && <NoteList items={guess.notes} label="推定できなかった理由" />}
        <ServiceDetails feed={feed} services={services} validity={validity} />
      </fieldset>

      <ExcludedRoutes stats={routeStats} excluded={excluded} onChange={setExcluded} replacementLabel={REPLACEMENT_LABELS[kind]} />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-medium">減便の理由(変更指示書に載せる。任意)</legend>
        <select
          aria-label="理由の区分"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value === '' ? null : (e.target.value as NonNullable<PolicyReason['category']>))}
        >
          <option value="">選ばない</option>
          {(Object.keys(REASON_LABELS) as NonNullable<PolicyReason['category']>[]).map((c) => (
            <option key={c} value={c}>
              {REASON_LABELS[c]}
            </option>
          ))}
        </select>
        <Input aria-label="理由のメモ" placeholder="メモ(例:運転士 2 名の欠員)" value={note} onChange={(e) => setNote(e.target.value)} />
      </fieldset>

      <IssueList issues={problems.map(problemIssue)} title="方針の確かめ" />
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {confirmingReplace && draft ? (
        <InlineConfirm
          label="Claude の下書きを捨てる確認"
          message={replaceClaudeDraftMessage(draft)}
          confirmLabel="捨てて続ける"
          onConfirm={() => submit(true)}
          onCancel={() => setConfirmDraftId(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!settings || hasError}>
            対象便を確かめる
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              変えずに戻る
            </Button>
          )}
        </div>
      )}
    </form>
  )
}

function problemIssue(p: { severity: 'error' | 'warning'; code: string; message: string }): ValidationIssue {
  return { severity: p.severity, code: p.code, file: '', message: p.message, count: 1, examples: [] }
}

/** 期間の中の祝日。祝日一覧が無ければその旨と読み込み直しのボタン */
function HolidaysInPeriod({ state, validity }: { state: HolidayState; validity: { start: string; end: string } | null }) {
  if (state.status === 'idle') return null
  if (state.status === 'loading') return <p className="text-xs text-muted-foreground">祝日一覧を読み込み中…</p>
  if (state.status !== 'ready') {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
        <p>
          <span aria-hidden="true">! </span>祝日一覧を読めないため、祝日の確認をしていません。
          {state.status === 'error' && <>({state.message})</>}
        </p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void useHolidayStore.getState().load()}>
          祝日一覧を読み込み直す
        </Button>
      </div>
    )
  }
  if (!validity) return null
  const list = holidaysBetween(state.list, validity.start, validity.end)
  const uncovered = uncoveredRanges(state.list, validity.start, validity.end)
  return (
    <div className="text-xs">
      <p>
        期間の中の祝日:
        {list.length === 0 ? 'ありません' : list.map((h) => `${formatDateJa(h.date)} ${h.name}`).join('、')}
      </p>
      {uncovered.map((r) => (
        <p key={r.start} className="text-amber-900">
          <span aria-hidden="true">! </span>
          {formatDateJa(r.start)}〜{formatDateJa(r.end)} の祝日は、内閣府の一覧にまだ無いため確かめていません。
        </p>
      ))}
    </div>
  )
}

function serviceLabel(s: ServiceInfo): string {
  return `${s.serviceId}:${ROLE_LABELS[s.role]}・${s.tripCount} 便`
}

function ServiceSelect({
  id,
  label,
  services,
  value,
  guess,
  override,
  onChange,
}: {
  id: string
  label: string
  services: readonly ServiceInfo[]
  value: string | null
  guess: string | null
  override: Override | undefined
  onChange: (v: string) => void
}) {
  const options = services.filter((s) => s.tripCount > 0)
  const changedGuess = override && guess !== null && guess !== override.guessAtPick && guess !== override.value
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {value === null && <option value="">選んでください</option>}
        {options.map((s) => (
          <option key={s.serviceId} value={s.serviceId}>
            {serviceLabel(s)}
          </option>
        ))}
      </select>
      {!override && guess !== null && <p className="text-xs text-muted-foreground">曜日の列から推定しました。</p>}
      {changedGuess && <p className="text-xs text-amber-900">期間を変えたため、推定は {guess} になりました。</p>}
    </div>
  )
}

/** service ごとの材料(曜日の並び、便数、calendar の期間、新しい有効期間の中で走る日数、祝日に追加されるか) */
function ServiceDetails({
  feed,
  services,
  validity,
}: {
  feed: GtfsFeed
  services: readonly ServiceInfo[]
  validity: { start: string; end: string } | null
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">service の一覧({services.length} 件)</summary>
      <ul className="mt-1 flex flex-col gap-1">
        {services.map((s) => (
          <li key={s.serviceId} className="break-words">
            <span className="font-mono">{s.serviceId}</span> {ROLE_LABELS[s.role]}({daysPattern(s.days)})、{s.tripCount} 便
            {s.calendarRange && `、calendar ${formatDateJa(s.calendarRange.start)}〜${formatDateJa(s.calendarRange.end)}`}
            {validity && `、新しい有効期間に走る日 ${activeDaysIn(feed, s.serviceId, validity.start, validity.end)} 日`}
            {s.addedOnHolidays === null ? '、祝日の追加:判定できません' : s.addedOnHolidays ? '、祝日に追加されます' : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}

interface RouteStat {
  routeId: string
  name: string
  weekday: number
  replacement: number
}

/** 平日便のある系統ごとの、平日の便数と写す元の便数。写す元の便数が 0 の系統を先に、あとは route_id の順 */
function routeTripCounts(feed: GtfsFeed, weekday: string | null, replacement: string | null): RouteStat[] {
  if (!weekday) return []
  const names = new Map<string, string>()
  for (const r of feed.tables.get('routes')?.rows ?? []) {
    const id = r.route_id?.trim() ?? ''
    if (id !== '' && !names.has(id)) names.set(id, r.route_short_name?.trim() || r.route_long_name?.trim() || id)
  }
  const stats = new Map<string, RouteStat>()
  for (const t of feed.tables.get('trips')?.rows ?? []) {
    const sid = t.service_id?.trim() ?? ''
    const routeId = t.route_id?.trim() ?? ''
    if (sid !== weekday && sid !== replacement) continue
    let s = stats.get(routeId)
    if (!s) stats.set(routeId, (s = { routeId, name: names.get(routeId) ?? routeId, weekday: 0, replacement: 0 }))
    if (sid === weekday) s.weekday++
    else s.replacement++
  }
  return [...stats.values()]
    .filter((s) => s.weekday > 0)
    .sort((a, b) => (a.replacement === 0) !== (b.replacement === 0) ? (a.replacement === 0 ? -1 : 1) : a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0)
}

/** 入れ替えから外す系統(§3)。除外は推定しない(既定はどれも外さない) */
function ExcludedRoutes({
  stats,
  excluded,
  onChange,
  replacementLabel,
}: {
  stats: RouteStat[]
  excluded: string[]
  onChange: (v: string[]) => void
  replacementLabel: string
}) {
  const weekdayOnly = stats.filter((s) => s.replacement === 0).length
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">
        入れ替えから外す系統{excluded.length > 0 ? `(${excluded.length} 系統を外す)` : '(既定はどれも外さない)'}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {weekdayOnly > 0 && (
          <p className="rounded-md border border-amber-400 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
            <span aria-hidden="true">! </span>
            {replacementLabel}の便が無い系統({weekdayOnly} 系統。表の先頭)は、入れ替えると全曜日で便がなくなります(路線の休止の届出に当たるかを運輸支局に確認してください)。除外すると平日の便がそのまま残ります。
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
        <p className="text-xs text-muted-foreground">外した系統は、平日の便をそのまま残し、{replacementLabel}の便は写しません。</p>
      </div>
    </details>
  )
}

// ---- 対象便を確かめる(§6) ----

function PolicyReview({ draft, onCommitted }: { draft: OpDraft; onCommitted: () => void }) {
  const [vanishChecked, setVanishChecked] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // 実施日までの日数などに使う今日(日本時間)。画面を開いた日
  const [today] = useState(() => todayInJapan(new Date()))
  const op = draft.record.op
  if (op.type !== 'applyPolicy') return null
  const byClaude = draft.record.by === 'claude'
  const heading = `対象便を確かめる(下書き ${draft.id}${byClaude ? '、Claude の提案' : ''})`

  const discard = () => useEditStore.getState().discard()
  if (!draft.outcome.ok || !draft.diff) {
    return (
      <section className="flex flex-col gap-2" aria-label="対象便の確かめ">
        <h3 className="text-sm font-medium">{heading}</h3>
        <Alert variant="destructive">
          <AlertDescription>
            <p>この方針は適用できません。</p>
            {!draft.outcome.ok &&
              draft.outcome.message.split('\n').map((line) => (
                <p key={line} className="whitespace-pre-wrap">
                  {line}
                </p>
              ))}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" className="self-start" onClick={discard}>
          やめる
        </Button>
      </section>
    )
  }

  const result = draft.outcome.result
  const diff = draft.diff
  const texts = form2Texts(result, today)
  const timing = timingNotices(result, today)
  const blocking = blockingIssues(draft.issues)
  const needVanishCheck = diff.vanishingRoutes > 0
  const canCommit = blocking.length === 0 && (!needVanishCheck || vanishChecked)

  function commit() {
    setMessage(null)
    const r = useEditStore.getState().commit()
    if (r.ok) onCommitted()
    else setMessage(r.message)
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="対象便の確かめ">
      <h3 className="text-sm font-medium">{heading}</h3>
      <p className="text-xs">
        {POLICY_KIND_LABELS[op.settings.kind]}。期間 {periodText(op.settings.period.start, op.settings.period.end)}。平日{' '}
        <span className="font-mono">{op.settings.weekdayService}</span> を <span className="font-mono">{op.settings.replacementService}</span>{' '}
        の便に入れ替えます。
      </p>
      <DiffCounts diff={diff} result={result} />
      <RouteDiffList diff={diff} />
      <StartBandTable diff={diff} />
      <Notice47Table diff={diff} />
      <NoteList items={texts.validity} label="有効期間と期間の外" />
      <NoteList items={texts.changes} label="何が変わるか" />
      <IssueList issues={[...draft.issues, ...timing]} title="確かめること" />
      {needVanishCheck && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={vanishChecked}
            onChange={(e) => setVanishChecked(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          全曜日で便がなくなる系統があることを確かめました
        </label>
      )}
      {blocking.length > 0 && <p className="text-sm text-destructive">誤りがあるため、この内容では進められません。</p>}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canCommit} onClick={commit}>
          この内容で進める
        </Button>
        <Button type="button" variant="outline" onClick={discard}>
          やめる
        </Button>
      </div>
    </section>
  )
}

function totals(diff: WeekdayDiff): { before: number; after: number } {
  let before = 0
  let after = 0
  for (const r of diff.byRoute) {
    before += r.before
    after += r.after
  }
  return { before, after }
}

/** 件数(§6 の 1) */
function DiffCounts({ diff, result }: { diff: WeekdayDiff; result: Form2Result }) {
  const { before, after } = totals(diff)
  const excludedCount = diff.byRoute.filter((r) => r.excluded).length
  const addBack = result.report.addBack
  const rejected = addBackRejections(addBack, result.plan.kind)
  return (
    <dl className="flex flex-col gap-0.5 text-sm" aria-label="平日便の件数">
      <div>
        <dt className="inline">平日便:</dt>
        <dd className="inline">
          <FromTo before={before} after={after} emphasizeDecrease={after < before} /> 便
        </dd>
      </div>
      <div>
        <dt className="inline">内訳:</dt>
        <dd className="inline tabular-nums">
          消える {diff.removed.length} 便・入る {diff.added.length} 便・残る {diff.same.length} 便
        </dd>
      </div>
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
          <dt className="inline">足し戻し:</dt>
          <dd className="inline tabular-nums">
            選んだ {addBack.requested} 便のうち、受け付け {addBack.accepted.length} 便
            {rejected.length > 0 && `、受け付けなかった便 ${rejected.length} 便(手順5に理由)`}
          </dd>
        </div>
      )}
    </dl>
  )
}

const EARLIER = (r: RouteDiff) =>
  r.lastDepartureBefore !== null && r.lastDepartureAfter !== null && r.lastDepartureAfter < r.lastDepartureBefore

/** 系統ごとの表(§6 の 2)。系統を開くと、消える便と入る便を始発の時刻順に並べる(§6 の 5) */
function RouteDiffList({ diff }: { diff: WeekdayDiff }) {
  const earlier = diff.byRoute.filter(EARLIER).length
  return (
    <details open className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">
        系統ごと({diff.byRoute.length} 系統{earlier > 0 && `。終発が早まる系統 ${earlier}`})
      </summary>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-2 border-b pb-1 text-[11px] text-muted-foreground">
        <span>系統</span>
        <span className="text-right">平日便</span>
        <span className="text-right">始発</span>
        <span className="text-right">終発</span>
      </div>
      <ul className="flex flex-col">
        {diff.byRoute.map((r) => (
          <RouteDiffRow key={r.routeId} route={r} diff={diff} />
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        記号:除=入れ替えから外した系統、⚠=全曜日で便がなくなる系統、▼=減る・早まる。始発・終発は平日の始発便・終発便の出発時刻(前 → 後)。
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
    <li className="border-b py-0.5" data-route={r.routeId}>
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
          <TripList title={`消える便(${removed.length})`} trips={removed} />
          <TripList title={`入る便(${added.length})`} trips={added} />
          {added.length > 0 && (
            <p className="text-[11px] text-amber-900">
              入る便の系統と時刻を確かめてください(写す元のダイヤに、季節で走らなくなった便が残っていることがあります)。
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
              {t.feed === 'base' ? '(基準)' : '(編集後)'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 始発の時間帯ごとの表(§6 の 3) */
function StartBandTable({ diff }: { diff: WeekdayDiff }) {
  const rows = diff.byStartBand.filter((b) => b.before + b.after + b.removed + b.added > 0)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">始発の時間帯ごと</summary>
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="px-1">始発の時間帯</TableHead>
            <TableHead className="px-1 text-right">平日便</TableHead>
            <TableHead className="px-1 text-right">消える</TableHead>
            <TableHead className="px-1 text-right">入る</TableHead>
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

/** 公示第46号の表の下限を下回る系統(平日の回数が 11〜15 回の系統が 10 回以下になる。例 main の 0031 は 11 → 4 回) */
function belowNotice46(r: RouteDiff): boolean {
  return r.before >= 11 && r.before <= 15 && r.after <= 10
}

/**
 * 公示第47号の時間帯ごとの表(§6 の 4)。系統 × 帯の前後の便数。0 回になる系統 × 帯に ✕、
 * 公示第46号の表の下限を下回る系統(系統の平日の回数で判定)に ▼ を付ける
 */
export function Notice47Table({ diff }: { diff: WeekdayDiff }) {
  const routes = diff.byRoute.filter((r) => r.before + r.after > 0)
  const cell = (routeId: string, band: string) => diff.byNotice47Band.find((c) => c.routeId === routeId && c.band === band)
  const zeroCount = diff.byNotice47Band.filter((c) => c.before > 0 && c.after === 0).length
  const below = diff.byRoute.filter(belowNotice46)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-sm font-medium">
        公示第47号の時間帯ごとの便数{zeroCount > 0 && `(0 回になる系統 × 帯 ${zeroCount})`}
      </summary>
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
        記号:✕=0 回になる、▼=公示第46号の表の下限を下回る(系統の平日の回数が 11〜15 回から 10 回以下になる)。目安です。時間帯は始発停留所の出発時刻で数えています。回数の単位と届出の区分は判定しません。運輸支局に確認してください。
      </p>
    </details>
  )
}

// ---- 承認したあと ----

function PolicySummary({
  base,
  plan,
  reason,
  version,
  onChange,
}: {
  base: BaseGtfs
  plan: Form2Plan
  reason: PolicyReason | null
  version: Form2Result
  onChange: () => void
}) {
  const diff = useMemo(() => diffOf(base.feed, version), [base.feed, version])
  const { before, after } = totals(diff)
  const names = new Map(diff.byRoute.map((r) => [r.routeId, r.routeName]))
  return (
    <section className="flex flex-col gap-2" aria-label="適用した方針">
      <dl className="flex flex-col gap-0.5 text-sm">
        <div>
          <dt className="inline">適用した方針:</dt>
          <dd className="inline font-medium">{POLICY_KIND_LABELS[plan.kind]}</dd>
        </div>
        <div>
          <dt className="inline">期間:</dt>
          <dd className="inline">{periodText(plan.period.start, plan.period.end)}</dd>
        </div>
        <div>
          <dt className="inline">service:</dt>
          <dd className="inline">
            平日 <span className="font-mono">{plan.weekdayService}</span> ← {REPLACEMENT_LABELS[plan.kind]}{' '}
            <span className="font-mono">{plan.replacementService}</span>
          </dd>
        </div>
        <div>
          <dt className="inline">除外した系統:</dt>
          <dd className="inline">
            {plan.excludedRoutes.length === 0 ? 'なし' : plan.excludedRoutes.map((r) => names.get(r) ?? r).join('、')}
          </dd>
        </div>
        <div>
          <dt className="inline">理由:</dt>
          <dd className="inline">
            {reason?.category ? REASON_LABELS[reason.category] : '選んでいません'}
            {reason?.note && `(${reason.note})`}
          </dd>
        </div>
        <div>
          <dt className="inline">平日便:</dt>
          <dd className="inline">
            <FromTo before={before} after={after} emphasizeDecrease={after < before} /> 便(消える {diff.removed.length}・入る{' '}
            {diff.added.length}・残る {diff.same.length})
          </dd>
        </div>
        <div className={diff.vanishingRoutes > 0 ? 'font-semibold text-destructive' : undefined}>
          <dt className="inline">全曜日で便がなくなる系統:</dt>
          <dd className="inline">{diff.vanishingRoutes} 系統</dd>
        </div>
      </dl>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onChange}>
        方針を変える
      </Button>
    </section>
  )
}

/** 編集の履歴と、元に戻す・すべて戻す。Claude の「元に戻す」の下書きもここで承認する */
function EditHistoryPanel() {
  const history = useEditStore((s) => s.history)
  const draft = useEditStore((s) => s.draft)
  const draftId = draft?.id ?? null
  // 押したボタンの場所に出す確認(ブラウザ標準の確認ダイアログは使わない)。
  // 押したときの履歴(store は変えるたびに新しい配列にする)と下書きの id を覚え、どちらかが変わったら確認を消す。
  // 隠すだけにすると、件数が同じに戻ったときや下書きが無くなったときに、押していない確認がまた出てしまう
  const [pending, setPending] = useState<{ kind: 'undo' | 'undoAll'; history: EditRecord[]; draftId: string | null } | null>(null)
  if (pending && (pending.history !== history || pending.draftId !== draftId)) setPending(null)
  const undoDraft = draft?.kind === 'undo' ? draft : null
  if (history.length === 0 && !undoDraft) return null

  // Claude の下書きがあれば、元に戻す操作はそれを捨てる(確かめてから)
  const claudeDraft = draft && draftActor(draft) === 'claude' ? draft : null
  const confirming =
    pending &&
    pending.history === history &&
    pending.draftId === draftId &&
    history.length > 0 &&
    (pending.kind === 'undoAll' || claudeDraft !== null)
      ? pending.kind
      : null
  const undo = () => {
    if (claudeDraft) setPending({ kind: 'undo', history, draftId })
    else useEditStore.getState().undo()
  }
  const undoAll = () => setPending({ kind: 'undoAll', history, draftId })
  const cancel = () => setPending(null)
  const confirm = () => {
    setPending(null)
    if (confirming === 'undoAll') useEditStore.getState().undoAll()
    else useEditStore.getState().undo()
  }

  return (
    <section className="flex flex-col gap-2 border-t pt-2" aria-label="編集の履歴">
      <h3 className="text-sm font-medium">編集の履歴(承認済み)</h3>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-xs">
        {history.map((r, i) => (
          <li key={i} className="break-words">
            {describeRecord(r)}({ACTOR_LABELS[r.by]}、{shortDateTime(r.at)})
          </li>
        ))}
      </ol>
      {undoDraft && (
        <div className="flex flex-col gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs">
          <p>
            下書き {undoDraft.id}{draftActor(undoDraft) === 'claude' && '(Claude の提案)'}:最後の操作を元に戻します。地図と表は戻したあとの状態を「下書き」として出しています。
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => useEditStore.getState().commit()}>
              元に戻すことを承認する
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => useEditStore.getState().discard()}>
              やめる
            </Button>
          </div>
        </div>
      )}
      {confirming === 'undoAll' ? (
        <InlineConfirm
          label="すべて戻す確認"
          message={
            <>
              本当にすべて戻しますか。すべての編集({history.length} 件)を戻して、読み込んだ GTFS のままにします。
              {claudeDraft && <>Claude の下書き {claudeDraft.id} も捨てます。</>}
            </>
          }
          confirmLabel="すべて戻す"
          onConfirm={confirm}
          onCancel={cancel}
        />
      ) : confirming === 'undo' && claudeDraft ? (
        <InlineConfirm
          label="Claude の下書きを捨てる確認"
          message={replaceClaudeDraftMessage(claudeDraft)}
          confirmLabel="捨てて続ける"
          onConfirm={confirm}
          onCancel={cancel}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={history.length === 0} onClick={undo}>
            元に戻す
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={history.length === 0} onClick={undoAll}>
            すべて戻す
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{UNDO_NOTE}</p>
    </section>
  )
}
