/**
 * 学校・病院の時間帯の窓を、周辺の施設の調査で調べた事実(ラベルと値の文)から施設ごとに決める(docs/tasks-1103b.md の T27)。
 * あわせて、学校の長期休業の期間を読み、減便の期間と重なるかを出す。
 *
 * 読み取りは決まった規則でコードが行う(AI には読ませない。数はコードが出す方針)。読めなければ決め打ちの窓
 * (FACILITY_WINDOWS)に戻し、窓ごとに出どころ(調べた結果 / 既定)を持つ。
 *
 * 時刻の読み方(readTimeRanges):
 * - 値を NFKC で直す(全角の数字・コロン・「～」(U+FF5E)は半角になる。「〜」(U+301C)は変わらないので、区切りに両方を入れる)
 * - 時刻は「8:00」「8時」「8時30分」「8時半」「正午」。「15分前」「2時間」「10月1日」は時刻としない
 * - 「午前」「午後」は、その時刻の前にある最も近いもの(同じ句の中。「。」「、」「,」「/」「(」「)」と改行で切る)を使う。
 *   午後で 12 時より前なら 12 時間を足す(「〔午後〕13：00」は 13 時のまま。「〔」「〕」では切らない)。
 *   句で切るのは、「月〜金 8:30〜11:30(午後は予約のみ)、土 8:30〜10:00」の括弧の中や前の句の「午後」を、後ろの句の時刻に
 *   かけないため。時刻の直前の「(午後)」「(午前)」は、括弧で切る前にその時刻の目印として読む。範囲の終わりの時刻に
 *   午前・午後が無ければ、範囲の始まりのものを引き継ぐ(「(午後)1:00〜3:00」「午後は1時から4時まで」「午前8時30分から11時」)
 * - 範囲は、2つの時刻の間が区切り(~ 〜 - ‐ − – — ー から より)だけのもの。「昼休み」「休憩」「休診」の直後の範囲は使わない
 * - 5〜22 時の外の時刻を含む範囲と、始まりが終わりより後(同じを含む)の範囲は読めないとして捨てる
 *
 * 病院・診療所(hospitalWindows):label に「受付|外来|診療」を含む事実(「時間外」「救急」「面会」を含むものは除く)を、
 * 「受付」を含むものを先に、あとは並びの順に見て、範囲を読めた最初の事実を使う。
 * - 受付開始 = 範囲の始まりの最も早い時刻(初診 8:00・再診 7:50 のように並んでいれば早いほう)。正午以降しか無ければ読めない
 * - 午前の受付終了 = 正午より前に始まり 13 時までに終わる範囲の終わりの最も遅い時刻。そういう範囲が無い
 *   (「午前8時30分から午後5時まで」のように1つの範囲が昼をまたぐ)ときは正午とする
 * - 最後の受付終了 = 範囲の終わりの最も遅い時刻
 * - 着く窓 = [受付開始 − 30分, 午前の受付終了)、出る窓 = [午前の受付終了, 最後の受付終了 + 120分)
 * - 根拠の文には範囲を MAX_BASIS_RANGES 件まで書き、残りは「ほか N 件」とする(窓の計算にはすべての範囲を使う)
 *
 * 学校(schoolWindows):label に「始業|終業|登校|下校」を含む事実から読む。「始業式」「終業式」は学校行事の日なので、
 * label でも値の語でも始業・終業として扱わない。
 * - 時刻の直前(同じ句の中)に「始業」「登校」があればその時刻を始業、「終業」「下校」があれば終業とする
 * - そういう時刻が無く範囲があれば、label に始業・登校があれば範囲の始まりを始業、終業・下校があれば範囲の終わりを終業とする
 * - 範囲も無く時刻が1つだけなら、label が始業・登校だけを含めば始業、終業・下校だけを含めば終業とする
 * - 着く窓 = [始業 − 60分, 始業)、出る窓 = [終業, 終業 + 120分)。始業と終業の片方だけ読めたら、もう片方の窓は既定のまま。
 *   両方読めて始業が終業より後(同じを含む)なら、どちらも読めないとする
 *
 * 窓はどれも開始を含み終わりを含まない(restore.ts の手がかりと同じ)。
 *
 * 長期休業(readLongBreaks・overlapLongBreaks):label に「休業|休暇|休み」を含む事実の値から
 * 「M月D日(曜日)からM月D日(曜日)まで」(「から」の代わりに区切りの記号も読む)を読む。片方の日付しか無いもの
 * (「8月18日まで(26日間)」など)は読まない。年は書いてあっても使わず、減便の期間から決める(12月〜1月をまたぐ休業は、
 * 終わりを翌年にする)。
 */

