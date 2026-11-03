import { useMemo, useState, type ReactNode } from 'react'
import StepSection from '@/components/StepSection'
import { Button } from '@/components/ui/button'
import { createTripBriefer, NOTICE47_BANDS, restoreTotals, type TripBrief } from '@/gtfs/edit/diff'
import { feedVersionProblem, type Form2Result } from '@/gtfs/edit/form2'
import { addBackReasons, policyReasonOf, type EditRecord } from '@/gtfs/edit/ops'
import { forEachDay, indexFeedServiceDays, runsOn } from '@/gtfs/edit/services'
import { stopDiff, type StopDiffResult } from '@/gtfs/edit/stopDiff'
import { form2Texts } from '@/gtfs/validate/edit'
import { formatDateJa, todayInJapan } from '@/lib/dates'
import { diffOf, lastVersion, useEditStore, type BaseGtfs } from '@/store/edit'
import {
  periodText,
  POLICY_KIND_LABELS,
  REASON_LABELS,
  REPLACEMENT_LABELS,
  restoreTotalsText,
  RESTORE_DUTY_NOTE,
  SCHOOL_HOLIDAY_NOTE,
} from '@/components/steps/editText'

/**
 * 保護する便がこの数を超えたら、印刷では表を半分ずつ左右に並べる(行は落とさない。承認の記録なので全便を紙に残す)。
 * 便が多いと A4 縦1枚に収まらず、2枚目に続くことがある
 */
const TRIP_ROWS_SPLIT = 8

/** 勤務の確認欄(研究の資料 docs/research/dia-planning.md の B 変更指示書。数値は目安で、Dispatcher は判定しない) */
const DUTY_CHECKS = [
  '拘束時間(13 時間以内、最大 15 時間)',
  '休息期間(継続 9 時間以上)',
  '連続運転(4 時間まで)',
  '休日労働(2 週に 1 回の休日)',
]

/** 周知の欄(掲示・ウェブサイト・電話窓口・市町村、学校、病院への連絡)。実施した日を手書きする */
const NOTICE_CHECKS = ['停留所の掲示', 'ウェブサイト', '電話窓口', '市町村・学校・病院への連絡']

/** 'YYYY-MM-DDThh:mm:ss+09:00' を「2026年11月4日 09:30」にする。読めなければそのまま */
function approvedAtText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`
}

const ACTOR_TEXT = { user: '利用者が作成して承認', claude: 'AI(Claude)の下書きを利用者が承認' } as const

/**
 * 掲示を差し替える停留所の件数を数える日。減便の期間の中で、基準の平日の service が最初に走る日。
 * 比べる日を影響(到達圏)の手順の日付に任せると、土日を選んだままのときに「差し替え 0 件」になるため、変更指示書は平日で数える。
 * 見つからなければ null
 */
function weekdayComparisonDate(base: BaseGtfs, version: Form2Result): string | null {
  const days = indexFeedServiceDays(base.feed).get(version.plan.weekdayService.trim())
  let found: string | null = null
  forEachDay(version.report.validity.start, version.report.validity.end, (date, weekday) => {
    if (runsOn(days, date, weekday)) {
      found = date
      return true
    }
  })
  return found
}

/** 一覧を前半と後半の2つに分ける(limit 件以下なら分けない)。印刷で左右に並べて1枚に収めるため */
function splitHalf<T>(items: readonly T[], limit: number): T[][] {
  if (items.length <= limit) return [[...items]]
  const half = Math.ceil(items.length / 2)
  return [items.slice(0, half), items.slice(half)]
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <h3 className="mb-1 border-b border-foreground/40 pb-0.5 text-sm font-semibold print:text-[10px]">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

/** 項目名と値(値は文字。手書きの欄は Blank) */
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-1.5 ${wide ? 'print:col-span-2' : ''}`}>
      <dt className="shrink-0 text-muted-foreground print:text-black">{label}:</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** 手書き用の空欄 */
function Blank({ width = 'w-28' }: { width?: string }) {
  return <span role="presentation" className={`inline-block h-4 border-b border-foreground/60 align-baseline ${width}`} />
}

/** 手書きで印を付ける四角つきの項目 */
function CheckItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-1">
      <span aria-hidden="true">☐</span>
      <span>{children}</span>
    </li>
  )
}

