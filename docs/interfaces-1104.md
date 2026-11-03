# 11/4 のモジュール間の取り決め

11/4 の実装(減便の方針の適用、足し戻し、元に戻す、前後の比較、GTFS の書き出し)を複数の担当で並行して進めるための、関数の形とデータの形の取り決めです。
変えたいときは勝手に変えず、指示役に理由を返してください。
`docs/interfaces-1103.md`(追記・追記2・追記3を含む)はそのまま有効です。食い違う所は、この文書を優先します。

根拠は、道北バスの GTFS の 2 版(9/17 版=減便前、10/29 版=減便後)の分析と、Python で別に書いた形2の参照実装・正解データです(§11)。

11/3 に3つのレビュー(GTFS・GTFS-JP の正しさ、運行管理者・GTFS 担当者の実務、要件と Claude の API)を反映しました。反映しなかった指摘と理由は §12.2、急がない指摘は §13 にまとめています。§5 の規則を変えた所では、道北バスの正解データ(5 つの場面)の出力が変わらないことを、その場で書いています。

## 共通

- **キー・日付・時刻・時間帯**:`docs/interfaces-1103.md` の「共通」のとおり。照合は前後の空白を取った値で行い、書き出す値は元のまま
- **基準の GTFS**:利用者が読み込んだ GTFS。編集後の GTFS は、毎回、基準から作り直す(§4)。基準のフィードの `Map`・表・行は書き換えない。行を変えるときは `{ ...row, trip_id }` のように新しい行を作る。変えない表は、編集後のフィードでも同じ参照を使う
- **作成日時(generatedAt)**:`'YYYYMMDDhhmm'`(日本時間)。編集と書き出しの純粋な関数は時計を読まず、引数で受け取る。store は `deps.now()` から作る
- **今日(today)**:`'YYYYMMDD'`(日本時間)。実施日までの日数などで今日が要る関数も、引数で受け取る(§5.10 の `timingNotices`)
- **時間帯の端**:時間帯は開始を含み、終わりを含まない(`[6:00, 9:00)`)。この文書の「6〜9時」はすべてこの意味
- **文字列の並べ替え**:`a < b ? -1 : a > b ? 1 : 0`(UTF-16 のコード単位の順)。参照実装(Python)はコードポイントの順で、基本多言語面の外の文字が無ければ同じ結果になる
- **文言**:コメント、テスト名、画面の文言、エラーは日本語
- **「期間」と「有効期間」**:「期間」は利用者が方針で指定する日付の範囲。「有効期間」は出力 GTFS の範囲(calendar の端と feed_info の `feed_start_date`・`feed_end_date`)。形2では、有効期間を期間に合わせる(§5.6)

新しく作るファイル(すべてリポジトリの最上位から):

| ファイル | 中身 | 節 |
| --- | --- | --- |
| `data/src/dispatcher_data/holidays.py` | 内閣府の祝日 CSV を JSON にする | §2 |
| `server/src/dispatcher_server/app.py`(足す) | `GET /api/holidays`。Claude の中継(11/5) | §2・§10 |
| `web/src/gtfs/holidays.ts` | 祝日一覧の型・読み込み・判定 | §2 |
| `web/src/gtfs/edit/services.ts` | service_id の役割の見分け | §3 |
| `web/src/gtfs/edit/signature.ts` | 便の署名(便どうしを比べる単位) | §5.1 |
| `web/src/gtfs/edit/form2.ts` | 形2の適用(純粋な関数) | §5 |
| `web/src/gtfs/edit/ops.ts` | 編集の操作と、操作の列から計画を作る関数 | §4 |
| `web/src/gtfs/edit/diff.ts` | 平日便の差(消える・入る・残る)、足し戻しの集計 | §6・§8 |
| `web/src/gtfs/edit/restore.ts` | 足し戻しの手がかり(`restoreHints`) | §8 |
| `web/src/gtfs/validate/edit.ts` | 書き換えのたびの検証(11/4 の分)、祝日の確認、実施日までの日数による注意 | §4.5・§5.8・§5.10 |
| `web/src/gtfs/write.ts` | CSV と ZIP の書き出し | §9 |
| `web/src/reach/compare.ts` | 到達圏の前後の比較、運行がゼロになる停留所・系統 | §7 |
| `web/src/store/edit.ts` | 編集の履歴・下書き・元に戻す | §4 |
| `web/src/store/holidays.ts` | 祝日一覧の読み込みの状態 | §2 |
| `web/src/components/steps/PolicyStep.tsx`・`RestoreStep.tsx`・`ExportStep.tsx` | 方針・足し戻し・出力の手順 | §3・§6・§8・§9 |
| `web/src/claude/tools.ts` | Claude のツールの定義と、ブラウザでの実行(11/5) | §10 |
| `server/src/dispatcher_server/claude.py` | Claude の中継(11/5) | §10 |

## 1. 範囲

### 11/4 に作るもの

- 祝日一覧の入手・変換・配信・読み込みと、期間内の祝日の警告(§2・§5.8)
- service_id の役割の見分けと、方針の画面(種類・期間・除外する系統)(§3)
- 形2の適用、編集の操作、下書きと承認、元に戻す(§4・§5)
- 対象便を人が確かめる画面(§6)。系統ごとの始発・終発と、公示第47号の時間帯ごとの便数を含む
- 前後の比較:基準の起点と coverable を使う到達圏、表と地図、運行がゼロになる停留所・系統・場所の警告(§7)
- 手で便を選ぶ足し戻しの画面(§8)
- 書き換えのたびの検証のうち、§4.5 の規則と、実施日までの日数による注意(§5.10)
- CSV の書き出し(`serializeTable`)と、正解データとのバイト単位の照合(§9・§11)。ZIP の書き出し(`writeGtfsZip`)と出力の画面は、11/4 に間に合わなければ 11/6 に回す

11/4 の到達点は、Notion の全体スケジュールのとおり「平日を土曜ダイヤに」で夜の空白が地図で見えること(§11 の受け入れ条件)。

11/4 の中で遅れたときに削る順(上から削る。方針の適用と前後の比較は削らない):

1. 系統の除外の画面(Notion で決まっていない。§12.1-8。`excludedRoutes` を受ける関数はそのまま作る)
2. 手で選ぶ足し戻しの画面(11/5 に回す。`addBack` の操作と `applyForm2` の足し戻しは 11/4 に作る)
3. 4色の差の地図(`'before'`・`'after'` の切り替えだけ残す)
4. 公示第47号の時間帯ごとの便数の表(§6 の `byNotice47Band`。削ったら B に回し、正解データの照合はテストの中で数える)
5. 祝日の配信(画面は「祝日一覧を読めないため…」のまま動く)
6. 「日祝ダイヤに」の方針(§3 の `weekdayToSundayHoliday`。Notion のとおり最後に削る)

### 11/4 に作らないもの

- Claude の中継とツールの実行。§10 は契約だけで、実装は 11/5
- Claude による足し戻しの提案と理由づけ(11/5)。§8 の手がかりのうち、到達圏を使うもの(`onlyServiceAtStop`・`restoresLostCells`)も 11/5
- 前提情報の調査(11/6 午前)
- 検証器の全規則(fare_rules などを含む全表の検査。11/6)
- 編集の履歴の IndexedDB への保存
- B の機能(停留所ごとの一覧と掲示の差し替えの件数、変更指示書、周知文)
- 便を消す操作、系統ごとの間引き、ほかの方針(§12.1-10)
- 祝日の例外を補うこと(§5.8 は警告だけ)
- transfers・attributions・translations のうち便を指す行の書き換え(11/4 は、その行があれば方針を適用しない。§5.2)
- 減便をやめるときの版の出力(§12.1-3)

## 2. 祝日

### 入手(data/raw/)

- 置き場所:`data/raw/holidays/syukujitsu.csv`
- 入手元:https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv(配布ページ https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html )。ダウンロードしてよい参照データとして扱う
- 入手した担当は、入手した日時(日本時間)・URL・大きさを `data/raw/README.md` の「入手の記録」に、置き場所と利用条件を同じファイルの表に足す。利用条件の表記は、入手するときに配布ページの記載で確かめる
- 利用条件(2026-11-03 に確かめた):配布ページに記載は無く、内閣府ホームページ利用規約(令和7年3月25日現在)が、権利表記の無いコンテンツに**公共データ利用規約(第1.0版)**(デジタル庁、CC BY 4.0 互換)を適用する。政府標準利用規約(第2.0版)ではない。出典の記載と、加工したときは加工した旨の記載が要る
- CSV の形(`docs/research/dia-planning.md` 438 行):文字コードは Shift_JIS、見出しは「国民の祝日・休日月日,国民の祝日・休日名称」、日付は `2027/1/1` のようにゼロを詰めない、収録は 1955-01-01〜2027-11-23(1,067 行)、振替休日と国民の休日の名称は「休日」

### 変換(data/)

`uv run dispatcher-holidays`(`pyproject.toml` の `[project.scripts]` に足す)で `data/out/ref/holidays.json` を書く。`--raw`・`--out` は `dispatcher-data` と同じ意味。参照データの作成(`dispatcher-data`)とは別のコマンドにし、祝日の CSV が無くても参照データは作れるようにする。

- `cp932` で読む。先頭に BOM があれば取る
- 1行目が上の見出しと一致しなければ止める(形が変わったため)
- 日付は `Y/M/D` を `YYYYMMDD` にする。読めない行、実在しない日付、同じ日付の2回目は、行番号を出して止める
- 名称は前後の空白を取る。日付の昇順に並べる
- JSON(UTF-8、空白なし):

```json
{
  "source": "内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成",
  "url": "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",
  "first": "19550101",
  "last": "20271123",
  "coveredUntil": "20271231",
  "holidays": [["19550101", "元日"], ["20261103", "文化の日"]]
}
```

- `coveredUntil` は、最後の祝日の年の 12月31日。内閣府は翌年の祝日を1年分まとめて載せる(2028年分は 2027年2月に載る予定)ので、最後の年は年末まで判定できるとみなす

### 配信(server/)

- `GET /api/holidays`:`{DISPATCHER_REF_DIR}/holidays.json`(既定は `data/out/ref/holidays.json`)を返す。参照データと同じ場所に置くので、Docker でも同じボリュームで渡せる
- 無ければ 404(`detail` は日本語。「祝日一覧が見つかりません。data/ の dispatcher-holidays で data/out/ref に作ってください。」)。`Cache-Control: public, max-age=3600`
- `/api/ref/{mesh1}` は数字4桁だけを受け付けるので、`holidays` はそちらの経路に入らない

### web

```ts
// web/src/gtfs/holidays.ts
export interface HolidayList {
  /** キーは 'YYYYMMDD'、値は名称 */
  names: Map<string, string>
  first: string
  /** この日までは祝日を判定できる */
  coveredUntil: string
  /** 画面の「データの出典」に出す文 */
  source: string
}
export function parseHolidayJson(json: unknown): HolidayList                 // 形が違えば日本語のエラー
export function fetchHolidays(): Promise<HolidayList | null>                  // 404 は null。ほかの失敗はエラー
export function holidaysBetween(list: HolidayList, start: string, end: string): { date: string; name: string }[]
/** start〜end のうち、収録の範囲(first〜coveredUntil)の外の部分。無ければ空 */
export function uncoveredRanges(list: HolidayList, start: string, end: string): { start: string; end: string }[]

// web/src/store/holidays.ts
export type HolidayState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; list: HolidayList }
  | { status: 'missing' }                 // 404
  | { status: 'error'; message: string }
```

- 画面を開いたときに1回だけ読む。失敗しても読み込み直しのボタン以外は出さない
- **祝日一覧が無くても、方針の適用・足し戻し・比較・出力はすべて動く。** 祝日に関わる確かめの代わりに「祝日一覧を読めないため、祝日の確認をしていません」と出す
- 使い道:日祝の service の見分け(§3)、方針の画面で期間内の祝日を並べる(§3)、祝日の例外の確かめ(§5.8)
- 範囲の外:出力の有効期間に `uncoveredRanges` があれば警告する(「{開始日}〜{終了日} の祝日は、内閣府の一覧にまだ無いため確かめていません」)
- 出典:`status: 'ready'` のときだけ、「データの出典」に「国民の祝日(内閣府)」の行を出す(`source` の文と、入手時に確かめた利用条件)。README にも同じ行を足す。CLAUDE.md の「データと出典」の表に足すのは指示役

## 3. 方針のモデル

### service_id の役割

```ts
// web/src/gtfs/edit/services.ts
export type ServiceRole = 'weekday' | 'saturday' | 'sunday' | 'saturdaySunday' | 'other'
export interface ServiceInfo {
  serviceId: string                 // 空白を取った値
  role: ServiceRole
  /** calendar の曜日の列(月〜日)。calendar に行が無ければ null */
  days: boolean[] | null
  /** calendar_dates で、祝日一覧の祝日に追加(exception_type=1)される日がある。祝日一覧が無ければ null(判定できない) */
  addedOnHolidays: boolean | null
  tripCount: number
  calendarRange: { start: string; end: string } | null
}
export function describeServices(feed: GtfsFeed, holidays: HolidayList | null): ServiceInfo[]   // service_id の昇順

/** その service が start〜end(両端を含む)の中で走る日(activeServiceIds に入る日)の数 */
export function activeDaysIn(feed: GtfsFeed, serviceId: string, start: string, end: string): number

export interface ServiceChoice {
  weekday: string | null
  saturday: string | null
  sundayHoliday: string | null
  /** 決められなかった理由(画面に出す)。決まったものには無い */
  notes: string[]
}
/** validity は方針の期間から作った新しい有効期間(§5.6)。この中で1日も走らない service は候補にしない */
export function guessServiceChoice(feed: GtfsFeed, services: readonly ServiceInfo[], validity: { start: string; end: string }): ServiceChoice
/** 2つの service の便が、署名(§5.1)の多重集合として同じか(道北バスの 03 と 06 は同じ) */
export function sameTimetable(feed: GtfsFeed, a: string, b: string): boolean
```

- 役割は calendar の曜日の列(値を空白を取って `'1'` と照合)で決める
  - `weekday`:月〜金がすべて 1、土・日が 0
  - `saturday`:土だけが 1
  - `sunday`:日だけが 1
  - `saturdaySunday`:土・日が 1、月〜金が 0(土休日ダイヤ)
  - `other`:それ以外。calendar に行が無い service(calendar_dates だけ)もここ
- `guessServiceChoice`:便が1本以上あり、新しい有効期間(`validity`)の中で1日以上走る(`activeDaysIn` が 1 以上)service だけを候補にする。季節ごとに service を分ける GTFS(夏の土曜 `03`=4/1〜10/31、冬の土休日 `13`=11/1〜3/31 など)で、期間に走らない夏の service を選ばないため
  - 平日:`weekday` がちょうど1つならそれ
  - 土曜:`saturday` がちょうど1つならそれ。無ければ `saturdaySunday` がちょうど1つならそれ
  - 日祝:`sunday` がちょうど1つならそれ(複数なら `addedOnHolidays` が true のものがちょうど1つならそれ)。無ければ `saturdaySunday` がちょうど1つならそれ
  - 祝日一覧が無い(`addedOnHolidays` が null)ときは、`sunday` が複数でも祝日で選ばず `null` にし、notes に「祝日一覧を読めないため、日祝のダイヤを決められません」を入れる
  - 0 個か複数で決まらなければ `null` にし、**利用者に選ばせる**。選択肢は service ごとに、曜日の並び、便数、calendar の期間、新しい有効期間の中で走る日数、祝日に追加されるかを出す
  - 画面は、期間を変えるたびに `guessServiceChoice` を呼び直す。ただし利用者が選び直した役割は上書きしない(推定の結果が変わったら、選んだ service の横に「期間を変えたため、推定は {service} になりました」と出す)
- 道北バス(両版):`01`=平日、`03`=土曜、`06`=日祝(`addedOnHolidays`)。3つとも有効期間の全体で走るので、期間による絞り込みで候補は変わらない。`sameTimetable(feed, '03', '06')` は true なので、画面に「この GTFS では土曜と日祝が同じ時刻表のため、2つの方針は同じ結果になります」と出す
- 平日の役割の service がほかにもあり、選んだもの以外は入れ替えない。そのときは警告する(`otherWeekdayServices`)

### 方針

```ts
// web/src/gtfs/edit/ops.ts
export type PolicyKind = 'weekdayToSaturday' | 'weekdayToSundayHoliday'
export interface Period {
  start: string                     // 'YYYYMMDD'
  end: string | null                // null は「当面の間」(終わりを決めない)
}
export interface PolicySettings {
  kind: PolicyKind
  weekdayService: string            // 入れ替える平日の service_id(空白を取った値)
  replacementService: string        // 写す元。kind が weekdayToSaturday なら土曜、weekdayToSundayHoliday なら日祝の service_id
  period: Period
  excludedRoutes: string[]          // 入れ替えから外す route_id(空白を取った値。利用者が選んだ順)
}
/** 減便の理由。Dispatcher は判定せず、利用者(または Claude の下書きを承認した利用者)の入力だけを残す。変更指示書に使う */
export interface PolicyReason {
  /** 運転士の一時的な欠員/慢性的な不足/需要の減少。選ばなければ null */
  category: 'temporaryShortage' | 'chronicShortage' | 'demandDecline' | null
  note: string
}
export interface PolicyProblem { severity: 'error' | 'warning'; code: string; message: string }
export function checkPolicy(base: GtfsFeed, settings: PolicySettings): PolicyProblem[]
```