/** 手がかりに使う施設の種類。学校(高校・大学など)と、入院設備のある病院 */
export type FacilityHintKind = 'school' | 'hospital'

/** arrive は施設の最寄りの停留所に着く(降りる)、depart はそこから出る(乗る) */
export type FacilityTiming = 'arrive' | 'depart'

/** 学校・病院の時間帯の既定の窓(時。開始を含み終わりを含まない)。調べた結果から読めないときに使う */
export const FACILITY_WINDOWS: Record<FacilityHintKind, Record<FacilityTiming, readonly [number, number]>> = {
  school: { arrive: [7, 9], depart: [14, 18] },
  hospital: { arrive: [8, 11], depart: [11, 16] },
}

/** 窓を決めるのに使った事実(ラベル・値・出典の URL。出典が読めなければ null) */
export interface FactRef {
  label: string
  value: string
  url: string | null
}

/** 窓を決める材料の事実(url は無くてもよい) */
export interface FactLike {
  label: string
  value: string
  url?: string | null
}

/** 施設の1つの時間帯の窓 */
export interface FacilityWindow {
  /** 0時からの分。開始を含む */
  from: number
  /** 0時からの分。終わりを含まない */
  to: number
  /** research は調べた結果から読んだ窓、default は既定の窓(FACILITY_WINDOWS) */
  source: 'research' | 'default'
  /** research のとき、読んだ時刻(「外来の受付 8:00〜11:30・13:00〜15:15」「始業 8:40」)。理由の文に入れる */
  basis?: string
  /** research のとき、読んだ事実 */
  fact?: FactRef
}

export type FacilityWindows = Record<FacilityTiming, FacilityWindow>

/** 時刻の範囲(0時からの分) */
export interface TimeRange {
  from: number
  to: number
}

const EARLIEST = 5 * 60
const LATEST = 22 * 60
const NOON = 12 * 60
const MORNING_LIMIT = 13 * 60
/** 病院:受付開始の何分前から着く窓にするか */
const HOSPITAL_ARRIVE_BEFORE = 30
/**
 * 根拠の文(basis)に書く範囲の数の上限。窓の計算には読んだ範囲をすべて使い、文には始まりの早いものからこの数だけ書き、
 * 残りは「ほか N 件」とする(曜日ごとの表などで範囲が多いときに、理由の文と AI に渡す結果の1件が長くなりすぎないように)
 */
export const MAX_BASIS_RANGES = 4
/** 病院:最後の受付終了の何分後まで出る窓にするか */
const HOSPITAL_DEPART_AFTER = 120
/** 学校:始業の何分前から着く窓にするか */
const SCHOOL_ARRIVE_BEFORE = 60
/** 学校:終業の何分後まで出る窓にするか */
const SCHOOL_DEPART_AFTER = 120

const HOSPITAL_LABEL = /受付|外来|診療/
const HOSPITAL_LABEL_EXCLUDED = /時間外|救急|面会/
// 「始業式」「終業式」(学校行事の日と時刻)は毎日の始業・終業ではないので当てない
const SCHOOL_LABEL = /始業(?!式)|終業(?!式)|登校|下校/
const SCHOOL_START_WORD = /始業(?!式)|登校/
const SCHOOL_END_WORD = /終業(?!式)|下校/
const LONG_BREAK_LABEL = /休業|休暇|休み/

/** 分を 'H:MM' にする(理由の文に入れる。時は0で埋めない) */
export function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** 範囲を 'H:MM〜H:MM' にする */
function formatRange(r: TimeRange): string {
  return `${formatMinutes(r.from)}〜${formatMinutes(r.to)}`
}

/** 既定の窓(FACILITY_WINDOWS を分にしたもの) */
export function defaultFacilityWindows(kind: FacilityHintKind): FacilityWindows {
  const w = FACILITY_WINDOWS[kind]
  return {
    arrive: { from: w.arrive[0] * 60, to: w.arrive[1] * 60, source: 'default' },
    depart: { from: w.depart[0] * 60, to: w.depart[1] * 60, source: 'default' },
  }
}

// ---- 時刻の読み取り ----

