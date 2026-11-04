import { flushSync } from 'react-dom'
import { SELECTED_TOGGLE_CLASS } from '@/components/selectedToggle'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { PolicyKind } from '@/gtfs/edit/ops'
import { jevChoiceOf } from '@/gtfs/groups/rules'
import type { GroupProblem, KindGroups, KindRow, ServiceFeatures, ServiceGroups } from '@/gtfs/groups/types'
import type { GroupChoice } from '@/gtfs/groups/view'
import { useServiceGroupsStore } from '@/store/serviceGroups'
import { REPLACEMENT_LABELS } from '../editText'
import { BASIS_LABELS, SIDE_LABELS, tripsText } from '../load/serviceGroupsText'
import { assignedTo, manualEdits, targetsText, type ManualChoice, type ReplaceMode } from './groupReplace'
import { PairList } from './PairList'

/**
 * 減便の方針の詳しい設定の「入れ替えるダイヤ」(指摘19。docs/tasks-1105.md の U04、§2 の D3)。
 * - 自動(既定):ダイヤのグループ分けのとおりに一括で入れ替える。組の内訳(PairList)を見せる
 * - 手動で選ぶ:今の方針の種類について、平日の側の service(平日だけ・形2で表せない)ごとに「入れ替える/入れ替えない」と
 *   入れ替え先1つ(土曜/日祝の service、または「便をなくす」)を選ぶ。値は store の edit(GroupEdit の into・treatment)に変えて渡し、
 *   gtfs/groups の規則は変えない。入れる先が決まらない・食い違う入れ替えに使う service は、下の欄で入れる先を選ぶ
 * 単純な GTFS で1組の形で足りる(道北バス)ときは、この欄は出ない(PolicyForm が今の ServiceSelect を出す)
 */

/** 手動の欄の見出しの id(決まらない行の「手動で選ぶ」から焦点を移す先) */
export const GROUP_MANUAL_ID = 'group-replace-manual'

/** 入れ替え先の選択肢の値:便をなくす */
const NONE = '__none__'
/** 入れ替え先の選択肢の値:自動の案で入れ替え先が複数(「03001 ほか 1」)。選んだままなら何も変えない */
const MULTI = '__multi__'
/** 入れる先の選択肢の値:使わない */
const UNUSED = '__unused__'

function rowId(kind: PolicyKind, serviceId: string, part: string): string {
  return `grp-${kind}-${serviceId}-${part}`
}

/**
 * 押したボタンが消えるとき、焦点を body に落とさないよう、描き直したあとで代わりの要素に移す。
 * id の要素が入力でなければ(ToggleGroup の枠)、その中の選んでいるボタン(無ければ最初の押せるボタン)に移す
 */
function focusAfter(action: () => void, id: string) {
  flushSync(action)
  const el = document.getElementById(id)
  if (!el) return
  const target =
    el instanceof HTMLButtonElement || el instanceof HTMLSelectElement
      ? el
      : (el.querySelector<HTMLElement>('button[data-state="on"]:not([disabled])') ?? el.querySelector<HTMLElement>('button:not([disabled])'))
  target?.focus()
}

/** 平日の側の service の並び:主の平日の service を先頭、あとは service_id の昇順 */
function weekdayRows(kg: KindGroups): KindRow[] {
  return kg.rows
    .filter((r) => r.side === 'weekdayOnly' || r.side === 'unsupported')
    .sort((a, b) => Number(b.serviceId === kg.mainWeekday) - Number(a.serviceId === kg.mainWeekday) || (a.serviceId < b.serviceId ? -1 : 1))
}

function FeatureLine({ row, feature }: { row: KindRow; feature: ServiceFeatures | undefined }) {
  return (
    <span className="text-xs text-muted-foreground">
      {SIDE_LABELS[row.side]}
      {feature && `・${BASIS_LABELS[feature.basis]}・${tripsText(feature)}`}
    </span>
  )
}