- `PolicyReason` は `PolicySettings` に入れず、操作(§4 の `applyPolicy`)の側に持つ。`PolicySettings` と `Form2Plan` の名前を参照実装の方針の JSON にそろえたままにするため

- 名前は参照実装の方針の JSON(`weekdayService`・`replacementService`・`period`・`excludedRoutes`)にそろえる。正解データの方針をそのまま渡せるようにするため
- `replacementService` は `kind` と §3 の選択から画面が決める。利用者は画面で変えられる
- 既定:`kind` は `weekdayToSaturday`。`period.start` は、今日(日本時間)が入力の有効期間(§5.6)の中なら今日、そうでなければ入力の開始日。`period.end` は `null`。`excludedRoutes` は空
- 期間の入力は `input type=date` の2つ(開始日と終了日)と、「当面の間(終わりを決めない)」のチェック(既定でオン)。範囲は入力の有効期間。期間の中の祝日(`holidaysBetween`)を下に並べる
- `checkPolicy` のエラー(方針を適用できない):
  - 日付が不正、`end < start`
  - `weekdayService` と `replacementService` が同じ、どちらかに便が無い
  - `period.start` が入力の有効期間の末日より後(新しい有効期間が空)
  - `weekdayCalendarOutside`:平日の service に calendar の行があり、**その service のどの行の期間も**新しい有効期間と1日も重ならない(行が2つ以上あるときは、1つでも重なればよい)
  - `weekdayNotActive`:`weekdayService` が新しい有効期間の中で1日も走らない(calendar と calendar_dates の両方で判定する `activeDaysIn` が 0)。calendar に行が無く calendar_dates だけで日を決める service でも止める。止めないと、§5.6 の規則で平日の service が便ごと出力から消え、方針が何も変えない出力になる
  - `replacementNotActive`:`replacementService` が新しい有効期間の中で1日も走らない(`activeDaysIn` が 0)。写した便が、走らない service の時刻表のまま平日に入るのを防ぐ(例:夏の土曜 `03` を、11/1 からの期間に写す)
  - `frequencies.txt` に行がある(§5.9)
  - `tripReferences`:transfers・attributions・translations に、平日の service の便を指す行がある(§5.2)
- 上の一覧で名前の無い error の code は、実装で `badPeriod`(日付が不正、`end < start`)・`sameService`・`noWeekdayTrips`・`noReplacementTrips`・`noValidity`・`emptyValidity`(新しい有効期間が空。`period.end` が入力の開始日より前も含む)・`frequencies` とした
- `checkPolicy` の警告:
  - `period.start` が入力の開始日より前(入力の開始日にそろえる)、`period.end` が入力の末日より後(入力の末日にそろえる)
  - `excludedRoutes` に routes.txt に無い route_id(`unknownExcludedRoute`)、平日便の無い route_id(`excludedRouteWithoutWeekdayTrips`)がある
  - `replacementPartial`:`replacementService` の calendar の期間(calendar に行が無ければ、走る日の最初〜最後)が、新しい有効期間の全体を覆わない。期間の一部の平日で、写した便が走らない時刻表になりうる
  - `shortValidity`:新しい有効期間が 7 日以下。方針の画面で開始日か終了日を変えるよう促す(この方針のままでは出力できない。§4.5)
  - `validityUnder30`:新しい有効期間が 30 日未満(GTFS-JP は可能であれば 30 日以上を望ましいとしている)
- 道北バスでは `replacementNotActive`・`replacementPartial`・`tripReferences` は起きない(03・06 は有効期間の全体を覆い、transfers は無く、translations の `record_id` は全行が空)。正解データの 5 つの場面はどれも方針を適用できる

### 系統の除外

- 方針に系統の除外を含めることは、Notion ではまだ決まっていない(§12.1-8)。関数(`excludedRoutes`)は作り、画面は 11/4 の中で最初に削る候補にする(§1)
- 画面は、平日便のある系統を並べ、系統ごとに平日の便数と、写す元の service の便数を出す。チェックした系統を「入れ替えから外す」(既定はどれもオフ)
- 写す元の便数が 0 の系統(平日だけの系統)は表の先頭にまとめ、次を出す:「入れ替えると全曜日で便がなくなります(路線の休止の届出に当たるかを運輸支局に確認してください)。除外すると平日の便がそのまま残ります。」除外を推定はしない(下の項目)ので、並べ替えと文言だけにする。レビューの全件集計では、9/17 版の平日の 65 系統のうち 19 系統がこれに当たる
- 除外した系統は、平日便をそのまま残し、その系統の写す元の便は写さない(§5.2)
- 道北バスの 10/29 版は 0051(51-沼田深川線)と 0151(151-沼田深川西高線)を入れ替えから外している。0051 はデータから分かるが、0151 はデータだけでは決まらない(土曜便が無く、平日だけの系統 8 つと同じ形)。画面もテストも、除外を GTFS から推定しない

## 4. 編集の操作

### 操作と計画

```ts
// web/src/gtfs/edit/ops.ts
export interface AddBackItem {
  tripId: string                    // 基準の平日便の trip_id(空白を取った値)
  reason: string                    // 便ごとの理由(変更指示書の「保護する便、理由」に使う)。空でもよい
  /** 休校日運休の便(「(学)」)。GTFS には入れず、変更指示書と周知文にだけ使う(§8) */
  schoolDaysOnly: boolean
}
export type EditOp =
  | { type: 'applyPolicy'; settings: PolicySettings; reason: PolicyReason }
  | { type: 'addBack'; items: AddBackItem[] }
  | { type: 'withdrawAddBack'; tripIds: string[] }            // 足し戻しを取り消す
export type EditActor = 'user' | 'claude'
export interface EditRecord {
  op: EditOp
  by: EditActor
  /** 承認した日時(ISO 8601、日本時間 '2026-11-04T09:30:00+09:00')。変更指示書に使う */
  at: string
}

/** 形2の適用に渡す計画。参照実装の方針の JSON と同じ名前(理由は持たない) */
export interface Form2Plan extends PolicySettings {
  /** 足し戻す便。重複なし、足した順 */
  addBackTripIds: string[]
}
export function planOf(history: readonly EditRecord[]): Form2Plan | null
/** 足し戻した便ごとの理由。同じ便を2回足したときは最初の理由(planOf で2回目は無視されるため)。取り消したあとに足し直したときは、足し直したときの理由 */
export function addBackReasons(history: readonly EditRecord[]): Map<string, { reason: string; schoolDaysOnly: boolean; by: EditActor; at: string }>
/** 最後の applyPolicy の理由。無ければ null */
export function policyReasonOf(history: readonly EditRecord[]): PolicyReason | null
```

`planOf` は操作の列を前から畳む。

- 空の列は `null`(編集なし。編集後のフィードは基準そのもの)
- `applyPolicy`:方針を置き換える。足し戻しの一覧は残す(方針を変えても、選んだ便は選んだまま。適用できない便は §5.3 の分類で知らせる)
- `addBack`:一覧に無い trip_id だけを、`items` の順に後ろへ足す(`addBackTripIds` は trip_id だけ。正解データの方針 JSON をそのまま `Form2Plan` として渡せる)
- `withdrawAddBack`:一覧から除く
- 最初の `applyPolicy` より前の `addBack`・`withdrawAddBack` は履歴に入らない(store が断る)

### 編集後のフィードは、基準と計画から毎回作り直す

```
編集後 = applyForm2(基準, planOf(履歴), { generatedAt })
```

- 前の版に操作を1つずつ当てる作りにしない。写した便の trip_id は、残す便と足し戻した便の trip_id を先に押さえてから割り当てる(§5.4)ので、足し戻しを後から足すと割り当てが変わることがある。基準と計画全体から作り直せば、参照実装と同じ結果になる
- `applyForm2` は道北バスで数十 ms。版ごとに結果を持つので、元に戻すときは作り直さない

### 元に戻す

- **元に戻す**は、承認済みの操作の列(`history`)の最後を1つ除くこと。結果の版(`versions`)も同じだけ除く
- **すべて戻す**は、`history` を空にする(編集後のフィード = 基準)
- やり直し(redo)は作らない
- 出力した GTFS だけでは元に戻せない。元に戻せるのは、この画面の編集の履歴と、読み込んだ基準の GTFS を持っている間だけ(画面と README にこの違いを書く)

### 下書きと承認

```ts
// web/src/store/edit.ts
export interface BaseGtfs {
  feed: GtfsFeed
  /** 元の ZIP のバイト列(§9 の書き出しで、変えない表をそのまま写すため) */
  zip: ArrayBuffer
  label: string
  sample: SampleGtfsInfo | null
}
export type Draft =
  | {
      kind: 'op'
      /** 'd1'、'd2' … (store の中で増やす。Claude のツールの結果の draft_id) */
      id: string
      record: EditRecord            // at は承認したときに入れ直す
      outcome: Form2Outcome         // §5
      diff: WeekdayDiff | null      // §6。outcome が失敗なら null
      issues: ValidationIssue[]     // §4.5。outcome が失敗なら []
    }
  | {
      /** 元に戻す下書き(Claude の undo_edit)。承認すると undo() と同じことをする */
      kind: 'undo'
      id: string
      by: EditActor
      /** 戻したあとの版(history が1つなら null = 基準) */
      result: Form2Result | null
      diff: WeekdayDiff | null
    }
export type ProposeOutcome = { ok: true; draft: Draft } | { ok: false; message: string }
export type CommitOutcome = { ok: true } | { ok: false; message: string }
/** 下書きの行方。Claude に次の発言で伝える(§10) */
export interface DraftNotice { draftId: string; by: EditActor; result: 'committed' | 'discarded' | 'replaced'; at: string }
interface EditState {
  base: BaseGtfs | null
  history: EditRecord[]
  versions: Form2Result[]           // versions[i] は history[0..i] を適用した結果
  draft: Draft | null
  /** Claude にまだ伝えていない下書きの行方(Claude が出した下書きの分だけ) */
  draftNotices: DraftNotice[]
  /**
   * 下書きを作る(履歴は変えない)。
   * 下書きがあるとき:by が 'claude' なら ok: false(「下書き {id} が承認待ちです」)。
   * by が 'user' なら前の下書きを捨てて作る(Claude の下書きを捨てるときは、画面が先に確かめる。捨てた下書きは draftNotices に 'replaced')
   */
  propose: (op: EditOp, by: EditActor) => ProposeOutcome
  /** 元に戻す下書きを作る。履歴が空なら ok: false。下書きがあるときの扱いは propose と同じ */
  proposeUndo: (by: EditActor) => ProposeOutcome
  /**
   * 下書きを承認して履歴に足す。下書きが無い、outcome.ok が false、または error の issue(exportOnly でないもの)があれば、
   * 何もせず ok: false と理由を返す
   */
  commit: () => CommitOutcome
  discard: () => void
  undo: () => void
  undoAll: () => void
  /** Claude に伝えた分を消す(§10 のチャットが送るときに呼ぶ) */
  takeDraftNotices: () => DraftNotice[]
  /** 読み込み直しで呼ぶ。履歴と下書きを捨てる */
  setBase: (base: BaseGtfs | null) => void
}
export interface EditStoreDeps {
  now: () => Date
  /** 編集後のフィードが変わったときに呼ぶ(到達圏の store の setEdited につなぐ) */
  onEdited: (edited: EditedSource | null) => void
}
export function createEditStore(deps: EditStoreDeps)
export const useEditStore = createEditStore({ now: () => new Date(), onEdited: (e) => useReachStore.getState().setEdited(e) })
```

- **Claude の操作は必ず下書きになる。** 利用者が画面で承認(`commit`)するまで、履歴も地図も変わらない(地図の下書きの表示は次の項目)
- **下書きは1つだけ。** Claude が1回の返答で編集のツールを2つ並べて呼んだ場合、2つ目は `propose` が ok: false を返し、ツールの結果は `is_error`(「下書き d3 が承認待ちです。承認か取り消しのあとで呼んでください」)になる(§10)。先の下書きを黙って捨てない
- 利用者の操作:方針は「対象便を確かめる」で `propose`、§6 の画面で「この内容で進める」を押すと `commit`。足し戻しと取り消しは、ボタンを押したことを承認とみなし、`propose` のあとすぐ `commit` する。`commit` が ok: false なら、その理由を画面に出す(履歴は変わらない)
- Claude の下書きがある間に利用者が編集のボタンを押したら、「Claude の下書き {id} を捨てて、この操作をしますか」と確かめてから `propose` する
- 下書きがある間は、地図と比較の表に下書きの結果を出し、「下書き」と明示する(`EditedSource.draft: true`)。`discard` で承認済みの最後の版(無ければ基準)に戻す
- `onEdited` に渡す値:下書きがあれば下書きの結果、無ければ最後の版、履歴が空なら `null`
- `generatedAt` は `propose` のときの `deps.now()`(分まで)。出力のときは作り直す(§9)
- 読み込み直し(`LoadStep` の `open()`)は、`useGtfsStore.clear()` と一緒に `useEditStore.getState().setBase(null)` を呼び、読み込めたら `setBase` に元の ZIP ごと渡す

### 4.5 書き換えのたびの検証

```ts
// web/src/gtfs/validate/edit.ts
export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  code: string
  file: string                      // 'trips.txt' など。全体の問題は ''
  message: string                   // 日本語
  count: number
  examples: string[]                // trip_id などを最大 5 件
  /** error のうち、出力だけを止めるもの(承認と比較はできる)。無ければ false */
  exportOnly?: boolean
  /** 基準(入力)にも同じ問題がある(下の「入力からある問題」)。無ければ false */
  inherited?: boolean
}
export function validateEdit(base: GtfsFeed, result: Form2Result, holidays: HolidayList | null): ValidationIssue[]
```

`propose` のたびに呼ぶ。11/4 に入れる規則は次のとおり。全表の検査(fare_rules など)は 11/6 の検証器で足し、同じ `ValidationIssue` を使う。

| 重さ | code | 規則 |
| --- | --- | --- |
| error | `duplicateTripId` | trips の trip_id(空白を取った値)が重複する |
| error | `tripWithoutStopTimes` | stop_times に1行も無い便がある |
| error | `stopTimesUnknownTrip` | stop_times の trip_id が trips に無い |
| error | `unknownService` | trips の service_id が calendar にも calendar_dates にも無い |
| error | `unknownRoute`・`unknownStop` | trips の route_id が routes に、stop_times の stop_id が stops に無い |
| error | `badCalendar` | calendar の日付が不正、`start_date > end_date` |
| error | `duplicateCalendarDate` | calendar_dates に同じ service_id・date の行が2つ以上ある |
| error | `badFeedInfo` | feed_info の `feed_start_date`・`feed_end_date` が不正か逆順、`feed_version` が空か入力と同じ |
| error(出力だけ止める) | `shortValidity` | 有効期間(`feed_end_date − feed_start_date + 1`)が 7 日以下。GTFS-JP 第4.0版(第1編 p.12)は「有効期間が7日間以下のデータセットは作成しないこととする」としている。`exportOnly: true` |
| warning | `validityUnder30` | 有効期間が 30 日未満(同じ箇所で「可能であれば30日以上が望ましい」) |
| info | `validityGapBefore`・`validityGapAfter` | 入力の有効期間のうち、出力から外れる日付の範囲(開始日より前、終了日より後)。形2では期間の外の日を表せないため(§5.6) |
| info | `tripIdReused` | 編集後の便の trip_id のうち、基準では別の便(署名が違う便)を指していたもの。一覧と件数(§5.4) |
| warning など | `form2.*` | §5 の警告(`Form2Report.warnings`)をそのまま写す。ただし `form2.shortValidity` は上の `shortValidity` にまとめて出さない |
| warning・info | `holiday*`・`weekdayNotRunning`・`yearEnd` | §5.8 の祝日・平日・年末年始の確かめ |

- **入力からある問題**:`validateEdit` は、上の error の規則(`shortValidity`・`badFeedInfo` の「入力と同じ」を除く)を基準のフィードにも当てる。同じ code で、同じ対象(examples に出す値。trip_id・stop_id・service_id など)の問題が基準にもあれば、その分を別の issue に分けて `warning`・`inherited: true` にし、文言の頭に「入力からある問題:」を付ける。編集で新しく生じた問題だけを error にする。入力の参照の欠け(stop_times の stop_id が stops に無い行が1つある、など)で方針を適用できなくなるのを防ぐため。道北バスは参照の欠けが 0 件なので、正解データでは表に出ない
- `exportOnly` でない error が1件でもあれば、`commit` と出力を止める。`exportOnly` の error は出力だけを止める(承認でき、比較の地図と表は動く。方針の画面で日付を直してもらう)
- 文言は §5.10

