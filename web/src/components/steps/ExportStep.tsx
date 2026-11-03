import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { restoreTotals } from '@/gtfs/edit/diff'
import HolidayCalendar from '@/components/HolidayCalendar'
import { addDays } from '@/gtfs/calendar'
import { applyForm2, applyRevert, defaultFeedVersion, feedVersionProblem, type Form2Result, type RevertOptions } from '@/gtfs/edit/form2'
import { planOf, type Form2Plan, type PolicyKind } from '@/gtfs/edit/ops'
import { describeServices, feedValidity, guessServiceChoice } from '@/gtfs/edit/services'
import type { HolidayList } from '@/gtfs/holidays'
import { form2Texts, timingNotices, validateEdit, type ValidationIssue } from '@/gtfs/validate/edit'
import { exportFileName, writeGtfsZip } from '@/gtfs/write'
import { formatDateJa, todayInJapan } from '@/lib/dates'
import { diffOf, generatedAtOf, lastVersion, useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { FromTo, IssueList, NoteList } from './editParts'
import { attributionOf, generatedAtText, REPLACEMENT_LABELS, restoreTotalsText } from './editText'

interface Exported {
  url: string
  fileName: string
  generatedAt: string
  feedVersion: string
}

/**
 * 足し戻した便と trip_id の注意(取り決め 1104 §5.4 の運用の違い)。
 * 写す元のダイヤは方針で決まる(土曜・日祝)。方針がまだ無いときは「入れ替え先のダイヤ」と書く
 */
function tripIdNote(kind: PolicyKind | null): string {
  const target = kind ? `出力の${REPLACEMENT_LABELS[kind]}ダイヤ` : '入れ替え先のダイヤ'
  return `足し戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は${target}の運用とは対応しません。`
}

function errorsIn(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error')
}

/**
 * 手順6:GTFS を出力(docs/interfaces-1104.md §9)。
 * 出力に使うのは承認済みの操作だけ(planOf(history))。下書きは含めない。押した時刻で作り直し、検証してから ZIP に書く。
 * GTFS はブラウザの中だけで作り、サーバーには送らない。
 */
export default function ExportStep() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const holidayState = useHolidayStore((s) => s.holidays)
  const holidays = holidayState.status === 'ready' ? holidayState.list : null
  const plan = useMemo(() => planOf(history), [history])
  const version = lastVersion({ versions })
  const feedVersion = useEditStore((s) => s.feedVersion)
  const customVersion = feedVersion.trim()
  const versionProblem = feedVersionProblem(customVersion)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportIssues, setExportIssues] = useState<ValidationIssue[]>([])
  const [exported, setExported] = useState<Exported | null>(null)
  const urlRef = useRef<string | null>(null)

  // 作ったダウンロードの URL は、次に作るときと画面を閉じるときに片付ける
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )
  // 読み込み直したとき、承認済みの最後の版が変わったとき(承認・元に戻す・すべて戻す)は、前の出力を消す。
  // 残すと「もう一度ダウンロードする」が古い内容の ZIP を指し、公開する版を取り違えるため
  const [shown, setShown] = useState({ base, version })
  if (base !== shown.base || version !== shown.version) {
    setShown({ base, version })
    setExported(null)
    setError(null)
    setExportIssues([])
  }
  // 出力を消したら、そのダウンロードの URL も片付ける
  useEffect(() => {
    if (exported === null && urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [exported])

  // 検証は、出力する feed_version と同じ値で行う。利用者が入れていれば、その値で作り直した版を見る
  // (既定の規則のときは、feed_version は出力の日時で決まるので、承認した版のままで足りる)
  // 作り直しと検証は道北バスの規模で 70ms ほどかかるので、入力のたびには待たせない(useDeferredValue で後から追いつく)。
  // 追いつく前に押されても、出力のときに押した値で作り直して検証するので、誤った値は書き出さない
  const [previewAt] = useState(() => generatedAtOf(new Date()))
  const deferredVersion = useDeferredValue(customVersion)
  const deferredProblem = feedVersionProblem(deferredVersion)
  const previewVersion = useMemo<Form2Result | null>(() => {
    if (!base || !plan || !version) return null
    if (deferredVersion === '' || deferredProblem) return version
    const outcome = applyForm2(base.feed, plan, { generatedAt: previewAt, feedVersion: deferredVersion })
    return outcome.ok ? outcome.result : version
  }, [base, plan, version, deferredVersion, deferredProblem, previewAt])
  const preview = useMemo(
    () => (base && previewVersion ? validateEdit(base.feed, previewVersion, holidays) : []),
    [base, previewVersion, holidays],
  )
  const previewErrors = errorsIn(preview)
  const blocked = !base
    ? null
    : draft
      ? `下書き ${draft.id} を承認するか、やめてから出力してください。`
      : !plan || !version
        ? '方針を適用してから出力できます。'
        : versionProblem
          ? versionProblem
          : previewErrors.length > 0
          ? '誤りがあるため出力できません(下の一覧)。方針の期間などを直してください。'
          : null

  async function onExport() {
    if (!base || !plan || blocked) return
    setBusy(true)
    setError(null)
    setExportIssues([])
    try {
      // 押した時刻で作り直す(承認済みの計画だけを使う)
      const generatedAt = generatedAtOf(new Date())
      const outcome = applyForm2(base.feed, plan, { generatedAt, feedVersion: customVersion })
      if (!outcome.ok) {
        setError(outcome.message)
        return
      }
      const issues = validateEdit(base.feed, outcome.result, holidays)
      if (errorsIn(issues).length > 0) {
        setExportIssues(issues)
        setError('検証で誤りが見つかったため、出力しませんでした。')
        return
      }
      const attribution = attributionOf(base.sample, generatedAt)
      const blob = await writeGtfsZip({
        original: base.zip,
        base: base.feed,
        edited: outcome.result.feed,
        generatedAt,
        attribution: attribution.file,
      })
      // 書いている間に編集が変わったら(元に戻すなど)、古い内容の ZIP は渡さない
      const now = useEditStore.getState()
      if (now.base !== base || lastVersion(now) !== version || now.feedVersion.trim() !== customVersion) {
        setError('出力の途中で編集の内容が変わったため、出力をやめました。もう一度押してください。')
        return
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const fileName = exportFileName(base.label, generatedAt)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setExported({ url, fileName, generatedAt, feedVersion: outcome.result.report.feedVersion.after })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'GTFS を出力できませんでした。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepSection title="6. GTFS を出力">
      {!base ? (
        <p className="text-sm text-muted-foreground">GTFS を読み込み、方針を承認すると、減便を反映した GTFS を出力できます。</p>
      ) : (
        <>
          {version && <ExportSummary base={base} version={version} customVersion={versionProblem ? '' : customVersion} />}
          <FeedVersionField before={version?.report.feedVersion.before ?? feedInfoVersion(base)} problem={versionProblem} previewAt={previewAt} />
          <p className="text-xs" data-testid="trip-id-note">
            {tripIdNote(plan?.kind ?? null)}
          </p>
          <IssueList issues={preview} title="出力の前の検証" />
          {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          <Button type="button" className="self-start" disabled={blocked !== null} loading={busy} loadingLabel="出力中" onClick={() => void onExport()}>
            GTFS を出力する
          </Button>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <IssueList issues={exportIssues} title="出力のときの検証" />
          {exported && (
            <div role="status" className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs">
              <p>
                出力しました:<span className="font-mono break-all">{exported.fileName}</span>(feed_version {exported.feedVersion}、作成{' '}
                {generatedAtText(exported.generatedAt)})
              </p>
              <a href={exported.url} download={exported.fileName} className="self-start underline">
                もう一度ダウンロードする
              </a>
            </div>
          )}
          <Attribution base={base} generatedAt={exported?.generatedAt ?? null} />
          <RevertExport base={base} plan={plan} holidays={holidays} />
        </>
      )}
    </StepSection>
  )
}

/** 入力の feed_info の feed_version(1行目)。無ければ空 */
function feedInfoVersion(base: BaseGtfs): string {
  return (base.feed.tables.get('feed_info')?.rows[0]?.feed_version ?? '').trim()
}

/**
 * feed_version の入力欄。空なら既定の規則(入力が空か 12 桁なら出力の日時、それ以外は '{入力}_dispatcher_{日時}')。
 * 入れた値が入力の値以下なら、下の検証の一覧に feedVersionNotIncreasing の注意が出る(同じ値なら誤り)
 */
function FeedVersionField({ before, problem, previewAt }: { before: string; problem: string | null; previewAt: string }) {
  const value = useEditStore((s) => s.feedVersion)
  const setValue = useEditStore((s) => s.setFeedVersion)
  const example = defaultFeedVersion(before, previewAt)
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="export-feed-version">出力する feed_version</Label>
      <Input
        id="export-feed-version"
        value={value}
        placeholder={`空欄なら出力した日時(例 ${example})`}
        aria-invalid={problem ? true : undefined}
        aria-describedby="export-feed-version-help"
        onChange={(e) => setValue(e.target.value)}
        className="font-mono"
      />
      <p id="export-feed-version-help" className="text-xs text-muted-foreground">
        入力の feed_version は {before || '(空)'}。空欄のときは、入力が空か 12 桁なら出力した日時、それ以外は「入力の値_dispatcher_出力した日時」にします。
        公開先が新しい版と見なすよう、入力より大きい値にしてください。
      </p>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  )
}

/** 出力する内容の要約(承認済みの最後の版):有効期間、feed_version、§5.10 の文言、平日便、全曜日で便がなくなる系統、足し戻しの集計 */
function ExportSummary({ base, version, customVersion }: { base: BaseGtfs; version: Form2Result; customVersion: string }) {
  // 実施日までの日数などに使う今日(日本時間)。画面を開いた日
  const [today] = useState(() => todayInJapan(new Date()))
  const { report } = version
  const diff = useMemo(() => diffOf(base.feed, version), [base.feed, version])
  const totals = useMemo(() => restoreTotals(base.feed, report.addBack.accepted), [base.feed, report.addBack.accepted])
  let before = 0
  let after = 0
  for (const r of diff.byRoute) {
    before += r.before
    after += r.after
  }
  const vanishing = diff.byRoute.filter((r) => r.vanishes)
  const texts = form2Texts(version, today)
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-0.5 text-sm" aria-label="出力する GTFS">
        <div>
          <dt className="inline">有効期間:</dt>
          <dd className="inline">
            {formatDateJa(report.validity.start)}〜{formatDateJa(report.validity.end)}({report.validity.days}日)
          </dd>
        </div>
        <div>
          <dt className="inline">feed_version:</dt>
          <dd className="inline">
            {report.feedVersion.before || '(空)'} →{' '}
            {customVersion !== '' ? <span className="font-mono break-all">{customVersion}</span> : `出力した日時の値(承認したときの例 ${report.feedVersion.after})`}
          </dd>
        </div>
        <div>
          <dt className="inline">平日便:</dt>
          <dd className="inline">
            <FromTo before={before} after={after} emphasizeDecrease={after < before} /> 便
          </dd>
        </div>
        <div className={vanishing.length > 0 ? 'font-semibold text-destructive' : undefined}>
          <dt className="inline">全曜日で便がなくなる系統:</dt>
          <dd className="inline">
            {vanishing.length} 系統{vanishing.length > 0 && `(${vanishing.map((r) => r.routeName).join('、')})`}
          </dd>
        </div>
      </dl>
      {report.addBack.accepted.length > 0 && <p className="text-xs">{restoreTotalsText(totals)}</p>}
      <NoteList
        items={version.plan.period.end !== null ? [...texts.validity, '元のダイヤに戻す版は、この画面の下の「減便をやめる版」で作れます。'] : texts.validity}
        label="有効期間と期間の外"
      />
      <NoteList items={texts.changes} label="何が変わるか" />
      <IssueList issues={timingNotices(version, today)} title="実施日までの日数と公開の注意" />
    </div>
  )
}

/** 出典(画面と ZIP の ATTRIBUTION.md に同じ内容) */
function Attribution({ base, generatedAt }: { base: BaseGtfs; generatedAt: string | null }) {
  const text = attributionOf(base.sample, generatedAt).screen
  return (
    <section className="flex flex-col gap-1 text-xs" aria-label="出力の出典">
      <h3 className="font-medium">出力の出典</h3>
      <p className="break-words">{text}</p>
      <p className="text-muted-foreground">
        ZIP には同じ内容を ATTRIBUTION.md として入れます{generatedAt === null && '(加工日時は出力した日時になります)'}。
      </p>
    </section>
  )
}

// ---- 減便をやめる版(docs/tasks-1103.md T23、取り決め 1104 §12.1-3 の (a)) ----

/** 戻す日の既定:承認した方針に期間の終わりがあればその翌日、無ければ今日。入力の有効期間の中にそろえる */
function defaultRestoreFrom(plan: Form2Plan | null, input: { start: string; end: string }, today: string): string {
  const d = plan?.period.end ? addDays(plan.period.end, 1) : today
  return d < input.start ? input.start : d > input.end ? input.end : d
}

/**
 * 検証で「平日ダイヤ」として見る service:承認した方針があればその service、無ければ推定した平日の service。
 * 祝日・年末年始の確かめに使うだけで、便の中身は変えない
 */
function revertServices(base: BaseGtfs, plan: Form2Plan | null, holidays: HolidayList | null, input: { start: string; end: string }): RevertOptions['services'] {
  if (plan) return { kind: plan.kind, weekdayService: plan.weekdayService, replacementService: plan.replacementService }
  const weekday = guessServiceChoice(base.feed, describeServices(base.feed, holidays), input).weekday
  return weekday ? { kind: 'weekdayToSaturday', weekdayService: weekday, replacementService: '' } : undefined
}

/**
 * 減便をやめる版の検証の結果。validateEdit は形2の出力に向けた文言なので、この版に合わないものを除き、言い換える。
 * - weekdayNotRunning(「方針の対象になりません」)と validityGapBefore(形2の理由の文)は出さない。期間の外は revertTexts が書く
 * - 「減便後の平日ダイヤ」は、この版では元の平日ダイヤなので「平日ダイヤ」と書く。言い換えるのは、その語を使う
 *   holidayWithoutException・yearEnd だけ(validate/edit.ts の文言が変わると効かなくなるので、ExportStep.test.tsx で確かめている)
 */
const REVERT_SKIPPED_CODES = new Set(['weekdayNotRunning', 'validityGapBefore'])
const REVERT_REWORDED_CODES = new Set(['holidayWithoutException', 'yearEnd'])
function revertIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues
    .filter((i) => !REVERT_SKIPPED_CODES.has(i.code))
    .map((i) => (REVERT_REWORDED_CODES.has(i.code) ? { ...i, message: i.message.replaceAll('減便後の平日ダイヤ', '平日ダイヤ') } : i))
}

/**
 * 減便をやめる版の公開の注意。便を消さない版なので「便の削除が大きいと審査が長引く」の注意(publishNotes)は出さない。
 * ただし、新しい有効期間に走らなくなる service の便を除いたとき(report.droppedServices)は便が減るので出す
 */
function revertTimingNotices(result: Form2Result, today: string): ValidationIssue[] {
  const notices = timingNotices(result, today)
  if (result.report.droppedServices.length > 0) return notices
  return notices.filter((i) => !(i.code === 'publishNotes' && i.message.includes('便の削除')))
}

function revertTexts(result: Form2Result): string[] {
  const { validity, inputValidity } = result.report
  const texts = [
    `出力する GTFS の有効期間は ${formatDateJa(validity.start)}〜${formatDateJa(validity.end)}(${validity.days}日)です。便と時刻は読み込んだ GTFS のままで、減便の方針と足し戻しは入りません。`,
  ]
  if (validity.start > inputValidity.start) {
    texts.push(`${formatDateJa(inputValidity.start)}〜${formatDateJa(addDays(validity.start, -1))} は出力に含まれません(戻す日より前は減便版の期間です)。`)
  }
  texts.push(
    '読み込んだ GTFS が減便前の元の GTFS であることを確かめてください。減便版の ZIP を読み込んでいると、減便のダイヤのまま出力されます。',
    'feed_version は、公開中の減便版の feed_version より大きい値にしてください。公開先が新しい版と見なさないことがあります。',
  )
  return texts
}

/** 減便をやめる版の出典(画面と ZIP の ATTRIBUTION.md)。減便を反映した版の文(attributionOf)とは加工の内容が違う */
function revertAttributionOf(sample: BaseGtfs['sample'], generatedAt: string | null): { file: string; screen: string } {
  const when = generatedAt === null ? '出力した日時' : generatedAtText(generatedAt)
  if (sample) {
    const text = `元データ:${sample.name} GTFS(北海道オープンデータプラットフォーム)。ライセンス:CC BY 4.0(https://creativecommons.org/licenses/by/4.0/deed.ja)。Dispatcher で有効期間と feed_version を書き換えています(便は元のまま。加工日時 ${when})。`
    return { file: `# 出典\n\n${text}\n`, screen: text }
  }
  return {
    file: `# 加工の記録\n\nこの GTFS は、Dispatcher で有効期間と feed_version を書き換えたもの(減便をやめる版。便は元のまま)です(加工日時 ${when})。元の GTFS の出典と利用条件は、元の GTFS の提供者の表示に従ってください。\n`,
    screen: '元の GTFS の利用条件に従って、出典と加工した旨を示してください。',
  }
}

/** 減便をやめる版の ZIP の名前。減便を反映した版と取り違えないよう、後ろに _restore を付ける */
function revertFileName(label: string, generatedAt: string): string {
  return exportFileName(label, generatedAt).replace(/\.zip$/, '_restore.zip')
}

interface RevertExported extends Exported {
  restoreFrom: string
}

/**
 * 減便をやめる版の出力。読み込んだ GTFS の便を変えず、有効期間を「戻す日〜入力の末日」にし、feed_version を新しくする
 * (applyRevert。§5.6・§5.7 の切り詰めと feed_info の規則は形2と同じ)。編集の履歴(方針・足し戻し・下書き)には関わらない。
 * 中身は開いたときだけ作る(検証に道北バスの規模で 70ms ほどかかるため)
 */
function RevertExport({ base, plan, holidays }: { base: BaseGtfs; plan: Form2Plan | null; holidays: HolidayList | null }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-2 border-t pt-3" aria-labelledby="revert-heading">
      <h3 id="revert-heading" className="text-sm font-medium">
        減便をやめる版(元のダイヤに戻す版)
      </h3>
      <p className="text-xs text-muted-foreground">
        減便を終えて元のダイヤに戻すときに公開する GTFS です。読み込んだ GTFS の便をそのまま使い、有効期間を戻す日から入力の末日までにして、feed_version を新しくします。
      </p>
      <Button type="button" variant="outline" size="sm" className="self-start" aria-expanded={open} aria-controls="revert-body" onClick={() => setOpen((v) => !v)}>
        {open ? '減便をやめる版を閉じる' : '減便をやめる版を作る'}
      </Button>
      {open && (
        <div id="revert-body" className="flex flex-col gap-2">
          <RevertBody base={base} plan={plan} holidays={holidays} />
        </div>
      )}
    </section>
  )
}

