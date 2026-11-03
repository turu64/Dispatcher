import { FileArchiveIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { describeServices, feedValidity, type ServiceRole } from '@/gtfs/edit/services'
import type { GtfsFeed } from '@/gtfs/load'
import { formatDateJa } from '@/lib/dates'
import { fetchSampleGtfs, fetchSampleGtfsInfo, type SampleGtfsInfo } from '@/gtfs/sample'
import { loadGtfsInWorker } from '@/gtfs/workerClient'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useReachStore } from '@/store/reach'

type SampleState = { status: 'checking' } | { status: 'ready'; info: SampleGtfsInfo } | { status: 'unreachable' }

const MAX_WARNINGS_SHOWN = 10
const MAX_SERVICES_SHOWN = 12

const ROLE_LABELS: Record<ServiceRole, string> = {
  weekday: '平日',
  saturday: '土曜',
  sunday: '日曜',
  saturdaySunday: '土日',
  other: 'その他',
}

/**
 * 読み込んだ GTFS の版と期間:feed_version、有効期間、service_id ごとの便数。
 * 出力の feed_version と有効期間を決める材料なので、読み込んだ直後に見せる。
 * 有効期間は feed_info の値で、無ければ calendar・calendar_dates の端から求める
 */
function FeedSummary({ feed }: { feed: GtfsFeed }) {
  const info = feed.tables.get('feed_info')?.rows[0]
  const version = (info?.feed_version ?? '').trim()
  const validity = feedValidity(feed)
  const fromInfo = (info?.feed_start_date ?? '').trim() !== '' && (info?.feed_end_date ?? '').trim() !== ''
  const services = describeServices(feed, null)
  const shown = services.slice(0, MAX_SERVICES_SHOWN)
  return (
    <dl className="flex flex-col gap-0.5 text-sm" aria-label="読み込んだ GTFS の版と期間">
      <div>
        <dt className="inline">feed_version:</dt>
        <dd className="inline font-mono break-all">{version || '(空)'}</dd>
      </div>
      <div>
        <dt className="inline">有効期間:</dt>
        <dd className="inline">
          {validity ? `${formatDateJa(validity.start)}〜${formatDateJa(validity.end)}` : '(求められません)'}
          {validity && !fromInfo && '(feed_info に無いため、calendar・calendar_dates から求めました)'}
        </dd>
      </div>
      <div>
        <dt>service_id ごとの便数:</dt>
        <dd>
          {services.length === 0 ? (
            '(service_id がありません)'
          ) : (
            <ul className="list-disc pl-5">
              {shown.map((sv) => (
                <li key={sv.serviceId}>
                  <span className="font-mono break-all">{sv.serviceId}</span>({ROLE_LABELS[sv.role]}):
                  <span className="tabular-nums">{sv.tripCount.toLocaleString('ja-JP')}</span> 便
                </li>
              ))}
              {services.length > shown.length && <li>ほか {services.length - shown.length} 件</li>}
            </ul>
          )}
        </dd>
      </div>
    </dl>
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
  const label = useGtfsStore((s) => s.label)
  const feed = useGtfsStore((s) => s.feed)
  const loadedSample = useGtfsStore((s) => s.sample)
  const loadedSize = useGtfsStore((s) => s.size)
  const loadedAt = useGtfsStore((s) => s.loadedAt)

  useEffect(() => {
    fetchSampleGtfsInfo()
      .then((info) => setSample({ status: 'ready', info }))
      .catch(() => setSample({ status: 'unreachable' }))
  }, [])

  // ファイル選択とサンプルは、どちらもここから同じ読み込み処理を通す。
  // ZIP の展開と CSV の読み取りは Web Worker で行い、画面を止めない
  async function open(kind: Busy, getData: () => Promise<Blob>, name: string, knownSize: number | null, sampleInfo?: SampleGtfsInfo) {
    const { clear, setLoaded } = useGtfsStore.getState()
    const reach = useReachStore.getState()
    const edit = useEditStore.getState()
    setBusy(kind)
    setAttempt({ name, size: knownSize, isSample: kind === 'sample', status: 'loading' })
    setError(null)
    clear()
    reach.setSource(null)
    // 前の GTFS の編集の履歴と下書きも捨てる
    edit.setBase(null)
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
          type="button"
          variant="outline"
          loading={busy === 'file'}
          loadingLabel="読み込み中"
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
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
            {shown.isSample && (
              <AttachmentActions>
                <Badge variant="secondary">サンプル</Badge>
              </AttachmentActions>
            )}
          </Attachment>
        )}
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
              <p className="text-sm text-muted-foreground">
                出典:{loadedSample.source}「{loadedSample.name}」({loadedSample.license})
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  )
}