## 5. 形2の出力

```ts
// web/src/gtfs/edit/form2.ts
export interface Form2Options { generatedAt: string }
export type Form2Outcome = { ok: true; result: Form2Result } | { ok: false; message: string }
export function applyForm2(base: GtfsFeed, plan: Form2Plan, opts: Form2Options): Form2Outcome

export interface Form2Result {
  /**
   * 編集後のフィード。trips・stop_times・calendar・calendar_dates・feed_info のうち、基準にある表だけを新しい表にする。
   * 基準に無い表は作らない(calendar.txt が無い GTFS に空の calendar を足さない)。例外は feed_info を作る場合(§5.7)だけ。warnings は []
   */
  feed: GtfsFeed
  plan: Form2Plan
  report: Form2Report
}
export interface Form2Report {
  inputValidity: { start: string; end: string }
  validity: { start: string; end: string; days: number }   // days は両端を含む日数
  tripIds: {
    rule: 'replace-service-part' | 'append-service'        // §5.4
    /** service_id の部分の位置(0 始まり)。'append-service' なら null */
    servicePartIndex: number | null
    derived: { from: string; to: string }[]                  // from の昇順
    kept: string[]                                           // 以下すべて昇順
    addedBack: string[]
    removed: string[]
    collisions: { from: string; candidate: string; assigned: string; collidedWithService: string | null }[]
  }
  addBack: {
    requested: number
    accepted: string[]
    ignoredExcludedRoute: string[]
    ignoredAlreadyPresent: { tripId: string; sameAs: string }[]   // tripId の昇順
    notWeekday: string[]
    notFound: string[]
    duplicate: string[]
  }
  calendarDates: { kept: number; dropped: { service_id: string; date: string; exception_type: string }[] }
  /** 新しい有効期間のどの日にも走らなくなり、便ごと出力から除いた service(§5.6) */
  droppedServices: { serviceId: string; trips: number }[]
  rowOrder: { trips: 'service_id,trip_id' | 'trip_id' | 'input'; stop_times: 'trips' | 'input' }
  feedVersion: { before: string; after: string }
  warnings: { code: string; message: string }[]
}
```

- `tripIds`(`rule` と `servicePartIndex` を除く)・`addBack`・`calendarDates`・`rowOrder` は、参照実装 `form2_ref.py` の `summary.json` と同じ名前・同じ並びにしてあり、そのまま比べられる。`inputValidity`・`validity`・`feedVersion` は `summary.json` の `input`・`output` の値を組み直したもの、`droppedServices` は参照実装に無い(§11)
- 参照実装と違うのは、キーの空白を取って照合すること(道北バスには空白が無いので結果は同じ)と、§5.6 の `droppedServices`・§5.7 の feed_info を作る場合・§5.9 の frequencies の扱い(いずれも正解データには出てこない)
- 11/3 のランダムな突き合わせ(1,517 件)で分かった参照実装との違い(どれも道北バスの正解データには出てこない):§5.4 の見つけ方(参照実装は便ごとに5部分の正規表現で判定し、TS はすべての便の形がそろうときだけ置き換える)、feed_info に列を足すこと(`feedInfoColumnsAdded`)、§3 の `checkPolicy` の error(参照実装は止めずに進む)、参照実装に無い警告(`otherWeekdayServices`・`blockIdCopied`)、§9 の書き出し(元の見出しの文字列と最後の改行を入力に合わせる)、不正な日付の扱い(TS は日付として確かめる。参照実装は文字列で比べる)、警告の数え方(§5.8)、§5.1 の読めない `stop_sequence`。参照実装は 0 バイトの表・不正な日付・見出しの空白などで止まるので、道北バスより広い入力の基準にはしない

### 5.1 便の署名

```ts
// web/src/gtfs/edit/signature.ts
export function tripSignature(routeId: string, rows: readonly GtfsRow[]): string
```

- `route_id + "\t" + 行ごとの "stop_id,arrival_time,departure_time" を ";" でつないだもの`。行は `stop_sequence` の数値の昇順(読めない値の行は入力の順で後ろ)。値は空白を取る
- 読める `stop_sequence` は、空白を取って `/^\d+$/` に合う値(0 以上の 10 進の整数。GTFS の規定どおり)。`-1`・`+3`・`2.0`・空は読めない値(参照実装は `int()` で読むので `-1` を読む)
- 便どうしを比べる単位。trip_id は比べない。足し戻しの「既にある便」(§5.3)、平日便の差(§6)、正解データの `signatureDigest` に使う
- 時刻は文字列のまま比べる(`7:05:00` と `07:05:00` は別の便になる)。乗降の区分(`pickup_type`・`drop_off_type`)・`stop_headsign`・`trip_headsign` は含めない。道北バスでは時刻の書き方がそろっており、署名が一致した便どうしでほかの列に違いが無いことを確かめてある。時刻を秒に直して比べる案は §12.2
- `signatureDigest`:対象の便の署名を重複も含めて並べ替え、`"\n"` でつないだ UTF-8 の SHA-256(末尾に改行を付けない)

### 5.2 便の分け方と写し方

平日の便 = 基準の trips で `service_id` が `plan.weekdayService` の便。写す元の便 = `plan.replacementService` の便。

1. **残す(kept)**:平日の便のうち、`excludedRoutes` の系統の便。行はそのまま
2. **写す(derived)**:写す元の便のうち、`excludedRoutes` の系統でない便。trips の行は写す元のまま、`trip_id` と `service_id` だけ変える(`service_id` は `plan.weekdayService`)。stop_times は写す元の行をそのまま写し、`trip_id` だけ変える。`stop_sequence` は振り直さない(9/17 版には番号が飛ぶ便が 36 ある)。`block_id`・`shape_id`・`trip_headsign` などもそのまま写す
3. **足し戻す(accepted)**:§5.3 で受け付けた便。行はそのまま
4. **消す(removed)**:平日の便のうち、上のどれにも入らない便
5. 平日でも写す元でもない service の便は、そのまま残す(写す元の便も、土曜(日祝)の便として残る)

写した便の trip_id が、消した平日便の trip_id と同じになることがある(消した便の id は空くため)。1つのフィードの中では一意なので GTFS の誤りではなく、道北バスの 10/29 版も `0904_01_01_01_0735` を 9/17 版とは別の便に使っている。ただし trip_id だけで前後を比べると取り違えるので、比べるときは署名を使い、画面とツールでは trip_id にどちらのフィードの id かを添える(§6 の `TripBrief.feed`、§10)。9/17 版では、除外なしで 16 便、0051・0151 を除外すると 15 便がこれに当たる(例 `0004_01_01_01_0710`)。`validateEdit` の `tripIdReused`(info)で一覧を出す。

**便を指すほかの表の行**(transfers の `from_trip_id`・`to_trip_id`、attributions の `trip_id`、translations の `table_name` が `trips` か `stop_times` の行の `record_id`):

- 11/4 は、平日の service の便を指す行が1つでもあれば `checkPolicy` のエラー(`tripReferences`)にして方針を適用しない。消した便を指したまま残る行(外部キーの誤り)や、使い回した trip_id で別の便を指す行を出さないため
- この制限を外すときの規則(11/6 以降。それまでは作らない):
  1. 消した便を指す行は出力から除き、件数と例を warning に出す
  2. 署名が同じ便(§6 の `same` の組)を指す行は、編集後の便の trip_id に書き換える
  3. 消した便の trip_id を指す行があれば、その id を §5.4 の「押さえる」側に入れ、写した便に使い回さない
  4. 書き換える表がふえるので、§5.9 の「書き換える表は 5 つ」と §9 の書き出しもあわせて直す
- 道北バスには transfers・attributions が無く、translations の `record_id` は 5,943 行すべて空なので、どちらの規則でも正解データの出力は変わらない

### 5.3 足し戻しの分類

`plan.addBackTripIds` を前から順に調べ、最初に当てはまったものに分ける。

| 順 | 分類 | 条件 |
| --- | --- | --- |
| 1 | `duplicate` | 同じ trip_id の2回目以降 |
| 2 | `notFound` | 基準の trips に無い |
| 3 | `notWeekday` | 平日の service の便でない |
| 4 | `ignoredExcludedRoute` | 除外した系統の便(すでに残っている) |
| 5 | `ignoredAlreadyPresent` | 署名が写す便(§5.2 の 2)と同じ(`sameAs` は、同じ署名の写す元の便のうち基準の trips の並びで最初のものの trip_id)、または先に受け付けた便と同じ(`sameAs` はその便) |
| 6 | `accepted` | 足し戻す |

- 受け付けた便は、元の平日便を trip_id・時刻とも変えずに残す
- 画面は、受け付けなかった便を分類ごとに理由をつけて出す(「土曜ダイヤに同じ時刻の便があるため、足し戻す必要がありません」など)

### 5.4 写した便の trip_id

**service_id の部分を置き換える(`replace-service-part`)。** 入力の trip_id の付け方を、入力から見つけて従う。

- 見つけ方:平日の便と写す元の便のすべてについて trip_id を `_` で分ける。部分の数がすべて同じ N で、ある位置 k の部分がどの便でも自分の `service_id` と等しければ、その k を使う。複数の位置が当てはまれば最も右の位置。見つからなければ `append-service`
- 道北バス:trip_id は `{運用 4桁}_{運用内の順番 2桁}_{01}_{service_id 2桁}_{始発の発時刻 HHMM}` で、k = 3(4つ目)。両版の全便(1,169 便・1,099 便)が当てはまる。例 `0026_01_01_03_0705` → `0026_01_01_01_0705`
- `replace-service-part`:写す元の trip_id の k 番目の部分を `plan.weekdayService` に置き換える。k 番目が写す元の service_id でない便(起きない想定)は `append-service` と同じにする
- `append-service`(仮の規則):`{写す元の trip_id}_{plan.weekdayService}`
- **重なり**:先に、平日以外のすべての便、残す便、足し戻す便の trip_id を押さえる。写す便は写す元の trip_id の昇順に割り当て、候補が押さえた id か先に割り当てた id と重なれば、候補の後ろに `_2`、`_3` … を付ける(`0004_01_01_01_0710` → `0004_01_01_01_0710_2`)。重なりは `tripIds.collisions` に残す(`collidedWithService` は、候補と同じ trip_id の基準の便の service_id。無ければ null)
- 正解データの main の場面では重なりは 0。9/17 版の平日便 447 便のどれを足し戻しても、重なるのは最大 89 便。そのうち 76 便は、写すどれかの便と署名が同じなので §5.3 の 5 で足し戻さず、`_2` が付くのは 13 便(0051・0151 を除外すると 86・74・12 便)。レビューの全件集計
- 足し戻した便と残す便は、元の trip_id のまま
- この規則は id の形だけに従う。事業者の運用の付け直しは再現しない。`_2` を付けると 5 つの部分の形は崩れる。レビューの全件集計では次のとおり:
  - 10/29 版と署名で一致する 374 便のうち、trip_id まで同じなのは 240 便
  - 10/29 版の平日にだけある 25 便のうち、9/17 版の平日便と署名まで同じなのは 24 便で、trip_id が同じなのは 6 便(`0371_03_01_01_0730`、`0372_03`・`04`・`05` の 3 便、`0931_02_01_01_0805`、`0932_01_01_01_0710`)、違うのは 18 便(例 `0002_01_01_01_1610` → `0035_06_01_01_1610`、`0013_07_01_01_1550` → `0004_06_01_01_1550`)。除外した系統の 4 便を除くと、足し戻した 20 便のうち trip_id を保ったのは 2 便。残る 1 便は `0953_01_01_01_0730`(0662 忠和線。冬季だけで 9/17 版に無い)
  - 指示役の当初の集計(24 便のうち 17 便が違う)は 18 便に直す
  - この規則の main の出力では、平日便の trip_id の(運用, 順番)の部分が 11 組重なる(例 `0005_01` が、足し戻した便と写した便の2つ)。block_id が空なので GTFS としては問題ないが、trip_id から運用を読む事業者には合わない(§12.1-6)
- `form2.verify.test.ts` は 10/29 版との trip_id の一致を求めない

### 5.5 行の並び

- trips:入力が `(service_id, trip_id)` の昇順なら、出力もその順(道北バスは両版ともこの順)。そうでなく `trip_id` の昇順ならその順。どちらでもなければ入力の順のまま、写した便を割り当ての順で後ろに足す。並びの判定と並べ替えは空白を取ったキーで行う
- stop_times:入力が便ごとにまとまり、その便の並びが trips の並び(stop_times に出てくる便だけを見た順)と同じなら、出力も出力の trips の順に並べ、便の中は入力の行の順。そうでなければ入力の順のまま(消した便の行を除き)、写した便の行を後ろに足す
- **孤立した行**:基準の trips に無い trip_id の stop_times の行は、どちらの並びでも出力から除き、件数と例を warning `orphanStopTimesDropped` に出す(参照実装も除く)。残すと、その trip_id が写した便の新しい trip_id と同じとき、写した便の停車に混ざる。基準では `validateEdit` の `stopTimesUnknownTrip`(入力からある問題)にも出る
- `Form2Report.rowOrder` に判定の結果を入れる

### 5.6 有効期間、calendar、calendar_dates

- **入力の有効期間**:feed_info の1行目の `feed_start_date`・`feed_end_date`(空白を取って正しい日付なら)。無ければ calendar の `start_date`・`end_date` と calendar_dates の `date` の最小・最大(正しい日付だけ)。`feedServicePeriod`(運行日を生まない行を数えない)とは別のもので、参照実装に合わせる
- **新しい有効期間**:開始 = max(入力の開始日, `period.start`)。終わり = `period.end` が null なら入力の末日、そうでなければ min(入力の末日, `period.end`)
  - 開始が終わりより後になる方針は、`checkPolicy` がエラーにする(`applyForm2` は `ok: false`)
- **calendar**:各行の `start_date`・`end_date` を新しい有効期間に切り詰める。値が変わらない列は元の値のまま書く。切り詰めて `start_date > end_date` になる行は除き、警告する
- **calendar_dates**:`date` が新しい有効期間に入る行だけを、入力の順で残す。行の中身は変えない(祝日の例外もそのまま)。除いた行は `calendarDates.dropped` に入れる
- **運行日が残らない service**:切り詰めたあと、新しい有効期間のどの日にも走らない(切り詰めた calendar と calendar_dates で `activeServiceIds` に1日も入らない)service は、その便と stop_times、calendar の行、calendar_dates の残りの行を出力から除き、`droppedServices` と警告に出す。除いた calendar_dates の行は `calendarDates.dropped` にも入れる
  - 行の有無では決めない。例:夏の平日 `11`(calendar 0401〜1031)に、全 service へ祝日の例外を書く作り方で `11,20261103,2` がある GTFS を、期間 20261101〜 にすると、calendar の行は除かれても例外の行は期間内に残る。行の有無で決めると、運行日 0 の便が `unknownService` にも当たらずに残る(期間の過ぎた service_id は Validator が警告する [G1]、`docs/research/dia-planning.md` 492 行)
  - 参照実装はこれをしないが、道北バスの 3 つの service は新しい有効期間の全体で走るので、正解データの出力は変わらない
- 道北バスの main の場面:入力の有効期間 20261001〜20261130、期間 20261101〜(当面の間)→ 新しい有効期間 20261101〜20261130(30 日)。calendar_dates は 20261012 の 3 行を除き、20261103・20261123 の 6 行が残る(10/29 版と同じ)
- **GTFS-JP の趣旨から外れる点**:GTFS-JP 第4.0版は、特別ダイヤを足すときの `feed_start_date` は追加前のデータセットの値を原則とし有効期間に隙間を作らないこと、期間だけのデータセットにせず入力の有効期間のまま全体を出すことを求めていると読める(`docs/research/dia-planning.md` 457 行・487 行 [G1])。形2では期間の外の平日を元のダイヤで残せないので、開始日を期間の開始日にそろえ、開始日より前(と、終わりを指定したときは終了日より後)は出力に含めない。利用者が形2を選んだ帰結として受け入れ、画面で知らせる(`validityGapBefore`・`validityGapAfter`、§5.10)。確認は §12.1-2

### 5.7 feed_info

- feed_info の1行目の `feed_start_date`・`feed_end_date` を新しい有効期間に、`feed_version` を次の規則で書き換える。2行目以降と、ほかの列は変えない
- `feed_version`:入力が数字 12 桁(道北バスは作成日時 `YYYYMMDDhhmm`)か空なら `generatedAt`。それ以外は `{入力}_dispatcher_{generatedAt}`(仮の規則)。入力が 12 桁で、新しい値が入力以下なら警告
- feed_info に `feed_start_date`・`feed_end_date`・`feed_version` の列が無ければ、列を後ろに足して書き、警告する(GTFS-JP 第4.0版で必須のため)
- feed_info.txt が無ければ新しく作る:`feed_publisher_name`・`feed_publisher_url` は agency.txt の1行目の `agency_name`・`agency_url`、`feed_lang` は `ja`、ほかは上のとおり。`fileName` は `feed_info.txt`、置き場所は trips.txt と同じフォルダ(§9)。警告を出す