/** 読んだ時刻の1つ(文の中の位置つき) */
interface TimeToken {
  minutes: number
  start: number
  end: number
  /** 読んだ午前・午後(無ければ undefined。正午は undefined) */
  meridiem: string | undefined
  /** 午前・午後を当てる前の時刻(0時からの分) */
  plain: number
}

/** 午前・午後を当てた時刻(0時からの分)。午後で 12 時より前なら 12 時間を足す */
function withMeridiem(plain: number, meridiem: string | undefined): number {
  return meridiem === '午後' && plain < 12 * 60 ? plain + 12 * 60 : plain
}

/** 時刻:「8:00」「8時」「8時30分」「8時半」「正午」。前に付いた午前・午後も含める */
const TIME = /(午前|午後)?\s*(?:(\d{1,2}):(\d{2})(?!\d)|(\d{1,2})時(?!間)(?:(\d{1,2})分|(半))?|(正午))/g
/** 午前・午後の目印(〔午前〕のような括弧の中も含む) */
const MERIDIEM = /午前|午後/g
/** 2つの時刻の間が区切りだけか */
const RANGE_SEPARATOR = /^\s*(?:~|〜|-|‐|−|–|—|ー|から|より)\s*$/
/** 範囲の直前にあれば、その範囲を使わない語(昼休み・休憩・休診の時間) */
const EXCLUDED_BEFORE = /(?:昼休み|昼休|休憩|休診)[\s:は]*$/

/** NFKC で直す(全角の数字・コロン・括弧・「～」を半角にする) */
function normalize(text: string): string {
  return text.normalize('NFKC')
}

/** 午前・午後の目印をさかのぼって探す範囲を切る文字(normalize 済みの text。全角の括弧・読点・斜線は半角になっている) */
const CLAUSE_BREAKS = ['。', '、', ',', '/', '(', ')', '\n']

/** 時刻の直前の、括弧で囲んだ午前・午後(「(午後)」。normalize 済みなので全角の括弧も半角) */
const ENCLOSED_MERIDIEM = /\((午前|午後)\)\s*$/

/** at の前の句の始まりの位置 */
function clauseStart(text: string, at: number): number {
  return Math.max(...CLAUSE_BREAKS.map((c) => text.lastIndexOf(c, at - 1))) + 1
}

/** 文の中の時刻を、前から順に読む(text は normalize 済み) */
function timeTokens(text: string): TimeToken[] {
  const out: TimeToken[] = []
  for (const m of text.matchAll(TIME)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    let hour: number
    let minute: number
    if (m[7] !== undefined) {
      hour = 12
      minute = 0
    } else if (m[2] !== undefined) {
      hour = Number(m[2])
      minute = Number(m[3])
    } else {
      hour = Number(m[4])
      minute = m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? 30 : 0
    }
    if (minute >= 60) continue
    // 午前・午後:時刻に付いていればそれ、無ければ同じ句の中の前にある最も近い目印
    let meridiem = m[1]
    if (meridiem === undefined && m[7] === undefined) {
      // 「(午後)1:00」のように括弧で囲んだ目印は、括弧で句を切る前に、時刻の直前にあるかを見る
      const enclosed = ENCLOSED_MERIDIEM.exec(text.slice(Math.max(0, start - 8), start))
      const before = enclosed ? enclosed[1] : text.slice(clauseStart(text, start), start)
      const marks = [...before.matchAll(MERIDIEM)]
      if (marks.length > 0) meridiem = marks[marks.length - 1][0]
    }
    const plain = hour * 60 + minute
    out.push({ minutes: withMeridiem(plain, meridiem), start, end, meridiem, plain })
  }
  return out
}

function inDay(minutes: number): boolean {
  return minutes >= EARLIEST && minutes <= LATEST
}

/** 範囲と、その範囲の始まりの時刻の前の文 */
interface FoundRange extends TimeRange {
  before: string
}

