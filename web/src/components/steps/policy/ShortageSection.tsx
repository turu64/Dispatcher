import { CountField } from '@/components/steps/CountField'
import { parseShortage, SHORTAGE_LABEL, supplyText, supplyWarningText } from '@/components/steps/reach/driverText'
import { SHORTAGE_SECTION_ID } from '@/components/steps/stepIds'
import { driverSupplyOf, MAX_SHORTAGE, useDriversStore } from '@/store/drivers'

/** 欠員の欄の見出し(入力欄の名前 SHORTAGE_LABEL とは別の短い名前にする) */
export const SHORTAGE_TITLE = '欠員'

/** 在籍の運転士の数を入れていないときに、欠員の欄に出す文 */
export const SHORTAGE_ROSTER_HINT = '在籍の運転士の数は、手順「運行の前提」で入れます。入れると、乗務できる運転士の数(目安)をここにも出します。'

/**
 * 減便の方針の手順の欠員の欄(2026-11-07 に利用者の指示で、運行の前提の欄から移した)。
 * 欠員(その日に乗務できない運転士の数)を入れ、在籍の運転士の数が入っていれば乗務できる運転士の数(目安)の数え方を1行で出す。
 * 方針の入力(PolicyForm)や確かめの欄の外に置くので、承認の前・確かめている間・承認の後・「方針を変える」の後も同じ値で出る。
 * 値は store/drivers.ts(メモリだけ)。減便の方針の操作(applyPolicy)と AI の apply_policy には入れない。
 * 影響(到達圏)の手順の「欠員を入れる(減便の方針)」で、この欄へ移る(stepIds.ts の jumpToShortage)
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
      className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      aria-labelledby="driver-shortage-title"
    >
      <h3 id="driver-shortage-title" className="font-medium">
        {SHORTAGE_TITLE}
      </h3>
      <p className="text-xs text-muted-foreground">
        手順「影響(到達圏)」の「要る運転士の数(目安)」で、乗務できる運転士の数(目安)と減便後に要る勤務の数を比べるのに使います。値はこの画面の中だけに持ち、サーバーには送りません。
      </p>
      <CountField
        id="driver-shortage"
        label={SHORTAGE_LABEL}
        value={shortage}
        max={MAX_SHORTAGE}
        placeholder="例:19"
        parse={parseShortage}
        onCommit={(v) => useDriversStore.getState().setShortage(v)}
      />
      <p className="text-xs" data-testid="shortage-supply">
        {supply ? supplyText(supply) : SHORTAGE_ROSTER_HINT}
      </p>
      {warning && (
        <p className="text-xs font-medium text-destructive" data-testid="shortage-supply-warning">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </p>
      )}
    </section>
  )
}
