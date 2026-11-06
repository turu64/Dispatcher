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
  parseWorkDays,
  PREMISE_TITLE,
  ROSTER_LABEL,
  SHORTAGE_LABEL,
  WORK_DAYS_LABEL,
  type OptionalCountResult,
} from '@/components/steps/reach/driverText'
import { PREMISE_SECTION_ID } from '@/components/steps/stepIds'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BOUND_LIMIT_MIN, dutyAssumptions, type DutyParams, type DutyPlace } from '@/gtfs/edit/duties'
import { DOHOKU_SAMPLE_BUTTON, DOHOKU_SAMPLE_OFFICE_COUNT, DOHOKU_SAMPLE_PLACES, DOHOKU_SAMPLE_ROSTER } from '@/lib/samplePlaces'
import type { ParseResult } from '@/reach/input'
import { MAX_ROSTER, MAX_SHORTAGE, WORK_DAYS_RANGE, useDriversStore } from '@/store/drivers'
import { useGtfsStore } from '@/store/gtfs'

/**
 * 前提情報の手順の「運行の前提(営業所・運転士の数)」の欄(利用者の指摘、11/5)。
 * 要る運転士の数(目安)の推定と判定に使う入力を、この欄にまとめる:
 * - 運転士の数:在籍の運転士の数(判定に要る)・1人あたりの週の出勤日数(既定 5)・欠員(その日に乗務できない運転士の数)
 * - 道北バスのサンプル(営業所5か所と在籍 150 人)を入れるボタン(サンプルの GTFS を読み込んだときだけ。押したときだけ入れる)
 * - 営業所(reach/PlacesEditor.tsx。地図で置く操作は、この手順の地図で行う。map/PlacesLayer.tsx)
 * - 勤務の数の推定の仮定(拘束時間の上限・点呼・回送の速さ)。欄には今の値の短い要約だけを出し、「勤務時間の設定」の Dialog で変える
 *   (11/6 の利用者の指示。前は開閉(details)の中にあった)
 * 結果(減便の前後の勤務の数と判定)は、影響(到達圏)の手順の reach/DriverPanel.tsx に出す。
 * 値は store/drivers.ts(メモリだけ)。GTFS を読み込み直すと運転士の数と場所は消え、仮定は残る
 */
export default function OperationPremise() {
  const shortage = useDriversStore((s) => s.shortage)
  const roster = useDriversStore((s) => s.roster)
  const workDays = useDriversStore((s) => s.workDays)
  const params = useDriversStore((s) => s.params)
  const places = useDriversStore((s) => s.places)
  const sampleAvailable = useGtfsStore((s) => s.sample !== null)
  const store = useDriversStore.getState
  return (
    <OperationPremiseView
      shortage={shortage}
      roster={roster}
      workDays={workDays}
      params={params}
      places={places}
      onShortage={(v) => store().setShortage(v)}
      onRoster={(v) => store().setRoster(v)}
      onWorkDays={(v) => store().setWorkDays(v)}
      onApplySample={sampleAvailable ? () => store().applyDohokuSample() : undefined}
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
  workDays,
  params,
  places,
  onShortage,
  onRoster,
  onWorkDays,
  onApplySample,
  onParams,
  onResetParams,
  placesEditor,
}: {
  shortage: number | null
  roster: number | null
  workDays: number
  params: DutyParams
  places: readonly DutyPlace[]
  onShortage: (value: number | null) => void
  onRoster: (value: number | null) => void
  onWorkDays: (value: number) => void
  /** 道北バスのサンプルを入れる(在籍を入れたら true)。サンプルの GTFS でなければ省く(ボタンを出さない) */
  onApplySample?: () => boolean
  onParams: (patch: Partial<DutyParams>) => void
  onResetParams: () => void
  /** 営業所を置く欄(store を使うので外から渡す) */
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
        を読み込み直すと、運転士の数と置いた場所は消えます(週の出勤日数と仮定は残ります)。
      </p>
      {onApplySample && <SampleButton onApply={onApplySample} />}
      <div className="flex flex-col gap-2">
        <CountField
          id="driver-roster"
          label={ROSTER_LABEL}
          value={roster}
          max={MAX_ROSTER}
          placeholder="例:150"
          parse={parseRoster}
          onCommit={onRoster}
        />
        <WorkDaysField value={workDays} onCommit={onWorkDays} />
        <CountField
          id="driver-shortage"
          label={SHORTAGE_LABEL}
          value={shortage}
          max={MAX_SHORTAGE}
          placeholder="例:19"
          parse={parseShortage}
          onCommit={onShortage}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        乗務できる運転士の数(目安)を、在籍 × 週の出勤日数 ÷ 7 − 欠員(小数は切り捨て)で数え、減便後に要る勤務の数と比べます。在籍の運転士の数を入れないと、足りるかの目安は出しません。
      </p>
      {placesEditor}
      <AssumptionFields params={params} places={places} onParams={onParams} onReset={onResetParams} />
    </section>
  )
}