/** 文の中の時刻の範囲(normalize 済みの text)。5〜22 時の外と、始まりが終わり以後の範囲は捨てる */
function rangesIn(text: string, tokens: readonly TimeToken[]): FoundRange[] {
  const out: FoundRange[] = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]
    // 範囲の終わりに午前・午後が無ければ、始まりのものを引き継ぐ(「(午後)1:00〜3:00」は括弧で句を切るので、3:00 の
    // さかのぼりでは目印が見つからない)
    const next = tokens[i + 1]
    const b = next.meridiem === undefined && a.meridiem !== undefined ? { ...next, minutes: withMeridiem(next.plain, a.meridiem) } : next
    if (!RANGE_SEPARATOR.test(text.slice(a.end, b.start))) continue
    i++
    const before = text.slice(Math.max(0, a.start - 8), a.start)
    if (EXCLUDED_BEFORE.test(before)) continue
    if (!inDay(a.minutes) || !inDay(b.minutes) || a.minutes >= b.minutes) continue
    out.push({ from: a.minutes, to: b.minutes, before })
  }
  return out
}

/**
 * 文の中の時刻の範囲を読む(「8:00〜11:30」「8時30分から」「午前8時30分〜午後5時」「〔午前〕8：00～11：30」)。
 * 0時からの分で返す。読めなければ空
 */
export function readTimeRanges(value: string): TimeRange[] {
  const text = normalize(value)
  return rangesIn(text, timeTokens(text)).map(({ from, to }) => ({ from, to }))
}

// ---- 病院・診療所 ----

/** 病院の外来の受付時間(readHospitalHours の結果。0時からの分) */
export interface HospitalHours {
  /** 読んだ範囲(始まりの順) */
  ranges: TimeRange[]
  /** 受付開始 */
  open: number
  /** 午前の受付終了 */
  morningClose: number
  /** 最後の受付終了 */
  lastClose: number
}

/** 1つの値から外来の受付時間を読む。読めなければ null */
export function readHospitalHours(value: string): HospitalHours | null {
  const sorted = readTimeRanges(value).sort((a, b) => a.from - b.from || a.to - b.to)
  // 同じ範囲が2回書いてあれば1つにする(「午前8:30～12:00 … 午前8時30分から正午まで」)
  const ranges = sorted.filter((r, i) => i === 0 || r.from !== sorted[i - 1].from || r.to !== sorted[i - 1].to)
  if (ranges.length === 0) return null
  const open = ranges[0].from
  if (open >= NOON) return null
  const morning = ranges.filter((r) => r.from < NOON && r.to <= MORNING_LIMIT)
  const morningClose = morning.length > 0 ? Math.max(...morning.map((r) => r.to)) : NOON
  const lastClose = Math.max(...ranges.map((r) => r.to))
  return { ranges, open, morningClose, lastClose }
}

function factRef(f: FactLike): FactRef {
  return { label: f.label, value: f.value, url: f.url ?? null }
}

/** 病院・診療所の窓。調べた事実から読めなければ既定(病院の FACILITY_WINDOWS) */
export function hospitalWindows(facts: readonly FactLike[]): FacilityWindows {
  const candidates = facts.filter((f) => HOSPITAL_LABEL.test(f.label) && !HOSPITAL_LABEL_EXCLUDED.test(f.label))
  // 「受付」のラベルを先に(診療日・休診日などより、受付時間を優先する)。同じなら並びの順
  const ordered = [...candidates.filter((f) => f.label.includes('受付')), ...candidates.filter((f) => !f.label.includes('受付'))]
  for (const f of ordered) {
    const hours = readHospitalHours(f.value)
    if (!hours) continue
    const shown = hours.ranges.slice(0, MAX_BASIS_RANGES).map(formatRange).join('・')
    const rest = hours.ranges.length - MAX_BASIS_RANGES
    const basis = `外来の${f.label.includes('受付') ? '受付' : '診療時間'} ${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}`
    const fact = factRef(f)
    return {
      arrive: { from: hours.open - HOSPITAL_ARRIVE_BEFORE, to: hours.morningClose, source: 'research', basis, fact },
      depart: { from: hours.morningClose, to: Math.min(hours.lastClose + HOSPITAL_DEPART_AFTER, 24 * 60), source: 'research', basis, fact },
    }
  }
  return defaultFacilityWindows('hospital')
}

// ---- 学校 ----

/** 学校の始業・終業(readSchoolTimes の結果。0時からの分。読めなかったほうは null) */
export interface SchoolTimes {
  start: { minutes: number; fact: FactRef } | null
  end: { minutes: number; fact: FactRef } | null
}

/** 時刻の直前(同じ句の中)にある語 */
function wordBefore(text: string, token: TimeToken): string {
  const head = text.slice(0, token.start)
  const cut = Math.max(head.lastIndexOf('、'), head.lastIndexOf('。'), head.lastIndexOf(','), head.lastIndexOf('\n'))
  return head.slice(cut + 1)
}