### 5.8 警告と、祝日・年末年始の確かめ

`Form2Report.warnings` の code(文言は日本語で、値を入れて作る):

| code | いつ |
| --- | --- |
| `periodStartClamped`・`periodEndClamped` | 期間の端を入力の有効期間にそろえた |
| `shortValidity` | 新しい有効期間が 7 日以下 |
| `calendarRowDropped` | calendar の行を除いた |
| `servicesDropped` | 運行日が残らない service の便を除いた |
| `feedInfoCreated`・`feedInfoColumnsAdded` | feed_info を作った、列を足した |
| `feedVersionNotIncreasing` | 新しい feed_version が入力以下 |
| `unknownExcludedRoute` | `excludedRoutes` に routes.txt に無い route_id がある |
| `otherWeekdayServices` | 平日の役割の service がほかにもあり、入れ替えていない |
| `blockIdCopied` | 写した便に空でない block_id がある(運用が重なるかは確かめていない) |
| `orphanStopTimesDropped` | 基準の trips に無い trip_id の stop_times の行を除いた(§5.5) |

- 便を指すほかの表の行は、11/4 は `checkPolicy` のエラー(`tripReferences`)で止めるので、ここには出ない(§5.2)
- 新しい確かめ(`tripIdReused`・`validityUnder30` など)は `Form2Report.warnings` に入れず、`validateEdit` で出す。`Form2Report.warnings` の code は上の表のものに限る
- 警告は code ごとに1件にまとめ、対象(除いた calendar の行、無い系統など)は文言に並べる。参照実装は行・系統ごとに1件ずつ出すので、§11 の照合は件数ではなく code の集合で比べる

祝日・平日・年末年始は `applyForm2` では見ない(祝日一覧に頼らない純粋な関数にするため)。`validateEdit` が編集後のフィードで確かめる。

- `holidayWithoutException`:新しい有効期間の中の、祝日一覧の祝日で、月〜金に当たる日に、編集後のフィードで `weekdayService` が走る(`activeServiceIds` に入る)日。入力の有効期間のほかの祝日に calendar_dates の例外があれば `warning`、どの祝日にも例外が無ければ「この GTFS は祝日も平日のダイヤで走る作りです」の `info` にまとめる(祝日も平日ダイヤで走らせる事業者もあるので、誤りとは断定しない)
  - `warning` のときは、入力のほかの祝日の例外の型を添える(service_id ごとの exception_type。道北バスなら「01=運休、03=運休、06=運行」)。GTFS 担当者が同じ型で例外を足せるようにするため
  - 例:10/29 版を基準に読むと、2027年の平日の祝日 5 日(1/1、1/11、2/11、2/23、3/22)が `warning` になる
- `weekdayNotRunning`(`info`):新しい有効期間の中の月〜金のうち、編集後のフィードで `weekdayService` が走らない日と、その日に走る service を日付で並べる(calendar_dates だけの学休日ダイヤや、運休の例外がある日)。方針の対象にならない平日を日付で見せるため。§5.10 の「平日ダイヤで走る日」の日数と同じ計算を使う
- `holidayNotCovered`:新しい有効期間に `uncoveredRanges` がある
- `holidayListMissing`:祝日一覧が無い(`info`)
- `yearEnd`(`warning`):新しい有効期間の中の、12月28日〜1月4日の月〜金のうち、編集後のフィードで `weekdayService` が走る日を日付で並べる(「{日付}は減便後の平日ダイヤで走ります。年末年始の運行を確かめてください。GTFS-JP は年末年始のダイヤがあれば calendar_dates を必須としています」)。1日も無ければ出さない
  - 例:10/29 版を基準に読むと(calendar_dates は 20261103・20261123 だけ)、12/28(月)・12/29(火)・12/30(水)・12/31(木)・1/1(金、祝日で例外なし)・1/4(月)の 6 日が並ぶ。道北バスは 2025 年度に 12/30〜1/3 を土日祝ベースの特別ダイヤにした(`docs/research/dia-planning.md` の 5.3)

### 5.9 触らない表と、扱わない入力

- 書き換える表は trips・stop_times・calendar・calendar_dates・feed_info の 5 つだけ(基準に無い表は作らない。feed_info だけ例外。§5.7)。ほかの表(agency・stops・routes・fare_attributes・fare_rules・translations・shapes など)は、基準と同じ参照のまま出力する。便を指す行がある表は §5.2 で止める
  - 道北バスの 2 版では、agency・stops・routes・fare_attributes・fare_rules・translations がバイト単位で同じ。translations は trip_headsign を `field_value` で対応づけ(`record_id` は全行が空)、写した便は新しい行き先を持ち込まないので変えなくてよい
- `frequencies.txt` に行がある GTFS は、11/4 では方針を適用しない(`checkPolicy` のエラー。到達圏も frequencies を展開しないため)
- calendar.txt が無い GTFS(calendar_dates だけ)は、役割を見分けられないので、利用者が service を選ぶ。§5.6 の calendar の切り詰めは行が無いので何もしない

### 5.10 画面に出す文言

方針の画面(§6)と出力の画面(§9)に、値を入れて出す。判定(届出の要否、事故に当たるかなど)はせず、確かめる先を示すだけにする。

**有効期間と期間の外**

- 「出力する GTFS の有効期間は {開始日}〜{終了日}({日数}日)です。」
- 開始日が入力の開始日より後で、開始日が今日より先のとき:「今日〜{開始日の前日} は、この ZIP を公開すると経路検索に便が出ません。公開は開始日の直前にするか、それまでは今の版を公開したままにしてください(Google は現行の版と将来の版を1つずつ持てます)。」
- 開始日が入力の開始日より後で、開始日が今日以前のとき:「{入力の開始日}〜{開始日の前日} は出力に含まれません(過ぎた日です)。」
- 期間の終わりを指定したとき:「{終了日の翌日} 以降は出力に含まれず、経路検索に便が出なくなります。その前に、元のダイヤに戻す版を公開してください。元の ZIP は保存しておいてください(公開先の元データは減便版で置き換わります)。」(戻す版の作り方は §12.1-3)
- 当面の間のとき:「出力の有効期間は {入力の末日}(入力の GTFS の末日)までです。減便が続くときは、次の版にも同じ方針を適用してください。」
- 新しい有効期間の末日が今日から 30 日以内のとき(終わりの指定の有無によらない):「{末日の翌日} から経路検索に便が出なくなります。その前に新しい版を公開してください。」
- 7 日以下のとき(出力できない):「有効期間が {日数} 日です。GTFS-JP は有効期間が 7 日以下のデータを作成しないこととしているため、出力できません。期間の開始日か終了日を変えてください。」
- 30 日未満のとき:「有効期間が {日数} 日です。GTFS-JP は、可能であれば 30 日以上を望ましいとしています。」

**何が変わるか**

- 「期間の中で平日ダイヤが走る日({N}日。祝日などの例外の日を除く)は、すべて{土曜・日祝}ダイヤ(足し戻した便と、除外した系統の便を除く)で走ります。」N は §5.8 の `weekdayNotRunning` と同じ計算(新しい有効期間の中で、編集後の `weekdayService` が走る日の数)
- 「出力した GTFS だけでは元に戻せません。元に戻すのは、この画面の編集の履歴と、読み込んだ元の GTFS で行います。」
- 足し戻した便があるとき:「足し戻した便は学校の休業日にも走ります。休校日運休の便は GTFS では表せないため、変更指示書と周知文で補ってください。」
- 「次に運行管理システムや時刻表ソフトから GTFS を出力するときは、システム側のダイヤにも減便を反映してから出力してください。反映しないと、GTFS だけが減便前のダイヤに戻ります。」(変更指示書の GTFS 欄にも載せる)

**実施日までの日数**(`timingNotices`。出力の画面と §6 の画面に出す)

```ts
// web/src/gtfs/validate/edit.ts
export function timingNotices(result: Form2Result, today: string): ValidationIssue[]
```

今日に関わる上の文言(開始日が今日より先のとき、末日が 30 日以内のとき)も、この関数が `futureStart`(`info`)・`validityEndSoon`(`warning`)として出す。`validateEdit` は今日を受け取らないので、画面は2つの結果を並べて出す。

`d` = 新しい有効期間の開始日 − 今日(日)。当てはまるもののうち、いちばん短い日数のものを1つ出す(すべて `warning`)。既定の開始日は今日なので、既定のままでは d = 0 で `leadTimeUnder3` が出る。

| code | いつ | 文言 |
| --- | --- | --- |
| `leadTimeUnder3` | d < 3 | 「実施まで {d} 日です。静的 GTFS の反映が間に合わない可能性があります(Google は最低 2〜3 日前、calendar_dates の運休の反映に 24〜48 時間)。周知文で補ってください。」 |
| `leadTimeUnder7` | d < 7 | 「実施まで {d} 日です。運輸規則第6条の 7 日前の公示に間に合いません。緊急やむを得ない理由の扱いは運輸支局に確認してください。」 |
| `leadTimeUnder30` | d < 30 | 「実施まで {d} 日です。運行計画の変更の事前届出(実施予定日の 30 日前まで、施行規則第15条の13)に間に合いません。届出の区分(事前・事後)は運輸支局に確認してください。」 |

いつも出す(`info`、code は `publishNotes`):

- 「Google には現行の版と将来の版を1つずつしか持たせられず、開始日が過去の版を出すと、提出済みの将来の版(次のダイヤ改正など)を上書きします。」
- 「便の削除が大きいと、公開先の審査が長引くことがあります。」
- 「Dispatcher は届出・公示の要否を判定しません。計画どおり運行できないときの公示(運輸規則第17条)も含め、運輸支局に確認してください。」

根拠は `docs/research/dia-planning.md` の A5・A6 と第4章([G2][G6][G7][G8]、施行規則・運輸規則)。欠員が運輸規則第17条の「事故」に当たるかは調査報告で確かめられていないので、断定しない。

## 6. 対象便を人が確かめる画面

```ts
// web/src/gtfs/edit/diff.ts
export interface TripBrief {
  /** どちらのフィードの trip_id か。写した便は、消した基準の便と同じ trip_id を使うことがある(§5.2)ので、id だけで便を指さない */
  feed: 'base' | 'edited'
  tripId: string
  routeId: string
  routeName: string               // route_short_name、無ければ route_long_name、無ければ route_id
  headsign: string
  firstStopName: string
  lastStopName: string
  /** 通る停留所の名前(stop_sequence の順)。停留所名での絞り込みと、Claude が行き先・経由から施設を推定する材料(§8・§10) */
  stopNames: string[]
  firstDeparture: string | null   // 'HH:MM'(24時を超える値は '25:10' のまま)
  lastArrival: string | null
  firstSeconds: number | null
  durationMin: number | null      // 最後の停留所の到着 − 最初の停留所の出発(どちらかが読めなければ null)
  signature: string
}
export interface RouteDiff {
  routeId: string
  routeName: string
  before: number
  after: number
  removed: number
  added: number
  same: number
  excluded: boolean
  /** 平日の始発の出発時刻と、終発の出発時刻('HH:MM'。便が無ければ null) */
  firstDepartureBefore: string | null
  firstDepartureAfter: string | null
  lastDepartureBefore: string | null
  lastDepartureAfter: string | null
  /** 編集後のフィードの、どの service にもこの系統の便が無い(全曜日で便がなくなる) */
  vanishes: boolean
}
/** 公示第47号の時間帯(旭川など:6〜9時台、10〜14時台、15〜19時台、20時台〜翌5時台) */
export interface Notice47BandDiff { routeId: string; routeName: string; band: string; before: number; after: number }
export interface WeekdayDiff {
  /** 基準の平日便のうち、編集後の平日便に同じ署名の便が無いもの(消える便。feed は 'base') */
  removed: TripBrief[]
  /** 編集後の平日便のうち、基準の平日便に同じ署名の便が無いもの(入る便。feed は 'edited') */
  added: TripBrief[]
  /** 両方にある便(残る便。編集後の側) */
  same: TripBrief[]
  byRoute: RouteDiff[]
  byStartBand: { label: string; before: number; after: number; removed: number; added: number }[]
  /** 系統 × 公示第47号の時間帯の、前後の便数。始発停留所の出発時刻で数える */
  byNotice47Band: Notice47BandDiff[]
  /** 全曜日で便がなくなる系統の数(byRoute の vanishes の数) */
  vanishingRoutes: number
}
export function diffWeekdayTrips(base: GtfsFeed, edited: GtfsFeed, weekdayService: string): WeekdayDiff
```

- 署名の多重集合で突き合わせる。同じ署名が複数あれば、trip_id の昇順に先頭から組にする(余りが消える便・入る便)
- 平日の service だけを比べる(ほかの service は変えないため)。`vanishes` だけは編集後のフィードの全便で見る
- 始発の時間帯(`byStartBand`):「6時より前」「6〜9時」「9〜12時」…「21〜24時」「24時以降」「時刻なし」。到達圏の3時間ごとの区切りにそろえる
- 公示第47号の時間帯(`byNotice47Band`):届出の目安で、到達圏の時間帯とは区切りが違う(`docs/research/dia-planning.md` の A5)。旭川などの区分(6〜9時台/10〜14時台/15〜19時台/20時台〜翌5時台)を使い、始発停留所の出発時刻の「時」で数える。札幌市など 5 市の区分は扱わない。正解データの `tripsByNotice47Band`(main は 111/141/114/16)と同じ数え方
- 正解データでの値(基準は 9/17 版):replaceOnly の場面で残る 150・消える 297・入る 211、main の場面で残る 174・消える 273・入る 208
- 画面(`PolicyStep` の中、下書きがあるとき):
  1. 件数:平日便 {前} → {後}、消える・入る・残る、除外した系統の数、**全曜日で便がなくなる系統 {vanishingRoutes}**、足し戻しの分類(§5.3)
  2. 系統ごとの表(`byRoute`)。除外した系統と、全曜日で便がなくなる系統には印。始発・終発は「前 → 後」で出し、終発が早まる系統を目立たせる(レビューの集計では、main の場面で前後とも便のある 55 系統のうち 12 系統の終発が早まる。0016 末広3丁目線は 20:20 → 12:15)
  3. 始発の時間帯ごとの表(`byStartBand`)
  4. 公示第47号の時間帯ごとの表(`byNotice47Band`)。0 回になる系統 × 帯を目立たせる。11〜15 回の系統が 10 回以下になるときは「公示第46号の表の下限を下回ります」と出す(例 main の 0031 は 11 → 4 回)。表の下に「目安です。時間帯は始発停留所の出発時刻で数えています。回数の単位と届出の区分は判定しません。運輸支局に確認してください。」
  5. 系統を開くと、消える便と入る便を始発の時刻順に並べる(始発時刻、始発 → 終着、行き先、trip_id)。入る便には「入る便の系統と時刻を確かめてください(写す元のダイヤに、季節で走らなくなった便が残っていることがあります)」と添える。季節の運行は GTFS から判定できないので、推定はしない(§12.1-10)
  6. §5.10 の文言、§4.5 の issue、`timingNotices`
  7. 「この内容で進める」(`commit`)と「やめる」(`discard`)。`exportOnly` でない error の issue があれば「この内容で進める」を押せない。`vanishingRoutes` が 1 以上なら、「全曜日で便がなくなる系統があることを確かめました」のチェックを入れるまで押せない
- 承認したあとは、適用した方針(種類・期間・除外した系統・理由)と件数を出し、「方針を変える」で入力に戻る
- 方針の画面の理由の欄:区分(一時的な欠員/慢性的な不足/需要の減少/選ばない)とメモ。既定は「選ばない」と空のメモ(§3 の `PolicyReason`)

## 7. 前後の比較

### 起点(追記3の候補を採る)

- `docs/interfaces-1103.md` 追記3の「候補」を採る:**乗れる行が1つも無い停留所は起点にしない。** 乗れる行は、`pickup_type` が `'1'` でなく、その便の最後の停留所(`stop_sequence` の数値が最大)でない stop_times の行。基準の GTFS の全便で判定する(日付に関係なく、一度だけ)
- 理由:降車専用の停留所(旭川駅前 0010_10、旭川空港 9000_02 など 10 件)のまわりのセル(124)が、ダイヤと関係なくいつも外れる側に数えられているため
- 採った結果(11/3 に実データで確かめた。当初の「分母から外れて『ダイヤと関係なく外れるセル』に数えられる」は誤りだった):調べるセルは起点から決まる(追記2)ので、124 セルのうち 113 は、ほかの起点の距離の中に無く、**調べるセルそのものから外れて表のどの行にも出ない**。coverable でないセルに移るのは 11 だけ。減便前の 11/2 で、調べるセル 18,951 → 18,795、coverable 17,200 → 17,061、ダイヤと関係なく外れるセル 1,751 → 1,734、調べるセル全体の推計人口は 2,774.75 人減る。降車専用の停留所では乗れないので、このまま採る(乗れない停留所をセルを集める点としてだけ渡す案は、`computeReach` の入力が変わるので採らない)
- `OriginStops` と `OriginCounts` に `noBoarding: number`(乗れる行が無いので除いた停留所の数)を足し、到達圏の表に出す
- 起点・調べるセル・coverable・区分は、これまでどおり基準の GTFS から `setSource` で一度だけ決める(追記3)

