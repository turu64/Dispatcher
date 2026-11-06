import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  checkPolicy,
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
import {
  choicePairs,
  droppedPairWeekdays,
  groupedPolicyServices,
  groupSettings,
  POLICY_KINDS,
  sentenceServices,
  skippedReplacements,
  type GroupChoice,
} from '@/gtfs/groups/view'
import type { HolidayList } from '@/gtfs/holidays'
import type { ValidationIssue } from '@/gtfs/validate/edit'
import { appToday } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { setChatToolProviders } from '@/store/chat'
import { useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore, type HolidayState } from '@/store/holidays'
import { jevPending, useServiceGroupsStore } from '@/store/serviceGroups'
import { draftActor, proposeAsUser, replaceClaudeDraftMessage } from '../editActions'
import { InlineConfirm, IssueList, NoteList } from '../editParts'
import { diaLabel, invalidCalendarNote, REASON_LABELS, REPLACEMENT_LABELS } from '../editText'
import { ExcludedRoutes } from './DiffTables'
import { GROUP_MANUAL_ID, GroupReplaceFields } from './GroupReplaceFields'
import { hasKindEdits, type ReplaceMode } from './groupReplace'
import { EMPTY_HOLE_CLASS, PERIOD_PROBLEM_CODES, PeriodChecks, PeriodHoles, PolicyKindField } from './PeriodFields'
import { ServiceDetails, ServiceSelect } from './ServiceFields'
import { routeTripCounts, sameGroupTimetable } from './stats'
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
  /** 「方針を変える」のときの今の方針、または AI の方針の下書きの値 */
  initial: PolicySettings | null
  initialReason: PolicyReason | null
  onCancel?: () => void
}) {
  const feed = base.feed
  const holidayState = useHolidayStore((s) => s.holidays)
  const holidays = holidayListOf(holidayState)
  const input = useMemo(() => feedValidity(feed), [feed])
  const services = useMemo(() => describeServices(feed, holidays), [feed, holidays])
  // ダイヤのグループ分け(docs/design-service-groups.md §5.2)。単純な GTFS で1組の形で足りるときは null(今の service の選び方のまま)。
  // 単純でない GTFS で Jev の答えを待っている間は unconfirmed(今の選び方のまま、待っていることを出す)。確定のしくみは無い(指摘19)
  const groups = useServiceGroupsStore((s) => s.groups)
  const jevState = useServiceGroupsStore((s) => s.jev.state)
  const stopJev = useServiceGroupsStore((s) => s.stopJev)
  const groupsReady = !jevPending(jevState)
  const grouped = useMemo(() => groupedPolicyServices(groups, groupsReady), [groups, groupsReady])
  const groupTrips = useMemo(() => new Map((groups?.features.services ?? []).map((f) => [f.serviceId, f.tripCount])), [groups])

  const [kind, setKind] = useState<PolicyKind>(initial?.kind ?? 'weekdayToSaturday')
  // 入れ替えるダイヤの選び方(方針の種類ごと)。既定は自動。その種類で手動で直した値が残っていれば手動から始める
  const [replaceModes, setReplaceModes] = useState<Record<PolicyKind, ReplaceMode>>(() => ({
    weekdayToSaturday: hasKindEdits(groups, 'weekdayToSaturday') ? 'manual' : 'auto',
    weekdayToSundayHoliday: hasKindEdits(groups, 'weekdayToSundayHoliday') ? 'manual' : 'auto',
  }))
  const replaceMode = replaceModes[kind]
  const setReplaceMode = (m: ReplaceMode) => setReplaceModes((prev) => ({ ...prev, [kind]: m }))
  // 期間の日付は GTFS と同じ 'YYYYMMDD'(まだ決まっていなければ '')
  const [startDate, setStartDate] = useState(() => {
    if (initial) return initial.period.start
    // 既定の開始日:今日が入力の有効期間の中なら今日、そうでなければ入力の開始日
    const today = appToday()
    return input && input.start <= today && today <= input.end ? today : (input?.start ?? '')
  })
  const [indefinite, setIndefinite] = useState(initial ? initial.period.end === null : true)
  const [endDate, setEndDate] = useState(initial?.period.end ?? input?.end ?? '')
  const [overrides, setOverrides] = useState<Partial<Record<ChoiceRole, Override>>>(() => {
    if (!initial) return {}
    const replacementRole: ChoiceRole = initial.kind === 'weekdayToSaturday' ? 'saturday' : 'sundayHoliday'
    // 「選んだときの推定」は、渡された方針の期間で推定した値にする。service の値そのものにすると、推定と違う service を
    // 選んだ方針(承認済みの方針・AI の下書き)を開いただけで「期間を変えたため、推定が変わった」と扱ってしまう
    const v = input ? policyValidity(input, initial.period) : null
    const g = v ? guessServiceChoice(feed, services, v) : null
    return {
      weekday: { value: initial.weekdayService, guessAtPick: g?.weekday ?? null },
      [replacementRole]: { value: initial.replacementService, guessAtPick: g?.[replacementRole] ?? null },
    }
  })
  const [excluded, setExcluded] = useState<string[]>(initial?.excludedRoutes ?? [])
  const [reasonChoice, setReasonChoice] = useState<ReasonChoice | null>(() => reasonChoiceOf(initialReason))
  // 「その他」の文と、区分を選んだときの補足は、意味が違うので別に持つ(区分を切り替えても、片方の文をもう片方に持ち越さない)
  const [otherText, setOtherText] = useState(() => (reasonChoiceOf(initialReason) === 'other' ? (initialReason?.note ?? '') : ''))
  const [note, setNote] = useState(() => (reasonChoiceOf(initialReason) === 'other' ? '' : (initialReason?.note ?? '')))
  const [message, setMessage] = useState<string | null>(null)
  // Claude の下書きを捨ててよいかを確かめている間の、その下書きの番号
  const [confirmDraftId, setConfirmDraftId] = useState<string | null>(null)
  const draft = useEditStore((s) => s.draft)
  const confirmingReplace = confirmDraftId !== null && draft !== null && draftActor(draft) === 'claude' && draft.id === confirmDraftId

  const start = startDate || null
  const end = indefinite ? null : endDate || null
  const period = useMemo(() => (start && (indefinite || end) ? { start, end } : null), [start, end, indefinite])
  const validity = useMemo(() => (input && period ? policyValidity(input, period) : null), [input, period])
  // 期間を変えるたびに推定し直す(利用者が選び直した役割は overrides が優先する)
  const guess: ServiceChoice | null = useMemo(
    () => (validity ? guessServiceChoice(feed, services, validity) : null),
    [feed, services, validity],
  )

  const replacementRole: ChoiceRole = kind === 'weekdayToSaturday' ? 'saturday' : 'sundayHoliday'
  // ダイヤ単位で選ぶとき(Jev の答えを待っていない)の、この種類の値。作れなければ error
  const groupChoice = grouped?.status === 'confirmed' ? grouped.byKind[kind] : null
  const groupMode = groupChoice !== null
  const groupValue = groupChoice && !('error' in groupChoice) ? groupChoice : null
  const groupErrors = groupChoice && 'error' in groupChoice ? groupChoice.error : null
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
          // ダイヤ単位で選べるときは、AI のツールもダイヤ単位で減便の方針を作る(手動で選んだ値も store に入っている)
          ...(grouped ? { groups: grouped } : {}),
        }
      },
    })
    return () => setChatToolProviders({ policyServices: null })
  }, [feed, services, guess, overrides, grouped])

  const settings: PolicySettings | null = useMemo(() => {
    if (!period) return null
    if (groupMode) return groupValue ? groupSettings(groupValue, period, excluded) : null
    return weekday && replacement ? { kind, weekdayService: weekday, replacementService: replacement, period, excludedRoutes: excluded } : null
  }, [kind, weekday, replacement, period, excluded, groupMode, groupValue])
  // service がまだ決まらなくても、期間の誤り(badPeriod・emptyValidity)は確かめて期間の欄の下に出す
  // (service が空のままの確かめが出す、service に関する誤りは出さない)
  const allProblems = useMemo(
    () =>
      settings
        ? checkPolicy(feed, settings)
        : period
          ? checkPolicy(feed, { kind, weekdayService: weekday ?? '', replacementService: replacement ?? '', period, excludedRoutes: excluded }).filter(
              (p) => PERIOD_PROBLEM_CODES.has(p.code),
            )
          : [],
    [feed, settings, period, kind, weekday, replacement, excluded],
  )
  const periodProblems = useMemo(() => allProblems.filter((p) => PERIOD_PROBLEM_CODES.has(p.code)), [allProblems])
  // 期間の誤りは期間の欄の下に出すので、「方針の確かめ」には重ねて出さない
  const problems = useMemo(() => allProblems.filter((p) => !PERIOD_PROBLEM_CODES.has(p.code)), [allProblems])
  // 平日の service の calendar に日付の正しくない行があって、期間の中で1日も走らないとき、その行は数えていないと添える
  const mainWeekday = groupMode ? (groupValue?.weekdayService ?? null) : weekday
  const weekdayCalendarNote = useMemo(() => (mainWeekday ? invalidCalendarNote(feed, mainWeekday) : null), [feed, mainWeekday])
  // 土曜と日祝が同じ時刻表かは、入力の GTFS の有効期間で推定した service で決める。期間で推定した guess は期間がそろうまで
  // 無いので、それに頼ると期間を選ぶ途中(1回目と2回目の押下の間)で案内が出たり消えたりして、下のカレンダーが上下に動く
  const inputGuess: ServiceChoice | null = useMemo(
    () => (input ? guessServiceChoice(feed, services, input) : null),
    [feed, services, input],
  )
  const sameSatSun = useMemo(() => {
    if (grouped?.status === 'confirmed') return sameGroupTimetable(feed, grouped.byKind)
    const sat = overrides.saturday?.value ?? inputGuess?.saturday ?? null
    const sun = overrides.sundayHoliday?.value ?? inputGuess?.sundayHoliday ?? null
    return sat && sun && sat !== sun ? sameTimetable(feed, sat, sun) : false
  }, [feed, overrides.saturday, overrides.sundayHoliday, inputGuess, grouped])
  // 期間に走らないため組ごと除く平日の service(方針の種類ごと)。承認の前から、組の内訳・文・系統の便数で数えない
  const droppedByKind = useMemo(() => {
    const of = (k: PolicyKind) => {
      const c = grouped?.status === 'confirmed' ? grouped.byKind[k] : null
      return c && !('error' in c) ? droppedPairWeekdays(feed, c, validity) : new Set<string>()
    }
    return { weekdayToSaturday: of('weekdayToSaturday'), weekdayToSundayHoliday: of('weekdayToSundayHoliday') }
  }, [feed, grouped, validity])
  const dropped = droppedByKind[kind]
  // 期間に走らないため加えない入れ替えに使う service(方針の種類ごと)。承認の前から、組の内訳・文・系統の便数で数えない
  const skippedByKind = useMemo(() => {
    const of = (k: PolicyKind) => {
      const c = grouped?.status === 'confirmed' ? grouped.byKind[k] : null
      return c && !('error' in c) ? skippedReplacements(feed, c, validity) : new Set<string>()
    }
    return { weekdayToSaturday: of('weekdayToSaturday'), weekdayToSundayHoliday: of('weekdayToSundayHoliday') }
  }, [feed, grouped, validity])
  const skipped = skippedByKind[kind]
  const routeStats = useMemo(() => {
    if (!groupMode) return routeTripCounts(feed, weekday, replacement)
    if (!groupValue) return []
    const pairs = choicePairs(groupValue).filter((p) => !dropped.has(p.weekday))
    return routeTripCounts(
      feed,
      pairs.map((p) => p.weekday),
      pairs.flatMap((p) => p.replacements).filter((r) => !skipped.has(r)),
    )
  }, [feed, weekday, replacement, groupMode, groupValue, dropped, skipped])
  // 入れ替えに使うダイヤの便が無い系統のうち、除外していないもの(入れ替えると全曜日で便がなくなる)
  const vanishingRoutes =
    !groupMode && replacement === null ? 0 : routeStats.filter((r) => r.replacement === 0 && !excluded.includes(r.routeId)).length
  const [routesOpen, setRoutesOpen] = useState(false)

  const pick = (role: ChoiceRole, value: string) => {
    setOverrides((o) => ({ ...o, [role]: { value, guessAtPick: guess?.[role] ?? null } }))
  }
  const hasError = allProblems.some((p) => p.severity === 'error')

  // service の推定に問題があるとき(推定できない・選んだあとに推定が変わった)は、詳しい設定を開いて選び直してもらう。
  // 期間が決まるまでは推定しないので、問題としない
  const serviceProblem =
    !groupMode &&
    validity !== null &&
    (weekday === null ||
      replacement === null ||
      (['weekday', replacementRole] as const).some((role) => {
        const o = overrides[role]
        const g = guess?.[role] ?? null
        return o !== undefined && g !== null && g !== o.guessAtPick && g !== o.value
      }))
  const [detailsOpen, setDetailsOpen] = useState(serviceProblem)
  const detailsSummaryRef = useRef<HTMLElement>(null)
  const needsDetails = serviceProblem || vanishingRoutes > 0
  // 問題が出たときに一度だけ開く(利用者が閉じたら、問題が消えて出直すまで閉じたままにする)
  const [hadServiceProblem, setHadServiceProblem] = useState(serviceProblem)
  if (serviceProblem !== hadServiceProblem) {
    setHadServiceProblem(serviceProblem)
    if (serviceProblem) setDetailsOpen(true)
  }

  // 決まらない行などで作れないときの「手動で選ぶ」:詳しい設定を開いて手動にし、手動の欄の見出しへ焦点を移す
  function openManual() {
    flushSync(() => {
      setReplaceMode('manual')
      setDetailsOpen(true)
    })
    const el = document.getElementById(GROUP_MANUAL_ID)
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    el?.focus({ preventScroll: true })
  }

  function submit(replaceClaudeDraft = false) {
    if (!settings) return
    setMessage(null)
    const r = proposeAsUser({ type: 'applyPolicy', settings, reason: reasonOf(reasonChoice, otherText, note) }, { replaceClaudeDraft })
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
          入力の有効期間(feed_info の feed_start_date・feed_end_date、calendar の期間)が分からないため、減便の方針を選べません。
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      aria-label="減便の方針"
      // ブラウザ標準の範囲検証で送信を止めない。範囲の外の日付は、checkPolicy の警告
      // (periodStartClamped・periodEndClamped。入力の端にそろえる)でアプリ側が知らせる
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {/* 入力の中心は1つの文。「[理由] のため、[開始日] から [終了日] までの間、[平日] を [土曜] ダイヤに変更する。」の穴を埋める */}
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="sr-only">減便の内容</legend>
        <p className="text-xs text-muted-foreground">文の枠を押して選びます。減便の理由は任意です。</p>
        <div data-testid="policy-sentence" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
          <ReasonHole
            choice={reasonChoice}
            onChoiceChange={setReasonChoice}
            otherText={otherText}
            onOtherTextChange={setOtherText}
            note={note}
            onNoteChange={setNote}
            noteHintId={REASON_NOTE_HINT_ID}
          />
          <span>のため、</span>
          <PeriodHoles
            input={input}
            start={startDate}
            onStartChange={setStartDate}
            end={endDate}
            onEndChange={setEndDate}
            indefinite={indefinite}
            onIndefiniteChange={setIndefinite}
            holidayState={holidayState}
          />
          <PolicyKindField kind={kind} onChange={setKind} labels={grouped?.status === 'confirmed' ? groupLabels(grouped.byKind, kind, droppedByKind, skippedByKind) : undefined} />
        </div>
        {reasonChoice !== null && reasonChoice !== 'other' && (
          // 括弧の補足の入力欄の説明(aria-describedby)。見た目は小さく
          <p id={REASON_NOTE_HINT_ID} className="text-[11px] leading-tight text-muted-foreground">
            括弧の補足は、変更指示書に載せます。
          </p>
        )}
      </fieldset>

      <section aria-label="確認の結果" className="flex flex-col gap-1.5 rounded-md bg-muted/50 px-2.5 py-2">
        {period === null && (
          <p className="text-xs text-muted-foreground">
            {/* 終了日は、セレクトで「終了日」を選んだときと、開始日を終了日より後にしたときに空になる */}
            {[!startDate && '開始日', !indefinite && !endDate && '終了日'].filter(Boolean).join('と')}を選んでください。
          </p>
        )}
        <PeriodChecks validity={validity} periodProblems={periodProblems} holidayState={holidayState} />
        {reasonChoice === 'other' && otherText.trim() === '' && (
          <p className="text-xs text-muted-foreground">その他の理由が空のため、理由は記録しません。</p>
        )}
        {sameSatSun && (
          <p className="text-xs text-muted-foreground">この GTFS では土曜と日祝が同じ時刻表のため、どちらに変更しても同じ結果になります。</p>
        )}
        {groupValue && sentenceServices(groupValue, dropped, skipped).replacements.length === 0 && (
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-300" data-testid="groups-erase-only">
            <span aria-hidden="true">! </span>
            {REPLACEMENT_LABELS[kind]}のダイヤに入れ替える便がないため、{diaLabel('平日', sentenceServices(groupValue, dropped, skipped).weekdays)}
            の便は、期間の間すべてなくなります(土曜・日祝の便には入れ替わりません)。
          </p>
        )}
        {grouped?.status === 'unconfirmed' && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-900 dark:text-amber-300" data-testid="groups-unconfirmed">
            <p>
              <span aria-hidden="true">! </span>
              この GTFS は平日・土曜・日祝のダイヤが複数の service_id に分かれています。
              {jevState === 'awaitingConsent'
                ? '手順「読み込み」で Jev に送るかを選ぶと、ダイヤ単位で選べます'
                : 'Jev の答えが届くと、ダイヤ単位で選べます'}
              (それまでは、下の詳しい設定で選んだ service だけを入れ替えます)。
            </p>
            {(jevState === 'checking' || jevState === 'sending') && (
              <Button type="button" variant="outline" size="xs" onClick={stopJev}>
                Jev を待たずに規則だけで進める
              </Button>
            )}
          </div>
        )}
        {groupErrors && (
          <div className="flex flex-col items-start gap-1 text-xs text-destructive" data-testid="groups-error">
            {groupErrors.map((p) => (
              <p key={p.code}>
                <span aria-hidden="true">! </span>
                {p.message}
              </p>
            ))}
            {!(detailsOpen && replaceMode === 'manual') && (
              <Button type="button" variant="outline" size="xs" onClick={openManual}>
                手動で選ぶ
              </Button>
            )}
          </div>
        )}
        {needsDetails && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-900 dark:text-amber-300">
            {serviceProblem && (
              <p>
                <span aria-hidden="true">! </span>
                {weekday === null || replacement === null ? '入れ替える service を推定できませんでした。' : '入れ替える service の推定を確かめてください。'}
                詳しい設定で service を選んでください。
              </p>
            )}
            {vanishingRoutes > 0 && (
              <p>
                <span aria-hidden="true">! </span>
                {REPLACEMENT_LABELS[kind]}の便がない系統が {vanishingRoutes} 系統あり、このままでは全曜日で便がなくなります。詳しい設定で入れ替えから除外できます。
              </p>
            )}
            {(!detailsOpen || (vanishingRoutes > 0 && !routesOpen)) && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  // 押すとこのボタンは消えるので、開いた詳しい設定の見出しへ焦点を移す(焦点を body に落とさない)
                  flushSync(() => {
                    setDetailsOpen(true)
                    if (vanishingRoutes > 0) setRoutesOpen(true)
                  })
                  detailsSummaryRef.current?.focus()
                }}
              >
                詳しい設定を開く
              </Button>
            )}
          </div>
        )}
        <IssueList issues={problems.map((p) => problemIssue(p, weekdayCalendarNote))} title="減便内容の確認" />
      </section>

      <details
        className="text-sm"
        open={detailsOpen}
        onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
        data-testid="policy-details"
      >
        <summary ref={detailsSummaryRef} className="cursor-pointer">
          詳しい設定(
          {groupMode
            ? `ダイヤ:${groupSummary(groupValue, dropped, skipped)}`
            : `service:${serviceSummary(validity !== null, weekday, replacement, REPLACEMENT_LABELS[kind])}`}
          、除外する系統:
          {excluded.length > 0 ? `${excluded.length} 系統` : 'なし'})
        </summary>
        {/* 開いた中身は、文や確認の結果と同じ高さに見えないよう、左の線で1つのまとまりにする */}
        <div className="mt-2 flex min-w-0 flex-col gap-3 border-l pl-3">
          {groupMode ? (
            <fieldset className="flex min-w-0 flex-col gap-2" data-testid="policy-groups">
              <legend className="mb-1 text-sm font-medium">入れ替えるダイヤ</legend>
              <GroupReplaceFields
                kind={kind}
                value={groupValue}
                errors={groupErrors}
                mode={replaceMode}
                onModeChange={setReplaceMode}
                tripCounts={groupTrips}
                dropped={dropped}
                skipped={skipped}
              />
              <ServiceDetails feed={feed} services={services} validity={validity} />
            </fieldset>
          ) : (
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">入れ替える service</legend>
            <ServiceSelect
              id="policy-weekday"
              label="入れ替え元のダイヤ(平日)"
              services={services}
              value={weekday}
              guess={guess?.weekday ?? null}
              override={overrides.weekday}
              onChange={(v) => pick('weekday', v)}
            />
            <ServiceSelect
              id="policy-replacement"
              label={`入れ替えに使うダイヤ(${REPLACEMENT_LABELS[kind]})`}
              services={services}
              value={replacement}
              guess={guess?.[replacementRole] ?? null}
              override={overrides[replacementRole]}
              onChange={(v) => pick(replacementRole, v)}
            />
            {guess && guess.notes.length > 0 && <NoteList items={guess.notes} label="推定できなかった理由" />}
            <ServiceDetails feed={feed} services={services} validity={validity} />
          </fieldset>
          )}

          <ExcludedRoutes
            stats={routeStats}
            excluded={excluded}
            onChange={setExcluded}
            replacementLabel={REPLACEMENT_LABELS[kind]}
            open={routesOpen}
            onOpenChange={setRoutesOpen}
          />
        </div>
      </details>

      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {confirmingReplace && draft ? (
        <InlineConfirm
          label="AI の下書きを破棄する確認"
          message={replaceClaudeDraftMessage(draft)}
          confirmLabel="破棄して続ける"
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

/** 括弧の補足の入力欄の説明の id(「変更指示書に載せます」) */
const REASON_NOTE_HINT_ID = 'policy-reason-note-hint'

/** 減便の理由の穴の選択肢。'other' は「その他」(文の中の入力欄に書いた文が理由になる。区分は null)、'none' は選ばない */
type ReasonChoice = NonNullable<PolicyReason['category']> | 'other'
const NO_REASON = 'none'

/** 理由の値 → 穴の選択。区分が無くて文があれば「その他」(Claude の下書きや前の方針で、区分を選ばずにメモだけを書いたもの) */
function reasonChoiceOf(reason: PolicyReason | null): ReasonChoice | null {
  if (!reason) return null
  if (reason.category) return reason.category
  return reason.note.trim() !== '' ? 'other' : null
}

/** 穴の選択と文 → 減便の理由。選んでいなければ区分もメモも空、「その他」なら区分は null でメモにその文、区分なら補足がメモ */
function reasonOf(choice: ReasonChoice | null, otherText: string, note: string): PolicyReason {
  if (choice === null) return { category: null, note: '' }
  if (choice === 'other') return { category: null, note: otherText.trim() }
  return { category: choice, note: note.trim() }
}

/**
 * グループの語の選択肢:「平日のダイヤ(01001 ほか 3)」と、種類ごとの「土曜のダイヤ(03001 ほか 3)」。
 * 対象便の確認・変更指示書の文(groupSentence)と同じ数え方にする:入れ替える組だけを数え、なくす service と
 * 期間に走らないため除く組と、期間に走らないため加えない入れ替えに使う service は数えない(入れ替える組が無ければ、なくす平日の service)
 */
function groupLabels(
  byKind: Record<PolicyKind, GroupChoice>,
  kind: PolicyKind,
  droppedByKind: Record<PolicyKind, ReadonlySet<string>>,
  skippedByKind: Record<PolicyKind, ReadonlySet<string>>,
): { weekday: string; targets: Record<PolicyKind, string> } {
  const value = (k: PolicyKind) => {
    const c = byKind[k]
    return 'error' in c ? null : c
  }
  const current = value(kind)
  const targets = Object.fromEntries(
    POLICY_KINDS.map((k) => {
      const v = value(k)
      return [k, diaLabel(REPLACEMENT_LABELS[k], v ? sentenceServices(v, droppedByKind[k], skippedByKind[k]).replacements : [])]
    }),
  ) as Record<PolicyKind, string>
  return { weekday: diaLabel('平日', current ? sentenceServices(current, droppedByKind[kind], skippedByKind[kind]).weekdays : []), targets }
}

/**
 * 詳しい設定の summary のダイヤの部分:「組 4・なくす 1・残す 2」(期間に走らないため除く組は数えない。
 * 入れ替えに使う service がすべて期間に走らない組は「なくす」に数え、加えない入れ替えに使う service の数を「加えない」に出す)
 */
function groupSummary(
  value: Exclude<GroupChoice, { error: unknown }> | null,
  dropped: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): string {
  if (!value) return '選べません'
  const pairs = choicePairs(value).filter((p) => !dropped.has(p.weekday))
  const replaced = pairs.filter((p) => p.replacements.some((r) => !skipped.has(r))).length
  const erased = pairs.length - replaced
  const kept = value.keptWeekdayServices?.length ?? 0
  const notAdded = pairs.flatMap((p) => p.replacements).filter((r) => skipped.has(r)).length
  return [
    `組 ${replaced}`,
    ...(erased > 0 ? [`なくす ${erased}`] : []),
    ...(kept > 0 ? [`残す ${kept}`] : []),
    ...(dropped.size > 0 ? [`期間に走らない ${dropped.size}`] : []),
    ...(notAdded > 0 ? [`期間に走らず加えない ${notAdded}`] : []),
  ].join('・')
}

/** 詳しい設定の summary の service の部分。「平日 WK を土曜 SA に」。期間が決まるまでは推定しないので、その旨を出す */
function serviceSummary(hasPeriod: boolean, weekday: string | null, replacement: string | null, replacementLabel: string): string {
  if (!hasPeriod && (weekday === null || replacement === null)) return '期間を選ぶと推定します'
  return `平日 ${weekday ?? '未選択'} を${replacementLabel} ${replacement ?? '未選択'} に`
}

/**
 * 減便の文の「[減便の理由] のため、」の穴。選択肢は区分3つと「その他」。「その他」を選ぶと、その場に文字の入力欄が出る
 * (書いた文が理由そのもので、括弧は出さない)。区分を選ぶと、理由の直後に「(補足)」の入力欄が出る(任意。変更指示書に載せる)。
 * 選んでいない間は、破線の枠に薄く「理由」と出す
 */
function ReasonHole({
  choice,
  onChoiceChange,
  otherText,
  onOtherTextChange,
  note,
  onNoteChange,
  noteHintId,
}: {
  choice: ReasonChoice | null
  onChoiceChange: (c: ReasonChoice | null) => void
  otherText: string
  onOtherTextChange: (v: string) => void
  note: string
  onNoteChange: (v: string) => void
  /** 補足の入力欄の説明(「変更指示書に載せます」)の id */
  noteHintId: string
}) {
  const otherRef = useRef<HTMLInputElement>(null)
  // 「その他」を選んだら、閉じたときに焦点をセレクトに戻さず、文の中に出た入力欄に移す
  const focusOther = useRef(false)
  return (
    <>
      <Select
        value={choice ?? ''}
        onValueChange={(v) => {
          focusOther.current = v === 'other'
          onChoiceChange(v === NO_REASON ? null : (v as ReasonChoice))
        }}
      >
        <SelectTrigger size="sm" aria-label="減便の理由" className={cn('max-w-full font-normal', choice === null && EMPTY_HOLE_CLASS)}>
          <SelectValue placeholder="理由" />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(e) => {
            if (!focusOther.current) return
            focusOther.current = false
            e.preventDefault()
            otherRef.current?.focus()
          }}
        >
          {(Object.keys(REASON_LABELS) as NonNullable<PolicyReason['category']>[]).map((c) => (
            <SelectItem key={c} value={c}>
              {REASON_LABELS[c]}
            </SelectItem>
          ))}
          <SelectItem value="other">その他</SelectItem>
          {choice !== null && <SelectItem value={NO_REASON}>選ばない</SelectItem>}
        </SelectContent>
      </Select>
      {choice === 'other' && (
        <Input
          ref={otherRef}
          aria-label="減便の理由(その他)"
          // 書いた文の長さに合わせて広げる(field-sizing は Chrome・Edge で効く)。欄より長ければ欄の幅で止める
          className="h-7 w-auto min-w-32 max-w-full text-sm field-sizing-content md:text-sm"
          placeholder="例:道路工事による迂回"
          value={otherText}
          onChange={(e) => onOtherTextChange(e.target.value)}
        />
      )}
      {choice !== null && choice !== 'other' && (
        // 括弧と入力欄は折り返しで離さない。括弧は見た目だけ(読み上げは入力欄の名前で足りる)
        <span className="inline-flex max-w-full min-w-0 items-center gap-0.5">
          <span aria-hidden="true">(</span>
          <Input
            aria-label="減便の理由の補足"
            aria-describedby={noteHintId}
            // 「その他」の欄と同じく、書いた文の長さに合わせて広げる
            className="h-7 w-auto min-w-32 max-w-full text-sm field-sizing-content md:text-sm"
            placeholder="補足(任意)例:インフルエンザ 20 人"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
          />
          <span aria-hidden="true">)</span>
        </span>
      )}
    </>
  )
}

function problemIssue(p: { severity: 'error' | 'warning'; code: string; message: string }, weekdayCalendarNote: string | null): ValidationIssue {
  // 平日の service が1日も走らない理由が calendar の日付の不正にあるかもしれないので、その行は数えていないと添える
  const message = p.code === 'weekdayNotActive' && weekdayCalendarNote ? `${p.message}${weekdayCalendarNote}` : p.message
  return { severity: p.severity, code: p.code, file: '', message, count: 1, examples: [] }
}
