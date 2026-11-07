import { TriangleAlert } from 'lucide-react'
import { CountField } from '@/components/steps/CountField'
import { parseShortage, SHORTAGE_LABEL, supplyText, supplyWarningText } from '@/components/steps/reach/driverText'
import { SHORTAGE_SECTION_ID } from '@/components/steps/stepIds'
import { driverSupplyOf, MAX_SHORTAGE, useDriversStore } from '@/store/drivers'

/** 欠員の欄の見出し(入力欄の名前 SHORTAGE_LABEL とは別の短い名前にする) */
export const SHORTAGE_TITLE = '欠員'

/** 在籍の運転士の数を入れていないときに、欠員の欄に出す文 */
export const SHORTAGE_ROSTER_HINT = '在籍の運転士の数は手順「運行の前提」で入れます。'

/**
 * 減便の方針の手順の欠員の欄(2026-11-07 に利用者の指示で、運行の前提の欄から移した)。
 * 欠員(その日に乗務できない運転士の数)を入れ、在籍の運転士の数が入っていれば乗務できる運転士の数(目安)を小さな枠で出し、
 * その数え方を1行で添える。
 * 方針の入力(PolicyForm)や確かめの欄の外に置くので、承認の前・確かめている間・承認の後・「方針を変える」の後も同じ値で出る。
 * 値は store/drivers.ts(メモリだけ)。減便の方針の操作(applyPolicy)と AI の apply_policy には入れない。
 * 影響(到達圏)の手順の「欠員を入れる(減便の方針)」で、この欄へ移る(stepIds.ts の jumpToShortage)。
 * 手順の欄の中で枠を重ねず、下の方針の入力とは区切り線で分ける(2026-11-07 に利用者の指示)
 */
export default function ShortageSection() {
  const shortage = useDriversStore((s) => s.shortage)
  const roster = useDriversStore((s) => s.roster)
  const workDays = useDriversStore((s) => s.workDays)
  const supply = driverSupplyOf(roster, workDays, shortage)
  const warning = supply ? supplyWarningText(supply) : null
  return (
    <section
      id={SHORTAGE_SECTION_ID}
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-sm text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      aria-labelledby="driver-shortage-title"
    >
      <h3 id="driver-shortage-title" className="font-medium">
        {SHORTAGE_TITLE}
      </h3>
      <div className="grid grid-cols-2 items-start gap-3">
        <CountField
          id="driver-shortage"
          label={SHORTAGE_LABEL}
          value={shortage}
          max={MAX_SHORTAGE}
          placeholder="例:19"
          parse={parseShortage}
          onCommit={(v) => useDriversStore.getState().setShortage(v)}
        />
        <div className="flex flex-col rounded-md bg-muted/50 px-2 py-1.5" data-testid="shortage-available">
          <span className="text-xs text-muted-foreground">乗務できる運転士の数(目安)</span>
          <span className="text-base font-semibold tabular-nums">{supply ? `${supply.available} 人` : '—'}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="shortage-supply">
        {supply ? supplyText(supply) : SHORTAGE_ROSTER_HINT}
      </p>
      {warning && (
        <p className="flex items-start gap-1 text-xs font-medium text-destructive" data-testid="shortage-supply-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">値はこの画面の中だけに持ち、サーバーには送りません。</p>
    </section>
  )
}
