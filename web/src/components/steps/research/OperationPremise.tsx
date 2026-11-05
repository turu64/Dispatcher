import { useState, type ReactNode } from 'react'
import NumberField from '@/components/NumberField'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import PlacesEditor from '@/components/steps/reach/PlacesEditor'
import {
  DEADHEAD_KMH_RANGE,
  MAX_CHECK_MIN,
  parseCheckMinutes,
  parseDeadheadKmh,
  parseRoster,
  parseShortage,
  PREMISE_TITLE,
  ROSTER_LABEL,
  SHORTAGE_LABEL,
  type OptionalCountResult,
} from '@/components/steps/reach/driverText'
import { PREMISE_SECTION_ID } from '@/components/steps/stepIds'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BOUND_LIMIT_MIN, dutyAssumptions, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { MAX_ROSTER, MAX_SHORTAGE, useDriversStore } from '@/store/drivers'

/**
 * 前提情報の手順の「運行の前提(営業所・休憩施設・運転士の数)」の欄(利用者の指摘、11/5)。
 * 要る運転士の数(目安)の推定と判定に使う入力を、この欄にまとめる:
 * - 運転士の数:在籍の運転士の数(任意)と欠員(その日に乗務できない運転士の数)
 * - 営業所・車庫・休憩施設(reach/PlacesEditor.tsx。地図で置く操作は、この手順の地図で行う。map/PlacesLayer.tsx)
 * - 勤務の数の推定の仮定(拘束時間の上限・点呼・回送の速さ)
 * 結果(減便の前後の勤務の数と判定)は、影響(到達圏)の手順の reach/DriverPanel.tsx に出す。
 * 値は store/drivers.ts(メモリだけ)。GTFS を読み込み直すと運転士の数と場所は消え、仮定は残る
 */
export default function OperationPremise() {
  const shortage = useDriversStore((s) => s.shortage)
  const roster = useDriversStore((s) => s.roster)
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  const store = useDriversStore.getState
  return (
    <OperationPremiseView
      shortage={shortage}
      roster={roster}
      params={params}
      places={places}
      onShortage={(v) => store().setShortage(v)}
      onRoster={(v) => store().setRoster(v)}
      onParams={(patch) => store().setParams(patch)}
      onResetParams={() => store().resetParams()}
      placesEditor={<PlacesEditor />}
    />
  )
}

/** 欄の中身(store を使わない。テストでは値を直接渡す) */
export function OperationPremiseView({
  shortage,
  roster,
  params,
  places,
  onShortage,
  onRoster,
  onParams,
  onResetParams,
  placesEditor,
}: {
  shortage: number | null
  roster: number | null
  params: DutyParams
  places: readonly DutyPlace[]
  onShortage: (value: number | null) => void
  onRoster: (value: number | null) => void
  onParams: (patch: Partial<DutyParams>) => void
  onResetParams: () => void
  /** 営業所・車庫・休憩施設を置く欄(store を使うので外から渡す) */
  placesEditor?: ReactNode
}) {
  return (
    <section
      id={PREMISE_SECTION_ID}
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      aria-labelledby="operation-premise-title"
    >
      <h3 id="operation-premise-title" className="font-medium">
        {PREMISE_TITLE}
      </h3>
      <p className="text-xs text-muted-foreground">
        手順「影響(到達圏)」の「要る運転士の数(目安)」の推定と判定に使います。値はこの画面の中だけに持ち、サーバーには送りません。GTFS
        を読み込み直すと、運転士の数と置いた場所は消えます(仮定は残ります)。
      </p>
      <div className="flex flex-col gap-2">
        <CountField
          id="driver-roster"
          label={ROSTER_LABEL}
          value={roster}
          max={MAX_ROSTER}
          placeholder="例:110"
          parse={parseRoster}
          onCommit={onRoster}
        />
        <CountField
          id="driver-shortage"
          label={SHORTAGE_LABEL}
          value={shortage}
          max={MAX_SHORTAGE}
          placeholder="例:20"
          parse={parseShortage}
          onCommit={onShortage}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        欠員は、減便で減る勤務の数(目安)と比べます。在籍の運転士の数を入れると、乗務できる運転士(在籍 − 欠員)と減便後に要る勤務の数(目安)も参考に並べます。
      </p>
      {placesEditor}
      <AssumptionFields params={params} places={places} onParams={onParams} onReset={onResetParams} />
    </section>
  )
}

