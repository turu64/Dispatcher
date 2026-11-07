import { describe, expect, it } from 'vitest'
import {
  defaultFacilityWindows,
  facilityWindows,
  FACILITY_WINDOWS,
  hospitalWindows,
  longBreakOverlaps,
  MAX_BASIS_RANGES,
  readHospitalHours,
  readLongBreaks,
  readSchoolTimes,
  readTimeRanges,
  schoolWindows,
  type FacilityWindow,
  type FactLike,
} from './facilityHours'

// 調べた事実から学校・病院の時間帯の窓を決め、長期休業を読む(docs/tasks-1103b.md の T27)。
// フィクスチャの文は data/demo/research_dohoku.json(2026-11-03 のデモ用の保存済みの結果)の事実を写したもの

const h = (hh: number, mm = 0) => hh * 60 + mm

/** 窓の範囲と出どころだけ */
function span(w: FacilityWindow): [number, number, string] {
  return [w.from, w.to, w.source]
}

// ---- data/demo/research_dohoku.json から写した事実 ----

const NAYORO: FactLike[] = [
  { label: '外来受付時間', value: '〔午前〕8：00～11：30 〔午後〕13：00～15：15（公式ページ記載。診療可能日は診療科によって異なる）', url: 'https://example.jp/nayoro' },
  { label: '外来診療一覧', value: '科ごとに曜日と午前・午後の診療可否が示されている（令和8年7月1日更新）。例：内科系は平日の午前が中心、小児科は平日午前・午後' },
  { label: '予約センター', value: '直通電話 平日13：30～17：00。午前中は混雑するため午後の電話を案内' },
  { label: '休診日', value: '土曜・日曜・祝日は休診（旧版の受付案内PDF・第三者サイトの記載。最新の公式記載は未確認）' },
]

const SHIRITSU_ASAHIKAWA: FactLike[] = [
  { label: '診療日・休診日', value: '診療日は月曜日から金曜日まで。休診日は土曜日、日曜日、国民の祝日、年末年始(最終更新日 2026年9月1日)' },
  { label: '外来の受付時間', value: '各科診療時間は午前8時30分から午後5時まで(外来医師担当表、最終更新日 2026年10月1日)' },
  { label: '受付時間の補足', value: '診療受付時間のうち9時から11時まで正面入り口付近に看護師を配置し、受診目的などを聞いて受診科を案内' },
]

const SEKIJUJI: FactLike[] = [
  { label: '休診日', value: '土・日・祝日、5月1日、12月29日～1月3日(公式ページ)' },
  { label: '一般外来受付時間', value: '初診は8：00～11：30、再診は7：50～11：00、午後は13時30分～15時(公式ページ、年度表示なし)' },
]

const IDAI: FactLike[] = [
  {
    label: '外来の受付時間',
    value: '平日 午前8:30～12:00（公式トップページ）。外来担当医表では新・再来とも午前8時30分から正午まで、午後の受付・診療は予約患者が対象',
  },
  { label: '診療時間の変更(2024.12)', value: '令和6年12月1日から診療時間 8時40分～17時05分（受付開始8時30分は変更なし）。それ以前は8時30分～17時15分' },
  { label: '時間外・救急受付', value: '時間外受付・救急受付は0166-66-9901（事前に電話連絡が必要とされる記載あり）' },
]

const KOSEI: FactLike[] = [
  { label: '外来受付時間', value: '午前 8時00分～11時30分（予約優先制）。来院予定時間の15分前を目途に来院(公式、最終更新2024年10月8日)' },
]

/** 診療所(三上神経科内科クリニック):区切りが「▼」で、範囲として読めるのは昼休みだけ */
const MIKAMI: FactLike[] = [
  {
    label: '診療時間',
    value:
      '月 09:00▼16:30、火 09:00▼16:30、水 09:00▼18:30、木 09:00▼12:00、金 09:00▼16:30、土 09:00▼12:00。受付終了は30分前。月・火・金は昼休み12:30～13:30、水曜は昼休み12:30～15:00(旭川市医師会ページ、掲載時点不明)',
  },
]

