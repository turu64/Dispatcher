import { useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { checkedAtText, safeUrl } from '@/claude/research'
import { Button } from '@/components/ui/button'
import type { AddBackItem } from '@/gtfs/edit/ops'
import { FACILITY_WINDOW_NAMES, type HintFacility, type NearFacility } from '@/gtfs/edit/restore'
import type { Candidate } from './grouping'
import { TripLine } from './TripLine'

/** 調べた結果の確認日時が古いとみなす日数。これを超えたら、出典で確かめるよう添える */
const STALE_CHECK_DAYS = 30

/** 確認日時(ISO 8601)が now の STALE_CHECK_DAYS 日より前か。日時を読めなければ false(古いとは決めつけない) */
function isStaleCheck(checkedAt: string, now: number): boolean {
  const t = Date.parse(checkedAt)
  return Number.isFinite(t) && now - t > STALE_CHECK_DAYS * 86_400_000
}

/** 古い確認日時に添える注意 */
const STALE_CHECK_NOTE = `${STALE_CHECK_DAYS}日より前の確認です。出典で確かめてください。`

/** 施設の時間帯の窓や長期休業を決めるのに使った、調べた事実(使い道つき) */
interface EvidenceFact {
  label: string
  value: string
  url: string | null
  uses: string[]
}

/** 施設の窓と長期休業に使った事実を、同じラベルと値でまとめて集める */
function evidenceFacts(f: HintFacility): EvidenceFact[] {
  const out: EvidenceFact[] = []
  const add = (fact: { label: string; value: string; url: string | null } | undefined, use: string) => {
    if (!fact) return
    const hit = out.find((e) => e.label === fact.label && e.value === fact.value)
    if (hit) {
      if (!hit.uses.includes(use)) hit.uses.push(use)
    } else out.push({ label: fact.label, value: fact.value, url: fact.url, uses: [use] })
  }
  for (const timing of ['arrive', 'depart'] as const) {
    const w = f.windows[timing]
    if (w.source === 'research') add(w.fact, `${FACILITY_WINDOW_NAMES[f.kind][timing]}の窓に使用`)
  }
  for (const b of f.longBreaks) add(b.fact, '長期休業の重なりの確認に使用')
  return out
}

/** 窓の出どころの文 */
function windowSourceText(f: HintFacility): string {
  const sources = [f.windows.arrive.source, f.windows.depart.source]
  if (sources.every((s) => s === 'research')) return '調べた結果'
  if (sources.every((s) => s === 'default')) return '既定'
  return '調べた結果と既定'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 学校・病院の判断材料の理由の文の下に出す、調べた要点(開閉できる)。閉じていても、窓の出どころと確認日時
 * (30 日を超えたら注意)は見える。開くと、窓と長期休業を決めた事実(受付時間・始業・終業・休業)を出典のリンクつきで出す。
 * 数と時刻はコードが読んだもの(AI の文ではない)。確認日時は調べた結果のもの
 */
export function FacilityEvidence({ near }: { near: NearFacility }) {
  const [open, setOpen] = useState(false)
  // 画面を開いた時点の日時で、確認日時が古いかを決める(再描画のたびに変わらない)
  const [now] = useState(() => Date.now())
  const f = near.facility
  const research = f.research
  const facts = evidenceFacts(f)
  const panelId = useId()
  const stale = research ? isStaleCheck(research.checkedAt, now) : false
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-left font-medium underline-offset-2 hover:underline"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${f.name}の調べた要点`}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true" className="w-3 text-muted-foreground">
            {open ? '▾' : '▸'}
          </span>
          調べた要点
        </button>
        <span className="text-muted-foreground">窓は{windowSourceText(f)}</span>
        {research && (
          <span className="text-muted-foreground">
            確認日時 {checkedAtText(research.checkedAt)}・{research.origin === 'demo' ? 'デモ用の保存済みの結果' : 'Web で調べた結果'}
          </span>
        )}
        {stale && <span className="font-medium text-amber-800 dark:text-amber-300">{STALE_CHECK_NOTE}</span>}
      </div>
      {open && (
        <div id={panelId} className="flex flex-col gap-0.5 rounded-md border bg-muted/30 px-2 py-1">
          {facts.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              {facts.map((e) => {
                const url = e.url ? safeUrl(e.url) : null
                return (
                  <div key={`${e.label}\t${e.value}`} className="contents">
                    <dt className="text-muted-foreground">{e.label}</dt>
                    <dd className="break-words">
                      {e.value}
                      <span className="ml-1 text-muted-foreground">({e.uses.join('・')})</span>{' '}
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 break-all underline underline-offset-2">
                          出典 {hostOf(url)}
                          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">出典を表示できません</span>
                      )}
                    </dd>
                  </div>
                )
              })}
            </dl>
          ) : !research ? (
            <p className="text-muted-foreground">この施設は「判断材料を調べる」で調べていないため、時間帯の窓は既定です。</p>
          ) : research.status === 'not_found' ? (
            <p className="text-muted-foreground">調べましたが見つからなかったため、時間帯の窓は既定です。</p>
          ) : (
            <p className="text-muted-foreground">調べた結果から受付時間・始業・終業を読めなかったため、時間帯の窓は既定です。</p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 「AI に候補を聞く」の結果(Claude の足し戻しの下書き)にある便を、一覧の先頭にまとめて出す(指摘5)。
 * 下書きを承認するかやめると消える。ここで選んだ便は、系統の一覧で選んだ便と同じ扱い
 */
export function AiPicks({
  picks,
  selected,
  onSelect,
}: {
  /** 候補にある便と、Claude の下書きの項目(時刻の順) */
  picks: readonly { candidate: Candidate; item: AddBackItem }[]
  selected: ReadonlySet<string>
  onSelect: (tripId: string, checked: boolean) => void
}) {
  if (picks.length === 0) return null
  return (
    <section className="flex flex-col gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs" aria-label="AI のおすすめ">
      <h3 className="font-medium">AI のおすすめ({picks.length} 便)</h3>
      <p className="text-muted-foreground">
        AI の下書きにある便です。下書きをそのまま承認するか、ここで一部を選んで平日に戻せます。選んで戻すと、AI の下書きは破棄します。
      </p>
      <ul className="flex flex-col divide-y rounded-md border bg-background">
        {picks.map(({ candidate: c, item }) => (
          <li key={c.trip.tripId} className="px-2 py-1">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={selected.has(c.trip.tripId)}
                onChange={(e) => onSelect(c.trip.tripId, e.target.checked)}
                aria-label={`${c.trip.firstDeparture ?? '時刻なし'} ${c.trip.routeName} ${c.trip.tripId} を選ぶ`}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <TripLine trip={c.trip} hints={c.detail.hints} lostCells={c.detail.lostCells} />
                <span className="text-muted-foreground">
                  AI の理由:{item.reason === '' ? '(なし)' : item.reason}
                  {item.schoolDaysOnly && '・休校日運休(学)'}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 選んだ便と、便ごとの「休校日運休(学)」のチェック(GTFS には入れず、変更指示書と周知文に使う) */
export function SelectedTrips({
  trips,
  school,
  schoolNotes,
  onSchool,
  onRemove,
}: {
  trips: readonly Candidate[]
  school: ReadonlySet<string>
  /** 便ごとの、学校の長期休業が減便の期間と重なるときの注意(休校日運休(学)のチェックの近くに出す。チェックは自動で付けない) */
  schoolNotes?: ReadonlyMap<string, readonly string[]>
  onSchool: (tripId: string, checked: boolean) => void
  onRemove: (tripId: string) => void
}) {
  if (trips.length === 0) return null
  return (
    <section className="flex flex-col gap-1 text-xs" aria-label="選んだ便">
      <h3 className="font-medium">選んだ便({trips.length} 便)</h3>
      <ul className="flex flex-col divide-y rounded-md border">
        {trips.map((c) => (
          <li key={c.trip.tripId} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 py-1">
            <span className="min-w-0 break-words">
              <span className="font-medium tabular-nums">{c.trip.firstDeparture ?? '—'}</span> {c.trip.routeName}:{c.trip.firstStopName} →{' '}
              {c.trip.lastStopName} <span className="font-mono text-[10px] text-muted-foreground">{c.trip.tripId}</span>
            </span>
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={school.has(c.trip.tripId)}
                  onChange={(e) => onSchool(c.trip.tripId, e.target.checked)}
                  aria-label={`${c.trip.tripId} を休校日運休(学)にする`}
                />
                休校日運休(学)
              </label>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onRemove(c.trip.tripId)} aria-label={`${c.trip.tripId} を選ぶのをやめる`}>
                外す
              </Button>
            </span>
            {(schoolNotes?.get(c.trip.tripId) ?? []).map((t) => (
              <p key={t} className="w-full break-words text-amber-900 dark:text-amber-200" data-testid="school-break-note">
                {t}
              </p>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">休校日運休(学)は、学校の休業日に走らせない便の印です。GTFS には入れず、変更指示書と周知文に使います。</p>
    </section>
  )
}
