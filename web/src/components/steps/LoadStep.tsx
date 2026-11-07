import { BusFrontIcon, CalendarRangeIcon, FileArchiveIcon, FolderOpenIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import StepSection from '@/components/StepSection'
import ServiceGroupsCard from '@/components/steps/load/ServiceGroupsCard'
import {
  DELETE_DIALOG_CANCEL,
  DELETE_DIALOG_CONFIRM,
  DELETE_DIALOG_TITLE,
  deleteConfirmMessage,
} from '@/components/steps/loadText'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { feedValidity } from '@/gtfs/edit/services'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { fetchSampleGtfs, fetchSampleGtfsInfo, type SampleGtfsInfo } from '@/gtfs/sample'
import { loadGtfsInWorker } from '@/gtfs/workerClient'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useReachStore } from '@/store/reach'
import { resetAll } from '@/store/reset'

type SampleState = { status: 'checking' } | { status: 'ready'; info: SampleGtfsInfo } | { status: 'unreachable' }

const MAX_WARNINGS_SHOWN = 10

/**
 * 読み込んだ GTFS の版と期間:feed_version、有効期間(service_id ごとの便数は、下の「ダイヤのグループ分け」に出す)。
 * 出力の feed_version と有効期間を決める材料なので、読み込んだ直後に見せる。
 * 有効期間は feed_info の値で、無ければ calendar・calendar_dates の端から求める
 */