/**
 * 出力の手順のタブ「変更指示書」。承認した内容を A4 縦1枚にまとめ、画面から印刷(PDF)できる。
 * 数字は gtfs/edit(diff・stopDiff・ops の履歴)が出し、ここでは並べるだけ。
 * 使うのは承認済みの操作だけ(planOf(history)。下書きは含めない)。届出の区分(事前・事後・不要)は判定せず、運輸支局に確認する欄にする。
 */
export default function ChangeOrder() {
  const base = useEditStore((s) => s.base)
  const history = useEditStore((s) => s.history)
  const versions = useEditStore((s) => s.versions)
  const draft = useEditStore((s) => s.draft)
  const customFeedVersion = useEditStore((s) => s.feedVersion)
  const version = lastVersion({ versions })

  return (
    <StepSection title="変更指示書">
      {!base ? (
        <p className="text-sm text-muted-foreground">GTFS を読み込み、減便の方針を承認すると、承認した内容を1枚にまとめます。</p>
      ) : !version ? (
        <p className="text-sm text-muted-foreground">減便の方針を承認すると、承認した内容を1枚にまとめます。</p>
      ) : (
        <>
          <div className="print-hide flex flex-col gap-1.5">
            <Button type="button" className="self-start" onClick={() => window.print()}>
              印刷する
            </Button>
            <p className="text-xs text-muted-foreground">
              印刷の画面で送信先を「PDF に保存」にすると、PDF にできます。A4 縦1枚に収まるように作っていますが、保護する便や変わる系統が多いときは2枚目に続きます(便は省かずにすべて載せます)。
              {draft && `承認前の下書き(${draft.id})は含めていません。`}
            </p>
          </div>
          <Sheet base={base} history={history} version={version} customFeedVersion={customFeedVersion.trim()} />
        </>
      )}
    </StepSection>
  )
}