/** 診療所(あけ美肌クリニック):昼休みの範囲は使わない */
const AKE: FactLike[] = [
  { label: '外来の受付時間(公式)', value: '月・水～土 10:00～18:00(昼休み 13:00～14:00)。フッターでは受付時間 10:00～12:30、14:00～18:00' },
]

/** 診療所(くまいクリニック):区切りが「-」 */
const KUMAI: FactLike[] = [
  { label: '外来受付時間(公式)', value: '9:00-13:00 / 14:00-16:30 / 16:30-19:00 の表。月・水・木・金・土に受付(16:30-19:00は月・水・金のみ)。火・日・祝日は休み。' },
]

const KAGURA_JUNIOR: FactLike[] = [
  { label: '夏季休業(市立中学校共通)', value: '令和8年度 7月24日(金曜日)から8月24日(月曜日)まで。最終更新日2026年4月1日', url: 'https://example.jp/kagura' },
  { label: '冬季休業(市立中学校共通)', value: '令和8年度 12月25日(金曜日)から1月12日(火曜日)まで', url: 'https://example.jp/kagura' },
  { label: 'その他の休業日', value: '市立中学校の休業日等予定表はPDFで掲載。このページの本文からは内容未確認' },
]

const MIDORIGAOKA_JUNIOR: FactLike[] = [
  { label: '夏季休業日(令和8年度)', value: '7月24日(金曜日)から8月24日(月曜日)まで。旭川市立小中学校の共通予定として掲載。最終更新日 2026年4月1日' },
  { label: '冬季休業日(令和8年度)', value: '12月25日(金曜日)から1月12日(火曜日)まで。同ページの市立小中学校共通の予定' },
  { label: '始業・終業時刻', value: '学校ホームページでは確認できず(見つからなかった)' },
]

const NAGAMINE_HIGH: FactLike[] = [
  { label: '課業日の時間(公式アクセスページ記載)', value: '平日8:15～16:45（土曜、日曜、祝日、学校閉庁日を除く）。始業・終業の正式な時刻表記ではなく『課業日』の表記' },
]

const NAYORO_HIGH: FactLike[] = [
  { label: '学校の電話対応時間', value: '8時30分より16時45分まで(職員室直通 01654-3-6842)' },
  { label: '始業終業・授業日・長期休業・生徒数', value: '公式アクセスページ・市の時刻表では見つからなかった' },
]

const SHIHO_HIGH: FactLike[] = [
  { label: 'スクールバス始発時刻(路線図の表記)', value: '東川・豊岡線 7:25、忠和・緑が丘線 7:20、春光台・末広線 7:15、旭川駅・新富線 7:45' },
]

const BIYO: FactLike[] = [
  { label: '2026年度の休業（夏）', value: '「夏季休暇　8月18日まで(26日間)」と年間行事予定表に記載（作成日2026(R8).03.27）。開始日は読み取れず' },
  { label: '2026年度の休業（冬）', value: '「冬季休暇 1月12日まで (19日間）」と年間行事予定表に記載（作成日2026(R8).03.27）。開始日は読み取れず' },
]

const KOGYO_HIGH: FactLike[] = [
  { label: '始業・終業時刻', value: '公式ページで確認できず(全日制の公開ページ・年間行事の確認範囲では時刻表記なし)' },
  { label: '外来受付時間・休業日', value: '該当なし(高校のため外来なし)。定時制の夏季休業について、定時制ページで『夏季休業は８月23日（日）までとなっています』との記載あり(定時制の記事)' },
]