/** 語(正規表現)が最後に出てくる位置。無ければ -1 */
function lastIndexOfWord(text: string, word: RegExp): number {
  let at = -1
  for (const m of text.matchAll(new RegExp(word.source, 'g'))) at = m.index ?? at
  return at
}

/** 学校の始業・終業の時刻を、label に「始業|終業|登校|下校」を含む事実から読む */
export function readSchoolTimes(facts: readonly FactLike[]): SchoolTimes {
  let start: SchoolTimes['start'] = null
  let end: SchoolTimes['end'] = null
  for (const f of facts) {
    if (!SCHOOL_LABEL.test(f.label)) continue
    const text = normalize(f.value)
    const tokens = timeTokens(text).filter((t) => inDay(t.minutes))
    const ref = factRef(f)
    let found = false
    // 1. 直前に始業・終業などの語がある時刻
    for (const t of tokens) {
      const before = wordBefore(text, t)
      // 同じ句に両方の語があるときは、時刻に近いほうの語(後に出てきたほう)で決める
      const startAt = lastIndexOfWord(before, SCHOOL_START_WORD)
      const endAt = lastIndexOfWord(before, SCHOOL_END_WORD)
      if (startAt < 0 && endAt < 0) continue
      const isStart = startAt > endAt
      const isEnd = !isStart
      found = true
      if (isStart && start === null) start = { minutes: t.minutes, fact: ref }
      if (isEnd && end === null) end = { minutes: t.minutes, fact: ref }
    }
    if (found) continue
    const labelStart = SCHOOL_START_WORD.test(f.label)
    const labelEnd = SCHOOL_END_WORD.test(f.label)
    // 2. 範囲(始まりを始業、終わりを終業)
    const ranges = rangesIn(text, timeTokens(text))
    if (ranges.length > 0) {
      if (labelStart && start === null) start = { minutes: ranges[0].from, fact: ref }
      if (labelEnd && end === null) end = { minutes: ranges[0].to, fact: ref }
      continue
    }
    // 3. 時刻が1つだけで、label が片方だけを指すとき
    if (tokens.length === 1 && labelStart !== labelEnd) {
      if (labelStart && start === null) start = { minutes: tokens[0].minutes, fact: ref }
      if (labelEnd && end === null) end = { minutes: tokens[0].minutes, fact: ref }
    }
  }
  if (start && end && start.minutes >= end.minutes) return { start: null, end: null }
  return { start, end }
}

/** 学校の窓。始業・終業のうち読めたほうだけ調べた結果の窓にし、読めないほうは既定(学校の FACILITY_WINDOWS) */
export function schoolWindows(facts: readonly FactLike[]): FacilityWindows {
  const out = defaultFacilityWindows('school')
  const { start, end } = readSchoolTimes(facts)
  if (start) {
    out.arrive = { from: start.minutes - SCHOOL_ARRIVE_BEFORE, to: start.minutes, source: 'research', basis: `始業 ${formatMinutes(start.minutes)}`, fact: start.fact }
  }
  if (end) {
    out.depart = {
      from: end.minutes,
      to: Math.min(end.minutes + SCHOOL_DEPART_AFTER, 24 * 60),
      source: 'research',
      basis: `終業 ${formatMinutes(end.minutes)}`,
      fact: end.fact,
    }
  }
  return out
}

/**
 * 施設の窓。学校は schoolWindows、病院・診療所は hospitalWindows。facts は調べた事実(調べていなければ空。
 * 事実は先頭の数件に絞らず、全部を渡す)
 */
export function facilityWindows(kind: FacilityHintKind | 'clinic', facts: readonly FactLike[]): FacilityWindows {
  return kind === 'school' ? schoolWindows(facts) : hospitalWindows(facts)
}

// ---- 長期休業 ----

/** 読んだ長期休業の1つ(年は持たない) */
export interface LongBreak {
  /** label から括弧の中を除いたもの(「夏季休業」など) */
  name: string
  start: { month: number; day: number }
  end: { month: number; day: number }
  /** 'M月D日〜M月D日' */
  text: string
  fact: FactRef
}

/** 減便の期間と重なる長期休業 */
export interface LongBreakOverlap extends LongBreak {
  /** 年を決めた休業の期間('YYYYMMDD') */
  from: string
  to: string
  /** 減便の期間と重なる部分('YYYYMMDD') */
  overlapFrom: string
  overlapTo: string
}

