import { useEffect, useState } from 'react'
import { loadGtfsZip, type GtfsFeed } from './gtfs/load'
import { fetchSampleGtfs, fetchSampleGtfsInfo, type SampleGtfsInfo } from './gtfs/sample'

interface Loaded {
  label: string
  feed: GtfsFeed
  /** サンプルを読み込んだときの出典 */
  sample?: SampleGtfsInfo
}

type SampleState = { status: 'checking' } | { status: 'ready'; info: SampleGtfsInfo } | { status: 'unreachable' }

const MAX_WARNINGS_SHOWN = 10

// 1画面構成:左に手順、右に地図。地図と到達圏は 11/3 以降に実装する。
export default function App() {
  const [sample, setSample] = useState<SampleState>({ status: 'checking' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSampleGtfsInfo()
      .then((info) => setSample({ status: 'ready', info }))
      .catch(() => setSample({ status: 'unreachable' }))
  }, [])

  // ファイル選択とサンプルは、どちらもここから同じ読み込み処理を通す
  async function open(getData: () => Promise<Blob>, label: string, sampleInfo?: SampleGtfsInfo) {
    setBusy(true)
    setError(null)
    setLoaded(null)
    try {
      const feed = await loadGtfsZip(await getData())
      setLoaded({ label, feed, sample: sampleInfo })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const sampleInfo = sample.status === 'ready' ? sample.info : undefined

  return (
    <div className="app">
      <aside className="steps">
        <h1>Dispatcher</h1>
        <p>減便ダイヤの判断支援(準備中)</p>

        <section>
          <h2>1. GTFS を読み込む</h2>
          <input
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
          <button
            type="button"
            disabled={busy || !sampleInfo?.available}
            onClick={() => sampleInfo && void open(fetchSampleGtfs, sampleInfo.name, sampleInfo)}
          >
            サンプルを読み込む({sampleInfo?.name ?? '道北バス'})
          </button>
          {sample.status === 'unreachable' && (
            <p className="note">サーバーにつながらないため、サンプルは使えません。</p>
          )}
          {sampleInfo && !sampleInfo.available && (
            <p className="note">サンプルの GTFS がサーバーに置かれていません。</p>
          )}
          {busy && <p>読み込み中…</p>}
          {error && <p className="error">{error}</p>}
        </section>

        {loaded && (
          <section>
            <h2>{loaded.label}</h2>
            <table>
              <thead>
                <tr>
                  <th>ファイル</th>
                  <th>行数</th>
                </tr>
              </thead>
              <tbody>
                {[...loaded.feed.tables.values()].map((t) => (
                  <tr key={t.fileName}>
                    <td>{t.fileName}</td>
                    <td className="num">{t.rows.length.toLocaleString('ja-JP')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loaded.feed.warnings.length > 0 && (
              <div className="warnings">
                <p>確かめたほうがよい点が {loaded.feed.warnings.length} 件あります。</p>
                <ul>
                  {loaded.feed.warnings.slice(0, MAX_WARNINGS_SHOWN).map((w, i) => (
                    <li key={i}>
                      {w.file}
                      {w.line !== undefined && ` ${w.line}行目`}:{w.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {loaded.sample && (
              <p className="note">
                出典:{loaded.sample.source}「{loaded.sample.name}」({loaded.sample.license})
              </p>
            )}
          </section>
        )}
      </aside>
      <main className="map" aria-label="地図" />
    </div>
  )
}