describe('時刻の範囲の読み取り(readTimeRanges)', () => {
  it('全角の数字・コロン・「～」と、午前・午後の目印(〔午後〕13：00 は 13 時のまま)を読む', () => {
    expect(readTimeRanges(NAYORO[0].value)).toEqual([
      { from: h(8), to: h(11, 30) },
      { from: h(13), to: h(15, 15) },
    ])
  })

  it('「午前8時30分から午後5時まで」「13時30分～15時」「8時半〜正午」「8:00〜11:30」(U+301C)を読む', () => {
    expect(readTimeRanges(SHIRITSU_ASAHIKAWA[1].value)).toEqual([{ from: h(8, 30), to: h(17) }])
    expect(readTimeRanges('午後は13時30分～15時')).toEqual([{ from: h(13, 30), to: h(15) }])
    expect(readTimeRanges('8時半〜正午')).toEqual([{ from: h(8, 30), to: h(12) }])
    expect(readTimeRanges('8:00〜11:30')).toEqual([{ from: h(8), to: h(11, 30) }])
    expect(readTimeRanges('8:00 - 11:30')).toEqual([{ from: h(8), to: h(11, 30) }])
    // 午後の目印は、時刻の前の同じ句の中の最も近いもの。範囲の終わりは始まりの午前・午後を引き継ぐ
    expect(readTimeRanges('午後1時～3時')).toEqual([{ from: h(13), to: h(15) }])
    expect(readTimeRanges('午後は1時から4時まで')).toEqual([{ from: h(13), to: h(16) }])
    expect(readTimeRanges('午前8時30分から11時')).toEqual([{ from: h(8, 30), to: h(11) }])
  })

  it('午前・午後の目印は句(「、」「,」「/」「(」「)」「。」と改行)を越えて後ろの時刻にかけない。「〔」「〕」では切らない', () => {
    // 括弧の中の「午後は予約のみ」を、後ろの句の土曜の時刻にかけない
    expect(readTimeRanges('月〜金 8:30〜11:30(午後は予約のみ)、土 8:30〜10:00')).toEqual([
      { from: h(8, 30), to: h(11, 30) },
      { from: h(8, 30), to: h(10) },
    ])
    // 前の句の「午後は」を、括弧の中の土曜の時刻にかけない
    expect(readTimeRanges('午前8:30〜11:00、午後は13:00〜16:00(土曜は8:30〜10:00)')).toEqual([
      { from: h(8, 30), to: h(11) },
      { from: h(13), to: h(16) },
      { from: h(8, 30), to: h(10) },
    ])
    // 斜線で区切った表。土曜を 21:00〜22:30 と読まない
    expect(readTimeRanges('平日 8:30〜11:00 / 午後 13:00〜16:00 / 土曜 9:00〜10:30')).toEqual([
      { from: h(8, 30), to: h(11) },
      { from: h(13), to: h(16) },
      { from: h(9), to: h(10, 30) },
    ])
    // 全角の括弧・読点・斜線も同じ(NFKC で半角になる)
    expect(readTimeRanges('平日 ８：３０～１１：００（午後は予約）、土 ８：３０～１０：００')).toEqual([
      { from: h(8, 30), to: h(11) },
      { from: h(8, 30), to: h(10) },
    ])
    // 〔午後〕は句の切れ目にしない(後ろの時刻にかかる)
    expect(readTimeRanges('〔午後〕1：00～3：00')).toEqual([{ from: h(13), to: h(15) }])
    // 時刻の直前の括弧で囲んだ目印は、その時刻にかける(括弧で切らない)。後ろの句にはかけない
    expect(readTimeRanges('(午前)8:30〜11:00 (午後)1:00〜3:00')).toEqual([
      { from: h(8, 30), to: h(11) },
      { from: h(13), to: h(15) },
    ])
    expect(readTimeRanges('（午後）１：００～３：００、土 9:00〜10:00')).toEqual([
      { from: h(13), to: h(15) },
      { from: h(9), to: h(10) },
    ])
  })

  it('「15分前」「2時間」「10月8日」は時刻にしない。昼休み・休診の範囲と「▼」の区切りは読まない', () => {
    expect(readTimeRanges(KOSEI[0].value)).toEqual([{ from: h(8), to: h(11, 30) }])
    expect(readTimeRanges('1日2時間から3時間')).toEqual([])
    expect(readTimeRanges(MIKAMI[0].value)).toEqual([])
    expect(readTimeRanges(AKE[0].value)).toEqual([
      { from: h(10), to: h(18) },
      { from: h(10), to: h(12, 30) },
      { from: h(14), to: h(18) },
    ])
  })

  it('5〜22 時の外の時刻を含む範囲と、始まりが終わり以後の範囲は捨てる', () => {
    expect(readTimeRanges('4:30〜11:00')).toEqual([])
    expect(readTimeRanges('17:00〜23:00')).toEqual([])
    expect(readTimeRanges('11:30〜8:00')).toEqual([])
    expect(readTimeRanges('8:00〜8:00')).toEqual([])
    expect(readTimeRanges('5:00〜22:00')).toEqual([{ from: h(5), to: h(22) }])
  })
})

