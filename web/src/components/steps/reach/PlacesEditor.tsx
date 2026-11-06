import { useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Stop } from '@/gtfs/parse'
import {
  importResultText,
  MAX_PLACE_NAME,
  MAX_PLACES,
  MAX_PLACES_FILE_BYTES,
  parsePlacesFile,
  PLACE_TYPE_LABELS,
  placesFileName,
  serializePlaces,
  type PlaceInput,
  type PlaceType,
} from '@/lib/placesFile'
import { DOHOKU_SAMPLE_OFFICE_COUNT, DOHOKU_SAMPLE_PLACES } from '@/lib/samplePlaces'
import { PlaceSymbol } from '@/map/PlacesLayer'
import { useDriversStore, type UserPlace } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import { searchStops } from './places'

/**
 * 前提情報の手順の「運行の前提」の欄(research/OperationPremise.tsx)の中の、営業所を置く欄
 * (指摘 24、docs/tasks-1105.md の D05。11/5 に影響(到達圏)の手順から移した。11/6 に種類を営業所1つにまとめた)。
 * 足し方は2つ:「地図で営業所を置く」を押して地図を1回押す(地図は map/PlacesLayer.tsx)か、停留所の名前で探して選ぶ。
 * 名前を変える・消すができ、一覧は JSON に書き出し・読み込みできる(lib/placesFile.ts)。
 * 場所はメモリだけに持ち(store/drivers.ts)、サーバーにもブラウザの保存にも入れない。推定(gtfs/edit/duties.ts)に渡す
 */

