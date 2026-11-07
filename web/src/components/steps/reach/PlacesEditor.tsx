import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DUTY_DEFAULTS } from '@/gtfs/edit/duties'
import type { Stop } from '@/gtfs/parse'
import { MAX_PLACE_NAME, MAX_PLACES, PLACE_TYPE_LABELS, type PlaceInput, type PlaceType } from '@/lib/userPlaces'
import { PlaceSymbol } from '@/map/PlacesLayer'
import { useDriversStore, type UserPlace } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'
import { searchStops } from './places'

const REMOTE_WAIT_MIN = DUTY_DEFAULTS.maxRemoteWaitMin ?? 0
/** 営業所から遠い停留所で待つ時間の上限('1 時間 30 分') */
const REMOTE_WAIT_TEXT =
  REMOTE_WAIT_MIN % 60 === 0 ? `${REMOTE_WAIT_MIN / 60} 時間` : `${Math.floor(REMOTE_WAIT_MIN / 60)} 時間 ${REMOTE_WAIT_MIN % 60} 分`

/**
 * 運行の前提の手順の「運行の前提」の欄(research/OperationPremise.tsx)の中の、営業所を置く欄
 * (指摘 24、docs/tasks-1105.md の D05。11/5 に影響(到達圏)の手順から移した。11/6 に種類を営業所1つにまとめ、
 * 折りたたまずに出すようにし、JSON の書き出し・読み込みをなくした。どれも利用者の指示)。
 * 足し方は2つ:「地図で営業所を置く」を押して地図を1回押す(地図は map/PlacesLayer.tsx)か、停留所の名前で探して選ぶ。
 * 名前を変える・消すができる。場所はメモリだけに持ち(store/drivers.ts)、サーバーにもブラウザの保存にも入れない。
 * GTFS を読み込み直すと消える。推定(gtfs/edit/duties.ts)に渡す。
 * 道北バスのサンプルの営業所を入れるボタンは、在籍の運転士の数も入れるので、11/6 に運行の前提の欄の上(OperationPremise.tsx)へ移した
 */

export interface PlacesEditorProps {
  places: readonly UserPlace[]
  placing: PlaceType | null
  stops: readonly Stop[]
  onAdd: (place: PlaceInput) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onStartPlacing: (type: PlaceType) => void
  onCancelPlacing: () => void
}

/** 欄(store を使う) */
export default function PlacesEditor() {
  const places = useDriversStore((s) => s.places)
  const placing = useDriversStore((s) => s.placing)
  const stops = useGtfsStore((s) => s.stops)
  const store = useDriversStore.getState
  return (
    <PlacesEditorView
      places={places}
      placing={placing}
      stops={stops}
      onAdd={(p) => store().addPlace(p)}
      onRename={(id, name) => store().renamePlace(id, name)}
      onRemove={(id) => store().removePlace(id)}
      onStartPlacing={(t) => store().startPlacing(t)}
      onCancelPlacing={() => store().cancelPlacing()}
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
  onStartPlacing,
  onCancelPlacing,
}: PlacesEditorProps) {
  const type: PlaceType = 'office'
  const label = PLACE_TYPE_LABELS[type]
  const [query, setQuery] = useState('')
  const full = places.length >= MAX_PLACES
  const matches = searchStops(stops, query)

  return (
    <section className="flex flex-col gap-3 text-xs" data-testid="places-editor" aria-labelledby="places-editor-title">
      <h4 id="places-editor-title">
        <span className="font-medium">営業所を置く</span>
        <span className="text-muted-foreground">({places.length} か所)</span>
      </h4>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          {'置いた営業所は勤務の数の推定に使います。営業所は出庫・入庫と点呼の場所で、休憩も取れる場所とみなします。' +
            'どの勤務も、最初と最後の停留所から最寄りの営業所へ回送するとみなすので、営業所はすべて置いてください。' +
            `営業所を1つでも置くと、営業所から遠い停留所で ${REMOTE_WAIT_TEXT}より長く待つすき間は、営業所へ戻って休むとみなします。`}
        </p>
        <p className="text-muted-foreground">
          場所はこの画面の中だけに持ち、サーバーには送りません。GTFS を読み込み直すと一覧は空になります。
        </p>
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
      </div>
    </section>
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