/**
 * 道北バスのサンプルを入れるボタン。営業所の一覧を5か所に置き換え、在籍の運転士の数が空なら 150 を入れる
 */
function SampleButton({ onApply }: { onApply: () => boolean }) {
  const [message, setMessage] = useState<string | null>(null)
  const names = DOHOKU_SAMPLE_PLACES.map((p) => p.name).join('、')
  return (
    <div className="flex flex-col items-start gap-1 text-xs">
      {/* 左の欄が狭くても名前を切らずに折り返す */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-auto max-w-full py-1 text-left whitespace-normal"
        onClick={() => {
          const filled = onApply()
          setMessage(
            filled
              ? `道北バスのサンプルの営業所を ${DOHOKU_SAMPLE_OFFICE_COUNT} か所置き、在籍の運転士の数に ${DOHOKU_SAMPLE_ROSTER} を入れました。`
              : `道北バスのサンプルの営業所を ${DOHOKU_SAMPLE_OFFICE_COUNT} か所置きました。在籍の運転士の数は、入れてあった数のままです。`,
          )
        }}
      >
        {DOHOKU_SAMPLE_BUTTON}
      </Button>
      <span className="text-muted-foreground">
        営業所({names})で今の一覧を置き換え、在籍の運転士の数が空なら {DOHOKU_SAMPLE_ROSTER} を入れます(道北バスの在籍は約 {DOHOKU_SAMPLE_ROSTER} 人)。
      </span>
      {message && <p role="status">{message}</p>}
    </div>
  )
}

/**
 * 1人あたりの週の出勤日数の欄(1〜7 の整数。全角の数字も受け付ける)。空や読めない値は store に入れず、理由を出す。
 * 全角の数字を打てるよう type="text" にする(NumberField は type="number")
 */
function WorkDaysField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value))
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | null>(null)
  if (value !== committed) {
    setCommitted(value)
    setText(String(value))
    setError(null)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor="driver-work-days" className="text-xs">
        {WORK_DAYS_LABEL}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id="driver-work-days"
          type="text"
          inputMode="numeric"
          value={text}
          aria-invalid={error !== null}
          className="h-7 w-24 tabular-nums"
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            const r: ParseResult = parseWorkDays(t)
            if (!r.ok) {
              setError(r.message)
              return
            }
            setError(null)
            setCommitted(r.value)
            onCommit(r.value)
          }}
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          日({WORK_DAYS_RANGE.min}〜{WORK_DAYS_RANGE.max}。週休2日なら 5)
        </span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
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

/** 勤務の数の推定の仮定を変える Dialog を開くボタンの文と、Dialog の見出し */
export const DUTY_SETTINGS_TITLE = '勤務時間の設定'

/** 欄に出す、今の仮定の短い要約 */
function dutySettingsSummary(params: Pick<DutyParams, 'maxBoundMin' | 'preCheckMin' | 'postCheckMin' | 'deadheadKmh'>): string {
  return `拘束 ${params.maxBoundMin / 60} 時間・点呼 ${params.preCheckMin}/${params.postCheckMin} 分・回送 時速 ${params.deadheadKmh}km`
}

/**
 * 「勤務の数の推定の仮定」の要約と、変える Dialog(「勤務時間の設定」)。拘束の上限・点呼の分・回送の速さを変えると、
 * すぐに store の値が変わって計算し直す(保存のボタンは無い。閉じても値は残る)
 */
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
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">勤務の数の推定の仮定</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground" data-testid="duty-settings-summary">
          {dutySettingsSummary(params)}
        </span>
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="xs">
              {DUTY_SETTINGS_TITLE}
            </Button>
          </DialogTrigger>
          <DialogContent showCloseButton={false} className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{DUTY_SETTINGS_TITLE}</DialogTitle>
              <DialogDescription>勤務の数の推定の仮定です。値を変えると、すぐに要る運転士の数(目安)を計算し直します。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-xs">
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
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={onReset}>
                既定値に戻す
              </Button>
              <DialogClose asChild>
                <Button type="button" size="sm">
                  閉じる
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