function RevertBody({ base, plan, holidays }: { base: BaseGtfs; plan: Form2Plan | null; holidays: HolidayList | null }) {
  const [today] = useState(() => todayInJapan(new Date()))
  const [previewAt] = useState(() => generatedAtOf(new Date()))
  const input = useMemo(() => feedValidity(base.feed), [base.feed])
  // null は既定の戻す日(承認した方針に合わせて変わる)。利用者が選んだら、その日のまま
  const [picked, setPicked] = useState<string | null>(null)
  const [feedVersion, setFeedVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportIssues, setExportIssues] = useState<ValidationIssue[]>([])
  const [exported, setExported] = useState<RevertExported | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )
  // 読み込み直したら、選んだ日・feed_version・前の出力を消す
  const [shownBase, setShownBase] = useState(base)
  if (shownBase !== base) {
    setShownBase(base)
    setPicked(null)
    setFeedVersion('')
    setExported(null)
    setError(null)
    setExportIssues([])
  }
  useEffect(() => {
    if (exported === null && urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [exported])

  const restoreFrom = input ? (picked ?? defaultRestoreFrom(plan, input, today)) : null
  const services = useMemo(() => (input ? revertServices(base, plan, holidays, input) : undefined), [base, plan, holidays, input])
  const custom = feedVersion.trim()
  const versionProblem = feedVersionProblem(custom)
  const deferredVersion = useDeferredValue(custom)
  const preview = useMemo(() => {
    if (!restoreFrom) return null
    const v = feedVersionProblem(deferredVersion) ? '' : deferredVersion
    const outcome = applyRevert(base.feed, { generatedAt: previewAt, restoreFrom, feedVersion: v, services })
    if (!outcome.ok) return { result: null, message: outcome.message, issues: [] as ValidationIssue[] }
    return { result: outcome.result, message: null, issues: revertIssues(validateEdit(base.feed, outcome.result, holidays)) }
  }, [base.feed, restoreFrom, deferredVersion, previewAt, services, holidays])

  if (!input || !restoreFrom) {
    return <p className="text-sm text-muted-foreground">入力の有効期間が決まらないため、減便をやめる版を作れません。</p>
  }
  const blocked = versionProblem
    ? versionProblem
    : !preview?.result
      ? (preview?.message ?? null)
      : errorsIn(preview.issues).length > 0
        ? '誤りがあるため出力できません(下の一覧)。戻す日などを直してください。'
        : null

  function pick(date: string) {
    setPicked(date)
    // 前に出力した ZIP は別の戻す日のものなので、表示を消す
    setExported(null)
    setError(null)
    setExportIssues([])
  }

  async function onExport() {
    if (!restoreFrom || blocked) return
    setBusy(true)
    setError(null)
    setExportIssues([])
    try {
      const generatedAt = generatedAtOf(new Date())
      const outcome = applyRevert(base.feed, { generatedAt, restoreFrom, feedVersion: custom, services })
      if (!outcome.ok) {
        setError(outcome.message)
        return
      }
      const issues = revertIssues(validateEdit(base.feed, outcome.result, holidays))
      if (errorsIn(issues).length > 0) {
        setExportIssues(issues)
        setError('検証で誤りが見つかったため、出力しませんでした。')
        return
      }
      const blob = await writeGtfsZip({
        original: base.zip,
        base: base.feed,
        edited: outcome.result.feed,
        generatedAt,
        attribution: revertAttributionOf(base.sample, generatedAt).file,
      })
      // 書いている間に読み込み直したら、古い内容の ZIP は渡さない
      if (useEditStore.getState().base !== base) {
        setError('出力の途中で読み込んだ GTFS が変わったため、出力をやめました。もう一度押してください。')
        return
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const fileName = revertFileName(base.label, generatedAt)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setExported({ url, fileName, generatedAt, feedVersion: outcome.result.report.feedVersion.after, restoreFrom })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '減便をやめる版を出力できませんでした。')
    } finally {
      setBusy(false)
    }
  }

  const result = preview?.result ?? null
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium" id="revert-date-label">
          戻す日(この日から元のダイヤで走る)
        </span>
        <div aria-labelledby="revert-date-label" role="group">
          <HolidayCalendar value={restoreFrom} onChange={pick} min={input.start} max={input.end} holidays={holidays} />
        </div>
        {plan?.period.end && (
          <p className="text-xs text-muted-foreground">既定は、承認した方針の期間の終わり({formatDateJa(plan.period.end)})の翌日です。</p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="revert-feed-version">減便をやめる版の feed_version</Label>
        <Input
          id="revert-feed-version"
          value={feedVersion}
          placeholder={`空欄なら出力した日時(例 ${defaultFeedVersion(result?.report.feedVersion.before ?? feedInfoVersion(base), previewAt)})`}
          aria-invalid={versionProblem ? true : undefined}
          onChange={(e) => setFeedVersion(e.target.value)}
          className="font-mono"
        />
        {versionProblem && <p className="text-xs text-destructive">{versionProblem}</p>}
      </div>
      {result && (
        <>
          <dl className="flex flex-col gap-0.5 text-sm" aria-label="減便をやめる版">
            <div>
              <dt className="inline">有効期間:</dt>
              <dd className="inline">
                {formatDateJa(result.report.validity.start)}〜{formatDateJa(result.report.validity.end)}({result.report.validity.days}日)
              </dd>
            </div>
            <div>
              <dt className="inline">feed_version:</dt>
              <dd className="inline">
                {result.report.feedVersion.before || '(空)'} →{' '}
                {custom !== '' && !versionProblem ? <span className="font-mono break-all">{custom}</span> : `出力した日時の値(例 ${result.report.feedVersion.after})`}
              </dd>
            </div>
          </dl>
          <NoteList items={revertTexts(result)} label="減便をやめる版の有効期間" />
          <IssueList issues={preview?.issues ?? []} title="減便をやめる版の出力の前の検証" />
          <IssueList issues={revertTimingNotices(result, today)} title="減便をやめる版の公開の注意" />
        </>
      )}
      {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
      <Button type="button" className="self-start" disabled={blocked !== null} loading={busy} loadingLabel="出力中" onClick={() => void onExport()}>
        減便をやめる版を出力する
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <IssueList issues={exportIssues} title="減便をやめる版の出力のときの検証" />
      {exported && (
        <div role="status" aria-label="減便をやめる版の出力" className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs">
          <p>
            出力しました:<span className="font-mono break-all">{exported.fileName}</span>(戻す日 {formatDateJa(exported.restoreFrom)}、feed_version{' '}
            {exported.feedVersion}、作成 {generatedAtText(exported.generatedAt)})
          </p>
          <a href={exported.url} download={exported.fileName} className="self-start underline">
            減便をやめる版をもう一度ダウンロードする
          </a>
        </div>
      )}
      <p className="text-xs break-words text-muted-foreground">出典:{revertAttributionOf(base.sample, exported?.generatedAt ?? null).screen}</p>
    </>
  )
}