describe('病院・診療所の窓(hospitalWindows)', () => {
  it('名寄市立総合病院:受付 8:00〜11:30・13:00〜15:15 → 着く 7:30〜11:30、出る 11:30〜17:15', () => {
    const w = hospitalWindows(NAYORO)
    expect(span(w.arrive)).toEqual([h(7, 30), h(11, 30), 'research'])
    expect(span(w.depart)).toEqual([h(11, 30), h(17, 15), 'research'])
    expect(w.arrive.basis).toBe('外来の受付 8:00〜11:30・13:00〜15:15')
    expect(w.arrive.fact).toEqual({ label: '外来受付時間', value: NAYORO[0].value, url: 'https://example.jp/nayoro' })
    expect(w.depart.fact).toEqual(w.arrive.fact)
  })

  it('旭川赤十字病院:初診 8:00・再診 7:50 は早いほうを受付開始にし、午前の受付終了は遅いほう(11:30)', () => {
    const hours = readHospitalHours(SEKIJUJI[1].value)!
    expect(hours).toMatchObject({ open: h(7, 50), morningClose: h(11, 30), lastClose: h(15) })
    const w = hospitalWindows(SEKIJUJI)
    expect(span(w.arrive)).toEqual([h(7, 20), h(11, 30), 'research'])
    expect(span(w.depart)).toEqual([h(11, 30), h(17), 'research'])
    // 「休診日」の 12月29日～1月3日 は時刻ではない
    expect(w.arrive.fact?.label).toBe('一般外来受付時間')
  })

  it('市立旭川病院:時刻の無い「診療日・休診日」を飛ばし、昼をまたぐ 8:30〜17:00 は正午で午前と午後に分ける', () => {
    const w = hospitalWindows(SHIRITSU_ASAHIKAWA)
    expect(span(w.arrive)).toEqual([h(8), h(12), 'research'])
    expect(span(w.depart)).toEqual([h(12), h(19), 'research'])
    expect(w.arrive.basis).toBe('外来の受付 8:30〜17:00')
    expect(w.arrive.fact?.label).toBe('外来の受付時間')
  })

  it('旭川医科大学病院:同じ範囲が2回書いてあっても1つ。「受付」のラベルを「診療時間の変更」より先に使い、時間外受付は使わない', () => {
    const w = hospitalWindows(IDAI)
    expect(span(w.arrive)).toEqual([h(8), h(12), 'research'])
    expect(span(w.depart)).toEqual([h(12), h(14), 'research'])
    expect(w.arrive.basis).toBe('外来の受付 8:30〜12:00')
    // 受付のラベルが無ければ、診療のラベルの事実を使う(言い方は「診療時間」)
    const onlyChange = hospitalWindows([IDAI[1], IDAI[2]])
    // 「受付開始8時30分」は範囲ではないので読まない。範囲は始まりの順
    expect(onlyChange.arrive.basis).toBe('外来の診療時間 8:30〜17:15・8:40〜17:05')
    expect(span(onlyChange.arrive)).toEqual([h(8), h(12), 'research'])
  })

  it('括弧の中や前の句の「午後」を土曜の受付にかけず、出る窓は最後の受付終了 + 120 分まで', () => {
    const sat = hospitalWindows([{ label: '外来受付時間', value: '月〜金 8:30〜11:30(午後は予約のみ)、土 8:30〜10:00' }])
    expect(span(sat.arrive)).toEqual([h(8), h(11, 30), 'research'])
    expect(span(sat.depart)).toEqual([h(11, 30), h(13, 30), 'research'])
    expect(sat.arrive.basis).toBe('外来の受付 8:30〜10:00・8:30〜11:30')
    const paren = hospitalWindows([{ label: '外来受付時間', value: '午前8:30〜11:00、午後は13:00〜16:00(土曜は8:30〜10:00)' }])
    expect(span(paren.arrive)).toEqual([h(8), h(11), 'research'])
    expect(span(paren.depart)).toEqual([h(11), h(18), 'research'])
    expect(paren.arrive.basis).toBe('外来の受付 8:30〜10:00・8:30〜11:00・13:00〜16:00')
  })

  it('根拠の文に書く範囲は MAX_BASIS_RANGES 件までで、残りは「ほか N 件」。窓の計算にはすべての範囲を使う', () => {
    const value = '月 8:30〜11:00、火 8:40〜11:10、水 8:50〜11:20、木 9:00〜11:30、金 9:10〜11:40、土 9:20〜16:00'
    const w = hospitalWindows([{ label: '外来受付時間', value }])
    expect(MAX_BASIS_RANGES).toBe(4)
    expect(w.arrive.basis).toBe('外来の受付 8:30〜11:00・8:40〜11:10・8:50〜11:20・9:00〜11:30 ほか 2 件')
    // 最後の受付終了は書いていない土曜の 16:00 から決まる
    expect(span(w.depart)).toEqual([h(11, 40), h(18), 'research'])
  })

  it('旭川厚生病院:「午前 8時00分～11時30分」を読み、「15分前」は読まない', () => {
    const w = hospitalWindows(KOSEI)
    expect(span(w.arrive)).toEqual([h(7, 30), h(11, 30), 'research'])
    expect(span(w.depart)).toEqual([h(11, 30), h(13, 30), 'research'])
  })

  it('診療所:昼休みを除き、区切りが「-」の表も読む。範囲が読めなければ既定に戻る', () => {
    expect(span(hospitalWindows(AKE).arrive)).toEqual([h(9, 30), h(12, 30), 'research'])
    expect(span(hospitalWindows(AKE).depart)).toEqual([h(12, 30), h(20), 'research'])
    expect(span(hospitalWindows(KUMAI).arrive)).toEqual([h(8, 30), h(13), 'research'])
    expect(span(hospitalWindows(KUMAI).depart)).toEqual([h(13), h(21), 'research'])
    expect(hospitalWindows(MIKAMI)).toEqual(defaultFacilityWindows('hospital'))
  })

  it('調べていない・該当のラベルが無い・正午より後の受付しか無いときは既定(8〜11時着・11〜16時発)', () => {
    const def = defaultFacilityWindows('hospital')
    expect(span(def.arrive)).toEqual([h(8), h(11), 'default'])
    expect(span(def.depart)).toEqual([h(11), h(16), 'default'])
    expect(def.arrive.basis).toBeUndefined()
    expect(hospitalWindows([])).toEqual(def)
    expect(hospitalWindows([{ label: '病床数', value: '8:00〜11:30' }])).toEqual(def)
    expect(hospitalWindows([{ label: '面会の受付', value: '13:00〜19:00' }])).toEqual(def)
    expect(hospitalWindows([{ label: '外来受付時間', value: '午後 13:00〜15:00' }])).toEqual(def)
    expect(facilityWindows('clinic', [])).toEqual(def)
  })
})