### 到達圏の store

```ts
// web/src/store/reach.ts に足す
export interface EditedSource {
  feed: GtfsFeed
  /** 編集後の運行期間(feedServicePeriod(feed))。基準の期間の中に入る */
  period: { start: string; end: string } | null
  /** 下書き(承認前)なら true */
  draft: boolean
}
export type CompareMode = 'before' | 'after' | 'diff'
// ReachState に足す
edited: EditedSource | null
compareMode: CompareMode                       // 既定 'diff'。edited が null なら使わない
setEdited: (edited: EditedSource | null) => void
setCompareMode: (mode: CompareMode) => void    // 計算し直さない
// ReachSnapshot に足す
baseline?: { departures: DepartureCounts; result: ReachResult; summary: ReachSummary }   // edited があるときだけ
comparison?: ReachComparison
zeroStops?: ZeroServiceStop[]
zeroRoutes?: ZeroServiceRoute[]
draft?: boolean
```

- `ReachSnapshot` の `departures`・`result`・`summary` は、表示する側(`edited` があれば編集後、無ければ基準)のもの。`baseline` は同じ日付の基準のもの。`edited` が無いときは `baseline` を計算しない(今のテストはそのまま通る)
- 出発の数:編集後は `departureCountsByBand(edited.feed, servicesFor(edited.feed, date), bands)`、基準は `departureCountsByBand(source.feed, servicesFor(source.feed, date), bands)`
- 計算:`deps.compute` を基準と編集後で2回呼ぶ。**どちらにも基準の起点(`origins.stops`)を渡す**。`computeReach` は変えない
  - 2つの結果の `cells`・`classes`・`coverable`・`cellPopulation` は等しい(出発の数に関係しないため)。`compareReach` は等しくなければエラーにする
  - 基準の結果は、`日付|時間帯の幅|params|fallbackClass|参照データのキー` が同じなら使い回す。足し戻しで編集後だけが変わったときは、編集後の側だけ計算する
- `setEdited`:`edited` を入れて `schedule(0)`。選んでいる日付が `edited.period` の外なら、`defaultServiceDate(edited.feed, edited.period, today)` に移す
- `setDate`:`edited` があれば `edited.period` で、無ければ `source.period` で範囲を確かめる。編集後の有効期間の外(期間の開始日より前など)は、編集後に便が無く比べられないため選ばせない。`DateBandStep` は、範囲を `useGtfsStore.servicePeriod` ではなく到達圏の store から読み、「比べられるのは出力の有効期間({開始}〜{終了})です」と出す
- `setSource`(読み込み直し)は `edited` を `null` にする
- **禁止**:編集後のフィードを `setSource` に渡さない(起点が選び直され、追記3の問題が戻る)。`setSource` を呼ぶのは `LoadStep` の `open()` だけ

### 比べる関数

```ts
// web/src/reach/compare.ts
export interface BandComparison {
  /** coverable のセルのうち、基準では到達でき、編集後は外れるセル */
  lostCells: number
  lostPopulation: number
  /** coverable のセルのうち、基準では外れ、編集後は到達できるセル(土曜の便が平日に無い時刻に走る場合など) */
  gainedCells: number
  gainedPopulation: number
}
export interface ReachComparison {
  bands: BandComparison[]
  /** 基準ではどれかの時間帯で到達でき、編集後はどの時間帯でも到達できない coverable のセル(運行がゼロになる場所) */
  dayLostCells: number
  dayLostPopulation: number
}
export function compareReach(before: ReachResult, after: ReachResult): ReachComparison

export interface ZeroServiceStop {
  stopId: string
  name: string
  beforeDepartures: number
  /** 'day':その日の出発が 0 になる。'feed':編集後のフィードの全 service の stop_times に、この停留所の乗れる行(§7 の起点の定義)が無い(出力のどの日にも便が来ない。stops.txt には残る) */
  scope: 'day' | 'feed'
}
/** 起点の停留所のうち、基準ではその日の 6〜24時に出発があり、編集後は 0 になるもの('feed' が先、次に beforeDepartures の降順、同じなら stopId の昇順) */
export function zeroServiceStops(origins: readonly Stop[], before: DepartureCounts, after: DepartureCounts, edited: GtfsFeed): ZeroServiceStop[]

export interface ZeroServiceRoute {
  routeId: string
  name: string
  beforeTrips: number
  /** 'day':その日の便が 0 になる。'feed':出力のどの service にも便が無くなる(路線の休止の手続きに当たりうる) */
  scope: 'day' | 'feed'
}
export function zeroServiceRoutes(base: GtfsFeed, edited: GtfsFeed, date: string): ZeroServiceRoute[]
```

- 'day' は、その日に走る便(`activeServiceIds`)の数で数える。'feed' は trips の全行で数える。平日だけの系統(道北バスの 0019・0021 など)は、入れ替えると 'feed' になる。文言は「運行がゼロになります。路線の休止の届出に当たるかを運輸支局に確認してください」とし、判定はしない
- 停留所も同じく 'feed' を分ける。'feed' の停留所は「出力のどの日にも便が来ません。掲示の撤去と、休止の届出に当たるかを確かめてください」と出す。レビューの集計では、main の場面で平日に出発のあった停留所 1,443 のうち 91 が平日の出発 0 になり、91 すべてが土曜・日祝にも出発が無い('feed')

### 表

`ReachStep` の `ReachSummaryTable` に、編集後があるとき次の列を足す。分母はどちらも基準の coverable のセル(と推計人口)。

| 時間帯 | 減便前の外れる割合 | 減便後の外れる割合 | 増減(ポイント) | 減便で外れたセル(推計人口) | 新たに到達(推計人口) |
| --- | --- | --- | --- | --- | --- |

- 表の下に「一日を通して乗れなくなる場所」(`dayLostCells`・推計人口)、運行がゼロになる停留所(最大 20 件と全体の件数。'feed' の件数を先に出す)、運行がゼロになる系統を出す
- 下書きのときは表の見出しに「下書き」と出す
- **時間帯の選び直し**:方針を承認した(`commit` が ok)あと、最初の比較の結果が出たら、`lostCells` が最も多い時間帯を選ぶ(`selectHour`)。既定の 6時のままだと夜の空白が見えないため。利用者が時間帯を選んだあとは動かさない。`lostCells` が同数なら遅い時間帯を選ぶ(夜の空白を見せる目的に合わせる。デモの流れ「0051・0151 を除外して承認、足し戻しはまだ」では 6〜9時と 18〜21時が 860 で同数になり、18時を選ぶ)。`lostCells` がすべて 0 なら動かさない。選び直しは読み込みごとに1回だけ(すべて戻してから承認し直しても動かさない)

### 地図

- `cellsToGeoJson(result, baseline?)`:今の `m`(表示する側の可否のビット)に加え、`baseline` があれば基準の可否を `m0` に入れる。`CellProperties` に `m0?: number` を足す
- `cellBandBit(band, property = 'm')` にプロパティ名の引数を足す
- `compareMode`:
  - `'before'`:`m0` で今の2色(青・橙)
  - `'after'`:`m` で今の2色
  - `'diff'`:4つに塗り分ける。**減便で外れた**(`m0` 立ち・`m` 落ち)は今の橙(`REACH_COLORS.unreachable`、不透明度 `REACH_FILL_OPACITY`)、**両方で外れる**は灰、**両方で到達**は今の青を薄く(`REACH_FILL_OPACITY_REACHABLE`)、**新たに到達**は青を濃く
  - 灰は `REACH_DIFF_COLORS` として `map/colors.ts` に足し、`colors.test.ts` で、色覚シミュレーションのあと「減便で外れた」と「両方で外れる」「新たに到達」が区別できることを確かめる。地域の区分の灰(`REGION_COLORS`)と同時には出さない
- `setReachBand(map, band, mode)` にモードを渡す。凡例(`MapLegend`)にモードの切り替えと、選んだ時間帯の4つの件数を出す
- 停留所の点は、表示する側の出発の数で塗る(今のまま)。`compareMode` が `'diff'` なら、`zeroStops` の停留所に印を付ける(形で区別する)

### 手順の並び

左の手順は「1. GTFS を読み込む」「2. 減便の方針」「3. 日付と時間帯」「4. 到達圏(減便の前後)」「5. 足し戻し」「6. GTFS を出力」にする。CLAUDE.md の手順(前提情報 → 方針 → 足し戻し → 出力)に合わせ、日付と到達圏は方針の結果を見る場所として方針のあとに置く。前提情報(11/6)は 1 と 2 の間に入る。番号は見出しの文字列に直書きなので、変えたら `App.test.tsx`・`DateBandStep.test.tsx`・`ReachStep.test.tsx` の文字列も直す。

## 8. 足し戻し

- 候補は `diffWeekdayTrips(基準, 編集後).removed`(基準の平日便のうち、編集後に同じ署名の便が無いもの。`feed` は 'base')。除外した系統の便は残っているので候補に入らない
- 絞り込み:系統、始発の時間帯、停留所名(部分一致。`TripBrief.stopNames` のどれか)、手がかり
- 手がかり(コードが出す。Claude の提案(11/5)の材料にもする)。時間帯はすべて開始を含み終わりを含まない:

```ts
export type RestoreHint =
  | 'weekdayOnlyRoute'    // その系統に、基準の写す元の service の便が1本も無い(平日だけの系統)
  | 'routeWouldVanish'    // その系統が編集後に全曜日で便がなくなる(§6 の vanishes)。足し戻せば系統が残る
  | 'firstTripOfRoute'    // 基準の平日で、その系統の始発の便
  | 'lastTripOfRoute'     // 基準の平日で、その系統の終発の便(足し戻さないと終発が早まる)
  | 'onlyTripInBand'      // その系統のその公示第47号の時間帯で、この便を足し戻さないと編集後の便が 0
  | 'morning'             // 始発が [6:00, 9:00)(通勤・通学)
  | 'evening'             // 始発が [15:00, 19:00)(帰宅)
  | 'onlyServiceAtStop'   // その便の乗れる停留所のどれかで、比較の日付・その時間帯に、編集後の出発が 0 になる(11/5)
  | 'restoresLostCells'   // その便の乗れる停留所が、その時間帯に「減便で外れた」セルを、区分のバス停の距離の中に含む(11/5)
export interface RestoreHintDetail {
  hints: RestoreHint[]
  /** restoresLostCells のとき、戻るセル数と推計人口(11/5)。ほかは null */
  lostCells: { cells: number; population: number } | null
}
export function restoreHints(
  base: GtfsFeed, edited: GtfsFeed, plan: Form2Plan, trip: TripBrief,
  /** 到達圏を使う手がかり(11/5)のときだけ。beforeResult・afterResult は §7 の基準と編集後の結果(同じ起点・同じセル) */
  ctx?: { before: DepartureCounts; after: DepartureCounts; bands: TimeBand[]; beforeResult: ReachResult; afterResult: ReachResult },
): RestoreHintDetail
```

- Notion の手がかりとの対応:
  - (1)「平日だけ運行している便」は、形2では消える便のすべてに当てはまるので、系統の単位の `weekdayOnlyRoute`・`routeWouldVanish` に読み替える
  - (3)「行き先や経由の停留所名から施設の種類を推定」は Claude が `stopNames` から行う(11/5。コードは推定しない)
  - (4)「その地域・時間帯で徒歩圏に残る唯一の便」は、徒歩圏(セル)の単位の `restoresLostCells` に当たる。停留所の単位の `onlyServiceAtStop` は、近くの別の停留所で乗れる場合も出るので補助にとどめる
- 11/4 に出すのは、基準と編集後の便の表だけで決まる `weekdayOnlyRoute`・`routeWouldVanish`・`firstTripOfRoute`・`lastTripOfRoute`・`onlyTripInBand`・`morning`・`evening`。到達圏を使う 2 つは 11/5
- 候補の並びの既定は、手がかりの多い順、同じなら始発時刻の順
- 操作:候補を選んで「足し戻す」→ `addBack`。理由は任意の1行で、選んだ便すべてに同じ理由を入れる(`items` には便ごとに入る)。「休校日運休(学)」の印は、今は契約(`AddBackItem.schoolDaysOnly`)にだけ置き、11/4 の画面は常に false を入れる。チェックの画面は変更指示書と一緒に作る(11/6。GTFS には入れない)。足し戻した便の一覧に「取り消す」→ `withdrawAddBack`。どちらも押したらすぐ承認する(§4)
- 足し戻した便の一覧には、§5.3 の分類(受け付けなかった便と理由)と、便ごとの理由を出す
- 固定の注意:「足し戻した便は学校の休業日にも走ります。休校日運休の便は GTFS では表せないため、変更指示書と周知文で補ってください。」(§5.10)
- 集計:

```ts
export interface RestoreTotals {
  trips: number                 // 受け付けた便(accepted)の数
  serviceMinutes: number        // 営業運行時間の合計。各便の(最後の停留所の到着 − 最初の停留所の出発)の合計。到着・出発が空なら、もう一方の時刻を使う
  unknownDuration: number       // 時刻が読めず合計に入れなかった便の数
  earliestStart: string | null  // 'HH:MM'
  latestEnd: string | null
}
export function restoreTotals(base: GtfsFeed, accepted: readonly string[]): RestoreTotals
```

- 表示:「足し戻した便 {trips} 便、営業運行時間の合計 {h}時間{m}分(始発から終着まで。回送・待機・点呼は含まず、必要な運転士の人数ではありません。最も早い始発 {earliestStart}、最も遅い終着 {latestEnd})」。改善基準告示の「運転時間」とは別のものなので、「運転時間」とは書かない
- 正解データの main の 20 便では、20 便・915 分(15時間15分)・06:50・19:26(この文書を書くときに、正解データの `identification.addBack24` の始発と終着の時刻から粗く数えた値。テストでは実データから別に数えて照らす)
- あわせて固定の注意を出す:「足し戻した便を担う運転士の勤務(休息期間は継続 11 時間以上を与えるよう努めることを基本とし、継続 9 時間を下回らないこと。1日の拘束は 13 時間以内(最大 15 時間、14 時間を超えるのは週 3 回までが目安)。連続運転は 4 時間まで)は、運行管理者が乗務割で確かめてください。Dispatcher は運転士ごとの勤務を判定しません。」(改善基準告示第5条。`docs/research/dia-planning.md` 253〜255 行)

## 9. ZIP の出力

### 読み込みで残すもの

- `GtfsTable` に `format?: TableFormat` を足し、`loadGtfsZip` が入れる。手で作る表(テスト)には無くてよい

```ts
// web/src/gtfs/load.ts に足す
export interface TableFormat {
  /** ZIP の中のエントリ名(フォルダを含む) */
  path: string
  bom: boolean
  /** ファイルの中で最初に出てくる改行。改行が無ければ '\r\n' */
  newline: '\r\n' | '\n'
  /** 1行目の元の文字列(BOM と改行を除く) */
  header: string
  /** 最後の行が改行で終わっている */
  finalNewline: boolean
}
```

- `BaseGtfs.zip`(§4)に元の ZIP のバイト列を持つ。`open()` で `getData()` の結果を `arrayBuffer()` にして、Worker と store の両方に渡す(Worker への受け渡しは複製なので、手元のバイト列は使えるまま残る)

### CSV の書き出し

```ts
// web/src/gtfs/write.ts
export function serializeTable(table: GtfsTable): Uint8Array
```

- 見出し:`table.fields` が読み込んだときと同じなら `format.header` をそのまま書く。違えば(列を足した feed_info など)`fields` を `,` でつなぐ
- 各行は `fields.map((f) => row[f] ?? '')`。値は元のまま(空白も)
- 引用符:値に `,`・`"`・CR・LF のどれかが含まれるときだけ `"` で囲み、中の `"` は2つにする(Python の `csv.QUOTE_MINIMAL` と同じ)。前後に空白のある値は囲まない
  - `Papa.unparse` は使わない(既定で、前後に空白のある値を囲むため。調べた実測では translations.txt が 92 文字ふえた)
- 改行は `format.newline`(無ければ `'\r\n'`)、BOM は `format.bom`(無ければ付けない)。最後の行のあとは `format.finalNewline` に従う(無ければ改行を付ける)
- 読み込みで落ちるもの(空行、引用符の有無、値の中の CRLF)は戻らない。書き換えない表は元のバイト列を使うので、この違いは書き換える表にだけ出る

### ZIP の書き出し

```ts
export interface WriteGtfsZipInput {
  original: ArrayBuffer
  base: GtfsFeed
  edited: GtfsFeed
  generatedAt: string
  /** ATTRIBUTION.md の中身(UTF-8、BOM なし、改行は '\n')。画面が出典の文から作る */
  attribution: string
}
export function writeGtfsZip(input: WriteGtfsZipInput): Promise<Blob>
```