/** 平日の側の1行 */
function WeekdayRow({ groups, kg, row, feature }: { groups: ServiceGroups; kg: KindGroups; row: KindRow; feature: ServiceFeatures | undefined }) {
  const edit = useServiceGroupsStore((s) => s.edit)
  const resetRow = useServiceGroupsStore((s) => s.resetRow)
  const kind = kg.kind
  const label = REPLACEMENT_LABELS[kind]
  const assigned = assignedTo(kg, row.serviceId)
  const replacements = kg.rows.filter((r) => r.side === 'replacement')
  const replace = row.treatment === 'erase' ? 'erase' : row.treatment === 'keep' ? 'keep' : ''
  const targetValue = assigned.length === 0 ? NONE : assigned.length === 1 ? assigned[0].serviceId : MULTI
  const selectId = rowId(kind, row.serviceId, 'target')
  const toggleId = rowId(kind, row.serviceId, 'replace')
  // 直した行:この平日の service と、入れ替えに使う service のうち直したもので、今ここに入っているもの・案(規則か Jev)ではここに入るもの
  // (「便をなくす」で外した service も、この行の「案に戻す」で戻せるように)
  const proposedInto = (r: KindRow) => {
    const jev = jevChoiceOf(groups, kind, r.serviceId).into
    return jev !== undefined ? jev : (groups.proposal[kind].rows.find((p) => p.serviceId === r.serviceId)?.into ?? null)
  }
  const editedIds = [
    ...(row.basisMark === 'edited' ? [row.serviceId] : []),
    ...replacements.filter((r) => r.intoMark === 'edited' && (r.into === row.serviceId || proposedInto(r) === row.serviceId)).map((r) => r.serviceId),
  ]
  const conflicts = assigned.filter((r) => r.intoMark === 'conflict')
  const basisConflict = row.basisMark === 'conflict'
  const jevBasis = basisConflict ? jevChoiceOf(groups, kind, row.serviceId).basis : undefined
  const apply = (choice: ManualChoice) => {
    const edits = manualEdits(kg, row.serviceId, choice)
    if (edits.length > 0) edit(edits)
  }
  return (
    <li className="flex flex-col gap-1 rounded-md border px-2 py-1.5" data-service={row.serviceId}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm break-all" id={rowId(kind, row.serviceId, 'name')}>
          {row.serviceId}
        </span>
        <FeatureLine row={row} feature={feature} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          id={toggleId}
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label={`${row.serviceId} を入れ替えるか`}
          value={replace}
          onValueChange={(v) => {
            // もう一度押して選択が外れたとき('')は、そのままにする
            if (v === 'erase') apply({ replace: true })
            else if (v === 'keep') apply({ replace: false })
          }}
        >
          <ToggleGroupItem value="erase" disabled={row.side === 'unsupported'} className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
            入れ替える
          </ToggleGroupItem>
          <ToggleGroupItem value="keep" className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
            入れ替えない
          </ToggleGroupItem>
        </ToggleGroup>
        {row.treatment === 'erase' && (
          <label className="flex min-w-0 items-center gap-1 text-xs">
            <span className="shrink-0">入れ替え先</span>
            <select
              id={selectId}
              aria-label={`${row.serviceId} の入れ替え先(${label})`}
              className="h-7 min-w-0 max-w-full rounded-md border bg-background px-1.5 font-mono text-xs"
              value={targetValue}
              onChange={(e) => {
                const v = e.target.value
                if (v === MULTI) return
                apply({ replace: true, target: v === NONE ? null : v })
              }}
            >
              {targetValue === MULTI && <option value={MULTI}>{targetsText(assigned.map((r) => r.serviceId))}</option>}
              {replacements.map((r) => (
                <option key={r.serviceId} value={r.serviceId}>
                  {r.serviceId}
                  {r.into !== null && r.into !== row.serviceId ? `(今は ${r.into} に入れる)` : ''}
                  {r.intoMark === 'undecided' ? '(入れる先が決まらない)' : ''}
                </option>
              ))}
              <option value={NONE}>便をなくす</option>
            </select>
          </label>
        )}
      </div>
      {row.side === 'unsupported' && (
        <p className="text-xs text-muted-foreground">
          平日と{label === '土曜' ? '日祝' : '土曜'}に走り、{label}に走らないため、形2では入れ替えられません。「入れ替えない」を選ぶと進めます。
        </p>
      )}
      {row.treatment === 'erase' && assigned.length === 0 && (
        <p className="text-xs text-muted-foreground">{label}のダイヤに入れ替えず、期間の間この service の便をなくします。</p>
      )}
      {basisConflict && jevBasis !== undefined && feature && (
        <p className="text-xs text-amber-900 dark:text-amber-300">
          規則と Jev が食い違っています(Jev:{BASIS_LABELS[jevBasis]}、規則:{BASIS_LABELS[feature.basis]})。扱いは規則の値です。
        </p>
      )}
      {conflicts.map((r) => {
        const jev = jevChoiceOf(groups, kind, r.serviceId).into
        return (
          <p key={r.serviceId} className="text-xs text-amber-900 dark:text-amber-300">
            <span className="font-mono">{r.serviceId}</span> は、規則と Jev が食い違っています(Jev:
            <span className={jev ? 'font-mono' : undefined}>{jev ?? '使わない'}</span>)。規則の値でここに入れています。
          </p>
        )
      })}
      {(basisConflict || conflicts.length > 0 || editedIds.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {(basisConflict || conflicts.length > 0) && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                focusAfter(
                  () =>
                    edit([
                      ...(basisConflict ? [{ kind, serviceId: row.serviceId, acceptConflict: true as const }] : []),
                      ...conflicts.map((r) => ({ kind, serviceId: r.serviceId, acceptConflict: true as const })),
                    ]),
                  toggleId,
                )
              }
            >
              規則の値のまま進める
            </Button>
          )}
          {editedIds.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                focusAfter(() => {
                  for (const id of editedIds) resetRow(id)
                }, toggleId)
              }
            >
              案に戻す
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

/** 入れる先が決まらない・食い違う入れ替えに使う service(どの平日の service の下にも出ないもの)の1行 */
function OrphanRow({ groups, kg, row, feature }: { groups: ServiceGroups; kg: KindGroups; row: KindRow; feature: ServiceFeatures | undefined }) {
  const edit = useServiceGroupsStore((s) => s.edit)
  const resetRow = useServiceGroupsStore((s) => s.resetRow)
  const kind = kg.kind
  const weekdays = kg.rows.filter((r) => r.side === 'weekdayOnly').map((r) => r.serviceId)
  const selectId = rowId(kind, row.serviceId, 'into')
  const jev = row.intoMark === 'conflict' ? jevChoiceOf(groups, kind, row.serviceId).into : undefined
  return (
    <li className="flex flex-col gap-1 rounded-md border px-2 py-1.5" data-service={row.serviceId}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-sm break-all">{row.serviceId}</span>
        <FeatureLine row={row} feature={feature} />
      </div>
      <label className="flex min-w-0 items-center gap-1 text-xs">
        <span className="shrink-0">入れる平日の service</span>
        <select
          id={selectId}
          aria-label={`${row.serviceId} の便を入れる平日の service`}
          className="h-7 min-w-0 max-w-full rounded-md border bg-background px-1.5 font-mono text-xs"
          value={row.into ?? (row.intoMark === 'undecided' ? '' : UNUSED)}
          onChange={(e) => {
            const v = e.target.value
            if (v === '') return
            edit({ kind, serviceId: row.serviceId, into: v === UNUSED ? null : v })
          }}
        >
          {row.intoMark === 'undecided' && row.into === null && (
            <option value="" disabled>
              選んでください
            </option>
          )}
          {weekdays.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
          <option value={UNUSED}>使わない</option>
        </select>
      </label>
      {row.intoMark === 'undecided' && <p className="text-xs text-destructive">入れる平日の service が決まりません。選んでください。</p>}
      {row.intoMark === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900 dark:text-amber-300">
          <p>
            規則と Jev が食い違っています(Jev:<span className={jev ? 'font-mono' : undefined}>{jev ?? '使わない'}</span>)。規則の値は「使わない」です。
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => focusAfter(() => edit({ kind, serviceId: row.serviceId, acceptConflict: true }), selectId)}
          >
            規則の値のまま進める
          </Button>
        </div>
      )}
      {row.intoMark === 'edited' && (
        <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => focusAfter(() => resetRow(row.serviceId), selectId)}>
          案に戻す
        </Button>
      )}
    </li>
  )
}