describe('学校の窓(schoolWindows)', () => {
  it('始業・終業の語の後の時刻を読む:着く = [始業 − 60分, 始業)、出る = [終業, 終業 + 120分)', () => {
    const facts = [{ label: '始業・終業時刻', value: '始業 8:30、終業 15:20(日課表)', url: 'https://example.jp/s' }]
    const w = schoolWindows(facts)
    expect(span(w.arrive)).toEqual([h(7, 30), h(8, 30), 'research'])
    expect(span(w.depart)).toEqual([h(15, 20), h(17, 20), 'research'])
    expect(w.arrive.basis).toBe('始業 8:30')
    expect(w.depart.basis).toBe('終業 15:20')
    expect(w.arrive.fact).toEqual({ label: '始業・終業時刻', value: '始業 8:30、終業 15:20(日課表)', url: 'https://example.jp/s' })
  })

  it('語が無ければ、範囲の始まりを始業・終わりを終業(ラベルが両方を指すとき)。時刻が1つならラベルの指すほう', () => {
    expect(readSchoolTimes([{ label: '始業・終業時刻', value: '8時40分〜15時30分' }])).toMatchObject({ start: { minutes: h(8, 40) }, end: { minutes: h(15, 30) } })
    const t = readSchoolTimes([
      { label: '始業', value: '8時40分' },
      { label: '下校', value: '15時30分' },
    ])
    expect([t.start?.minutes, t.end?.minutes]).toEqual([h(8, 40), h(15, 30)])
    // 「登校 8:10 / 下校 16:00」の両方の語が同じ句にあれば、時刻に近い語で決める
    const both = readSchoolTimes([{ label: '登校・下校', value: '登校 8:10 / 下校 16:00' }])
    expect([both.start?.minutes, both.end?.minutes]).toEqual([h(8, 10), h(16)])
  })

  it('「始業式」「終業式」は学校行事なので、毎日の始業・終業として読まず、既定に戻る', () => {
    const facts = [{ label: '始業式・終業式', value: '始業式 4月7日 9時から、終業式 3月24日 10時30分から' }]
    expect(readSchoolTimes(facts)).toEqual({ start: null, end: null })
    expect(schoolWindows(facts)).toEqual(defaultFacilityWindows('school'))
    // ラベルが始業・終業でも、値の「始業式」「終業式」の後の時刻は始業・終業にしない
    const mixed = readSchoolTimes([{ label: '始業・終業時刻', value: '始業式 9時30分、始業 8時40分、終業 15時20分' }])
    expect([mixed.start?.minutes, mixed.end?.minutes]).toEqual([h(8, 40), h(15, 20)])
  })

  it('始業だけ読めたら、出る時間帯は既定(14〜18時発)のまま', () => {
    const w = schoolWindows([{ label: '始業', value: '8時40分' }])
    expect(span(w.arrive)).toEqual([h(7, 40), h(8, 40), 'research'])
    expect(span(w.depart)).toEqual([h(14), h(18), 'default'])
  })

  it('デモの学校:「見つからず」の文・ラベルが始業・終業でない事実(課業日・電話対応・スクールバスの始発)は読まず、既定に戻る', () => {
    const def = defaultFacilityWindows('school')
    expect(span(def.arrive)).toEqual([h(7), h(9), 'default'])
    for (const facts of [MIDORIGAOKA_JUNIOR, NAGAMINE_HIGH, NAYORO_HIGH, SHIHO_HIGH, KOGYO_HIGH, []]) {
      expect(schoolWindows(facts)).toEqual(def)
    }
  })

  it('始業が終業以後なら、どちらも読めないとする。5〜22 時の外の時刻は読まない', () => {
    expect(schoolWindows([{ label: '始業・終業', value: '始業 16:00、終業 8:00' }])).toEqual(defaultFacilityWindows('school'))
    expect(schoolWindows([{ label: '始業', value: '4時30分' }])).toEqual(defaultFacilityWindows('school'))
    expect(facilityWindows('school', [{ label: '始業', value: '8時40分' }]).arrive.source).toBe('research')
  })

  it('既定の窓は FACILITY_WINDOWS を分にしたもの', () => {
    for (const kind of ['school', 'hospital'] as const) {
      const w = defaultFacilityWindows(kind)
      expect([w.arrive.from, w.arrive.to]).toEqual(FACILITY_WINDOWS[kind].arrive.map((x) => x * 60))
      expect([w.depart.from, w.depart.to]).toEqual(FACILITY_WINDOWS[kind].depart.map((x) => x * 60))
    }
  })
})

