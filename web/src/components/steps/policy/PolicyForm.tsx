import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  checkPolicy,
  type Form2Plan,
  type PolicyKind,
  type PolicyReason,
  type PolicySettings,
} from '@/gtfs/edit/ops'
import {
  describeServices,
  feedValidity,
  guessServiceChoice,
  policyValidity,
  sameTimetable,
  type ServiceChoice,
} from '@/gtfs/edit/services'
import type { HolidayList } from '@/gtfs/holidays'
import type { ValidationIssue } from '@/gtfs/validate/edit'
import { fromInputDate, toInputDate, todayInJapan } from '@/lib/dates'
import { setChatToolProviders } from '@/store/chat'
import { useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { draftActor, proposeAsUser, replaceClaudeDraftMessage } from '../editActions'
import { InlineConfirm, IssueList, NoteList } from '../editParts'
import { REASON_LABELS, REPLACEMENT_LABELS } from '../editText'
import { ExcludedRoutes } from './DiffTables'
import { PeriodFields, PolicyKindField } from './PeriodFields'
import { ServiceDetails, ServiceSelect } from './ServiceFields'
import { routeTripCounts } from './stats'
import type { ChoiceRole, Override } from './types'

// ---- 方針の入力 ----

function holidayListOf(state: HolidayState): HolidayList | null {
  return state.status === 'ready' ? state.list : null
}

export function PolicyForm({
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
      <PolicyKindField kind={kind} onChange={setKind} sameSatSun={sameSatSun} />

      <PeriodFields
        input={input}
        startText={startText}
        onStartChange={setStartText}
        endText={endText}
        onEndChange={setEndText}
        indefinite={indefinite}
        onIndefiniteChange={setIndefinite}
        validity={validity}
        periodMessage={periodMessage}
        holidayState={holidayState}
      />

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