/** ファイルを文字として読む(FileReader。テストの jsdom でも動く) */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('read'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 書き出しの既定:Blob を作ってダウンロードさせる */
function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export interface PlacesEditorProps {
  places: readonly UserPlace[]
  placing: PlaceType | null
  stops: readonly Stop[]
  onAdd: (place: PlaceInput) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onReplace: (places: readonly PlaceInput[]) => void
  onStartPlacing: (type: PlaceType) => void
  onCancelPlacing: () => void
  /** 道北バスのサンプルの営業所を置けるか(サンプルの GTFS を読み込んだときだけ true) */
  sampleAvailable?: boolean
  /** 書き出し(テストで差し替える) */
  download?: (fileName: string, text: string) => void
  /** 書き出しの日時(テストで差し替える) */
  now?: () => Date
}

/** 欄(store を使う) */
export default function PlacesEditor() {
  const places = useDriversStore((s) => s.places)
  const placing = useDriversStore((s) => s.placing)
  const stops = useGtfsStore((s) => s.stops)
  const sampleAvailable = useGtfsStore((s) => s.sample !== null)
  const store = useDriversStore.getState
  return (
    <PlacesEditorView
      places={places}
      placing={placing}
      stops={stops}
      onAdd={(p) => store().addPlace(p)}
      onRename={(id, name) => store().renamePlace(id, name)}
      onRemove={(id) => store().removePlace(id)}
      onReplace={(list) => store().replacePlaces(list)}
      onStartPlacing={(t) => store().startPlacing(t)}
      onCancelPlacing={() => store().cancelPlacing()}
      sampleAvailable={sampleAvailable}
    />
  )
}

/** 欄の中身(store を使わない。テストでは値を直接渡す) */
export function PlacesEditorView({
  places,
  placing,
  stops,
  onAdd,
  onRename,
  onRemove,
  onReplace,
  onStartPlacing,
  onCancelPlacing,
  sampleAvailable = false,
  download = downloadText,
  now = () => new Date(),
}: PlacesEditorProps) {
  const type: PlaceType = 'office'
  const label = PLACE_TYPE_LABELS[type]
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const full = places.length >= MAX_PLACES
  const matches = searchStops(stops, query)

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_PLACES_FILE_BYTES) {
      setMessage({ text: `ファイルが大きすぎます(${MAX_PLACES_FILE_BYTES.toLocaleString('ja-JP')} バイトまで)。書き出した JSON を選んでください。`, error: true })
      return
    }
    let text: string
    try {
      text = await readText(file)
    } catch {
      setMessage({ text: 'ファイルを読めませんでした。もう一度選んでください。', error: true })
      return
    }
    const result = parsePlacesFile(text)
    if (!result.ok) {
      setMessage({ text: result.message, error: true })
      return
    }
    onReplace(result.places)
    setMessage({ text: importResultText(result), error: false })
  }

  return (
    <details className="text-xs" data-testid="places-editor">
      <summary className="cursor-pointer">
        <span className="font-medium">営業所を置く</span>
        <span className="text-muted-foreground">({places.length} か所)</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-muted-foreground">
          {'置いた営業所は勤務の数の推定に使います。営業所は出庫・入庫と点呼の場所で、休憩も取れる場所とみなします。' +
            'どの勤務も、最初と最後の停留所から最寄りの営業所へ回送するとみなすので、営業所はすべて置いてください。' +
            '営業所を1つでも置くと、営業所の近くの停留所でのすき間だけを休憩に数えます。'}
        </p>
        <p className="text-muted-foreground">
          場所はこの画面の中だけに持ち、サーバーには送りません。GTFS を読み込み直すと一覧は空になります。残すときは JSON に書き出してください。
        </p>
        {sampleAvailable && (
          <div className="flex flex-col items-start gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onReplace(DOHOKU_SAMPLE_PLACES)
                setMessage({
                  text: `道北バスのサンプルの営業所を ${DOHOKU_SAMPLE_OFFICE_COUNT} か所置きました。`,
                  error: false,
                })
              }}
            >
              道北バスの営業所(サンプル)を置く
            </Button>
            <span className="text-muted-foreground">
              本社・旭川営業所、名寄出張所、上川営業所、層雲峡出張所、永山出張所。今の一覧を置き換えます。
            </span>
          </div>
        )}
        <div className="flex flex-col gap-1">
          {placing ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium" role="status">
                地図を押すと{PLACE_TYPE_LABELS[placing]}を置きます。Esc でやめます。
              </span>
              <Button type="button" variant="outline" size="sm" onClick={onCancelPlacing}>
                置くのをやめる
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={full} onClick={() => onStartPlacing(type)}>
              <PlaceSymbol type={type} className="size-3.5 shrink-0" />
              地図で{label}を置く
            </Button>
          )}
          {full && <span className="text-muted-foreground">置ける場所は {MAX_PLACES} か所までです。</span>}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="places-stop-search" className="text-xs">
            停留所の名前で探して{label}を置く
          </Label>
          <Input
            id="places-stop-search"
            type="search"
            placeholder="例:旭川駅前"
            value={query}
            className="h-7"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() !== '' && matches.length === 0 && <span className="text-muted-foreground">一致する停留所がありません。</span>}
          {matches.length > 0 && (
            <ul className="flex max-h-40 flex-col overflow-y-auto rounded-md border" aria-label="停留所の検索の結果">
              {matches.map((m) => (
                <li key={`${m.name}-${m.lat}-${m.lon}`}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50"
                    disabled={full}
                    onClick={() => {
                      onAdd({ type, name: m.name, lat: m.lat, lon: m.lon })
                      setQuery('')
                    }}
                  >
                    {m.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {places.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label="置いた場所">
            {places.map((p) => (
              <PlaceRow key={p.id} place={p} onRename={onRename} onRemove={onRemove} />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={places.length === 0}
            onClick={() => {
              download(placesFileName(now()), serializePlaces(places))
              setMessage({ text: `${places.length} か所を JSON に書き出しました。`, error: false })
            }}
          >
            JSON に書き出す
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            JSON を読み込む
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="places-file"
            onChange={(e) => void onFile(e)}
          />
        </div>
        <span className="text-muted-foreground">JSON を読み込むと、今の一覧を置き換えます。</span>
        {message && (
          <p className={message.error ? 'text-destructive' : ''} role={message.error ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
      </div>
    </details>
  )
}

/** 置いた場所の1行。名前は Enter か欄を離れたときに決める(空なら元に戻す) */
function PlaceRow({ place, onRename, onRemove }: { place: UserPlace; onRename: (id: string, name: string) => void; onRemove: (id: string) => void }) {
  const [text, setText] = useState(place.name)
  const [stored, setStored] = useState(place.name)
  if (place.name !== stored) {
    setStored(place.name)
    setText(place.name)
  }
  const commit = () => {
    if (text.trim() === '') setText(place.name)
    else if (text !== place.name) onRename(place.id, text)
  }
  const label = PLACE_TYPE_LABELS[place.type]
  return (
    <li className="flex items-center gap-1.5">
      <PlaceSymbol type={place.type} />
      <Input
        aria-label={`${label}の名前`}
        value={text}
        maxLength={MAX_PLACE_NAME}
        className="h-7 min-w-0 flex-1"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(place.name)
        }}
      />
      <Button type="button" variant="ghost" size="sm" aria-label={`${place.name}を消す`} onClick={() => onRemove(place.id)}>
        消す
      </Button>
    </li>
  )
}
