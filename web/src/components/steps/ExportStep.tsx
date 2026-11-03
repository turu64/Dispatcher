import { useEffect, useMemo, useRef, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { restoreTotals } from '@/gtfs/edit/diff'
import { applyForm2, type Form2Result } from '@/gtfs/edit/form2'
import { planOf } from '@/gtfs/edit/ops'
import { form2Texts, timingNotices, validateEdit, type ValidationIssue } from '@/gtfs/validate/edit'
import { exportFileName, writeGtfsZip } from '@/gtfs/write'
import { formatDateJa, todayInJapan } from '@/lib/dates'
import { diffOf, generatedAtOf, lastVersion, useEditStore, type BaseGtfs } from '@/store/edit'
import { useHolidayStore } from '@/store/holidays'
import { FromTo, IssueList, NoteList } from './editParts'
import { attributionOf, generatedAtText, restoreTotalsText } from './editText'

interface Exported {
  url: string
  fileName: string
  generatedAt: string
  feedVersion: string
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

  const preview = useMemo(() => (base && version ? validateEdit(base.feed, version, holidays) : []), [base, version, holidays])
  const previewErrors = errorsIn(preview)
  const blocked = !base
    ? null
    : draft
      ? `下書き ${draft.id} を承認するか、やめてから出力してください。`
      : !plan || !version
        ? '方針を適用してから出力できます。'
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
      const outcome = applyForm2(base.feed, plan, { generatedAt })
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
      if (now.base !== base || lastVersion(now) !== version) {
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
        <p className="text-sm text-muted-foreground">手順1で GTFS を読み込み、方針を承認すると、減便を反映した GTFS を出力できます。</p>
      ) : (
        <>
          {version && <ExportSummary base={base} version={version} />}
          <IssueList issues={preview} title="出力の前の検証" />
          {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          <Button type="button" className="self-start" disabled={blocked !== null || busy} onClick={() => void onExport()}>
            {busy ? '出力中…' : 'GTFS を出力する'}
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
        </>
      )}
    </StepSection>
  )
}

/** 出力する内容の要約(承認済みの最後の版):有効期間、feed_version、§5.10 の文言、平日便、全曜日で便がなくなる系統、足し戻しの集計 */
function ExportSummary({ base, version }: { base: BaseGtfs; version: Form2Result }) {
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
            {report.feedVersion.before || '(空)'} → 出力した日時の値(承認したときの例 {report.feedVersion.after})
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
      <NoteList items={texts.validity} label="有効期間と期間の外" />
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