function Sheet({
  base,
  history,
  version,
  customFeedVersion,
}: {
  base: BaseGtfs
  history: readonly EditRecord[]
  version: Form2Result
  customFeedVersion: string
}) {
  const [today] = useState(() => todayInJapan(new Date()))
  const { report, plan } = version

  const diff = useMemo(() => diffOf(base.feed, version), [base.feed, version])
  const reason = useMemo(() => policyReasonOf(history), [history])
  const policyRecord = useMemo(() => [...history].reverse().find((r) => r.op.type === 'applyPolicy') ?? null, [history])
  const addBackRecords = useMemo(() => history.filter((r) => r.op.type === 'addBack'), [history])
  const reasons = useMemo(() => addBackReasons(history), [history])
  const totals = useMemo(() => restoreTotals(base.feed, report.addBack.accepted), [base.feed, report.addBack.accepted])
  const texts = useMemo(() => form2Texts(version, today), [version, today])

  const routeNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const r of base.feed.tables.get('routes')?.rows ?? []) {
      const id = (r.route_id ?? '').trim()
      if (!names.has(id)) names.set(id, (r.route_short_name ?? '').trim() || (r.route_long_name ?? '').trim() || id)
    }
    return names
  }, [base.feed])

  // 保護する便(足し戻した便)。始発の時刻順
  const trips = useMemo<TripBrief[]>(() => {
    const ids = new Set(report.addBack.accepted)
    const brief = createTripBriefer(base.feed, 'base')
    const found = new Map<string, TripBrief>()
    for (const t of base.feed.tables.get('trips')?.rows ?? []) {
      const id = (t.trip_id ?? '').trim()
      if (ids.has(id) && !found.has(id)) found.set(id, brief(t))
    }
    return [...found.values()].sort(
      (a, b) => (a.firstSeconds ?? Infinity) - (b.firstSeconds ?? Infinity) || a.tripId.localeCompare(b.tripId, 'ja'),
    )
  }, [base.feed, report.addBack.accepted])
  const schoolTrips = trips.filter((t) => reasons.get(t.tripId)?.schoolDaysOnly).length

  // 系統×公示第47号の時間帯。1つでも変わった系統だけを出す(1枚に収めるため)
  const changedRoutes = useMemo(() => {
    return diff.byRoute.filter((r) => diff.byNotice47Band.some((c) => c.routeId === r.routeId && c.before !== c.after))
  }, [diff])
  const unchangedRoutes = diff.byRoute.length - changedRoutes.length
  const bandTotals = NOTICE47_BANDS.map((band) => {
    let before = 0
    let after = 0
    for (const c of diff.byNotice47Band) {
      if (c.band === band) {
        before += c.before
        after += c.after
      }
    }
    return { band, before, after }
  })
  const weekdayBefore = diff.byRoute.reduce((n, r) => n + r.before, 0)
  const weekdayAfter = diff.byRoute.reduce((n, r) => n + r.after, 0)
  const vanishing = diff.byRoute.filter((r) => r.vanishes)

  // 掲示を差し替える停留所
  const compareDate = useMemo(() => weekdayComparisonDate(base, version), [base, version])
  const stops = useMemo<StopDiffResult | null>(
    () => (compareDate ? stopDiff(base.feed, version.feed, compareDate) : null),
    [base.feed, version.feed, compareDate],
  )

  // 利用者が入れた feed_version は、出力の手順と同じ確かめ(feedVersionProblem)を通ったときだけ紙に出す。
  // 入れていなければ、出力の手順が出力した時点の日時で作るので、承認した時点の値(report.feedVersion.after)は例にとどめ、紙は手書きの欄にする
  const customProblem = customFeedVersion !== '' ? feedVersionProblem(customFeedVersion) : null
  const feedVersionText = customFeedVersion !== '' && customProblem === null ? customFeedVersion : null
  const gtfsReminder = texts.changes.find((t) => t.startsWith('次に運行管理システム')) ?? null
  const excluded = plan.excludedRoutes.map((id) => routeNames.get(id.trim()) ?? id)

  return (
    <div
      className="print-area flex flex-col gap-2.5 rounded-md border bg-background p-3 text-xs leading-snug print:gap-1 print:border-0 print:p-0 print:text-[9px] print:leading-tight print:text-black"
      aria-label="変更指示書"
      data-testid="change-order"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 border-b-2 border-foreground pb-1">
        <h2 className="text-base font-bold print:text-[13px]">変更指示書(減便)</h2>
        <p>
          作成日:{formatDateJa(today)}
          <span className="ml-2 text-muted-foreground print:text-black">元の GTFS:{base.label}</span>
        </p>
      </header>

      <Section title="1. 減便の理由">
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
          <Field label="区分">{reason?.category ? REASON_LABELS[reason.category] : '未選択'}</Field>
          <Field label="メモ">{reason?.note.trim() ? reason.note : '(なし)'}</Field>
        </dl>
        <p className="print-hide text-muted-foreground">
          区分は利用者が選んだ値をそのまま写しています。補助の扱いや届出の要否には、区分によって違いが出ることがあります。
        </p>
      </Section>

      <Section title="2. 方針と承認">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 print:grid-cols-2">
          <Field label="方針">{POLICY_KIND_LABELS[plan.kind]}</Field>
          <Field label="期間" wide>
            {periodText(plan.period.start, plan.period.end)}
            <span className="text-muted-foreground print:text-black">
              (出力する GTFS の有効期間 {formatDateJa(report.validity.start)}〜{formatDateJa(report.validity.end)}、{report.validity.days} 日)
            </span>
          </Field>
          <Field label="入れ替える service">
            平日 {plan.weekdayService} → {REPLACEMENT_LABELS[plan.kind]} {plan.replacementService}
          </Field>
          <Field label="除外した系統">{excluded.length > 0 ? excluded.join('、') : 'なし'}</Field>
          <Field label="平日の便数">
            {weekdayBefore} → {weekdayAfter} 便(消える {diff.removed.length}、入る {diff.added.length}、同じ {diff.same.length})
          </Field>
          <Field label="全曜日で便がなくなる系統">
            {vanishing.length > 0 ? `${vanishing.length} 系統(下の表の ✕)` : 'なし'}
          </Field>
          <Field label="方針の承認" wide>
            {policyRecord ? (
              <>
                {approvedAtText(policyRecord.at)}({ACTOR_TEXT[policyRecord.by]})
              </>
            ) : (
              '(記録なし)'
            )}
          </Field>
          {addBackRecords.length > 0 && (
            <Field label="足し戻しの承認" wide>
              {addBackRecords.length} 回(最後は {approvedAtText(addBackRecords[addBackRecords.length - 1].at)}、
              利用者が作成 {addBackRecords.filter((r) => r.by === 'user').length} 回・AI の下書き {addBackRecords.filter((r) => r.by === 'claude').length} 回)
            </Field>
          )}
          <Field label="承認者">
            <Blank width="w-40" />
          </Field>
        </dl>
      </Section>

      <Section title="3. 届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)">
        {changedRoutes.length === 0 ? (
          <p>時間帯ごとの便数が変わる系統はありません。</p>
        ) : (
          // 系統が多いと1枚に収まらないので、印刷では半分ずつ左右に並べる(画面では縦に並べる)
          <div className="grid grid-cols-1 gap-x-3 gap-y-1 print:grid-cols-2">
            {splitHalf(changedRoutes, 12).map((part, i) => (
              <table
                key={i}
                className="w-full table-fixed border-collapse text-center"
                aria-label="系統と時間帯ごとの平日の便数(前 → 後)"
              >
                <colgroup>
                  <col className="w-[34%]" />
                  {NOTICE47_BANDS.map((band) => (
                    <col key={band} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="border-b border-foreground/40">
                    <th scope="col" className="py-0.5 text-left font-medium">
                      系統
                    </th>
                    {NOTICE47_BANDS.map((band) => (
                      <th key={band} scope="col" className="py-0.5 font-medium">
                        {band}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {part.map((r) => (
                    <tr key={r.routeId} className="border-b border-foreground/15">
                      <th scope="row" className="py-0.5 text-left font-normal print:py-0" title={r.routeName}>
                        <span className="flex">
                          {r.vanishes && (
                            <span className="shrink-0 font-semibold">
                              <span aria-hidden="true">✕</span>
                              <span className="sr-only">(全曜日で無くなる)</span>
                            </span>
                          )}
                          <span className="truncate">{r.routeName}</span>
                        </span>
                      </th>
                      {NOTICE47_BANDS.map((band) => {
                        const c = diff.byNotice47Band.find((x) => x.routeId === r.routeId && x.band === band)
                        return (
                          <td key={band} className={`py-0.5 tabular-nums print:py-0 ${c && c.before !== c.after ? 'font-semibold' : ''}`}>
                            {c ? `${c.before} → ${c.after}` : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        )}
        <p className="font-medium" data-testid="notice47-total">
          全系統の合計(平日の便数):
          {bandTotals.map((t) => (
            <span key={t.band} className="ml-2 inline-block tabular-nums">
              {t.band} {t.before} → {t.after}
            </span>
          ))}
        </p>
        <p className="text-muted-foreground print:text-black">
          ✕は全曜日で便が無くなる系統。始発停留所の出発時刻で数え、変わらない {unchangedRoutes} 系統は省いています。
          <span className="print-hide">回数の単位と届出の区分は判定しません。</span>届出の区分は運輸支局に確認してください。
        </p>
      </Section>

      <Section title="4. 保護する便(足し戻した便)">
        {trips.length === 0 ? (
          <p>足し戻した便はありません。</p>
        ) : (
          <>
            <p>
              {trips.length} 便
              {schoolTrips > 0 && `(うち休校日運休(学) ${schoolTrips} 便)`}。{restoreTotalsText(totals)}
            </p>
            <div className={`grid grid-cols-1 gap-x-3 ${trips.length > TRIP_ROWS_SPLIT ? 'print:grid-cols-2' : ''}`}>
              {splitHalf(trips, TRIP_ROWS_SPLIT).map((part, i) => (
                <table key={i} className="w-full border-collapse text-left" aria-label="保護する便と理由">
                  <thead>
                    <tr className="border-b border-foreground/40">
                      <th scope="col" className="py-0.5 font-medium">
                        便(trip_id)
                      </th>
                      <th scope="col" className="py-0.5 font-medium">
                        系統・発着
                      </th>
                      <th scope="col" className="py-0.5 font-medium">
                        時刻
                      </th>
                      <th scope="col" className="py-0.5 font-medium">
                        理由
                      </th>
                      <th scope="col" className="py-0.5 font-medium">
                        印
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {part.map((t) => {
                      const info = reasons.get(t.tripId)
                      return (
                        <tr key={t.tripId} data-trip-id={t.tripId} className="border-b border-foreground/15 align-top">
                          <td className="py-0.5 pr-1 font-mono break-all print:py-0">{t.tripId}</td>
                          <td className="py-0.5 pr-1 print:py-0">
                            {t.routeName} {t.firstStopName}→{t.lastStopName}
                          </td>
                          <td className="py-0.5 pr-1 whitespace-nowrap tabular-nums print:py-0">
                            {t.firstDeparture ?? '—'}〜{t.lastArrival ?? '—'}
                          </td>
                          <td className="py-0.5 pr-1 print:py-0">{info?.reason.trim() ? info.reason : '(理由の記入なし)'}</td>
                          <td className="py-0.5 whitespace-nowrap print:py-0">{info?.schoolDaysOnly ? '(学)' : ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ))}
            </div>
            <p className="text-muted-foreground print:text-black">
              (学)は休校日運休の便の印です。<span className="print-hide">{SCHOOL_HOLIDAY_NOTE}</span>
            </p>
            <div>
              <p className="font-medium">勤務の確認(運行管理者が乗務割で確かめた項目に印を付ける)</p>
              <ul className="grid grid-cols-2 gap-x-3">
                {DUTY_CHECKS.map((c) => (
                  <CheckItem key={c}>{c}</CheckItem>
                ))}
              </ul>
              <p className="print-hide text-muted-foreground">{RESTORE_DUTY_NOTE}</p>
              <p>
                確認者:<Blank width="w-32" /> 確認日:<Blank width="w-24" />
              </p>
            </div>
          </>
        )}
      </Section>

      <Section title="5. 届出・公示(手書き)">
        <p className="print-hide text-muted-foreground">
          届出の区分(事前・事後・不要)は Dispatcher では判定しません。運輸支局に確認し、結果を書いてください。
        </p>
        <dl className="grid grid-cols-1 gap-y-1">
          <Field label="運輸支局に確認した結果(区分・確認先・確認日)">
            <Blank width="w-72" />
          </Field>
          <div className="grid grid-cols-3 gap-x-3">
            <Field label="届出日">
              <Blank width="w-20" />
            </Field>
            <Field label="公示日">
              <Blank width="w-20" />
            </Field>
            <Field label="実施日">
              <Blank width="w-20" />
            </Field>
          </div>
          <Field label="公示から実施まで 7 日を切るときの理由">
            <Blank width="w-60" />
          </Field>
        </dl>
        <p className="print-hide text-muted-foreground">
          方針の期間の開始日は {formatDateJa(plan.period.start)} です。
        </p>
      </Section>

      <div className="grid grid-cols-1 gap-2.5 print:grid-cols-2 print:gap-2">
      <Section title="6. GTFS">
        <dl className="flex flex-col gap-0.5">
          <Field label="feed_version">
            {report.feedVersion.before || '(空)'} →{' '}
            {feedVersionText ? (
              <span className="font-mono break-all">{feedVersionText}</span>
            ) : (
              <>
                出力した ZIP の値 <Blank width="w-32" />
                <span className="print-hide block text-muted-foreground">
                  出力した日時で作ります(承認したときの例 <span className="font-mono break-all">{report.feedVersion.after}</span>)。出力した後に、ZIP の
                  feed_info.txt の値を書いてください。
                  {customProblem && `入れた feed_version は使えません。${customProblem}`}
                </span>
              </>
            )}
          </Field>
          <Field label="有効期間">
            {formatDateJa(report.validity.start)}〜{formatDateJa(report.validity.end)}({report.validity.days} 日)
          </Field>
          <Field label="公開予定日">
            <Blank width="w-24" />
          </Field>
          <Field label="連絡した先(Google、国内の経路検索事業者)">
            <Blank width="w-40" />
          </Field>
        </dl>
              </Section>

      <Section title="7. 周知">
        <dl className="flex flex-col gap-0.5">
          <Field label="掲示を差し替える停留所">
            {stops ? (
              <>
                <span className="font-semibold tabular-nums">{stops.repostCount} 件</span>(全 {stops.stops.length} 件中。
                {formatDateJa(stops.date)}の発車を比べた件数)
              </>
            ) : (
              '—(比べる平日が見つかりません。減便後の GTFS に平日ダイヤの運行日があるか確かめてください)'
            )}
          </Field>
          {stops && stops.stopsWithAdded > 0 && (
            <Field label="新しく生じる発車時刻がある停留所">
              {stops.stopsWithAdded} 件(掲示より早い発車は早発になりえます)
            </Field>
          )}
          {stops && stops.stopsLosingAll > 0 && <Field label="発車がすべて無くなる停留所">{stops.stopsLosingAll} 件</Field>}
        </dl>
        <p className="print-hide text-muted-foreground">停留所ごとの一覧と掲示の案は、「停留所の一覧」「周知文」のタブにあります。</p>
        <ul className="grid grid-cols-2 gap-x-3">
          {NOTICE_CHECKS.map((c) => (
            <CheckItem key={c}>
              {c}(実施日 <Blank width="w-16" />)
            </CheckItem>
          ))}
        </ul>
      </Section>
      </div>
      {gtfsReminder && (
        <p className="break-inside-avoid">
          <span className="font-semibold">GTFS の注意:</span>
          {gtfsReminder}
        </p>
      )}
    </div>
  )
}