/** 空でもよい人数の入力欄。空にすると「入れていない」(null)。打っている途中の値で store を壊さないよう、文字は手元に持つ */
export function CountField({
  id,
  label,
  value,
  max,
  placeholder,
  parse,
  onCommit,
}: {
  id: string
  label: string
  value: number | null
  max: number
  placeholder: string
  parse: (text: string) => OptionalCountResult
  onCommit: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== committed) {
    setCommitted(value)
    setText(value === null ? '' : String(value))
    setError(null)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          placeholder={placeholder}
          value={text}
          aria-invalid={error !== null}
          className="h-7 w-24 tabular-nums"
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            const r = parse(t)
            if (!r.ok) {
              setError(r.message)
              return
            }
            setError(null)
            setCommitted(r.value)
            onCommit(r.value)
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground">人(0〜{max})</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** 「勤務の数の推定の仮定」の開閉。拘束の上限・点呼の分・回送の速さを変えると、store の値が変わって計算し直す */
export function AssumptionFields({
  params,
  places,
  onParams,
  onReset,
}: {
  params: DutyParams
  places: readonly DutyPlace[]
  onParams: (patch: Partial<DutyParams>) => void
  onReset: () => void
}) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">
        <span className="font-medium">勤務の数の推定の仮定を変える</span>
        <span className="text-muted-foreground">
          (拘束 {params.maxBoundMin / 60} 時間・点呼 {params.preCheckMin}/{params.postCheckMin} 分・回送 時速 {params.deadheadKmh}km)
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span id="driver-bound-label" className="text-xs">
            拘束時間の上限
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-labelledby="driver-bound-label"
            value={String(params.maxBoundMin)}
            onValueChange={(v) => {
              const n = Number(v)
              if (n === BOUND_LIMIT_MIN.standard || n === BOUND_LIMIT_MIN.extended) onParams({ maxBoundMin: n })
            }}
          >
            <ToggleGroupItem value={String(BOUND_LIMIT_MIN.standard)} className={SELECTED_TOGGLE_CLASS}>
              13 時間(原則)
            </ToggleGroupItem>
            <ToggleGroupItem value={String(BOUND_LIMIT_MIN.extended)} className={SELECTED_TOGGLE_CLASS}>
              15 時間(延長の上限)
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid grid-cols-2 items-end gap-2">
          <NumberField
            id="driver-pre-check"
            label="出庫前の点呼"
            value={params.preCheckMin}
            unit="分"
            max={MAX_CHECK_MIN}
            integer
            parse={parseCheckMinutes}
            onCommit={(v) => onParams({ preCheckMin: v })}
          />
          <NumberField
            id="driver-post-check"
            label="入庫後の点呼"
            value={params.postCheckMin}
            unit="分"
            max={MAX_CHECK_MIN}
            integer
            parse={parseCheckMinutes}
            onCommit={(v) => onParams({ postCheckMin: v })}
          />
          <NumberField
            id="driver-deadhead"
            label="回送の速さ"
            value={params.deadheadKmh}
            unit="km/h"
            max={DEADHEAD_KMH_RANGE.max}
            integer
            parse={parseDeadheadKmh}
            onCommit={(v) => onParams({ deadheadKmh: v })}
          />
        </div>
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground" aria-label="推定の仮定">
          {dutyAssumptions(params, places).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onReset}>
          既定値に戻す
        </Button>
      </div>
    </details>
  )
}
