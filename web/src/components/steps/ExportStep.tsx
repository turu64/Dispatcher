import { CircleCheckIcon, DownloadIcon } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { restoreTotals } from '@/gtfs/edit/diff'
import { applyForm2, defaultFeedVersion, feedVersionProblem, type Form2Result } from '@/gtfs/edit/form2'
import { planOf, type PolicyKind } from '@/gtfs/edit/ops'
import { form2Texts, timingNotices, validateEdit, type ValidationIssue } from '@/gtfs/validate/edit'
import { exportFileName, writeGtfsZip } from '@/gtfs/write'
import { appNow, appToday, formatDateJa } from '@/lib/dates'
import { diffOf, draftName, generatedAtOf, lastVersion, useEditStore, type BaseGtfs } from '@/store/edit'
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
  const target = kind ? `出力の${REPLACEMENT_LABELS[kind]}ダイヤ` : '入れ替えに使うダイヤ'
  return `平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は${target}の運用とは対応しません。`
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
  const [previewAt] = useState(() => generatedAtOf(appNow()))
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
      ? `承認待ちの${draftName(draft.id)} があります。「承認する」または「やめる」を押してから出力してください。`
      : !plan || !version
        ? '減便の方針を承認すると出力できます。'
        : versionProblem
          ? versionProblem
          : previewErrors.length > 0
          ? '誤りがあるため出力できません。下の一覧を確かめ、減便の期間などを直してください。'
          : null

  async function onExport() {
    if (!base || !plan || blocked) return
    setBusy(true)
    setError(null)
    setExportIssues([])
    try {
      // 押した時刻で作り直す(承認済みの計画だけを使う)
      const generatedAt = generatedAtOf(appNow())
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
        <p className="text-sm text-muted-foreground">GTFS を読み込み、減便の方針を承認すると、減便を反映した GTFS を出力できます。</p>
      ) : (
        <>
          {version && <ExportSummary base={base} version={version} customVersion={versionProblem ? '' : customVersion} />}
          <div className={version ? 'flex flex-col gap-3 border-t pt-3' : 'flex flex-col gap-3'}>
            <FeedVersionField before={version?.report.feedVersion.before ?? feedInfoVersion(base)} problem={versionProblem} previewAt={previewAt} />
            <p className="text-xs text-muted-foreground" data-testid="trip-id-note">
              {tripIdNote(plan?.kind ?? null)}
            </p>
            <IssueList issues={preview} title="出力の前の検証" />
            {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
            <Button type="button" className="self-start" disabled={blocked !== null} loading={busy} loadingLabel="出力中" onClick={() => void onExport()}>
              <DownloadIcon aria-hidden="true" />
              GTFS を出力する
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <IssueList issues={exportIssues} title="出力のときの検証" />
          {exported && (
            <div role="status" className="flex flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs">
              <p className="flex flex-wrap items-center gap-x-1">
                <CircleCheckIcon className="size-3.5 text-emerald-600" aria-hidden="true" />
                出力しました:<span className="font-mono break-all">{exported.fileName}</span>(feed_version {exported.feedVersion}、作成{' '}
                {generatedAtText(exported.generatedAt)})
              </p>
              <a href={exported.url} download={exported.fileName} className="self-start underline">
                もう一度ダウンロードする
              </a>
            </div>
          )}
          <Attribution base={base} generatedAt={exported?.generatedAt ?? null} />
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
        入力の feed_version は {before || '(空)'}。空欄なら、入力が空か 12 桁のときは出力した日時、それ以外は「入力の値_dispatcher_出力した日時」にします。
        公開先が新しい版と見なすよう、入力より大きい値にしてください。
      </p>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  )
}

/** 出力する内容の要約(承認済みの最後の版):有効期間、feed_version、§5.10 の文言、平日便、全曜日で便がなくなる系統、足し戻しの集計 */
function ExportSummary({ base, version, customVersion }: { base: BaseGtfs; version: Form2Result; customVersion: string }) {
  // 実施日までの日数などに使う今日(日本時間)。画面を開いた日
  const [today] = useState(() => appToday())
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
      {/* 見出しの「:」は読み上げと文の検索のために残し、見た目では隠す */}
      <dl className="grid grid-cols-2 gap-2 text-sm" aria-label="出力する GTFS">
        <div className="col-span-2 flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">
            有効期間<span className="sr-only">:</span>
          </dt>
          <dd className="font-semibold tabular-nums">
            {formatDateJa(report.validity.start)}〜{formatDateJa(report.validity.end)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">({report.validity.days}日)</span>
          </dd>
        </div>
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
          <dt className="text-xs text-muted-foreground">
            平日便<span className="sr-only">:</span>
          </dt>
          <dd className="text-base font-semibold">
            <FromTo before={before} after={after} emphasizeDecrease={after < before} /> 便
          </dd>
        </div>
        <div className={`flex flex-col rounded-md px-2 py-1.5 ${vanishing.length > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted/50'}`}>
          <dt className={`text-xs ${vanishing.length > 0 ? '' : 'text-muted-foreground'}`}>
            全曜日で便がなくなる系統<span className="sr-only">:</span>
          </dt>
          <dd className="text-base font-semibold tabular-nums">
            {vanishing.length} 系統
            {vanishing.length > 0 && <span className="text-xs font-normal">({vanishing.map((r) => r.routeName).join('、')})</span>}
          </dd>
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <dt className="text-xs text-muted-foreground">
            feed_version<span className="sr-only">:</span>
          </dt>
          <dd className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="font-mono break-all">
              {report.feedVersion.before || '(空)'}
            </Badge>
            {' → '}
            {customVersion !== '' ? (
              <Badge variant="secondary" className="font-mono break-all">
                {customVersion}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">出力した日時の値(承認したときの例 {report.feedVersion.after})</span>
            )}
          </dd>
        </div>
      </dl>
      {report.addBack.accepted.length > 0 && <p className="text-xs">{restoreTotalsText(totals)}</p>}
      <NoteList
        items={texts.validity}
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
    <section className="flex flex-col gap-1 border-t pt-3 text-xs" aria-label="出力の出典">
      <h3 className="text-sm font-medium">出力の出典</h3>
      <p className="break-words">{text}</p>
      <p className="text-muted-foreground">
        ZIP には同じ内容を ATTRIBUTION.md として入れます{generatedAt === null && '(加工日時は出力した日時になります)'}。
      </p>
    </section>
  )
}