/** 「M月D日(曜日)からM月D日(曜日)まで」。間に年(令和8年・2026年)があってもよい */
const DATE_RANGE =
  /(\d{1,2})月(\d{1,2})日\s*(?:\([^)]*\))?\s*(?:から|~|〜|-|‐|−|–|—|より)\s*(?:(?:令和|平成)?\d{1,4}年)?(\d{1,2})月(\d{1,2})日/g

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** 長期休業の事実(label に「休業|休暇|休み」)から、休業の期間を読む。読めなければ空 */
export function readLongBreaks(facts: readonly FactLike[]): LongBreak[] {
  const out: LongBreak[] = []
  for (const f of facts) {
    if (!LONG_BREAK_LABEL.test(f.label)) continue
    const text = normalize(f.value)
    const name = normalize(f.label).replace(/\([^)]*\)/g, '').trim()
    for (const m of text.matchAll(DATE_RANGE)) {
      const start = { month: Number(m[1]), day: Number(m[2]) }
      const end = { month: Number(m[3]), day: Number(m[4]) }
      if (!validMonthDay(start.month, start.day) || !validMonthDay(end.month, end.day)) continue
      out.push({ name, start, end, text: `${start.month}月${start.day}日〜${end.month}月${end.day}日`, fact: factRef(f) })
    }
  }
  return out
}

/** 'YYYYMMDD' を UTC の日の番号にする。日付として正しくなければ null */
function dayNumber(year: number, month: number, day: number): number | null {
  const t = Date.UTC(year, month - 1, day)
  const d = new Date(t)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return t / 86_400_000
}

function parseYmd(s: string): number | null {
  if (!/^\d{8}$/.test(s)) return null
  return dayNumber(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)))
}

function ymdOf(dayNo: number): string {
  const d = new Date(dayNo * 86_400_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 減便の期間('YYYYMMDD' の範囲。両端を含む)と重なる長期休業。年は減便の期間から決める:期間の始まりの前の年から
 * 終わりの年までの各年を休業の始まりの年として当て、終わりが始まりより前の月日なら終わりを翌年にする(12月〜1月の休業)。
 * end が null(当面の間)のときは、始まりから1年(始まりの翌年の前日まで)を期間とする(呼ぶ側で出力の有効期間の末日を
 * 渡せるなら、そちらを渡す)。期間が読めなければ空
 */
export function overlapLongBreaks(breaks: readonly LongBreak[], period: { start: string; end: string | null }): LongBreakOverlap[] {
  const ps = parseYmd(period.start)
  if (ps === null) return []
  let pe: number | null
  if (period.end === null) {
    const y = Number(period.start.slice(0, 4))
    const next = dayNumber(y + 1, Number(period.start.slice(4, 6)), Number(period.start.slice(6, 8))) ?? dayNumber(y + 1, 3, 1)
    pe = next === null ? null : next - 1
  } else {
    pe = parseYmd(period.end)
  }
  if (pe === null || pe < ps) return []
  const firstYear = Number(ymdOf(ps).slice(0, 4)) - 1
  const lastYear = Number(ymdOf(pe).slice(0, 4))
  const out: LongBreakOverlap[] = []
  const seen = new Set<string>()
  for (const b of breaks) {
    const crosses = b.end.month < b.start.month || (b.end.month === b.start.month && b.end.day < b.start.day)
    for (let y = firstYear; y <= lastYear; y++) {
      const bs = dayNumber(y, b.start.month, b.start.day)
      const be = dayNumber(crosses ? y + 1 : y, b.end.month, b.end.day)
      if (bs === null || be === null) continue
      const from = Math.max(bs, ps)
      const to = Math.min(be, pe)
      if (from > to) continue
      const key = `${b.name}\t${bs}\t${be}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...b, from: ymdOf(bs), to: ymdOf(be), overlapFrom: ymdOf(from), overlapTo: ymdOf(to) })
    }
  }
  return out
}

/** 長期休業の事実から休業の期間を読み、減便の期間と重なるものを返す(readLongBreaks と overlapLongBreaks を続けて呼ぶ) */
export function longBreakOverlaps(facts: readonly FactLike[], period: { start: string; end: string | null }): LongBreakOverlap[] {
  return overlapLongBreaks(readLongBreaks(facts), period)
}