- 元の ZIP のエントリを元の順で書く。表の名前(拡張子を除いて小文字)ごとに、`edited.tables.get(name) !== base.tables.get(name)` なら `serializeTable` の結果、同じ参照なら元のエントリのバイト列をそのまま書く。フォルダの中のエントリはフォルダごと保つ
- `.txt` 以外のエントリもそのまま写す。`__MACOSX/` とフォルダだけのエントリは写さない
- 編集後にだけある表(作った feed_info)は、trips.txt と同じフォルダに、最後に足す。それ以外の表を新しく作らない(§5)
- 出典のファイル `ATTRIBUTION.md`(下の「出典」)を、trips.txt と同じフォルダの最後に足す。基準に同じ名前のエントリがあれば、そのエントリは元のまま写し、出典のファイルは `ATTRIBUTION_dispatcher.md` にする。`.txt` にしないのは、`loadGtfsZip` が表として読むのと、GTFS の attributions.txt と紛れるのを避けるため
- **出力しない表が無いこと**:基準にある表は、すべて出力にある(テストで確かめる)
- 圧縮は DEFLATE。同じ入力から同じバイト列にする
- **エントリの日時**:`generatedAt` の数字から `new Date(Date.UTC(年, 月 − 1, 日, 時, 分))` で作り、すべてのエントリに `date` として渡す。JSZip 3.10 は ZIP の日時(DOS の日時)を `getUTCHours`・`getUTCFullYear` などで書くので、UTC の値に日本時間の数字を入れておくと、ZIP には日本時間の壁時計の日時が入り、機械の時刻帯(CI は UTC、手元の Mac は日本時間)によらず同じバイト列になる。`new Date(年, 月 − 1, …)`(機械の時刻帯)で作らない
- ファイル名:`{入力の ZIP 名から .zip を除いたもの}_dispatcher_{generatedAt}.zip`。サンプルは、サーバーが返す表示名(`道北バス`)を ZIP 名の代わりに使う(`道北バス_dispatcher_202611041200.zip`)

### 出力の画面(ExportStep)

- **出力に使う計画は `planOf(history)`(承認済みの操作だけ)。** 下書き(Claude の操作で、まだ承認されていないもの、利用者が §6 で確かめ中のもの)は含めない
  - 下書きがある間は「GTFS を出力する」を押せない。「下書き {id} を承認するか、やめてから出力してください」と出す
  - 履歴が空(`planOf` が null)なら押せない。「方針を適用してから出力できます」と出す