function FeedSummary({ feed }: { feed: GtfsFeed }) {
  const info = feed.tables.get('feed_info')?.rows[0]
  const version = (info?.feed_version ?? '').trim()
  const validity = feedValidity(feed)
  const fromInfo = (info?.feed_start_date ?? '').trim() !== '' && (info?.feed_end_date ?? '').trim() !== ''
  const stopRows = feed.tables.get('stops')?.rows ?? []
  const stops = stopRows.filter((r) => ['', '0'].includes((r.location_type ?? '').trim())).length
  const counts = [
    { label: '停留所', value: stops },
    { label: '系統', value: feed.tables.get('routes')?.rows.length ?? 0 },
    { label: '便(全ダイヤ)', value: feed.tables.get('trips')?.rows.length ?? 0 },
  ]
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1 text-sm" aria-label="読み込んだ GTFS の版と期間">
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-xs text-muted-foreground">版(feed_version)</dt>
          <dd>
            <Badge variant="outline" className="font-mono break-all">
              {version || '(空)'}
            </Badge>
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-xs text-muted-foreground">有効期間</dt>
          <dd className="flex items-center gap-1">
            <CalendarRangeIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {validity ? `${formatDateJa(validity.start)}〜${formatDateJa(validity.end)}` : '(求められません)'}
          </dd>
        </div>
        {validity && !fromInfo && <p className="text-xs text-muted-foreground">feed_info にないため、calendar・calendar_dates から求めました。</p>}
      </dl>
      <dl className="grid grid-cols-3 gap-2" aria-label="読み込んだ GTFS の数">
        {counts.map((c) => (
          <div key={c.label} className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5">
            <dt className="text-xs text-muted-foreground">{c.label}</dt>
            <dd className="text-base font-semibold tabular-nums">{c.value.toLocaleString('ja-JP')}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** ZIP の大きさ。1MB 未満は KB、それ以上は MB で出す */
function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 読み込んだ時刻を HH:MM で出す(端末の時刻) */
function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type Busy = 'file' | 'sample'

/** 読み込み中・失敗したファイルの表示用(読み込めたものは useGtfsStore が持つ) */
interface Attempt {
  name: string
  size: number | null
  isSample: boolean
  status: 'loading' | 'error'
}

/** 手順1:GTFS の読み込み。読み込んだ GTFS は store(useGtfsStore)に入る */
export default function LoadStep() {
  const [sample, setSample] = useState<SampleState>({ status: 'checking' })
  // 処理中のボタン。押したほうだけがスピナーになり、もう一方は無効になる
  const [busy, setBusy] = useState<Busy | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // 「読み込んだ GTFS を削除」を押して、ダイアログで確かめている間。本文は開いた時点の文を持ち、閉じる動きの間に文が変わらないようにする
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteMessage, setDeleteMessage] = useState('')
  // ダイアログを「削除する」で閉じたか。閉じた後の焦点の行き先(削除したら「ファイルを選ぶ」、やめたら削除のボタン)を決める
  const deleted = useRef(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const pickButton = useRef<HTMLButtonElement>(null)
  // ダイアログを開いたまま読み込みを始めた(読み込みがダイアログを閉じた)。閉じた後の焦点は削除のボタンではなく「ファイルを選ぶ」へ
  const closedByLoad = useRef(false)
  // ダイアログを閉じたとき、焦点を移せるボタンが無かった(読み込み中で「ファイルを選ぶ」も無効)。読み込みが終わったら移す
  const focusPickWhenIdle = useRef(false)
  const pendingDraft = useEditStore((s) => s.draft)
  const committedEdits = useEditStore((s) => s.history.length)
  const label = useGtfsStore((s) => s.label)
  const feed = useGtfsStore((s) => s.feed)
  const loadedSample = useGtfsStore((s) => s.sample)
  const loadedSize = useGtfsStore((s) => s.size)
  const loadedAt = useGtfsStore((s) => s.loadedAt)

  useEffect(() => {
    if (busy !== null || !focusPickWhenIdle.current) return
    focusPickWhenIdle.current = false
    // そのあいだに利用者がほかへ焦点を移していたら、動かさない
    const active = document.activeElement
    if (active === null || active === document.body) pickButton.current?.focus()
  }, [busy])

  useEffect(() => {
    fetchSampleGtfsInfo()
      .then((info) => setSample({ status: 'ready', info }))
      .catch(() => setSample({ status: 'unreachable' }))
  }, [])

  // ファイル選択とサンプルは、どちらもここから同じ読み込み処理を通す。
  // ZIP の展開と CSV の読み取りは Web Worker で行い、画面を止めない
  async function open(kind: Busy, getData: () => Promise<Blob>, name: string, knownSize: number | null, sampleInfo?: SampleGtfsInfo) {
    const { setLoaded } = useGtfsStore.getState()
    const reach = useReachStore.getState()
    const edit = useEditStore.getState()
    setBusy(kind)
    setAttempt({ name, size: knownSize, isSample: kind === 'sample', status: 'loading' })
    setError(null)
    // 読み込みを始めたら、削除の確かめは閉じる
    closedByLoad.current = true
    setConfirmingDelete(false)
    // 前の GTFS と、その編集の履歴・下書き・到達圏・運行の前提・周辺の施設の調査・AI との会話を捨てる(削除と同じ初期化。store/reset.ts)
    resetAll('reload')
    try {
      const blob = await getData()
      // サンプルの大きさは、取ってきた ZIP のバイト数から出す
      setAttempt((a) => (a ? { ...a, size: blob.size } : a))
      // 元の ZIP のバイト列は、出力のとき(変えない表をそのまま写す)にも使う。Worker へは複製で渡るので、手元のものは使えるまま残る
      const zip = await blob.arrayBuffer()
      const loaded = await loadGtfsInWorker(zip)
      setLoaded({ label: name, feed: loaded, sample: sampleInfo, size: blob.size, loadedAt: Date.now() })
      setAttempt(null)
      // 停留所と運行期間は setLoaded で求めてある。到達圏の手順に渡し、既定の日付で計算を始める
      const { stops, servicePeriod } = useGtfsStore.getState()
      reach.setSource({ feed: loaded, stops, period: servicePeriod })
      // 編集の基準にする(編集後のフィードは、毎回この基準から作り直す)
      edit.setBase({ feed: loaded, zip, label: name, sample: sampleInfo ?? null })
    } catch (e) {
      setAttempt((a) => (a ? { ...a, status: 'error' } : a))
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // 読み込んだ GTFS を削除して、画面を開いた直後と同じにする(読み込み直しと同じ初期化を通す)
  function removeLoaded() {
    deleted.current = true
    resetAll('delete')
    setConfirmingDelete(false)
    setAttempt(null)
    setError(null)
    // 同じファイルをもう一度選べるように、ファイルの選択も空に戻す
    if (fileInput.current) fileInput.current.value = ''
    pickButton.current?.focus()
  }

  function askDelete(isSample: boolean) {
    deleted.current = false
    closedByLoad.current = false
    focusPickWhenIdle.current = false
    setDeleteMessage(deleteConfirmMessage({ draft: pendingDraft, committed: committedEdits, sample: isSample }))
    setConfirmingDelete(true)
  }

  const sampleInfo = sample.status === 'ready' ? sample.info : undefined

  // 読み込み中・失敗は attempt、読み込めたものは store から出す(手順を移って戻っても残る)
  const shown =
    attempt ??
    (feed && label
      ? { name: label, size: loadedSize, isSample: loadedSample !== null, status: 'done' as const }
      : null)
  const statusText = shown?.status === 'loading' ? '読み込み中' : shown?.status === 'error' ? '失敗' : '読み込み済み'
  const details = shown
    ? [
        shown.size !== null ? formatFileSize(shown.size) : null,
        statusText,
        shown.status === 'done' && loadedAt !== null ? formatClock(loadedAt) : null,
      ].filter((x): x is string => x !== null)
    : []

  return (
    <>
      <StepSection title="1. GTFS を読み込む">
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          hidden
          tabIndex={-1}
          aria-label="GTFS の ZIP ファイル"
          disabled={busy !== null}
          onChange={(e) => {
            const file = e.target.files?.[0]
            // 同じファイルを選び直しても読み込めるように、選択を空に戻す
            e.target.value = ''
            if (file) void open('file', async () => file, file.name, file.size)
          }}
        />
        <Button
          ref={pickButton}
          type="button"
          variant="outline"
          loading={busy === 'file'}
          loadingLabel="読み込み中"
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          <FolderOpenIcon aria-hidden="true" />
          ファイルを選ぶ
        </Button>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Separator className="flex-1" />
          <span>または</span>
          <Separator className="flex-1" />
        </div>
        <Button
          type="button"
          variant="outline"
          loading={busy === 'sample'}
          loadingLabel="読み込み中"
          disabled={busy !== null || !sampleInfo?.available}
          onClick={() =>
            sampleInfo && void open('sample', fetchSampleGtfs, sampleInfo.name, null, sampleInfo)
          }
        >
          <BusFrontIcon aria-hidden="true" />
          サンプルを読み込む({sampleInfo?.name ?? '道北バス'})
        </Button>
        {sample.status === 'unreachable' && (
          <Alert>
            <AlertDescription>サーバーにつながらないため、サンプルは使えません。</AlertDescription>
          </Alert>
        )}
        {sampleInfo && !sampleInfo.available && (
          <Alert>
            <AlertDescription>サンプルの GTFS がサーバーに置かれていません。</AlertDescription>
          </Alert>
        )}
        {shown && (
          <Attachment
            role="group"
            aria-label="読み込んだ GTFS のファイル"
            state={shown.status === 'loading' ? 'processing' : shown.status === 'error' ? 'error' : 'done'}
            className="w-full"
          >
            <AttachmentMedia>
              {shown.status === 'loading' ? (
                <Spinner aria-hidden="true" role={undefined} aria-label={undefined} />
              ) : shown.status === 'error' ? (
                <TriangleAlertIcon aria-hidden="true" />
              ) : (
                <FileArchiveIcon aria-hidden="true" />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{shown.name}</AttachmentTitle>
              <AttachmentDescription>{details.join('・')}</AttachmentDescription>
            </AttachmentContent>
            {(shown.isSample || shown.status === 'done') && (
              <AttachmentActions className="gap-1">
                {shown.isSample && <Badge variant="secondary">サンプル</Badge>}
                {shown.status === 'done' && (
                  // 見た目は赤いごみ箱のアイコンだけ。名前(読み上げ・ポインターを重ねたときの表示)は「読み込んだ GTFS を削除」
                  <Button
                    ref={deleteButton}
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    disabled={busy !== null}
                    aria-haspopup="dialog"
                    aria-label="読み込んだ GTFS を削除"
                    title="読み込んだ GTFS を削除"
                    onClick={() => askDelete(shown.isSample)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                )}
              </AttachmentActions>
            )}
          </Attachment>
        )}
        <AlertDialog
          open={confirmingDelete}
          onOpenChange={(isOpen) => {
            // 「やめる」・Escape で閉じたら何も消さない
            if (!isOpen) setConfirmingDelete(false)
          }}
        >
          <AlertDialogContent
            onCloseAutoFocus={(e) => {
              // 削除したら「ファイルを選ぶ」へ、やめたら削除のボタンへ焦点を戻す。開いたまま読み込みを始めたとき・削除のボタンが
              // 無効か消えていたときは「ファイルを選ぶ」へ。それも無効(読み込み中)なら、読み込みが終わってから移す(焦点を body に落とさない)
              e.preventDefault()
              const candidates =
                deleted.current || closedByLoad.current ? [pickButton.current] : [deleteButton.current, pickButton.current]
              const target = candidates.find((b): b is HTMLButtonElement => b !== null && b.isConnected && !b.disabled)
              if (target) target.focus()
              else focusPickWhenIdle.current = true
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{DELETE_DIALOG_TITLE}</AlertDialogTitle>
              <AlertDialogDescription>{deleteMessage}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{DELETE_DIALOG_CANCEL}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={removeLoaded}>
                {DELETE_DIALOG_CONFIRM}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </StepSection>

      {feed && (
        <Card size="sm">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="break-all">
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <FeedSummary feed={feed} />
            <div className="border-t pt-3">
              <ServiceGroupsCard />
            </div>
            <details className="border-t pt-2 text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">ファイルと行数({feed.tables.size} ファイル)</summary>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ファイル</TableHead>
                    <TableHead className="text-right">行数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...feed.tables.values()].map((t) => (
                    <TableRow key={t.fileName}>
                      <TableCell>{t.fileName}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.rows.length.toLocaleString('ja-JP')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
            {feed.warnings.length > 0 && (
              <Alert className="border-amber-400 bg-amber-50 text-amber-950">
                <AlertDescription className="text-amber-950">
                  <p>確かめたほうがよい点が {feed.warnings.length} 件あります。</p>
                  <ul className="mt-1 list-disc pl-4">
                    {feed.warnings.slice(0, MAX_WARNINGS_SHOWN).map((w, i) => (
                      <li key={i}>
                        {w.file}
                        {w.line !== undefined && ` ${w.line}行目`}:{w.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {loadedSample && (
              <p className="text-xs text-muted-foreground">
                出典:{loadedSample.source}「{loadedSample.name}」({loadedSample.license})
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  )
}