/** 手動の欄 */
function ManualFields({ groups, kind }: { groups: ServiceGroups; kind: PolicyKind }) {
  const kg = groups.byKind[kind]
  const byId = new Map(groups.features.services.map((s) => [s.serviceId, s]))
  const rows = weekdayRows(kg)
  // どの平日の service の下にも出ない、確かめが要る入れ替えに使う service(決まらない・食い違いで使わない、利用者が使わないにしたもの)
  const orphans = kg.rows.filter(
    (r) => r.side === 'replacement' && r.into === null && (r.intoMark === 'undecided' || r.intoMark === 'conflict' || r.intoMark === 'edited'),
  )
  return (
    <div className="flex flex-col gap-2" data-testid="group-replace-manual">
      <h4 id={GROUP_MANUAL_ID} tabIndex={-1} className="text-xs font-medium outline-none">
        平日の側の service ごとに選ぶ({REPLACEMENT_LABELS[kind]}ダイヤに変えるとき)
      </h4>
      <ul className="flex flex-col gap-1.5" aria-labelledby={GROUP_MANUAL_ID}>
        {rows.map((row) => (
          <WeekdayRow key={row.serviceId} groups={groups} kg={kg} row={row} feature={byId.get(row.serviceId)} />
        ))}
      </ul>
      {orphans.length > 0 && (
        <>
          <h4 className="text-xs font-medium" id={`${GROUP_MANUAL_ID}-orphans`}>
            どの平日の service にも入れていない入れ替えに使う service
          </h4>
          <ul className="flex flex-col gap-1.5" aria-labelledby={`${GROUP_MANUAL_ID}-orphans`}>
            {orphans.map((row) => (
              <OrphanRow key={row.serviceId} groups={groups} kg={kg} row={row} feature={byId.get(row.serviceId)} />
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        ここで選んだ値は、AI の相談にも使います。「自動」に戻すと、この種類で手動で選んだ値を捨てて、グループ分けのとおりに戻します。
      </p>
    </div>
  )
}

export function GroupReplaceFields({
  kind,
  value,
  errors,
  mode,
  onModeChange,
  tripCounts,
  dropped,
  skipped,
}: {
  kind: PolicyKind
  /** グループ分けから作った値(作れなければ null) */
  value: Exclude<GroupChoice, { error: unknown }> | null
  /** 作れないときの理由(groupErrors) */
  errors: readonly GroupProblem[] | null
  mode: ReplaceMode
  onModeChange: (mode: ReplaceMode) => void
  tripCounts: ReadonlyMap<string, number>
  dropped: ReadonlySet<string>
  skipped: ReadonlySet<string>
}) {
  const groups = useServiceGroupsStore((s) => s.groups)
  const resetKind = useServiceGroupsStore((s) => s.resetKind)
  if (!groups) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="入れ替えるダイヤの選び方"
        value={mode}
        onValueChange={(v) => {
          if (v === 'auto') {
            // 自動はグループ分けのとおり。この種類で手動で選んだ値は捨てる
            resetKind(kind)
            onModeChange('auto')
          } else if (v === 'manual') {
            onModeChange('manual')
          }
        }}
      >
        <ToggleGroupItem value="auto" className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
          自動(グループ分けのとおり。既定)
        </ToggleGroupItem>
        <ToggleGroupItem value="manual" className={`h-7 px-2 text-xs ${SELECTED_TOGGLE_CLASS}`}>
          手動で選ぶ
        </ToggleGroupItem>
      </ToggleGroup>
      {mode === 'auto' ? (
        value ? (
          <PairList settings={value} tripCounts={tripCounts} dropped={dropped} skipped={skipped} />
        ) : (
          <p className="text-xs text-destructive">
            このグループ分けでは、{REPLACEMENT_LABELS[kind]}ダイヤに変更できません
            {errors && errors.length > 0 ? `(${errors.map((p) => p.message).join(' ')})` : ''}。「手動で選ぶ」で直せます。
          </p>
        )
      ) : (
        <>
          <ManualFields groups={groups} kind={kind} />
          {value && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium">今の組の内訳</p>
              <PairList settings={value} tripCounts={tripCounts} dropped={dropped} skipped={skipped} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