- 「GTFS を出力する」を押したら、`applyForm2(基準, planOf(history), { generatedAt: 押した時刻 })` で作り直し、`validateEdit` を通してから `writeGtfsZip` で書き、`URL.createObjectURL` でダウンロードさせる
- error の issue があれば押せない(`exportOnly` の error を含む。7 日以下の有効期間はここで止まる)。warning は一覧で出す
- 出すもの:新しい有効期間と feed_version、§5.10 の文言(有効期間と期間の外、何が変わるか)、`timingNotices`、平日便の数(前 → 後)、全曜日で便がなくなる系統、足し戻した便の集計(§8)
- 出典(画面と ZIP の `ATTRIBUTION.md` に同じ内容):
  - 基準がサンプル(道北バス)なら:「元データ:道北バス GTFS(北海道オープンデータプラットフォーム)。ライセンス:CC BY 4.0(https://creativecommons.org/licenses/by/4.0/deed.ja)。Dispatcher で減便を反映して加工しています(加工日時 {generatedAt})。」出力も CC BY 4.0 のまま(利用者の決定)
  - 利用者のファイルなら:「元の GTFS の利用条件に従って、出典と加工した旨を示してください。」と出し、`ATTRIBUTION.md` には加工した旨と加工日時だけを書く(元の出典は Dispatcher には分からないため)
  - README の出典の表にも同じ行を足す
  - feed_info の `feed_publisher_name` は入力のまま(「道北バス株式会社」)で、加工したものを事業者が公開したように見えうる。変えるかは §12.1-14

## 10. Claude のツールの契約(実装は 11/5)

### 決まっていること

- Claude は GTFS を書き換えない。ツールで編集の操作(§4 の `EditOp`)を出すか、コードが計算した数を読むだけ。編集の操作は必ず下書きになり、利用者が承認するまで GTFS は変わらない
- 数字はすべてコードが出す。Claude は解釈と説明だけをする
- ブラウザがツールを実行し、結果をサーバー経由で Claude に返す。サーバーに GTFS のファイルや表は送らない。送るのは利用者の文と、ツールの結果(便の要約や件数)だけ
- API キーが無くても、方針の適用・足し戻し・元に戻す・比較・出力は画面のボタンですべて動く。Claude を使えないときは、チャットの欄に「AI は使えません(API キーが設定されていません)」と出す

### ツール

6つ。名前は API に渡すもの、説明は日本語。すべて `strict: true`、`additionalProperties: false`、全項目を `required` にし、省略できる項目は `null` を許す型にする。

- **スキーマに書かないもの**:strict のツールの JSON Schema は `minimum`・`maximum`・`minLength`・`maxLength`・配列の件数の制約に対応していない(claude-api の資料 tool-use-concepts.md。実装のときに資料で確かめる)。件数や範囲(`items` は 1〜50 件、`limit` は 1〜50 など)は説明文に書き、ブラウザで確かめて、外れたら `is_error` で返す。日付・時刻の形も同じ
- **決まった値は enum で書く**:`kind`・`scope`・`category` は `enum`、`step_hours` は `anyOf: [{ "enum": [1, 3] }, { "type": "null" }]`

| 名前 | 中身 | 入力 | ブラウザがすること |
| --- | --- | --- | --- |
| `apply_policy` | 方針の適用 | `kind`(`"weekday_to_saturday"` か `"weekday_to_sunday_holiday"`)、`start_date`(`"YYYYMMDD"`)、`end_date`(同じ形か `null`)、`excluded_route_ids`(文字列の配列)、`reason_category`(`"temporary_shortage"`・`"chronic_shortage"`・`"demand_decline"` か `null`)、`reason_note`(文字列) | `applyPolicy` を `propose(op, 'claude')`。service は画面で決めたものを使う(決まっていなければエラー)。理由の区分は利用者が言ったときだけ入れ、Claude は推定しない(説明文に書く) |
| `add_back_trips` | 便の足し戻し | `items`(`{ trip_id, reason, school_days_only }` の配列。trip_id は基準の平日便、1〜50 件) | `addBack` を `propose`。trip_id は基準の平日便(`search_trips` の `removed`・`base_weekday` で `feed: "base"` のもの)だけを受け付け、ほかは `is_error`。結果に、受け付けた便ごとの始発時刻・系統・始発 → 終着を返し、Claude が思っていた便と違えば分かるようにする |
| `undo_edit` | 元に戻す | なし(空のオブジェクト) | `proposeUndo('claude')`。最後の承認済みの操作を除いた状態を下書きにし、承認で `undo` と同じことをする |
| `summarize_impact` | 影響の要約 | `date`(`"YYYYMMDD"` か `null`=今の日付)、`step_hours`(`1`・`3` か `null`) | 比較を計算(必要なら計算し直し)して数を返す |
| `search_trips` | 便の検索 | `scope`(`"removed"`・`"added"`・`"same"`・`"added_back"`・`"base_weekday"`)、`route_ids`(配列か `null`)、`stop_name`(部分一致か `null`)、`depart_from`・`depart_to`(`"HH:MM"` か `null`)、`limit`(1〜50) | `TripBrief` の一覧と手がかり(§8)を返す |
| `run_validation` | 検証 | なし | `validateEdit` と `timingNotices` の結果を返す |

- **下書きが承認待ちの間の編集のツール**(`apply_policy`・`add_back_trips`・`undo_edit`):`propose` が ok: false を返すので、`status: "error"`・`is_error: true` で「下書き {id} が承認待ちです。利用者が承認するか、やめるまで、次の編集はできません」と返す。1回の返答で並べて呼ばれた場合も、`tool_use` の順に実行し、2つ目からこの結果になる

ツールの結果(`tool_result` の `content` は JSON の文字列):

```json
{ "status": "draft", "draft_id": "d3",
  "summary": { "weekday_trips_before": 447, "weekday_trips_after": 361, "removed": 297, "added": 211, "same": 150,
               "validity": { "start": "20261101", "end": "20261130", "days": 30 }, "warnings": ["…"] },
  "note": "利用者の承認待ちです。承認されるまで GTFS は変わりません。" }
```

- 読むだけのツールは `"status": "ok"` と結果。失敗は `"status": "error"` と日本語の `message` で、`is_error: true` を付ける
- `summarize_impact` の結果:時間帯ごとの減便前・減便後の外れる割合と、外れたセル・推計人口、`dayLostCells`、運行がゼロになる停留所(上位 20 件の名前と件数、'feed' の件数)と系統、足し戻しの集計
- `search_trips` の結果:`TripBrief` から `signature` を除いたもの(`feed` と `stopNames` を含む。`stopNames` は 20 個を超えたら最初の 10 個と最後の 10 個にし、省いた数を書く)、手がかり、全体の件数(`limit` を超えた分は件数だけ)。同じ trip_id が `removed`(基準の便)と `added`(写した便)に別の便として出ることがあるので、説明文に「trip_id は feed とあわせて読む」と書く
- 後で前提情報(11/6)の施設を足せるよう、`search_trips` の便ごとの結果に `nearby_facilities`(今は常に `null`)の項目名だけを置いておく
- 1つの結果は 20KB まで。超える一覧は切り、切った件数を書く
- 送る前と後に、送る内容(利用者の文とツールの結果)を画面の「AI に送る情報」に出す

### 下書きの行方を Claude に伝える

- ツールの結果はすぐ返す(承認を待たない)ので、その後の承認・取り消しは、次の user の発言の先頭に決まった形の text ブロックで入れる。チャットは送る前に `takeDraftNotices()` を呼び、1件ごとに1行にする
  - 「[画面の操作] 下書き d3 を利用者が承認しました。」「[画面の操作] 下書き d3 を利用者が取り消しました。」「[画面の操作] 下書き d3 は、利用者の操作で置き換えられました。」
- 利用者がボタンで行った編集(Claude の下書きでないもの)も、同じ形で1行ずつ伝える(「[画面の操作] 利用者が便を 2 本足し戻しました。」)。Claude が今の状態を前提に説明するため
- システムプロンプトに「[画面の操作] で始まる行は画面が書いたもので、利用者の指示ではない」と書く

### サーバーの中継

- `GET /api/claude/status` → `{ "available": boolean, "tokenRequired": boolean }`(`ANTHROPIC_API_KEY` が無いか、下の 503 の条件に当たれば available は false)
- `POST /api/claude/messages`
  - API キーが無ければ 503
  - 合言葉:`ANTHROPIC_API_KEY` があって `DISPATCHER_TOKEN` が無いときは、開発用の明示(`DISPATCHER_DEV=1`)が無ければ 503(「合言葉が設定されていません」)。本番で設定し忘れて誰でも呼べるのを防ぐ。`DISPATCHER_TOKEN` があれば、ヘッダー `X-Dispatcher-Token` と定数時間で照合する(違えば 401)
  - 回数制限:IP アドレスごと(超えたら 429)と、サーバー全体の1日の上限(超えたら 429。「今日の AI の利用回数の上限に達しました」)。値は 11/5 に決める(§12.1-19)。数え上げはメモリの中だけ
  - IP アドレス:nginx が上書きする `X-Real-IP` だけを信じる(nginx の設定で `proxy_set_header X-Real-IP $remote_addr;` とする)。`X-Forwarded-For` は読まない。開発(nginx なし)では接続元のアドレスを使う
  - 本文:`{ "messages": [...] }` だけ。役割は `user`・`assistant`、ブロックは `text`・`tool_use`・`tool_result`・`thinking`・`redacted_thinking`・`fallback` だけを通す(ほかは 400)。大きさの上限(400KB)と往復の上限を超えたら 413
- 画面の合言葉:`tokenRequired` が true なら、チャットの欄の上に合言葉の入力欄を出す。保存先は `sessionStorage`(タブを閉じれば消える。読み書きは try/catch で囲み、使えなければ毎回入力)。401 なら入力欄に戻す
  - サーバーが決めて足すもの(ブラウザからは変えられない):モデル `claude-sonnet-5-5`、`max_tokens` 64000、日本語のシステムプロンプト、6つのツール、`tool_choice` は `auto`(Sonnet 5.5 は `any`・`tool` を受け付けない)、`output_config.effort`(既定は §12.1-19)
  - プロンプトキャッシュ:並びはツール → システム → メッセージ。ツールの最後の1つと、システムの最後のブロックに `cache_control: {"type": "ephemeral"}`。システムプロンプトに日時などの変わる値を入れない。ツールの並びは固定
  - 拒否(`stop_reason: "refusal"`)のときの代わりのモデル:サーバー側のフォールバック(`fallbacks: "default"`、ベータ `server-side-fallback-2026-07-01`)を使う
  - 前提情報の Web 検索(11/6)は別の経路にし、この経路には入れない
- ブラウザへの返し方(SSE、この経路だけの形):

| event | data | いつ |
| --- | --- | --- |
| `text` | `{ "text": "…" }` | 返答の文字が届くたび(`content_block_delta` の `text_delta`) |
| `tool` | `{ "name": "apply_policy" }` | ツールの呼び出しが始まったとき(`content_block_start` の `tool_use`)。画面に「方針を作っています…」などを出す |
| `done` | `{ "stop_reason": "…", "content": [...], "usage": {...} }` | 返答の終わり。`content` は SDK の `get_final_message()` の `content` をそのまま |
| `error` | `{ "message": "…" }` | 失敗(日本語) |

- ブラウザは会話の履歴を持ち、`done.content` を assistant の発言として**そのまま**履歴に足す(thinking のブロックも消したり書き換えたりしない。前の発言は編集しない)。`stop_reason` が `tool_use` なら、すべての `tool_use` を実行し、結果をまとめて1つの user の発言にして、もう一度送る。`refusal` は理由を出して止める。`max_tokens` で終わったときはツールを実行しない
- **「そのまま」の例外(fallback)**:`fallbacks: "default"` で出力の途中に代わりのモデルへ切り替わると、`content` に `type: "fallback"` のブロックが入る。ブラウザは、最後の `fallback` ブロックより前にある `thinking`・`redacted_thinking`・`tool_use` を除いて履歴に足し、その `tool_use` は実行しない(API の規則。claude-api の資料 model-migration.md の refusal の節。実装のときに資料で確かめる)。それ以外は今のとおりそのまま足す
- サーバーは状態を持たない(会話はブラウザが毎回送る)
- **ログ**:日時、回数、エラーの種類(HTTP の状態と SDK の例外の種類)だけ。メッセージ、ツールの入力と結果、システムプロンプトの中身、IP アドレスの生の値は残さない。回数制限の数え上げはメモリの中だけ

## 11. テスト

### 手で作る小さなフィード(`web/src/gtfs/edit/form2.test.ts` ほか)

1つのフィードを各テストで使う(`departures.test.ts` の `rowsOf`・`feedOf` と同じ作り)。

- service:`WK`(月〜金)、`SA`(土)、`SU`(日)。calendar はすべて 20261001〜20261130。calendar_dates は 20261103 に `WK,2`・`SA,2`・`SU,1`、20261012 に同じ 3 行
- trip_id は `{系統}_{時刻}_{service_id}`(service_id は3つ目の部分)
- 系統 `R1`:平日 `R1_0700_WK`(停留所 A→B)・`R1_0800_WK`(A→B、08:00)、土曜 `R1_0700_SA`(`R1_0700_WK` と同じ時刻)・`R1_0805_SA`(08:05)・`R1_0800_SA`(08:00 だが C→B)
- 系統 `R2`(除外用):平日 `R2_0900_WK`、土曜 `R2_1000_SA`
- 系統 `R3`(平日だけ):平日 `R3_0730_WK`。停留所 `S9` を通るのはこの便だけ
- 日曜の便、feed_info(feed_version `202609171038`、20261001〜20261130)、agency、routes、stops
- テストの中で一部を変えた版を作るもの:日曜の便の trip_id を `R1_0805_WK` にした版(写す便の候補と重なる。id の付け方の見つけ方は平日と写す元の便だけを見るので、見つけ方は変わらない)、`R1_0700_SA` の時刻を 07:10 にした版(写しの trip_id は `R1_0700_WK` のまま、署名は消える平日便と違う)

道北バスの形を確かめる2つ目の小さなフィード(`form2.test.ts` の中):service `01`(平日)・`03`(土曜)、trip_id は `0026_01_01_01_0705`・`0026_01_01_03_0705` のように、3つ目の部分が固定の `01` で平日の service_id と同じもの。

テスト名(この文言で):

- `form2.test.ts`
  - 「平日の便を土曜の便に入れ替え、写した便の trip_id は service_id の部分だけを平日に変える」(`R1_0805_SA` → `R1_0805_WK`)
  - 「写した便の trip_id が足し戻した便と重なったら、後ろに _2 を付けて重なりを残す」(`R1_0800_WK` を足し戻すと、`R1_0800_SA` の写しは `R1_0800_WK_2`)
  - 「写した便は、消した平日便の trip_id を使ってよい」(`R1_0700_SA` の写しが `R1_0700_WK` になる)
  - 「除外した系統の平日便はそのまま残し、その系統の土曜便は写さない」
  - 「足し戻した便は元の trip_id と時刻のまま残る」
  - 「足し戻しを分類する(重複・無い便・平日でない便・除外した系統・既にある便・受け付け)」(`R1_0700_WK` は `ignoredAlreadyPresent`、`sameAs` は `R1_0700_SA`)
  - 「有効期間を期間に合わせ、calendar を切り詰め、期間の外の calendar_dates を除く」(期間 20261101〜 → 20261012 の 3 行を除く)
  - 「期間の終わりを指定すると、有効期間はその日で終わる」
  - 「期間の開始日が入力の開始日より前なら、入力の開始日にそろえて警告する」
  - 「有効期間が 7 日以下なら警告を残す(出力を止めるのは validateEdit)」
  - 「feed_version は 12 桁なら作成日時にし、それ以外は _dispatcher_ と作成日時を付ける」
  - 「feed_info が無ければ agency から作って警告する」
  - 「有効期間に運行日が残らない service の便は、出力から除いて警告する」
  - 「例外の行だけが期間内に残っても、走る日が無い service は除き、その例外の行も除く」(夏の平日 `S11`、calendar 20261001〜20261031、`S11,20261103,2` を足したフィード。期間 20261101〜)
  - 「写す元の service が新しい有効期間に1日も走らなければ、方針を適用しない」(写す元の calendar を 20261001〜20261031 にしたフィード。`checkPolicy` が `replacementNotActive`、`applyForm2` が ok: false)
  - 「写す元の service が新しい有効期間の一部しか覆わなければ警告する」
  - 「平日の便を指す transfers の行があれば、方針を適用しない」
  - 「基準のフィードを書き換えない(行を凍結して適用してもエラーにならず、変えない表は同じ参照)」(基準の行・表・配列を `Object.freeze` してから適用する)
  - 「基準に無い calendar.txt を作らない」(calendar_dates だけのフィード)
  - 「trip_id の service_id の部分が見つからなければ、後ろに平日の service_id を付ける」
  - 「固定の部分が平日の service_id と同じでも、service_id の部分の位置を取り違えない」(2つ目の小さなフィードで、`servicePartIndex` が 3 になり 2 にならない。`0026_01_01_03_0705` → `0026_01_01_01_0705`)
  - 「日曜の便の trip_id が写す便の候補と同じなら、後ろに _2 を付ける」(`R1_0805_SA` の写しが `R1_0805_WK_2`、`collidedWithService` は `SU`)
  - 「入力が (service_id, trip_id) の順なら出力も同じ順にし、stop_times は trips の順にまとめる」
- `ops.test.ts`
  - 「操作の列から作った結果は、計画をまとめて適用した結果と同じ」
  - 「足し戻しを後から足しても、計画全体を一度に適用した trip_id と同じになる」
  - 「元に戻すと1つ前の版に戻り、すべて戻すと編集後は基準と同じ表になる」
  - 「方針を変えても足し戻しの一覧は残る」
  - 「足し戻しの理由は便ごとに残り、同じ便を2回足したときは最初の理由を使う」
- `store/edit.test.ts`
  - 「適用できない方針は履歴に入らず、commit は理由を返す」
  - 「Claude の下書きがある間は、Claude の次の編集は断られ、先の下書きは残る」
  - 「利用者の操作で Claude の下書きを置き換えると、置き換えたことが draftNotices に残る」
  - 「7 日以下の有効期間は承認でき、出力だけが止まる」(`exportOnly` の error)
- `diff.test.ts`
  - 「署名の多重集合で、消える便・入る便・残る便に分ける」
  - 「同じ署名の便が複数あれば、trip_id の順に組にする」
  - 「同じ trip_id で署名の違う便が、消える便(基準)と入る便(編集後)の両方に出る」(`R1_0700_SA` を 07:10 にした版。`feed` で区別できる)
  - 「系統ごとの始発・終発の前後と、全曜日で便がなくなる系統を出す」(`R3` が vanishes)
  - 「公示第47号の時間帯で、始発停留所の出発時刻の時で数える」
  - 「足し戻した便の営業運行時間を合計し、時刻の読めない便は数を別にする」
- `restore.test.ts`(§8 の手がかり):「系統の終発の便と、足し戻さないと帯の便が 0 になる便に印を付ける」「手がかりの多い順に並べる」
- `services.test.ts`:「曜日の列から平日・土曜・日曜・土休日を見分ける」「候補が 0 個か複数なら null にして利用者に選ばせる」「祝日に追加される service を日祝とみなす」「祝日一覧が無ければ、日祝を祝日で選ばず利用者に選ばせる」「新しい有効期間に走らない service を候補にしない」「土曜と日祝が同じ時刻表かを署名で判定する」
- `holidays.test.ts`:「祝日の JSON を読み、形が違えば日本語のエラーにする」「期間の中の祝日を並べる」「収録の範囲の外を返す」
- `validate/edit.test.ts`
  - 「他の祝日に例外があるのに、平日の祝日に平日の service が走れば、例外の型を添えて警告する」
  - 「どの祝日にも例外が無ければ情報にとどめる」
  - 「年末年始の窓の平日で、平日の service が走る日を日付で並べる」
  - 「平日の service が走らない平日を、その日に走る service とあわせて並べる」
  - 「trip_id の重複と、参照先の無い service_id はエラーにする」
  - 「入力にある参照の欠けでは commit を止めず、入力からある問題として警告にする」(stops に無い stop_id の行が基準に1つあるフィード)
  - 「有効期間が 7 日以下なら、出力だけを止める error にする」「30 日未満なら警告する」
  - 「基準では別の便を指していた trip_id を情報で出す」(`tripIdReused`)
  - 「実施日まで 3 日・7 日・30 日未満で、いちばん短いものの注意を1つ出す」(`timingNotices`)
- `write.test.ts`
  - 「値に , と " と改行があるときだけ引用符で囲む(前後の空白では囲まない)」
  - 「BOM・改行・最後の改行を入力に合わせる」
  - 「変えない表は元のエントリのバイト列をそのまま書く」
  - 「フォルダに入った ZIP は同じフォルダに書く」
  - 「基準にある表は、すべて出力にある」
  - 「出典のファイルを足し、基準に同じ名前があれば別の名前にする」
  - 「同じ入力から同じバイト列になり、時刻帯を変えても変わらない」(`process.env.TZ` を `UTC` と `Asia/Tokyo` にして2回書き、バイト列が同じ。ZIP の日時が generatedAt の日本時間の数字になる)
- `ExportStep.test.tsx`:「下書きがあっても、出力は承認済みの計画で作る(下書きがある間は押せない)」「履歴が空なら出力を押せない」
- `data/tests/test_holidays.py`:Shift_JIS の小さな CSV(`data/tests/fixtures/raw/holidays/syukujitsu.csv`)で、ゼロを詰めない日付、見出しの違い、重複、実在しない日付
- `server/tests/test_holidays.py`:あれば返す、無ければ日本語の 404、`DISPATCHER_REF_DIR` に従う

### Claude のツールと中継(11/5。API は呼ばない)

- `web/src/claude/tools.test.ts`(API キー無しで、ツールの入力を直接渡す):
  - 「apply_policy は下書きを作り status: draft と draft_id を返す」
  - 「不正な日付や範囲外の件数は is_error で返す」
  - 「並べて呼ばれた2つ目の編集は、下書きが承認待ちなのでエラーになる」
  - 「add_back_trips は基準の平日便の trip_id だけを受け付け、便の始発時刻と系統を返す」
  - 「結果が 20KB を超えたら切り詰めて件数を書く」
  - 「fallback ブロックより前の tool_use は実行せず、履歴からも除く」
  - 「承認・取り消しを、次の user の発言の先頭に [画面の操作] の行で入れる」
- `server/tests/test_claude.py`(Anthropic の SDK は偽物に差し替える):
  - 「API キーが無ければ 503」「API キーがあって合言葉が無ければ、DISPATCHER_DEV が無い限り 503」
  - 「合言葉が違えば 401」
  - 「通さないブロックは 400」「大きさの上限を超えたら 413」
  - 「IP ごとの回数とサーバー全体の1日の回数を超えたら 429」「IP は X-Real-IP だけを使う」
  - 「ログにメッセージの中身を残さない」(ログを捕まえて、送った文が含まれないことを確かめる)

### 追記3の受け入れ条件(`web/src/store/reach.test.ts`)

`createReachStore` に偽の `compute`(受け取った `stops` を記録する)を渡して書く。小さなフィードは、停留所 `S9` を通る便が1本だけで、その便を消すと `S9` が stop_times から無くなるもの。

- 「便を消して停留所が stop_times から消えても、基準の起点を使うので、そのまわりのセルは外れるセルに残り分母から消えない」:`setEdited` のあと、編集後の計算に渡す `stops` に `S9` があり、その `bandCounts` はすべて 0。基準と編集後の結果の `cells`・`coverable` が等しい
- 「編集後を渡すと、同じ日付で基準と編集後を計算し、表示は編集後、baseline は基準になる」
- 「編集後だけが変わったときは、基準の側を計算し直さない」(`compute` の呼ばれた回数で確かめる)
- 「編集後の有効期間の外の日付は選べず、編集後を渡したときに日付が外なら期間の中の日に移す」
- 「読み込み直すと編集後を捨てる」
- 「乗れる行が1つも無い停留所は起点にしない」(すべて終点か pickup_type 1 の停留所)
- 「便を足し戻すと、そのまわりのセルが減便で外れたセルから外れる」(`R3_0730_WK` を足し戻すと、`S9` のまわりのセルが `lostCells` に入らなくなる。`reach.test.ts` で `computeReach` を使う)
- 「方針を承認したあと、外れたセルが最も多い時間帯を選ぶ」(利用者が選んだあとは動かさない)
- 「全便で乗れる行が無くなった停留所は 'feed'、その日だけ 0 なら 'day' にする」(`zeroServiceStops`)

### 正解データとの照合(実データ)

- 正解データ(`golden_form2.json`)は、`web/src/gtfs/edit/form2.golden.json` に置く。入れるのは `schema`・`input`(`sha256`・`feedVersion` だけ。ZIP の絶対パスは消す)・`generatedAt`・`scenarios.*.policy`・`scenarios.*.summary`。`outputDir`・`policyFile`・`createdBy` などの絶対パスは入れず、出力のファイルも読まない。出典(道北バス GTFS、北海道オープンデータプラットフォーム、CC BY 4.0、加工した旨)を `source` に書く。リポジトリに入れてよいかは §12.1-15
- 参照実装 `form2_ref.py` は `data/tools/form2_ref.py` に置く(標準ライブラリだけ。`python3 -I` で動く)。TypeScript の実装は参照実装を見ずに、この取り決めから書く
- `web/src/gtfs/edit/form2.verify.test.ts`:
  - `describe.skipIf(!existsSync(ZIP))`(ZIP は `data/raw/gtfs/dohoku_bus_減便前.zip`)
  - ZIP の SHA-256 が正解データの `input.sha256`(`d81998880e2141d0f405c65fd2b2e5e2c9516842b94d61dd59f1cc54cf451abb`)と違えば、`console.warn` して照合を飛ばす
  - 5 つの場面(main・addBack24・replaceOnly・periodEnd・edgeCases)それぞれで、`loadGtfsZip` → `applyForm2(feed, { kind: 'weekdayToSaturday', ...policy }, { generatedAt: '202611041200' })` → 5 つの表を `serializeTable` し、SHA-256 と行数が `summary.files` と一致する
  - `Form2Report` の `tripIds`(`rule` を除く)・`addBack`・`calendarDates`・`validity`(`summary.output` の `feedStartDate`・`feedEndDate`・`validityDays`)・`rowOrder`・警告の code の集合が `summary` と一致する(§5.8。正解データの5場面はどれも警告が 0 件)
  - 平日の便について、便数、`signatureDigest`、公示第47号の時間帯の便数、3時間ごとの出発のある停留所の数を、テストの中で出力から数え直して `summary.output.weekday` と照らす(main は 382 便、`c76a2bb4…caf5`、111/141/114/16)
    - 公示第47号の時間帯の便数は `diffWeekdayTrips` の `byNotice47Band` を系統について足し合わせた値とも照らす
    - 3時間ごとの出発のある停留所の数は、正解データの README の定義で数え直す:`pickup_type` が `1` でない行(空は 0)、`departure_time` の時、半開区間。各便の最後の停留所は除かない。アプリの `departureCountsByBand` は最後の停留所も除くので定義が違い、道北バスで一致するのは全 1,169 便の最後の停留所が `pickup_type=1` だから(テストに注記する)
  - addBack24 の出力は main とバイト単位で同じ(除外した系統の 4 便は `ignoredExcludedRoute`)
  - edgeCases で `0004_01_01_03_0710` の写しが `0004_01_01_01_0710_2` になる
  - 5 つの場面すべてで、`validateEdit` に error(`exportOnly` を含む)が無い。新しい有効期間は 15〜30 日で、7 日以下の場面は無い
  - 0151 の除外を GTFS から推定できるとは表明しない(除外は方針の入力として渡す)
  - 10/29 版との trip_id の一致は求めない(§5.4)
  - 道北バスには便を指す transfers・attributions の行が無く、translations の `record_id` は全行が空なので、§5.2 の `tripReferences` に当たらない
- `web/src/gtfs/write.verify.test.ts`:サンプルの全 `.txt` を読み込み、`serializeTable` が元のエントリとバイト単位で同じ(参照実装の `--self-test` と同じ確かめ)。`writeGtfsZip` で書いた ZIP をもう一度 `loadGtfsZip` で読むと、表の名前・行数が編集後と同じ
- `web/src/store/reach.verify.test.ts` と `web/src/reach/reach.verify.test.ts` の `PYTHON`:
  - 追記3と §7 の起点の規則(乗れる行の無い停留所を除く)に合わせて、検証担当が `python3 -I` で計算し直す。実装のコードは見ず、この取り決めから書く
  - 減便後の値は、検証担当が `data/tools/form2_ref.py` を main の方針と `--generated-at 202611041200` で動かして編集後の表(trips・stop_times・calendar・calendar_dates)を作り直し、9/17 版を基準として、2026-11-04(水)の 3時間ごとで計算する。起点と coverable は基準のもの
  - 入力の指紋(参照データ + ZIP の SHA-256)が合うときだけ照合し、違えば `console.warn` して飛ばす(今の作りのまま)
- **11/4・11/5 の到達点の受け入れ条件**(`web/src/store/reach.verify.test.ts`。9/17 版を基準、2026-11-04、3時間ごと):
  - main の方針で、`lostCells` が最も多い時間帯が 18〜21時か 21〜24時になる(Notion の 11/4 の到達点「夜の空白が地図で見える」)。ならなければ、テストを直さず指示役に返す
  - main の方針(足し戻しあり)は、replaceOnly(足し戻しなし)より 6〜9時の `lostCells` が少ない(11/5 の到達点「足し戻すと空白が減る」)
  - 根拠(レビューの集計):平日の出発のある停留所は main で 18〜21時 772 → 708(−8.3%)、21〜24時 180 → 169(−6.1%)、6〜9時 1,044 → 1,009(−3.4%)。時ごとの出発は 19時台 820 → 636、20時台 500 → 351

### 実データのテストの規則

- ファイルが無ければ `describe.skipIf` で飛ばす。参照データも要るテストは、すべてのファイルがそろったときだけ動かす(`ready`)
- 照合の値は、入力の SHA-256 が合うときだけ使う
- フック(`vitest related`)でも動くよう、1 ファイルの実行は数秒に収める。`applyForm2` は場面ごとに1回だけ呼び、結果を同じ `describe` の中で使い回す


## 12. 決めていない点(指示役か利用者が決める)

### 12.1 決めること

各項目に、選択肢と、この文書のおすすめ(今の取り決めはおすすめの側で書いてある)を付けています。

**11/3 指示役の決定**:1〜20 はすべておすすめのとおりにする(12.1-1 の (a) は利用者も了承済み)。21 は指示役が直した(CLAUDE.md の機能凍結を 11/6 22:00 に、祝日の出典の行を足し、gtfs-jp-check の Skill を形2に合わせた)。祝日の利用条件の表記は、入手したときに内閣府のページで確かめて直す

1. **期間の終わりを指定したときの有効期間**。形2では期間の外の平日を元のダイヤで残せないので、終了日の翌日から先は空白になる(経路検索に便が出ない)
   - 選択肢:(a) 終了日で切る(今の取り決め。末日が今日から 30 日以内なら警告し、戻す版の公開を促す) (b) 終わりの指定をやめ、当面の間だけにする (c) 終わりは変更指示書と周知文にだけ使い、有効期間は入力の末日まで(終了日より後の平日も減便ダイヤのまま)
   - おすすめ:(a)。期間を GTFS で正しく表せるのはこれだけで、空白は §5.10 の文言と 12.1-3 の戻す版で補う
2. **GTFS-JP の趣旨から外れること**(§5.6)。GTFS-JP 第4.0版は、特別ダイヤを足すときの `feed_start_date` は追加前の値を原則とし隙間を作らないこと、期間だけのデータセットにせず入力の有効期間のまま全体を出すことを求めていると読める([G1]、`docs/research/dia-planning.md` 457・487 行)。形2では開始日より前の日(と終了日より後の日)が出力に無い
   - 選択肢:(a) 外れることを受け入れ、`validityGapBefore`・`validityGapAfter` と §5.10 の文言(公開は開始日の直前に、それまでは今の版を公開したままに)で知らせる(今の取り決め) (b) 開始日を入力の開始日のままにする(開始日より前の平日も減便ダイヤになる)
   - あわせて、期間の開始日が入力の開始日より前のときは、(a) 入力の開始日にそろえて警告する(今の取り決め) (b) エラーにする
   - おすすめ:どちらも (a)。利用者が形2を選んだ帰結で、道北バス自身も 10/29 版で同じ形をとっている
3. **減便をやめるときの版**。元の ZIP は feed_version が公開済みの減便版より古く、有効期間も古い。公開先の元データは減便版で置き換わっている。今の出力の画面は履歴が空だと出力できない
   - 選択肢:(a) 11/6 に「減便をやめる版を出力する」を作る(基準のまま、feed_version を新しくし、有効期間を戻す日〜入力の末日にする。§5.6・§5.7 の切り詰めと feed_info の規則を使い、便は変えない) (b) 作らず、§5.10 の「元の ZIP を保存しておいてください」の案内だけにする (c) 期間の終わりを指定したときに、戻す版も同時に出力する
   - おすすめ:11/6 に時間があれば (a)、無ければ (b)。11/4 は新しい操作を足す余裕が無いので作らない(§1)
4. **7 日以下の有効期間を、出力できない error にした**(指示役の案は警告)。根拠は GTFS-JP 第4.0版 第1編 p.12「有効期間が7日間以下のデータセットは作成しないこととする」と、gtfs-jp-v4-check の `feed_validity_too_short`(ERROR)
   - 選択肢:(a) 出力だけを止める(今の取り決め。承認と比較はできる) (b) 警告と確認のチェックで出力できるようにする (c) 方針の適用そのものを止める
   - おすすめ:(a)。9/17 版のサンプル(末日 11/30)では、11/24 以降に既定の開始日(今日)で操作すると止まる。デモ(11/7)では起きない
5. **feed_version の規則**のうち、12 桁でない入力の `{入力}_dispatcher_{作成日時}`
   - 選択肢:(a) 今の仮の規則 (b) 作成日時だけにする (c) 利用者が画面で入れる(既定は (a))
   - おすすめ:(c)。入力の命名(改正日と社内管理コードの組合せなど)に合わせられるのは利用者だけ。11/4 は (a) で作り、入力欄は 11/6
6. **trip_id の付け方**。重なりの `_2`(5 つの部分の形が崩れる)、service_id の部分が見つからないときの `{元の id}_{平日の service_id}`、足し戻した便は元の trip_id のまま。事業者は足し戻した 24 便のうち 18 便の trip_id を付け直しており、今の規則では main の出力で(運用, 順番)の部分が 11 組重なる(§5.4)
   - 選択肢:(a) 今の規則 (b) 署名が同じ平日便は平日便の id を残す(§13) (c) 重なったときは運用の部分を変えて形を保つ
   - おすすめ:(a)。block_id が空のフィードでは GTFS として問題が無く、運用の組み直しは Dispatcher の範囲(仕業・交番の再現はしない)の外。README と画面に「足し戻した便の trip_id は元の平日ダイヤのままで、運用番号は出力の土曜ダイヤの運用とは対応しません」と書く(§13)
7. **祝日に例外の無い平日の祝日**
   - 選択肢:(a) 警告と、入力の例外の型の表示だけ(今の取り決め) (b) 入力の作り方(道北バスなら 01・03 を運休、06 を運行)で例外を補う操作を作る
   - おすすめ:(a)。補う操作は calendar_dates を書き換える新しい操作になり、11/4〜11/5 には入らない
8. **系統の除外を方針に含めるか**。Notion の決定では方針の種類は2つだけで、系統の除外は決まっていない(系統ごとの運休・間引きは「余裕があれば」)。あわせて、デモで 0051・0151 の除外を使うか(0151 はデータだけでは決まらず、公表文と前例が根拠)
   - 選択肢:(a) 含める(今の取り決め。画面は 11/4 で最初に削る候補) (b) 含めない(関数は `excludedRoutes` を受けたまま、画面に出さない)
   - おすすめ:(a)、デモでは 0051・0151 を除外する。10/29 版と照らせる形になり、平日だけの系統が全曜日でゼロになることを除外の判断の場面で見せられる。0151 は「公表文による」と画面に添える
9. **年末年始**
   - 選択肢:(a) 警告と日付の一覧だけ(今の取り決め) (b) 年末年始の日を方針から外す操作を作る
   - おすすめ:(a)。年末年始の運行は事業者ごとに違い、GTFS 担当者が calendar_dates で書く
10. **季節で走らなくなった便**。9/17 版の土曜ダイヤには、告知上は 10/18 で終わった 0069 上野ファーム線 6 便と 0086 大雪湖線 2 便が残っており、main の場面は 11/1 以降の平日にこの 8 便(382 便の 2.1%)を走らせる。10/29 版との差 15 便のうち 8 便がこれ。季節の運行は GTFS から判定できない
    - 選択肢:(a) §6 で「入る便の系統と時刻を確かめてください」と促すだけ(今の取り決め) (b) 系統単位で「期間中は走らせない」操作(平日の便も写す元の便も出さない)を作る (c) 便を消す操作を作る
    - おすすめ:11/4 は (a)。(b) は Notion の「便から決めるのは足し戻しに限る」と食い違わない(系統単位)ので、余裕があれば 11/6 に検討する
11. **休校日運休の便(学)**。道北バスの公表文の足し戻し 21 便のうち 6 便が「(学)」だが、GTFS には属性が無く、形2では学休日用の service_id も足せない
    - 選択肢:(a) 足し戻しの操作に `schoolDaysOnly` の印を持たせ、変更指示書と周知文にだけ使い、画面に固定の注意を出す(今の取り決め) (b) 学休日用の service を足す(形2の外になる)
    - おすすめ:(a)
12. **平日・土曜・日祝の service_id が役割ごとに1つでないフィード**(複数の平日 service など)
    - 選択肢:(a) 1組だけ入れ替え、ほかは警告(今の取り決め) (b) 複数の組を1つの方針で入れ替える
    - おすすめ:(a)。11/4 は道北バスの形に絞る
13. **block_id が空でないフィード**で、写した便の block_id をそのまま写してよいか(足し戻した便と運用が重なりうる。道北バスは全便が空)
    - 選択肢:(a) そのまま写して警告(`blockIdCopied`、今の取り決め) (b) 写した便の block_id を空にする
    - おすすめ:(a)。空にすると、写す元の運用のつながり(乗り継ぎの案内)が消える
14. **出典のファイルと feed_publisher_name**。出典のファイル `ATTRIBUTION.md` を ZIP に入れる方向にした(§9。中身は出典・ライセンス(CC BY 4.0)・加工した旨・加工日時)。クレジットの文言は Notion で未完了
    - 選択肢(feed_publisher_name):(a) 入力のまま(今の取り決め) (b) 「{入力}(Dispatcher で加工)」にする
    - おすすめ:ファイルは入れる。feed_publisher_name は (a)。実際の運用では、出力を公開するのは事業者自身なので、公開者の名前は事業者のままが正しい。サンプルの加工は画面と `ATTRIBUTION.md` で示す
15. **正解データ(道北バスの trip_id・系統・ファイルの SHA-256 を含む)と参照実装をリポジトリに入れてよいか**
    - 選択肢:(a) 入れる(出典と CC BY 4.0、加工した旨を `source` に書く) (b) 入れず、`data/out/` に作り、テストは無ければ飛ばす
    - おすすめ:(a)。CI で照合でき、期間中に作ったことも履歴で示せる。GTFS の ZIP そのものは入れない
16. **追記3の候補(乗れる行の無い停留所を起点にしない)を §7 で採った**。到達圏の数が変わる
    - 選択肢:(a) 採る(今の取り決め) (b) 採らない
    - おすすめ:(a)。降車専用の停留所のまわりがダイヤと関係なく外れる側に数えられるのを防ぐ
    - 11/3 の検証で、まわりのセルの多くは「ダイヤと関係なく外れるセル」ではなく調べるセルから外れると分かった(§7)。それでも (a) のままにする
17. **方針を変えたときに足し戻しの一覧を残すか**
    - 選択肢:(a) 残す(今の取り決め。適用できない便は §5.3 の分類で知らせる) (b) 捨てる
    - おすすめ:(a)
18. **新しい有効期間のどの日にも走らない service の便を出力から除くか**(参照実装はしない。§5.6 で「行の有無」から「走る日の有無」に直した)
    - 選択肢:(a) 除く(今の取り決め) (b) 残して警告だけ
    - おすすめ:(a)。残すと期間の過ぎた service_id が出力に残り、Validator が警告する
19. **Claude の `output_config.effort` の既定、IP ごとの回数制限、サーバー全体の1日の上限**(11/5)
    - 選択肢:effort は `low`・`medium`・`high`。回数は 11/5 に料金から決める
    - おすすめ:effort は `medium`(チャットの質問と提案)。回数の仮の値は IP ごとに 1 時間 30 回、全体で 1 日 300 回とし、11/5 に API の料金と審査の期間の見込みから直す
20. **祝日一覧の収録の終わり**を、最後の祝日の年の 12月31日とみなしてよいか(2027-11-23 までとすると、年末までの期間がすべて警告になる)
    - 選択肢:(a) 12月31日とみなす(今の取り決め) (b) 最後の祝日の日まで
    - おすすめ:(a)。内閣府は翌年の祝日を1年分まとめて載せる
21. **ほかの文書の直し**(指示役が行う):`.claude/skills/gtfs-jp-check/SKILL.md` の「期間の外は元のまま」は形1の前提で、形2では期間の外の日は出力に含まれない。CLAUDE.md の機能凍結「11/6昼」は全体スケジュール(11/6 22:00)と食い違う。CLAUDE.md の「データと出典」の表に祝日の行を足す。指示役の既定「7日以下は警告」は 12.1-4 のとおり出力を止める形に直す

### 12.2 反映しなかった指摘と理由

- **7 日以下を確認のチェックで出せるようにする**(運行管理者の観点のレビュー):同じ点を GTFS-JP の規定から must とした指摘があり、出力を止める error にした(12.1-4)。日付を直すよう方針の画面で促す(`checkPolicy` の `shortValidity`)
- **方針なしの版(減便をやめる版)の出力**:新しい操作で、11/4 の半日には入らない。12.1-3 で決める。§5.10 の文言は「元の ZIP を保存しておいてください」に直した
- **足し戻した便が属する運用の数の表示**(任意とされたもの):trip_id から運用を読む規則は道北バスの形に限られ、一般の GTFS では決められない。12.1-6 で trip_id の扱いを決めるときにあわせて検討する
- **署名の一致を、時刻を秒に直した値で判定する。署名が同じ組の列(pickup_type・drop_off_type・trip_headsign・direction_id)の不一致の件数を出す**:道北バスでは時刻の書き方がそろい、署名が同じ便どうしでほかの列の違いは 0 件。11/4 は正解データとの照合(`signatureDigest`・`sameAs`・重なり)を崩さないことを優先し、署名は文字列のままにした(§5.1)。11/6 の検証器で、時刻の書き方の違い(時が1桁の値など)と列の不一致を warning として足す
- **平日になかった発車時刻が加わる停留所・発車時刻が消える停留所の件数と、掲示の差し替え・早発の注意**:停留所ごとの一覧(B)と同じ計算なので、B を作るときに件数と注意もあわせて出す。11/4 は §6 の「入る便の系統と時刻を確かめてください」までにする。§5.10 の「平日ダイヤで走る日」の文言の直しは反映した

### 12.3 11/3 の検証のあとの決定(指示役)

実装を正解データ・独立の Python・ブラウザ・ランダムな突き合わせで確かめたあと、次のように決めた。

1. 祝日の利用条件は公共データ利用規約(第1.0版)(§2。CLAUDE.md も直した)
2. 降車専用の停留所を起点にしない規則はそのまま。§7 の説明の誤りを直した
3. 承認後の時間帯の選び直しは、同数なら遅い時間帯(§7)
4. サンプルの出力 ZIP 名は表示名を使う(§9)
5. 孤立した stop_times の行は除いて警告する(§5.5・§5.8 の `orphanStopTimesDropped`)
6. `checkPolicy` に `weekdayNotActive` を足し、`weekdayCalendarOutside` は service のどの行も重ならないときだけにする(§3)
7. 読める `stop_sequence` の定義(§5.1)と、警告の照合を code の集合にすること(§5.8・§11)
8. 11/4 の後始末として直す(11/4 中):期間の入力欄のブラウザ標準の範囲検証を外し、§3 の「そろえる」警告を画面から出せるようにする。実施日を過ぎたときの文言。「すべて戻す」などの確認をブラウザ標準のダイアログから画面の部品にする。380px での折り返し。祝日一覧があとから読めたときの確かめの出し直し。§11 のテスト名

## 13. 後でよい

急がない指摘。期限の目安を付けて残す。

- **比較の初日の前日の扱い**(11/6 以降):比較の日付が編集後の有効期間の初日だと、編集後は前日の service が空になり、前日の便の 24時を超える出発(30:00 以降が 6時以降に入る)が減便と関係なく差に出る。前日の分を基準と同じに扱うか、画面に注意を出す。道北バスは 24:00 以降の時刻が 0 行で、既定の日付も 11/2 以降なので今は影響しない
- **§3 の `checkPolicy` の一覧に「`period.end` が入力の開始日より前(新しい有効期間が空)」を書き足す**:今も `replacementNotActive`(空の有効期間ではどの service も走らない)と `applyForm2` の ok: false で止まるので、誤った GTFS にはならない
- **検証器の規則を足す**(11/6 の検証器):error `badCalendarDate`(calendar_dates の日付が不正、exception_type が 1・2 以外)、warning `feedInfoRows`(feed_info が1行でない)、info `unusedRoutes`・`unusedStops`(便の無くなる系統、使われなくなる停留所。main で 90 停留所が stop_times から消え、replaceOnly では平日だけの 19 系統の便がすべて無くなる)
- **Dispatcher の出力を基準として読み直したときの trip_id**:`_2` の付いた便があると部分の数がそろわず、どの便も `append-service` になる。部分の数が N か N+1(末尾が `_数字`)なら N の部分だけで位置を調べる、などの扱いを決める(誤った GTFS にはならない)
- **系統を開いたときの並べ方**(§6):方向(始発 → 終着の停留所の組。direction_id は空が多い)ごとに、残る・消える・入る便を時刻順に1列で並べ、編集後の最大間隔(分)を添える。足し戻しの画面も同じ並べ方にする
- **README と画面に trip_id の注意を1行**:「足し戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の土曜ダイヤの運用とは対応しません」(12.1-6 を (a) で決めたら書く)
- **系統の親でまとめる**:`jp_parent_route_id` があるときは、系統の除外の表を親ごとにまとめ、親のチェックで子をすべて外す。道北バスは route_id と同じ値なので今は要らない
- **calendar が feed_info の範囲より広い入力**:切り詰めで、入力の feed_info の範囲の外にあった calendar の日が落ちるときは warning `calendarBeyondFeedInfo` を出す。道北バスの 2 版は端が同じ
- **署名が同じ平日便は平日便の trip_id を残す案**(12.1-6 の (b)):9/17 版の平日便のうち土曜に同じ署名の便がある 150 便で、今の規則では 77 便の trip_id が変わる。GTFS-RT やバスロケのように trip_id で照合する仕組みには (b) が向く。事業者の 10/29 版も id を付け直している
- **Claude の中継の費用と表示**(11/5 に決める):最後の user の発言にも `cache_control` を置くか、トップレベルの自動キャッシュを使う。`thinking.display` を `summarized` にするか、待っている間に「考えています…」を出す。`eager_input_streaming` を使うなら、ブラウザでツールの入力を必ず確かめる
- **ほかに決めておくこと**(11/5〜11/6):サンプル GTFS のダウンロードを合言葉の対象に入れるか(Notion §5 で未定)。編集の履歴の IndexedDB への保存と、画面から消す機能を作るか。前提情報(11/6)の学校・病院を足し戻しの手がかりにどうつなぐか(`search_trips` の `nearby_facilities` は項目名だけ置いた)
- **乗降の扱いだけが違う便の分類**:署名に pickup_type・drop_off_type を含めないので、乗降の扱いだけが違う平日便を足し戻そうとすると `ignoredAlreadyPresent` で断られる。別の分類(`differsOnlyInPickup`)にする案
