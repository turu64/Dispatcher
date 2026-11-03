import { useEffect, useState } from 'react'
import StepSection from '@/components/StepSection'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fetchSampleGtfs, fetchSampleGtfsInfo, type SampleGtfsInfo } from '@/gtfs/sample'
import { loadGtfsInWorker } from '@/gtfs/workerClient'
import { useEditStore } from '@/store/edit'
import { useGtfsStore } from '@/store/gtfs'
import { useReachStore } from '@/store/reach'

type SampleState = { status: 'checking' } | { status: 'ready'; info: SampleGtfsInfo } | { status: 'unreachable' }

const MAX_WARNINGS_SHOWN = 10

/** 手順1:GTFS の読み込み。読み込んだ GTFS は store(useGtfsStore)に入る */
export default function LoadStep() {
  const [sample, setSample] = useState<SampleState>({ status: 'checking' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = useGtfsStore((s) => s.label)
  const feed = useGtfsStore((s) => s.feed)
  const loadedSample = useGtfsStore((s) => s.sample)

  useEffect(() => {
    fetchSampleGtfsInfo()
      .then((info) => setSample({ status: 'ready', info }))
      .catch(() => setSample({ status: 'unreachable' }))
  }, [])

  // ファイル選択とサンプルは、どちらもここから同じ読み込み処理を通す。
  // ZIP の展開と CSV の読み取りは Web Worker で行い、画面を止めない
  async function open(getData: () => Promise<Blob>, name: string, sampleInfo?: SampleGtfsInfo) {
    const { clear, setLoaded } = useGtfsStore.getState()
    const reach = useReachStore.getState()
    const edit = useEditStore.getState()
    setBusy(true)
    setError(null)
    clear()
    reach.setSource(null)
    // 前の GTFS の編集の履歴と下書きも捨てる
    edit.setBase(null)
    try {
      // 元の ZIP のバイト列は、出力のとき(変えない表をそのまま写す)にも使う。Worker へは複製で渡るので、手元のものは使えるまま残る
      const zip = await (await getData()).arrayBuffer()
      const loaded = await loadGtfsInWorker(zip)
      setLoaded({ label: name, feed: loaded, sample: sampleInfo })
      // 停留所と運行期間は setLoaded で求めてある。到達圏の手順に渡し、既定の日付で計算を始める
      const { stops, servicePeriod } = useGtfsStore.getState()
      reach.setSource({ feed: loaded, stops, period: servicePeriod })
      // 編集の基準にする(編集後のフィードは、毎回この基準から作り直す)
      edit.setBase({ feed: loaded, zip, label: name, sample: sampleInfo ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const sampleInfo = sample.status === 'ready' ? sample.info : undefined

  return (
    <>
      <StepSection title="1. GTFS を読み込む">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gtfs-file">GTFS の ZIP ファイル</Label>
          <Input
            id="gtfs-file"
            type="file"
            accept=".zip"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              // 同じファイルを選び直しても読み込めるように、選択を空に戻す
              e.target.value = ''
              if (file) void open(async () => file, file.name)
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !sampleInfo?.available}
          onClick={() => sampleInfo && void open(fetchSampleGtfs, sampleInfo.name, sampleInfo)}
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
        {busy && <p className="text-sm">読み込み中…</p>}
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