describe('長期休業(readLongBreaks・longBreakOverlaps)', () => {
  it('神楽中学校:「7月24日(金曜日)から8月24日(月曜日)まで」「12月25日(金曜日)から1月12日(火曜日)まで」を読む。日付の無い休業日は読まない', () => {
    const breaks = readLongBreaks(KAGURA_JUNIOR)
    expect(breaks.map((b) => [b.name, b.text])).toEqual([
      ['夏季休業', '7月24日〜8月24日'],
      ['冬季休業', '12月25日〜1月12日'],
    ])
    expect(breaks[0].fact).toEqual({ label: KAGURA_JUNIOR[0].label, value: KAGURA_JUNIOR[0].value, url: 'https://example.jp/kagura' })
    expect(readLongBreaks(MIDORIGAOKA_JUNIOR).map((b) => [b.name, b.text])).toEqual([
      ['夏季休業日', '7月24日〜8月24日'],
      ['冬季休業日', '12月25日〜1月12日'],
    ])
  })

  it('始まりの無い「8月18日まで(26日間)」「8月23日(日)まで」は読まない。休診日(病院)のラベルも読まない', () => {
    expect(readLongBreaks(BIYO)).toEqual([])
    expect(readLongBreaks(KOGYO_HIGH)).toEqual([])
    expect(readLongBreaks(SEKIJUJI)).toEqual([])
  })

  it('減便の期間と重なる休業を、年を決めて返す(12月〜1月は終わりを翌年に)', () => {
    const got = longBreakOverlaps(KAGURA_JUNIOR, { start: '20261110', end: '20270331' })
    expect(got.map((b) => [b.name, b.from, b.to, b.overlapFrom, b.overlapTo])).toEqual([['冬季休業', '20261225', '20270112', '20261225', '20270112']])
    // 期間が休業の途中で始まる・終わるときは、重なる部分を overlapFrom・overlapTo に
    const part = longBreakOverlaps(KAGURA_JUNIOR, { start: '20270105', end: '20270801' })
    expect(part.map((b) => [b.name, b.from, b.to, b.overlapFrom, b.overlapTo])).toEqual([
      ['夏季休業', '20270724', '20270824', '20270724', '20270801'],
      ['冬季休業', '20261225', '20270112', '20270105', '20270112'],
    ])
  })

  it('重ならなければ空。当面の間(end が null)は始まりから1年', () => {
    expect(longBreakOverlaps(KAGURA_JUNIOR, { start: '20261110', end: '20261130' })).toEqual([])
    expect(longBreakOverlaps(KAGURA_JUNIOR, { start: '20261110', end: null }).map((b) => [b.name, b.from])).toEqual([
      ['夏季休業', '20270724'],
      ['冬季休業', '20261225'],
    ])
    expect(longBreakOverlaps(KAGURA_JUNIOR, { start: 'x', end: null })).toEqual([])
    expect(longBreakOverlaps([], { start: '20261110', end: '20270331' })).toEqual([])
  })
})
