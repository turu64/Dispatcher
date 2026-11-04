# service_id のグループ分けの設計(TypeSafe AI Jev を使う)

- 作成:2026-11-04。同日に改訂(GTFS 担当のレビュー M1〜M6・S1〜S11 と nit を反映し、利用者の決定と Jev の試しの呼び出しの結果を書き込んだ)。同日、A・B・C の実装へのレビュー(§8.2)を反映した
- 状態:§0 の決定のもとで実装に入る。課題は、このワークフローで作る A・B・C と、後の画面のワークフローで作る D に分ける(§7)
- 土台:dispatcher-f7 の会話(Jev の調査、State と質問の v1・v2、京都市営バスの分け方の研究。作ったファイルは `data/out/jev_playground/`)、今のコードの調査、`data/raw/gtfs/` の 12 個の GTFS を祝日一覧つきで数えた結果(§2.8)
- 取り決めの正は `docs/interfaces-1104.md`(形2)と `docs/interfaces-1105.md`(サーバーの中継)。この設計に合わせて、C が 1104 を、B が 1105 を直す(§7)

## 0. 決めたこと(2026-11-04、利用者)

1. **第1段(グループ分けと選択への反映)と第2段(形2の編集を複数の service に広げる)の両方を、機能凍結(11/6 22:00)までに入れる。** 凍結に間に合わないときは第2段だけを外せるように作る(§7.1)
2. **Jev は GTFS の読み込みの後に自動で呼ぶ。** 呼ぶのは、規則だけでは決まらない、または単純でない GTFS のとき(§2.7)。止める手段と、送った情報を見る手段は画面に置く(§3.6)
3. **Jev に送る情報に、系統名・行き先(停留所名を含む)を入れてよい。** f7 の State と同じ範囲。送り先(Vercel AI Gateway と TypeSafe AI)を画面と README に書く
4. ハッカソンで Claude 以外の AI(Jev)を使うこと、Vercel・TypeSafe の利用規約、送り先が増えることは、利用者が確かめた
5. キーの送り先を確かめる試しの呼び出しを1回してよい。結果は §3.2

改訂前の版から変えた点:

- 区分を「主な区分1つ」から「平日・土曜・日祝の網羅率の組」に変えた(レビュー M1)。入れ替えの組を1対1の表から「入れ替えに使う service → 便を入れる平日の service」の多対1の表に変えた
- 扱いに「なくす」を足し、平日だけで入れ替えに使う service が割り当たらない service の既定にした(M3)
- 入れ替え先を系統の重なりで決める規則をやめた。重なりは判断材料の文にだけ使う(M2 が構造的に起きなくなる)
- Jev の送り先を、試しの呼び出しで確かめた口に直した。401 のときに別の会社の口へ送り直す案は消した(M4)
- 京都市営バスでは到達圏を見ない。デモの柱は北海道の GTFS にする(M5)

## 1. 目的と範囲

### 目的

利用者の依頼(2026-11-04):

> 道北バスのような綺麗に平日・土曜日・日曜祝日に分かれている GTFS 以外に、複雑に service_id が組まれている GTFS において、TypeSafe AI Jev を使って自動的に平日・土曜日・日祝をグループ化する。1 GTFS を読み込むにおいて、読み込んだ GTFS から service_id のグループ分けを行い、以降の作業での選択において利用できるようにする。

今のコードは「平日・土曜・日祝のダイヤが service_id 1つずつ」という前提で作られている。今の推定(`guessServiceChoice`、`web/src/gtfs/edit/services.ts`)は calendar の曜日の列だけを見るので、次の GTFS で正しく入れ替えられない。

- 京都市営バス(service 30 個、便 17,835 本):平日のダイヤが `01001`・`01001_A`・`01001_F`・`01001_GYB` などに分かれている。`01001` だけを入れ替えると、ほかの平日の service の便は平日のまま残る
- 北海道中央バス(service 33 個):土曜に走る便は、土曜だけの `S000002`(238 便)と、土日祝の `S000027`・`S000028`・`S000029`(667・782・1,197 便)ほかに分かれている。`S000001` を正しく土曜ダイヤにするには、1つの平日の service に4つ以上の service の便を入れる必要がある
- 北門バス・名士バス:平日だけの service と毎日走る service しか無い。平日を土曜ダイヤにするには、平日だけの service の便をなくすだけでよいが、今は入れ替えに使う service が無いので止まる

この設計では次を作る。

1. 読み込みの手順で、service ごとに、走る日の区分と、減便の方針の種類ごとの役割(平日だけ・入れ替えに使う・両方に走る)と扱い(入れ替える・なくす・残す)の案を作る。案はコードの規則で作り、単純でない GTFS では Jev の判断で確かめる
2. 利用者が、読み込みの手順でその案を確かめて直し、確定する
3. 確定したグループ分けを、減便の方針の選択、AI のツール、変更指示書・周知文で使い、形2の編集を複数の service に広げる

### 範囲

| 入れる | 入れない |
| --- | --- |
| service ごとの判断材料の計算(ブラウザ) | GTFS のファイルや stop_times の行をサーバー・Jev に送ること |
| コードの規則による案(区分・役割・割り当て・扱い) | Jev に理由の文やグループの名前を作らせること(Jev は選択と確率だけを返す) |
| サーバーの Jev の中継(回数・1日の件数と額の上限、ログに中身を残さない) | Claude(調整役)に service を分けさせること |
| 読み込みの手順の「ダイヤのグループ分け」の表と直し方 | 祝日一覧に無い休み(年末年始など)を区分として別に持つこと |
| 形2の編集の複数 service 化(なくす service を含む) | calendar・calendar_dates を書き換えて平日の一部の日だけを外すこと(形2で表せないものはエラーにする。§2.6) |
| 減便の方針・AI・変更指示書・周知文での利用 | 参照実装 `data/tools/form2_ref.py` の複数 service 対応 |

## 2. 分け方

### 2.1 判断材料(ブラウザで計算する)

service ごとに計算する。便が1本以上ある service だけを対象にする(便の無い service は表に出さない)。期間は入力の有効期間(`feedValidity`)。

| 項目 | 中身 |
| --- | --- |
| `runningDays` | 有効期間の中の運行日の数。全体と、区分(平日・土曜・日祝)ごと |
| `coverage` | 区分ごとの網羅率(その区分の運行日 ÷ 有効期間の中のその区分の日数) |
| `levels`・`basis`・`runs` | §2.2 で決める走る日の区分 |
| `tripCount`・`routeCount` | 便の数、系統(route_id)の数 |
| `routes` | route_id ごとの便数と表示名(`route_short_name`、空なら `route_long_name`、どちらも空なら route_id)。便数の多い順 |
| `routeIds` | route_id の集合(系統の重なりの計算に使う。Jev には送らない) |
| `headsigns` | trip_headsign の上位5つ(便数の多い順。空は数えない) |
| `firstDeparture`・`lastArrival` | 便の最初の発時刻と最後の着時刻。秒で比べ、`HH:MM` で持つ(24 時を超える時刻は `25:10` のまま) |
| `runningDates` | 運行日が 10 日以下のときだけ、その日の一覧(`YYYYMMDD`) |
| `name` | service_id を最初の `_` で分けた頭と接尾辞(`01001_A` → 頭 `01001`、接尾辞 `A`。`_` が無ければ接尾辞は空。`SRV_8_10600_01_A` → 頭 `SRV`、接尾辞 `8_10600_01_A`) |

- 日の区分:日曜か、内閣府の祝日一覧にある日 → 日祝。土曜 → 土曜。それ以外 → 平日
- 運行日は今の `indexFeedServiceDays`・`runsOn`・`forEachDay` で数える
- 系統の重なり:`|A の route_id ∩ B の route_id| ÷ |A の route_id|`。判断材料の文と Jev の候補の並びにだけ使い、割り当ては決めない(§2.4)
- 祝日一覧:`App.tsx` が非同期に読み込む。**祝日一覧の状態が決まってから(読めた、または読めなかった)1回だけ計算し、そのあとで Jev を呼ぶ**(レビュー S10。祝日一覧が後から届いて計算し直し、Jev にもう一度送ることを防ぐ)。読めなかったときは日曜だけを日祝として計算し、表の上に「祝日一覧を読めないため、祝日を平日として数えています」と出す
- 京都市営バスの stop_times を1回なめるので、計算時間を測る(§7.3 A の受け入れ条件)

### 2.2 走る日の区分

区分(平日 W・土曜 S・日祝 H)ごとに、網羅率から水準を決める。

| 水準 | 網羅率 | 例 |
| --- | --- | --- |
| `regular`(ほぼ毎回) | 0.7 以上 | 京都 `01001` 平日 0.98、北海道中央バス `S000042` 日祝 0.76 |
| `partial`(一部の日) | 0.15 以上 0.7 未満 | 京都の大学の便 平日 0.59〜0.66、北門バス `S000003`(火曜だけ)0.19 |
| `rare`(まれ) | 0 より大きく 0.15 未満 | 京都 `02001` の平日 0.02(年末)、旭川電気軌道 `01` の日祝 0.12 |
| `none` | 0 | |

service の `basis`(基本の形)と `runs`(走る区分の集合)は次の順に決める。

1. `regular` の区分が1つ以上 → `basis = 'regular'`、`runs` = `regular` の区分。`partial`・`rare` の区分は判断材料の文にだけ出す
2. そうでなく、`partial` の区分が1つ以上 → `basis = 'partial'`、`runs` = `partial` の区分
3. そうでなく、運行日が1日以上 → `basis = 'special'`(特定の日だけ)、`runs` = 運行日が1日以上ある区分
4. 運行日が0日 → `basis = 'noDays'`、`runs` は空。表では「運行日なし」と出し、どの役割にもしない

`runs` は {W}、{S}、{H}、{S,H}、{W,S}、{W,H}、{W,S,H} のどれか(または空)になる。改訂前の「主な区分1つ」の決め方では、毎日運行(1111111)と土日祝(0000011)の service が割合 0.5〜0.68 で `special` に落ち、北海道の 10 個のうち 7 個で入れ替え先を作れなかった(M1)。

しきい値を 0.8 でなく 0.7 にしたのは、北海道中央バスの土日祝の service に日祝の網羅率 0.76・0.79 のものがあるため(`S000041`・`S000042`)。下側は京都の大学の便の 0.66 で、間は 0.10 しかない。境目から ±0.05 にある値は、判断材料に「網羅率が境目に近い」と書き、Jev に問う順番を先にする(§3.3)。

### 2.3 減便の方針の種類ごとの役割

方針の種類 `kind` の入れ替えに使う区分を X(`weekdayToSaturday` なら S、`weekdayToSundayHoliday` なら H)、残りの1つを Y とする。service ごとに役割 `side` を決める。

| `runs` | 役割 `side` | 形2での扱い |
| --- | --- | --- |
| W を含み、X も Y も含まない | `weekdayOnly`(平日だけ。入れ替え元) | 期間の間、この service の便をなくす。入れ替えに使う service が割り当たれば、その便が加わる |
| W を含まず、X を含む | `replacement`(入れ替えに使う) | 割り当てた平日だけの service に便を加える(§2.4) |
| W と X を含む | `both`(両方に走る) | 手を付けない |
| W と Y を含み、X を含まない | `unsupported`(形2で表せない) | エラー(§2.6) |
| W も X も含まない | `unrelated`(関係しない) | 手を付けない |

- 北海道中央バスの `weekdayToSaturday`:平日だけ `S000001`・`S000014`・`S000025`・`S000015`、入れ替えに使う `S000002`・`S000027`〜`029`・`S000036`・`S000038`・`S000041`・`S000042`・`S000049`(と、使わない `S000004`・`S000034`・`S000048`)、両方に走る `S000026` ほか毎日運行の service と `S000040`(月〜土)、形2で表せない `S000039`・`S000044`(月〜金と日祝)
- 毎日運行の service は「両方に走る」なので、平日を土曜ダイヤにしても手を付けない。土曜にも同じ便が走っているので正しい

### 2.4 入れ替えに使う service の割り当て(多対1)

`replacement` の service ごとに、便を入れる `weekdayOnly` の service(`into`)を1つ決める。1つの `weekdayOnly` の service に、複数の `replacement` の service が入ってよい。

**主の平日の service(`mainWeekday`)**:`weekdayOnly` のうち `basis = 'regular'` の service で、便が一番多いもの(同数なら service_id の昇順で先)。無ければ null。

**割り当ての規則**(上から順に、最初に当てはまったもの):

1. **接尾辞**:接尾辞が空でなく、同じ接尾辞の `weekdayOnly` の service がちょうど1つなら、それにする(京都 `03001_A` → `01001_A`、`03001_C` → `01001_C`)。接尾辞で対応させるのは、両方の `basis` が `regular` か、両方が `regular` でないときだけ(特定の日だけの service の便を、毎日走る平日の service に入れないため)。2つ以上なら、頭が `mainWeekday` の頭と同じものに絞り、ちょうど1つならそれにする。絞っても決まらなければ「決まらない」(`into = null`、印は `undecided`)
2. **主の平日の service**:`basis = 'regular'` で、`mainWeekday` があれば、それにする(京都 `03001` → `01001`、北海道中央バスの9つ → `S000001`、沿岸バス `S000006` → `S000004`)
3. **使わない**:それ以外(`basis` が `partial`・`special` で接尾辞が合わない、または `mainWeekday` が無い)は `into = null`。判断材料は「一部の日・特定の日だけ走る service のため、平日には加えません」(京都の SRV、北海道中央バス `S000004`・`S000034`・`S000048`)

- 1つの `replacement` の service は、1つの `into` にしか入らない。改訂前の規則で起きた「`01001` と `01005_MSN` の両方が `03001` を入れ替え先にして、`03001` の便が2回加わる」重複(M2)は、この形では起きない。確定のときと `checkPolicy`(§4.2)でも、1つの service が2つの組に出てこないことを確かめる
- 系統の重なりは割り当てを決めない。判断材料の文に「`S000001` の系統 62 のうち 45 が同じです」のように出す。重なりが 0.2 未満で主の平日の service に入れたときは、文に「系統の重なりが小さいため、確かめてください」を足す
- 利用者は `into` を、その kind の `weekdayOnly` の service のどれか、または「使わない」に直せる

### 2.5 平日だけの service の扱い

`weekdayOnly` の service の扱い `treatment` は `erase`(期間の間、便をなくす)か `keep`(平日のまま残す)。`erase` で入れ替えに使う service が割り当たっていれば画面では「入れ替える」、割り当たっていなければ「なくす」と出す。

| `basis` | 割り当て | 既定 | 理由の文の例 |
| --- | --- | --- | --- |
| `regular` | あり | `erase`(入れ替える) | 「土曜の 03001_A の便に入れ替えます(接尾辞が同じ)」 |
| `regular` | なし | `erase`(なくす) | 「土曜に走る service が割り当たらないため、期間の間はなくします。系統 2 つは土曜の 03001 にもあります」(京都 `01005_MSN`、北門バス `S000002`、名士バス `S000002`、北海道中央バス `S000014`・`S000025`) |
| `partial` | なし | `keep` | 「平日の 59% の日だけ走ります。通学など特定の需要の便とみて残します」(京都の大学の便、北門バス `S000003`、士別軌道 `S000006`・`S000009`) |
| `partial` | あり | `erase`(入れ替える) | |
| `special` | あり | `erase`(入れ替える) | 「11/2 だけ走る、01001_A の迂回の版です。土曜の迂回の版 03001_C に入れ替えます」(京都 `01001_C`) |
| `special` | なし | `keep` | 期間の中で走る日を出す(下の S5) |

- 扱いを「残す」にした service が期間の中で走る日があれば、`applyForm2` が警告 `weekdayServicesKept`(§4.3)で、service ごとに走る日の数(10 日以下なら日付)を出す。「残すと決めた 01001_C は、11/2 に平日のダイヤのまま全便走ります」(レビュー S5)
- `keep` にできるのは、入れ替えに使う service が割り当たっていない service だけ。割り当たっている service を残すには、先に割り当てを外す(画面の Select で選べなくし、純粋な関数では問題 `keptHasReplacements` を返す)
- Jev が学校の便とみた(§3.4)service は、理由の文に「行き先・系統名が学校を指しているとの判断(Jev)」を足す。扱いは変えない

### 2.6 形2で表せないもの

`side = 'unsupported'` の service(平日と Y に走り、X に走らない)は、平日の日だけ便を外す必要がある。形2は service の便を入れ替えるだけで calendar を書き換えないので、これを表せない。例:

- `weekdayToSundayHoliday` の月〜土の service(北海道中央バス `S000040` 15 便、士別軌道 `S000008` 6 便)
- `weekdayToSaturday` の月〜金と日祝の service(北海道中央バス `S000039` 1 便・`S000044` 2 便)

扱い:

- 規則の案では扱いを未決(`treatment = null`)にし、その kind の問題にエラー `unsupportedService` を入れる。このエラーがある kind の減便の方針は適用できない
- 利用者が扱いを `keep`(平日も走らせる)にすれば、エラーは消える。そのときは警告 `weekdayServicesKept` に入る。`erase` は選べない
- 今のコードは `roleOf`(`services.ts`)でこれらを `other` にし、`otherWeekdayServices` の警告も出していない。この設計でエラーとして見えるようになる

### 2.7 単純な GTFS

両方の kind で次をすべて満たすとき、単純な GTFS とする。

- `weekdayOnly` の service がちょうど1つで、`basis = 'regular'`
- `into` が決まった `replacement` の service が1つ以下で、その `basis` が `regular`
- `unsupported` の service が無い

`both`・`unrelated`、使わない(`into = null`)`replacement` の service はいくつあってもよい(土曜・日祝だけの臨時便、毎日運行の service、網羅率の低い特別の service を除いて判定する。レビュー M1 の 5)。`weekdayOnly` の service が無い GTFS(名寄市の毎日運行だけの GTFS)も単純とし、問題 `nothingToChange`(「平日と土曜(日祝)で同じダイヤのため、入れ替える便がありません」)を返す。

単純な GTFS では Jev を呼ばない。`guessServiceChoice` が平日・土曜・日祝の3つを決める GTFS では、その結果と同じ組になる(A のテストで確かめる)。

### 2.8 実データでの期待する結果

祝日一覧 `data/raw/holidays/syukujitsu.csv` を当て、§2.2〜§2.7 の規則で数えた結果(2026-11-04。作業用のスクリプトで数えた。スクリプトはコミットしない)。A の照らすテストの正解に使う。

| GTFS | 単純 | `weekdayToSaturday` | `weekdayToSundayHoliday` |
| --- | --- | --- | --- |
| 道北バス(9/17 版・10/29 版) | ○ | `01` ← `03` | `01` ← `06` |
| 沿岸バス | ○ | `S000004` ← `S000006`(土日祝) | 同じ |
| 旭川電気軌道 | ○ | `01` ← `03`(土日祝)。`0770-*` は特別で両方に走る | 同じ |
| 名士バス | ○ | `S000002` をなくす(入れ替えに使う service なし) | 同じ |
| 羽幌町 | ○ | `S000001` をなくす(土曜・日祝は便がない) | 同じ |
| 名寄市 | ○ | `nothingToChange` | 同じ |
| 京都市営バス | × | `01001` ← `03001`、`01001_A` ← `03001_A`、`01001_F` ← `03001_F`、`01001_GYB` ← `03001_GYB`、`01001_C` ← `03001_C`。`01005_MSN` をなくす。`01002_RIT`・`01003_KSU`・`01004_BUK` を残す。SRV は使わない | `02001` 系で同じ形(`01001_C` ← `02001_C`) |
| 北海道中央バス | × | `S000001` ← `S000002`・`S000027`・`S000028`・`S000029`・`S000036`・`S000038`・`S000041`・`S000042`・`S000049`。`S000014`・`S000025` をなくす。`S000015`(特別)を残す。`S000039`・`S000044` は形2で表せない | `S000001` ← `S000003`・`S000005`・`S000006`・`S000027`・`S000028`・`S000029`・`S000036`・`S000038`・`S000041`・`S000042`・`S000049`。`S000014`・`S000025` をなくす。`S000015` を残す。`S000040` は形2で表せない |
| 北門バス | × | `S000002` をなくす。`S000003`(火曜だけ)を残す | 同じ |
| 士別軌道 | × | `S000001` ← `S000002`。`S000007` をなくす。`S000006`・`S000009` を残す。`S000008`(月〜土)は両方に走る | 同じ割り当て。`S000008` は形2で表せない |
| 空知中央バス | × | `S000001` ← `S000002`。`S000003`・`S000004`(網羅率 0.48・0.50)を残す | 同じ |

入れ替えたあとの平日の便の数(期間に走る service の便を数えた見積もり。C の照らすテストの正解に使う)。北海道中央バスの2つと京都の 11/11 は、便の署名(系統と停車の時刻)の多重集合でも「出力の 11/11 = 入力の土曜(日祝)+ 残した便」になることを確かめた:

| GTFS と方針 | 入力の平日(11/11 水) | 入力の土曜・日祝 | 出力の 11/11 | 差の内訳 |
| --- | --- | --- | --- | --- |
| 北海道中央バス、土曜に | 5,494 便 | 11/14 土 3,736 便 | 3,739 便 | 形2で表せない `S000039`・`S000044` を残した 3 便 |
| 北海道中央バス、日祝に | 5,494 便 | 11/15 日 3,621 便 | 3,636 便 | `S000040` を残した 15 便 |
| 京都市営バス、土曜に(期間 11/5〜) | 6,353 便 | 11/14 土 5,353 便 | 5,417 便 | 残した大学の便 64 便 |
| 京都市営バス、土曜に(期間 11/1〜)の 11/2 | 6,313 便 | 10/31 土 5,366 便 | 5,063 便 | 使わない SRV の 13 便を引き、残した大学の便 24 便を足し、期間に走らないため加えない `03001_C` の 314 便を引く(加えていた 11/4 の前の版では 5,377 便。§6.2-7) |
| 士別軌道、土曜に | 55 便 | 11/14 土 27 便 | 29 便 | 残した `S000006`・`S000009` の 2 便 |
| 北門バス、沿岸バス、土曜に | 90 便、79 便 | 76 便、55 便 | 76 便、55 便 | なし |

## 3. Jev

### 3.1 役割

**既定の案はコードの規則が決め、Jev はそれを確かめる。** 規則と Jev の答えが食い違ったものに印を付け、規則で決まらないものだけを Jev の答えで埋める。

- §2 の規則は、割り当てを接尾辞と主の平日の service で決めるので、規則で決まらないのは接尾辞が2つ以上に当たるときだけになる。Jev の答えで値が変わる場面は少ない。Jev の主な働きは、規則の外れ(命名の違う事業者で接尾辞の規則が外れる、網羅率が境目にある)を食い違いとして画面に出すこと
- 理由:数字と既定はコードが出す(CLAUDE.md「計算はコード」)。精度の裏付けは f7 の数件と試しの1回だけで、境目の候補では値がぶれる。日本語の系統名・行き先では精度が落ちるとドキュメントも書いている

### 3.2 送り先(2026-11-04 の試しの呼び出しの結果)

改訂前の §2.4 の候補 A(`https://ai-gateway.vercel.sh/typesafe/v1/systemone`、本文に `model`、質問の型 `noul`)は、確かめていない推測だった。利用者の別のプロジェクト(`~/Documents/GitHub/minecraft-mcp-server/src/jev-client.ts`。2026-09-18 に実際の口で確かめた、と書いてある)で使っている Vercel AI Gateway の口に1回だけ送り、次を確かめた。コードは流用せず、送り方だけを参考にした。

| 項目 | 結果 |
| --- | --- |
| URL | `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model` |
| 認証 | `Authorization: Bearer <TYPESAFE_AI_VERCEL_KEY>`(キーは Vercel の口だけに送った) |
| ほかのヘッダー | `Content-Type: application/json`、`ai-gateway-protocol-version: 0.0.1`、`ai-evaluation-model-specification-version: 4`、`ai-model-id: typesafe-ai/jev` |
| 本文 | `{"state": {...}, "questions": {...}}`。`model` は本文に入れない |
| 質問の型 | `boolean`(`criteria` を付けない)、`choice`(`criteria` は名前 → 説明の文字列)、`score`(別のプロジェクトで確かめた型)。f7 の `noul` は `boolean` に直して送った(`noul` のまま送って断られるかは試していない)。`choice` の `criteria` の値に null は入れず、文字列にした |
| 状態 | HTTP 200、全体 1.86 秒(TypeSafe 側の処理は 334 ms) |
| 応答 | `answers`(名前ごとに choice は `{type, choice, probabilities}`、boolean は `{type, probability}`)、`model: "typesafe-ai/jev"`(版の番号は無い)、`rounding: {probabilityDecimals: 2, scoreDecimals: 2}`、`usage: {inputTokens: 8567, outputTokens: 507}`、`warnings: []`、`providerMetadata.typesafe.confidence`(choice の名前だけ。boolean には無い)、`providerMetadata.gateway`(`cost: "0.000359814"` ほか、`generationId`、`routing`) |
| 費用 | $0.00036(約 0.05 円) |
| 転送先 | `providerMetadata.gateway.routing.finalProvider` が `typesafe-ai`。転送先を限る指定なしでは、`fallbacksAvailable` に `digitalocean` がある(TypeSafe が答えないとき、Vercel が判断材料を別の会社に回すことがある。キーは Vercel にだけ送る) |
| 転送先を限る指定 | 2026-11-04 に、本文に `providerOptions.gateway.only: ["typesafe-ai"]` を足して1回送った(北海道中央バスの集計を架空の名前に差し替えた `server/tests/fixtures/jev_judge_request.json` の土曜の target。入力 1,408・出力 60 トークン、$0.000059)。HTTP 200、`warnings: []`、`routing.fallbacksAvailable: []`、`routing.planningReasoning` は「Provider set restricted to: typesafe-ai. System credentials planned for: typesafe-ai. Total execution order: typesafe-ai(system)」、`finalProvider: "typesafe-ai"`。口は指定を受け付け、予備の転送先(DigitalOcean)が外れた。中継はこの指定を必ず送る(§3.3・§6.2-1) |

送った State は f7 の `data/out/jev_playground/v2/01001_C.json`(京都 `01001_C`、候補は土曜 5・日祝 5)から `action_on_reduction` を除いたもの。答え(参考):

- `day_type`:`special`(確率 0.93、確信度 0.91)。規則の `basis = 'special'` と同じ
- `saturday_counterpart`:`03001_A`(0.88、確信度 0.86)。`03001_C` は 0.12。規則(接尾辞で `03001_C`)と食い違う。`01001_C` は 11/2 だけの迂回の版なので、迂回の土曜の版 `03001_C` を入れるのが正しい。Jev は系統と時刻の近さで選んでいる。この設計では、規則の値を既定にし、確信が高ければ「食い違い」の印を出す(§3.4)
- `sunday_counterpart`:`02001_A`(0.81、確信度 0.77)
- `is_school_service`:0.10

まだ確かめていないこと(§6.2):

- `providerOptions.gateway.zeroDataRetention` を、この口が受け付けるか。試しの1回では、断られて送り先・認証・形を確かめられなくなるのを避けるため、送らなかった(転送先を TypeSafe だけにする指定 `providerOptions.gateway.only` は、2026-11-04 に別の1回で確かめた。上の表の「転送先を限る指定」)
- §3.3 の新しい質問(平日だけの側・入れ替えに使う側に分けたもの)での答えの質。もう1回の呼び出しが要る

### 3.3 サーバーの中継

新しいファイル `server/src/dispatcher_server/service_groups.py`(ルーター)を作り、`app.py` で読み込む。作り方は `agent_relay.py`(接続元の決め方・断るときの形・ログ)と `ratelimit.py` を手本にする。

**エンドポイント**

| | 中身 |
| --- | --- |
| `GET /api/service-groups` | `{available: bool, provider: "TypeSafe AI Jev", via: "Vercel AI Gateway", reason: null \| "noKey" \| "badUrl" \| "dailyLimit"}` |
| `POST /api/service-groups/judge` | 判断材料を受け取り、target ごとに Jev に問い、答えと「実際に送った本文」を返す |

**入力の形・出力の形**は §7.5 の型(`JevJudgeRequest`・`JevJudgeResponse`)。サーバーは pydantic のモデルで、型・長さ・数を全部確かめる(知らない項目は断る)。

| 上限 | 値 | 超えたとき |
| --- | --- | --- |
| 本文 | 256 KB | 413 |
| `services` | 60 個 | 422 |
| `targets` | 40 個 | 422 |
| target ごとの `candidates` | 5 個 | 422 |
| service ごとの `routes` | 20 個 | 422 |
| `headsigns` | 5 個 | 422 |
| 文字列 | service_id・系統名・行き先は 100 文字、事業者名は 200 文字 | 422 |
| 数 | 0 以上 1,000,000 以下の整数。網羅率・重なりは 0〜1 | 422 |

- target と candidates の service_id は `services` の中にあること。同じ `(serviceId, role)` の target は2つ置かない
- 422 の本文には、項目の場所と種類だけを日本語で返し、送られた値(pydantic の `input`)を返さない(レビュー S9)
- ブラウザは送る前に上限に収める(§7.3 A の `buildJevRequest`)。それでも収まらないときは Jev を呼ばず、「service が多いため、Jev に問わず規則だけで分けました」と出す(413 を利用者に見せない)

**中継を汎用の Jev の口にしない。** 質問(`questions`)はブラウザから受け取らず、サーバーが固定の文から組み立てる。ブラウザが送れるのは判断材料の数と名前と、target の役割だけ。

**State の組み立て**(target ごとに1つ。数は文字列にする):

```jsonc
{
  "feed": { "agency": "北海道中央バス", "period": "2026-10-01 to 2027-03-31",
            "days_in_period": { "weekday": "122", "saturday": "26", "sunday_or_holiday": "34" } },
  "target": { "service_id": "S000027", "asked_as": "saturday",
              "trips": "667", "route_count": "41",
              "running_days": { "total": "59", "weekday": "2", "saturday": "25", "sunday_or_holiday": "32" },
              "coverage": { "weekday": "0.02", "saturday": "0.96", "sunday_or_holiday": "0.94" },
              "first_departure": "06:05", "last_arrival": "23:40",
              "routes_with_trip_counts": { "...": "..." }, "headsigns": ["..."], "running_dates": null },
  "candidates": [ { /* target と同じ項目 */ "route_overlap_with_target": "0.72" } ]
}
```

**質問**(英語。f7 の v2 の文をもとにする。`role` で組を変える):

- `role = 'weekday'`(平日だけの側として問う):
  - `service_kind`(choice):`regular_weekday`(ほぼすべての平日に走る)・`limited_weekdays`(大学の授業日・特定の曜日など、一部の平日だけ)・`specific_dates`(迂回・行事など、特定の日だけ)
  - `is_school_service`(boolean):行き先・系統名が大学・学校を指し、授業日だけ走るか
- `role = 'saturday'`・`'sundayHoliday'`(入れ替えに使う側として問う):
  - `weekday_counterpart`(choice):`candidates` の service_id と `none`。「平日をこの曜日のダイヤにするとき、この service の便は、どの平日の service の便の代わりに走るか」。criteria の値は「The weekday service with service_id {id}.」と、`none` の説明
- 改訂前の `sat_pair_*`・`sun_pair_*`(候補ごとの boolean)は入れない。割り当ては多対1になったので、候補ごとの確率は choice の `probabilities` で足りる

**送り方**

- 送り先は §3.2 の URL・ヘッダー。本文は `{state, questions, providerOptions}` で、`providerOptions` は転送先を TypeSafe AI だけに限る `{"gateway": {"only": ["typesafe-ai"]}}`(固定。§6.2-1)。TypeSafe AI が答えないとき、Vercel はほかの会社に回さず失敗を返し、中継も失敗(`upstream` など)として扱う。`DISPATCHER_JEV_URL` は、ホストが `ai-gateway.vercel.sh` で `https` のときだけ使う。ほかのホストを設定したら `available: false`(`reason: "badUrl"`)にする(キーを Vercel 以外に送らないため。nit)。401・403 が返っても、ほかの口に送り直さない(M4)
- 1つの target を1リクエストにする。並行は 4 つまで
- 待つ時間:1リクエスト 10 秒。429・503 は 0.5 秒・1 秒を空けて2回まで送り直す(Gateway は混んだときに 503 を返す)。全体で 30 秒を超えたら、残りを打ち切り、届いた分だけを返す(打ち切った target は `timeout`)
- 答えの形を確かめる:質問の名前がすべてあり、型が合い、choice が候補の中にあり、確率が 0〜1 で、choice の確率の和が 1 ± 0.03。合わなければその target を `invalid_answer` にする。`stats` などドキュメントに無い項目は読み飛ばす
- `providerMetadata.gateway.routing.finalProvider` を target ごとに返す。転送先を限っているので `typesafe-ai` のはずだが、それ以外なら、画面に「Vercel が別の送り先(digitalocean)に回しました」と出す(念のための表示)

**キー・設定(`settings.py`)**

| 関数 | 環境変数 | 既定 |
| --- | --- | --- |
| `jev_api_key()` | `TYPESAFE_AI_VERCEL_KEY` | 無し(無ければ `available: false`、`reason: "noKey"`) |
| `jev_url()` | `DISPATCHER_JEV_URL` | `https://ai-gateway.vercel.sh/v4/ai/evaluation-model` |
| `jev_model()` | `DISPATCHER_JEV_MODEL` | `typesafe-ai/jev`(ヘッダー `ai-model-id` に入れる) |
| `jev_requests_per_ip_hour()` | `DISPATCHER_JEV_PER_IP_HOUR` | 6(読み込み1回が1要求) |
| `jev_requests_per_ip_day()` | `DISPATCHER_JEV_PER_IP_DAY` | 20 |
| `jev_targets_per_day()` | `DISPATCHER_JEV_TARGETS_PER_DAY` | 2,000(サーバー全体。日本時間の日付ごと) |
| `jev_cost_cents_per_day()` | `DISPATCHER_JEV_COST_CENTS_PER_DAY` | 100(サーバー全体。`gateway.cost` の合計) |

- 値は呼ぶたびに環境変数から読む(今の `settings.py` と同じ)。キーの値はログにも応答にも出さない
- `.env.example` に `TYPESAFE_AI_VERCEL_KEY=` を足す。本番は compose の環境変数で渡し、イメージに入れない
- 回数制限:`ratelimit.py` の `Kind` に `"jev"` を足し、IP ごとの1時間と1日を数える。サーバー全体の1日の target の数と額は、SQLite の表 `jev_usage(day TEXT PRIMARY KEY, targets INTEGER, cost_microusd INTEGER)` に持つ(再起動で 0 に戻さない)。額は応答の `gateway.cost` を足す。上限に達したら、残りの target を送らず `budget` で返す
- 額は、送る直前に本文の大きさから見込んだ額(1 target あたり 360 マイクロドル以上。試しの1回の額)を足し、`gateway.cost` が届いたら差を直す。`cost` が無い応答・200 以外・timeout では見込みの額のまま残す(額の上限が target の数だけにならないため)。1 target の額が $1 を超える値は読み違いとみなして使わない。上限は足す前の額で判断するので、並行して送る数の分だけ超えうる
- 費用の上限を target の数だけでかけないのは、本文の大きさで費用が変わるため(S8)。上限の本文(候補 5、系統 20、文字列 100 字)で1 target はおよそ 1.5 万トークン以下、約 $0.0007 と見込む。IP ごとの上限(1時間 6 要求 × 40 target)だと、数個の IP で全体の 1日 2,000 target を使い切れる。そのときは全員が規則だけで動く(画面は「Jev の1日の上限に達したため、規則だけで分けました」)
- 接続元は `agent_relay.py` の `_client_address` と同じ規則(`DISPATCHER_TRUST_PROXY=1` のときだけ X-Real-IP)。共通の関数に切り出す
- 認証コードは掛けない(2026-11-03 の決定)
- HTTP の呼び出しには `httpx2` を使う(`anthropic` が使うものと同じ。本番の依存に明示した。`httpx` は開発の依存だけ)。リダイレクトはたどらず(`follow_redirects=False`)、環境変数を読まない(`trust_env=False`。`HTTPS_PROXY`・`ALL_PROXY`・`SSL_CERT_FILE`・`.netrc` で、キーを付けた要求の通り道と信頼する証明書を変えさせない)
- `DISPATCHER_JEV_MODEL` は、`typesafe-ai/` で始まり名前の形のときだけ使う(同じキーで別のモデルを呼ばないため)。ほかは既定の `typesafe-ai/jev`
- 上流に送った後の失敗(`timeout`・`rate_limited`・`upstream`・`invalid_answer`)は、`failures[].sent` に送った本文を入れる(§3.6 の「送った情報を見る」で、外に出た判断材料を全部見せるため)

### 3.4 規則の案と Jev の答えの合わせ方

項目は2つ:`weekdayOnly` の service の `basis`(Jev の `service_kind`)と、`replacement` の service の `into`(Jev の `weekday_counterpart`)。

| 規則 | Jev | 案の値 | 画面の印 |
| --- | --- | --- | --- |
| 決まった | 同じ値で、確信が高い | 規則の値 | `agreed`(規則と Jev が一致) |
| 決まった | 同じ値で、確信が低い | 規則の値 | `rule` |
| 決まった | 違う値で、確信が高い | 規則の値 | `conflict`(食い違い。確かめが要る) |
| 決まった | 違う値で、確信が低い | 規則の値 | `rule` |
| 決まらない | 確信が高い | Jev の値 | `jev` |
| 決まらない | 確信が低い | 空 | `undecided`(選んでもらう) |
| どちらでも | 失敗・上限・キー無し・止めた | 規則の値(決まらなければ空) | `rule` / `undecided` |

- 確信が高い:`confidence` が 0.9 以上で、選んだ値の確率が 0.8 以上(しきい値は `merge.ts` の1か所の定数)。試しの1回の `saturday_counterpart`(確信度 0.86)は「低い」になる
- `service_kind` は `regular_weekday` → `regular`、`limited_weekdays` → `partial`、`specific_dates` → `special` に当てる。`basis` が食い違っても、既定の扱いは規則の `basis` で決める
- `is_school_service` が 0.7 以上なら、理由の文を足す(§2.5)
- 利用者が直した行は `edited` にし、Jev の答えでは戻らない。「案に戻す」で規則と Jev の案に戻せる
- **確定の条件**(S7):`undecided` が 0 件なら確定できる。`conflict` は確定を止めない(件数を表の上に出し、行ごとに「この値でよい」を押すと消える)。`unsupportedService` のエラーは確定を止めず、その kind の減便の方針を適用できなくする
- Jev は同じ State にも少しぶれた答えを返すことがある。読み込み直すと印が変わりうることを、判断材料の開閉の中に書く(nit)

### 3.5 ログ

- 残すもの:日時、要求の数、target の数、届いた答えの数、失敗の種類ごとの数、HTTP の状態、使ったトークンの合計、`gateway.cost` の合計、転送先の名前(`typesafe-ai` など)、回数制限の種類
- 残さないもの:判断材料、State、質問、答え、service_id、事業者名、系統名、行き先、API キー、IP アドレスの生の値、上流のエラーの本文(S9)
- `httpx2`・`httpcore2`(と `httpx`・`httpcore`)のロガーは WARNING より上だけを出す(要求の URL とヘッダーを DEBUG に出さないため)
- `docs/interfaces-1105.md` §4.12 と同じロガー(`dispatcher_server`)を使う

### 3.6 自動で呼ぶ・止める・送った情報を見る

- **いつ呼ぶか**:単純でない GTFS で、祝日一覧の状態が決まり、判断材料と規則の案ができたあとに、自動で1回だけ呼ぶ。`GET /api/service-groups` が `available: false` なら呼ばない
- **送る前に止める**:読み込みの手順の、ファイルを選ぶ欄の上に「単純でない GTFS では、service ごとの集計を Jev に送って分け方を確かめる」のスイッチ(既定はオン)を置く。オフなら送らない。自動で送るので、止める手段は送る前に効く所に置く(M4)。スイッチの値は store に持ち、ブラウザに保存しない
- **送っている間に止める**:「Jev への問い合わせをやめる」ボタン(`AbortController` で中断し、届いた分は捨てて規則の案にする)
- **あとで捨てる**:「Jev の判断を使わない」ボタン。Jev の答えを捨て、規則の案だけにする(利用者が直した行は残す)
- **送った情報を見る**:「送った情報を見る」の開閉で、**サーバーが実際に Jev に送った本文**(応答の `results[].sent` と、送った後に失敗した target の `failures[].sent`。State と質問)を target ごとに出す。ブラウザが作った下書きではなく、サーバーが返したものを出す(M4)
- 送ったことの文(表の上に1行):「service ごとの集計(運行日の数・便数・系統名・行き先・始発と終着の時刻・事業者名・有効期間)を、TypeSafe AI Jev(Vercel AI Gateway 経由)に送り、分け方を確かめました。GTFS のファイル・停留所の位置・時刻表そのものは送っていません。」
- Jev を使えないときは理由を1行で出す(キーが無い/上限/失敗/止めた)

## 4. 形2の編集を複数の service に広げる

### 4.1 型(後方互換)

`web/src/gtfs/edit/ops.ts`:

```ts
/** 平日だけの service と、その便の代わりに加える入れ替えに使う service(0 個なら「なくす」) */
export interface ServicePair {
  /** 入れ替え元のダイヤ(平日)の service_id。期間の間、この service の便はなくなる(平日に戻した便・除外した系統の便を除く) */
  weekday: string
  /** 入れ替えに使うダイヤ(土曜/日祝)の service_id。この順に便を加える。空なら便をなくすだけ */
  replacements: string[]
}

export interface PolicySettings {
  kind: PolicyKind
  /** 主の組の平日の service(今のまま)。pairs があるときは pairs[0].weekday と同じ */
  weekdayService: string
  /** 主の組の入れ替えに使う service(今のまま)。pairs があるときは pairs[0].replacements[0]、空なら '' */
  replacementService: string
  period: Period
  excludedRoutes: string[]
  /** 組の表(主の組が先頭)。無ければ [{weekday: weekdayService, replacements: [replacementService]}] として扱う(今の処理) */
  pairs?: ServicePair[]
  /** グループ分けで「残す」と決めた平日の service。知らせるだけで、便は変えない */
  keptWeekdayServices?: string[]
}

export function pairsOf(settings: PolicySettings): ServicePair[]
export function weekdayServicesOf(settings: PolicySettings): Set<string>   // pairsOf の weekday の集合
```

- `pairs`・`keptWeekdayServices` が無いときは、計画・出力・report が今とバイト単位で同じ。`planOf` は、入っていないときは項目を書かない(`undefined` の項目を作らない)。正解データ(`form2.golden.json` の5つの場面)と `form2_ref.py` は変わらない
- `pairs` の並び:主の組を先頭、そのあとは `weekday` の昇順。`replacements` は主の入れ替えに使う service を先頭、そのあとは昇順(A の `policyServicesFor` がこの並びで作る。trip_id の割り当てが毎回同じになるため。nit)
- `replacementService` が `''` になるのは、`pairs` があり、主の組に入れ替えに使う service が無いとき(名士バス・羽幌町)だけ

### 4.2 `checkPolicy`

`pairs` が無いときは今のまま。`pairs` があるときは次を足す・変える。

| 確かめること | 重さ | code |
| --- | --- | --- |
| `pairs` が空でない。`pairs[0].weekday === weekdayService`。`replacementService === (pairs[0].replacements[0] ?? '')` | エラー | `badPairs` |
| 平日の service が組の間で重ならない。入れ替えに使う service が組の間・組の中で重ならない(M2)。入れ替えに使う service が平日の service や `keptWeekdayServices` に入っていない。`keptWeekdayServices` が平日の service と重ならない | エラー | `duplicateService` |
| 平日の service と入れ替えに使う service に便がある | エラー | `noWeekdayTrips`・`noReplacementTrips` |
| 平日の service の calendar の行に、土曜か日曜の列が 1 のものがある(§2.6 を祝日一覧なしで確かめる。土曜に走るなら加わる便と土曜の便が重なり、日曜に走るなら日曜の便がなくなる) | エラー | `weekdayServiceRunsOnWeekend` |
| 入れ替えに使う service の calendar の行に、月〜金の列が 1 のものがある(`weekdayServiceRunsOnWeekend` と対。平日の service の走る日に加えると、その便が2回走る)。calendar_dates だけの重なりは `replacementRunsWithWeekday` の警告のまま | エラー | `replacementRunsOnWeekday` |
| 主の組の平日の service:`weekdayCalendarOutside`・`weekdayNotActive` | 今のまま | |
| 主でない組の平日の service が、新しい有効期間に1日も走らない | 情報(警告の一覧に入れる) | `pairWeekdayNotActive`(「01001_C は期間に走らないため、組ごと出力から除きます」) |
| 入れ替えに使う service が、新しい有効期間に1日も走らない(**主の組も主でない組も同じ規則**) | 警告(止めない。その service の便は**加えない**。2026-11-04 に利用者が決定。§6.2-7) | `replacementNotActiveSkipped`(「入れ替えに使う service(03001_C)は新しい有効期間(…)の中で1日も走らないため、その便を 01001_C に加えません(季節ダイヤや迂回の版の便が平日に混ざらないようにするため)。」。組の入れ替えに使う service がすべて加わらないときは「01001_C には加わる便がなく、01001_C の便は走る日(11/2)に代わりの便なしでなくなります。」を添える) |
| 主の組の、便のある入れ替えに使う service が**すべて**新しい有効期間に1日も走らない | エラー(主の平日の便を代わりの便なしでなくさないため) | `replacementNotActive` |
| 入れ替えに使う service が、新しい有効期間の X の日(土曜に:土曜、日祝に:日曜。祝日一覧は受け取らないので数えない。年末年始 12/29〜1/3 は入力の calendar_dates の扱いを残すので除く)のうち走らない日がある | 警告(組ごとに1つ。service ごとの日数と日付を文に入れる) | `replacementPartial`(「S000001 に便を加える…(S000049:3 日(12/5・12/12・12/19))」) |
| 平日の便を指すほかの表の行(`tripReferences`) | エラー | すべての平日の service の便で見る |
| 除外する系統の `excludedRouteWithoutWeekdayTrips` | 警告 | すべての平日の service の便で見る |

- `weekdayServiceRunsOnWeekend`・`replacementRunsOnWeekday` は `pairs` があるときだけ見る(今の1組の処理を変えない)。`pairs` が無いときの `replacementNotActive`・`replacementPartial`(calendar の範囲で見る)は今のまま
- 期間に走らない入れ替えに使う service は、季節の service(北海道中央バスの冬ダイヤ `S000041`・`S000042`)も迂回の版(京都 `03001_C`)も同じく加えない(2026-11-04 に利用者が決定。§6.2-7)。判定は `isReplacementNotActive`(`ops.ts`。便があり、calendar と calendar_dates で新しい有効期間に1日も走らない)で、`checkPolicy`・`applyForm2`・画面(`skippedReplacements`)で同じ規則を使う
- 祝日の確かめは `checkPolicy` ではしない(祝日一覧を受け取らないため)。§2.6 の祝日つきの判定は A がする

### 4.3 `applyForm2`(`form2.ts`)の変え方

取り決め `docs/interfaces-1104.md` §5 の節ごとに書く。`pairs` が無いときは `pairsOf` が1組を返すので、同じ処理を通る。

- **§5.2 便の分け方**:平日の便 = service_id が `weekdayServicesOf` にある便。組ごとに、入れ替えに使う service の便(除外した系統を除く)を加わる便の元にする。加わる便の service_id は、その組の `weekday`。新しい有効期間に1日も走らない入れ替えに使う service(`skippedReplacementsOf`。§4.2 の `replacementNotActiveSkipped`)の便は、加わる便の元にも、平日に戻す便の「すでにある」の照合(§4.5)にも入れない(2026-11-04 の決定)
- **§5.3 平日に戻す便の分類**:§4.5
- **§5.4 加わる便の trip_id**:§4.4
- **§5.5 行の並び**:今のまま
- **§5.6 有効期間、calendar、calendar_dates**:`clampCalendars` は変えない。新しい有効期間に走らない平日の service(`droppedServiceIds` にあるもの)の組は、加わる便も出さない(trips は行ごとに service_id で落とす今の処理のまま。stop_times の `'input'` の並びの枝にある `if (!droppedServiceIds.has(wk))` を、加わる便の行ごとの判定に変える)
- **§5.8 警告**:
  - `otherWeekdayServices`:曜日の列が月〜金の service のうち、平日の service にも `keptWeekdayServices` にも無く、便があり、期間に走るものだけ
  - `weekdayServicesKept`(新):`keptWeekdayServices` のうち便があり期間に走る service を、走る日の数(10 日以下なら日付)つきで知らせる(S5)
  - `weekdayServicesErased`(新):入れ替えに使う service の無い組(なくす service)を便数つきで知らせる(「入れ替えに使うダイヤが無いため、期間の間なくす service:01005_MSN 3 便」)
  - `replacementRunsWithWeekday`(新):入れ替えに使う service と、その組の平日の service が、新しい有効期間の同じ日に走る日(5 つまで)。その日は加わる便と入れ替えに使う service の便が同じ時刻で2回走る
  - `replacementNotActiveSkipped`(新。2026-11-04):期間に走らないため加えなかった入れ替えに使う service と便の数(「03001_C:314 便 → 01001_C」)。組の入れ替えに使う service がすべて加わらないときは、その組の平日の便が代わりの便なしでなくなることを便数つきで添える。`validateEdit` を通って対象便の確認の「確かめること」に出る(file は trips.txt)
  - `blockIdCopied`:今のまま
- **report**:`tripIds.rule`・`servicePartIndex` は主の組の値(主の組に入れ替えに使う service が無ければ `'append-service'`・null)。`pairs` があるときだけ、新しい項目 `report.pairs` を足す:

```ts
pairs?: {
  weekday: string
  /** 新しい有効期間に走らないため、組ごと除いた */
  dropped: boolean
  /** なくなる平日の便の数 */
  removed: number
  /** notActive:新しい有効期間に1日も走らないため、便を加えなかった(added は 0。2026-11-04) */
  replacements: { serviceId: string; rule: TripIdRule; servicePartIndex: number | null; added: number; notActive: boolean }[]
}[]
export type TripIdRule = 'replace-service-part' | 'replace-family-part' | 'append-service'
```

- **元のダイヤに戻す版(`applyRevert`)**:便は変えない。`RevertOptions.services` に `pairs?` を足し、検証の祝日の確かめに渡すだけ

### 4.4 加わる便の trip_id(S1)

組の中の (平日の service W, 入れ替えに使う service R) の組み合わせごとに、置き換えの位置を1つ決める。**`pairs` の有無で規則を変えない。**

1. **service_id の部分**(`replace-service-part`。今の `findServicePart`):W の便と R の便のすべてで trip_id を `_` で分け、部分の数がすべて同じで、左から k 番目の部分がどの便でも自分の service_id と等しい k。複数あれば一番右
2. **頭の部分**(`replace-family-part`。新):1 で決まらなければ、W の便と R の便のすべてで、左から k 番目の部分が自分の service_id の頭(最初の `_` より前)と等しい k。部分の数はそろっていなくてよい。**すべての便で共通の k を求め、複数あれば一番右**。部分が k+1 個に足りない便が1つでもあれば、その k は使わない。置き換えは、k 番目の部分を R の頭から W の頭にする
3. **後ろに付ける**(`append-service`):どちらでも決まらなければ、今と同じく `{元の trip_id}_{W}`

- 実装で足した条件:部分が1つしかない便があるとき(trip_id 全体を置き換えることになる)と、W と R の頭が同じとき(置き換えても trip_id が変わらない)は、2 を使わない

- 京都 `03001` → `01001`:部分の数が 3 と 4 で混ざるので 1 は決まらず、2 で k = 1(`02001` の 10 便は 0 番目も 1 番目も頭と同じだが、共通の k は 1 だけ)。`00100_03001_9389` → `00100_01001_9389`。今は `append-service`(`00100_03001_9389_01001`)なので、京都の1組の出力の trip_id が変わる。正解データは道北バスだけで、道北バスは 1 で決まるので変わらない
- 京都 `03001_A` → `01001_A`:`05800_03001_11011_A` → `05800_01001_11011_A`。調べた範囲では、ほかの service の trip_id とぶつかるものは 0(`03001`・`_A`・`_C`・`_F`・`_GYB` と `02001` → `01001`)
- 北海道中央バス・沿岸バスなど(`T0102000001`):`_` が無いので 3。`T0102000002_S000001`
- 押さえる trip_id は、平日の service に無い service のすべての便、除外した系統の便、平日に戻した便。割り当て済みの trip_id は全部の組で1つの集合にする。ぶつかったら今と同じく `_2`・`_3` を付けて `collisions` に入れる
- 割り当ての順:`pairs` の順、組の中は `replacements` の順、その中は元の trip_id の昇順
- `docs/interfaces-1104.md` §5.4 に規則 2 を足し、参照実装 `form2_ref.py` は規則 2 と複数 service を扱わないことを §11 に書く(C)

### 4.5 平日に戻す便の分類(S2・S3)

前から順に、最初に当てはまったもの:

1. `duplicate`(同じ trip_id を2回)、`notFound`(減便前の GTFS に無い):今のまま
2. `alreadyKept`(新。`pairs` があるときだけ):その便の service が `keptWeekdayServices` にある。平日のまま走るので戻す必要がない(S3)
3. `notWeekday`:その便の service が平日の service に無い
4. `notActive`(新。`pairs` があるときだけ):その便の service が、新しい有効期間に1日も走らないため組ごと出力から除く平日の service(`report.droppedServices`)にある。出力に入らないので戻さない。`keepIds`・押さえる trip_id にも入れない(受け付けると、GTFS に無い便を「平日に戻した」と報告し、加わる便の trip_id に要らない `_2` が付く)
5. `ignoredExcludedRoute`:今のまま
6. `ignoredAlreadyPresent`:同じ署名の加わる便か、先に受け付けた平日に戻す便があり、**その便の service が、戻そうとする便の service の走る日(新しい有効期間の中)をすべて含む**とき。同じ service なら常に含む(今の1組の処理と同じ)。含まないときは「すでにある」とみなさず受け付ける(S2。例:`01001` の便と同じ署名の加わる便が `01001_A` にあっても、`01001_A` は 11/2 に運休するので、11/2 にその便がなくなる)
7. それ以外は `accepted`

- 「同じ署名」の表は、組をまたいで1つにする(京都の `01001` と `01001_A` は系統を3つ共有する)。表の値は (加わる便の元の trip_id, 加わる便の service) の一覧にし、6 の含むかの判定に使う
- `addBack.alreadyKept`・`notActive` は `pairs` があるときだけ置く(無いときは項目を作らない。正解データのテストが `report.addBack` を `toEqual` で比べているため)
- 除外した系統の便も、組ごと除く平日の service の便は「残した便」(`tripIds.kept`)に数えない

### 4.6 ほかの所

| 場所 | 変え方 | 担当 |
| --- | --- | --- |
| `validate/edit.ts` | 平日ダイヤが走る日・`weekdayNotRunning` は主の組で見る(01002_RIT のように一部だけ走る service で警告があふれないため)。祝日の確かめ(`holidayWithoutException`)は、すべての組の平日の service で、祝日に走る日を見る | C |
| `validate/feed.ts` の署名の確かめ | 平日の側を `weekdayServicesOf` で判定する | C |
| `edit/diff.ts` の `diffWeekdayTrips` | 平日の service の集合を受け取る。呼ぶ側は `activeWeekdayServicesOf(result)`(`form2.ts`。`weekdayServicesOf(plan)` から `report.droppedServices` を引いたもの)を渡す。`weekdayServicesOf(plan)` を渡すと、組ごと除いた service(京都 11/5〜の `01001_C` の 310 便)まで「なくなる便」と平日に戻す候補に入る | C |
| `edit/restore.ts` | 平日に戻す判断材料の対象を、平日の service の集合の便にする。`replacementRoutes`・`weekdayOnlyRoute` は入れ替えに使う service の和集合で見る | C |
| `edit/notice.ts` | 比較する日付は主の組で見る(今のまま)。文の中に service_id を出さない | C(変えないことをテストで確かめる) |
| `store/edit.ts` の `diffOf` | `activeWeekdayServicesOf(result)` を渡す(今は `plan.weekdayService` の1つを渡している) | D |
| `claude/tools.ts` | `add_back_trips`・`search_trips` の `base_weekday` を平日の service の集合にする。`deps.policyServices` を `policyServicesFor`(§7.5)に変える(S11) | D |
| `RestoreStep.tsx`・`ChangeOrder.tsx`・`ExportStep.tsx` | 「その日に平日の service が走るか」は主の組で見る。`applyRevert` に承認した方針の `pairs` を渡す | D |

到達圏は日付で走る service を拾う作り(`activeServiceIds`)なので、変える所は無い。

### 4.7 京都市営バス・北海道中央バスで気を付けること

- **京都 `_C`(五条坂を通らない迂回の版)**:`01001_C` は calendar_dates だけの service で、11/2 だけ走る(その日は `01001_A` と `01003_KSU` に運休の例外がある)。期間が 11/2 を含むとき、規則の案は `01001_C` ← `03001_C` で入れ替える。`03001_C` は 10/31 だけ走るので、期間を 11/1 から始めると新しい有効期間に走らないので、その便は加えない(警告 `replacementNotActiveSkipped`。2026-11-04 の決定。§6.2-7)。`01001_C` の 310 便は 11/2 に代わりの便なしでなくなる(11/2 に走る便は 5,063)。期間の開始が 11/3 以降なら `01001_C` は出力から除かれる(情報 `pairWeekdayNotActive`)
- **京都 SRV(秋の土日祝の臨時便)**:特別で、接尾辞の合う平日の service が無いので使わない。土曜・日祝の自分の日にはそのまま走る
- **年末(12/29〜1/3)**:京都は `01001` 系の削除と `02001` 系の追加、北海道中央バスは `S000001` の削除と土日祝の service の追加で表している。calendar_dates はそのまま残すので、入れ替えたあとも年末は日祝ダイヤで走る。北海道中央バスの土日祝の service は年末の平日にも走る(網羅率 0.02)が、その日は `S000001` が走らないので、加わる便と重ならない(重なる日があれば `replacementRunsWithWeekday` が出す)
- **block_id**:京都は 17,796 便にある。今と同じく警告 `blockIdCopied`
- **京都の到達圏**:参照データ(`data/out/ref/` は北海道の 6541〜6643 だけ)に京都(1次メッシュ 5235)の DID・人口・鉄道が無い。京都は形2の出力と検証の確認にだけ使い、到達圏は見ない(M5)
- **translations.txt で止まる GTFS**(C の実装とレビューで分かった。2026-11-04):translations.txt の trips・stop_times の行が `record_id` で平日の便を指すため、今の `checkPolicy` は `tripReferences`(1104 §5.2)で止める。**北海道中央バスだけではない。** グループ分けの規則の案・土曜に・期間 11/9〜で確かめた結果(`form2.multi.verify.test.ts` の表のテスト):

  | 止まる(行の数) | 止まらない |
  | --- | --- |
  | 北海道中央バス 34,852、士別軌道 1,658、北門バス 849、羽幌町 439、空知中央バス 172、沿岸バス 164、名士バス 6 | 道北バス(9/17 版・10/29 版)、旭川電気軌道、京都市営バス |

  名寄市は規則の案に入れ替える便が無い(`nothingToChange`)。§2.8 の北海道中央バスの便の数は、translations.txt を除いたフィードで確かめた。§6.2-6 がデモの「複雑な形」の案にしている士別軌道も、このままでは画面から適用できない。(a) 1104 §5.2 の規則 1〜3 を translations だけ先に入れる(消した便を指す行は除き、加わる便には入れ替えに使う便の行を新しい trip_id で写す)か、(b) デモを京都・道北バス・旭川電気軌道にするかは、11/6 15:00 の判断より前に利用者に聞く(§6.2-6)
- **北海道中央バスの到達圏**:停留所は 1次メッシュ 6440・6441・6541・6542 にある。札幌の 6440・6441 の参照データ(e-Stat の人口メッシュの 6440・6441 を含む)はまだ作っていない。デモで到達圏も見せるなら、D の前に `data/` の加工で作る(D9)

## 5. 画面(D で作る)

### 5.1 読み込みの手順の「ダイヤのグループ分け」

置き場所:`LoadStep.tsx` の「読み込んだ GTFS の版と期間」(`FeedSummary`)の下に、新しい部品 `components/steps/load/ServiceGroupsCard.tsx` を置く。今の「service_id ごとの便数」の一覧は、この表に置き換える。

**単純な GTFS**:1行の要約だけを出す。「平日 01・土曜 03・日祝 06 に分かれています(走る日から判定しました)。」(名士バスなら「平日だけの S000002 は、期間の間なくします。土曜・日祝は毎日運行の service だけが走ります。」)と「詳しく見る」の開閉。確定のボタンは出さず、読み込んだ時点で確定とする。

**単純でない GTFS**:

- 上に要約:「service_id が 33 個あります。平日・土曜・日祝のダイヤにまとめた案を作りました。確かめが要るものが 3 件あります。」
- タブで方針の種類を分ける:「平日を土曜ダイヤに」「平日を日祝ダイヤに」。役割が kind ごとに違うため
- Table の並び:入れ替える組(平日の service の下に入れ替えに使う service)→ なくす → 残す → 形2で表せない → 両方に走る・関係しない・使わない(閉じた開閉の中)

| 列 | 中身 |
| --- | --- |
| service_id | `01001_A`(等幅) |
| 走る日 | 「平日 97%・土曜 0%・日祝 0%」と、`basis` の語(ほぼ毎回/一部の日/特定の日/運行日なし)。印(Badge)を横に出す |
| 便数・系統 | 310 便・8 系統 |
| 役割 | 平日だけ/入れ替えに使う/両方に走る/形2で表せない/関係しない |
| 便を入れる平日の service | 入れ替えに使う service の行だけ。Select(その kind の平日だけの service と「使わない」) |
| 扱い | 平日だけの service の行だけ。Select(入れ替える・なくす/残す)。形2で表せない行は「残す」だけ |
| 判断材料 | 開閉の中に、規則の理由(定型の文)と、Jev の答え(確信度と確率) |

- 印(Badge)の色と文:一致(緑「規則と Jev が一致」)、規則(灰「規則」)、Jev(青「Jev の判断」)、食い違い(琥珀「規則と Jev が食い違っています」)、決まらない(赤「選んでください」)、利用者が直した(灰「直しました」)
- 確定のボタン:「このグループ分けで進める」。`undecided` が 0 件になるまで押せない(§3.4)。食い違いが残っていれば、ボタンの下に「規則と Jev が食い違っている N 件は、規則の値で進めます」と出す。確定すると表を閉じ、「グループ分けを確定しました。直すときは表を開きます。」と「表を開く」を出す。確定したあとに直すと、承認した減便の方針がある場合は「減便の方針を承認し直すまで、出力には反映されません」、承認待ちの方針の下書きがある場合は「承認待ちの下書き #N には反映されません」と出す
- 確定したあとの直し(直す・案に戻す・Jev の判断を使わない)で `undecided` の行が戻ったら、確定を外す(減便の方針の手順が `undecidedReplacement` で止まるのと、言うことをそろえる)。確定したあとに Jev に問い合わせ直して、割り当て・扱い、または確かめが要る行が変わったら、確定を外して表を開く
- 「Jev に問い合わせる」は、スイッチを切っていた・中断した・失敗した(回数の上限など)あとに出す。使えない(キーが無い・1日の上限)ときは出さない。サーバーが入口で断った(429・503 など)ときは、サーバーの文(いつ使えるようになるか)に「Jev には送っていません。」を足して出す
- 区分や割り当てを直したら、その行に関係する既定(扱い・印)を計算し直す(A の `editGroups`。nit)
- Jev の欄は §3.6

### 5.2 減便の方針の手順

- 減便の方針に入れる service は、単純な GTFS を含めて `policyServicesFor(groups, kind)`(§7.5)の値にする。単純な GTFS では、入れ替えに使う service があれば `pairs` 無しの今の形(道北バスは今と同じ)、無ければ `pairs` つきで `replacementService: ''`(名士バス・羽幌町。「平日だけの S000002 をなくす」)になる。今の service の選択(`ServiceSelect`)は、グループ分けをまだ計算していないとき(祝日一覧を待っている間など)だけに使う
- 単純でない GTFS でグループ分けが確定していれば、「[平日] を [土曜] ダイヤに変更する」の穴埋めの選択肢を、ダイヤの語にする:「平日のダイヤ(01001 ほか 8)を土曜のダイヤ(03001 ほか 4)に変更する」。確定していなければ、上に「読み込みの手順でダイヤのグループ分けを確かめると、ダイヤ単位で選べます」とリンクを出す
- 「組の内訳」の開閉:組の表(平日の service ← 入れ替えに使う service、便数)、なくす service、残す service、形2で表せない service
- `unsupportedService` のエラーがある kind は「適用する」を押せず、「形2で表せない service が 2 つあります。読み込みの手順で『残す』を選ぶと進めます」と出す
- `sameSatSun`(土曜と日祝が同じ時刻表か)は、すべての組で同じときだけ今の文を出す
- 第2段を外したとき(§7.1)は、内訳の上に「この版では、主の組(01001 ← 03001)だけを入れ替えます。ほかの組(4 つ)は平日のまま残ります。」を出す

### 5.3 AI のツール・変更指示書・周知文

- **AI(Claude)**:ツールの定義(`claude_tools.json`)は変えない(変えると `agents/coordinator.md` の写しと `ant apply` による版の上げ直しが要る)。グループの情報は、結果と [画面の状態] の行で伝える
  - `apply_policy` の結果の `services` に `groups: {pairs: {weekday, replacements}[], kept: string[], erased: string[]}` を足す
    - 数え方は画面の文・組の内訳(`sentenceServices`)と同じ。期間に走らないため組ごと除く平日の service は `pairs`・`erased` から外して `dropped_for_period` に、期間に走らないため加えない入れ替えに使う service は `pairs` から外して `not_added_for_period` に書く。入れ替えに使う service がすべて加わらない組は `erased` に入れる(2026-11-04)
    - 下書きの `summary.pairs`(組ごと)の `replacements_not_added_for_period` は、組ごと除いた組(`dropped_for_period: true`)では空にする
  - `screenLines.ts` の [画面の状態]:「平日のダイヤ:01001 ほか 8(グループ分けで確定)、土曜:03001 ほか 4。なくす:01005_MSN。残す:01002_RIT ほか 2」
  - `defaultPolicyServices`(`store/chat.ts`)は `policyServicesFor` の値を返す
- **変更指示書**(`ChangeOrder.tsx`):「平日 X → 土曜 Y」を、組があるときは組ごとの行にし、なくす service と残す service を別の行に並べる。第2段を外したときは、実際に入れ替えた主の組だけを「入れ替え」に書き、ほかを「入れ替えていない」に書く(S6。実際にしたことと食い違う書き方をしない)
- **周知文**(`notice.ts`):比較する日付(`pickNoticeDate`。変更指示書・調査の停留所も同じ日を使う)は、主の組の平日の service が走る日のうち、期間に走る組の平日の service(`activeWeekdayServicesOf`)の走り方がいちばん多い形の最初の日にする(京都の期間 11/1〜 で、01001_A が運休して迂回の版 01001_C だけが走る 11/2 を選ばないため。1組のときは主の組が最初に走る日で、今までと同じ)。文の中に service_id は出さない

### 5.4 運営情報のページと README

- `DataSources.tsx` に「送り先」の欄を足し、Jev を呼んだときだけ出す:「ダイヤのグループ分けの確かめ:TypeSafe AI Jev(TypeSafe AI)。Vercel AI Gateway を経由します。送るのは service ごとの集計(service_id、運行日の数と走る日の割合、便数、系統名と系統ごとの便数、行き先、始発・終着の時刻、運行日が 10 日以下の service の日付、事業者名、有効期間)で、GTFS のファイル・停留所の位置・時刻表そのものは送りません。TypeSafe AI に限って送ります(Vercel がほかの会社に回さないよう指定しています。TypeSafe AI が答えないときは、確かめを失敗として扱います)。」
- `AboutPage.tsx` の、AI(Claude)の利用に触れている所に、Jev を使うことと、Claude 以外の AI であること、役割(service の分け方の確かめだけ。会話・提案・説明は Claude)を足す
- README:「使っている AI と送るデータ」の節(無ければ作る)に、Claude(Anthropic)と並べて Jev を書く。サーバーの環境変数の一覧に §3.3 の7つを足す。`docs/deploy.md` にも足す
- CLAUDE.md の「アプリ内の Claude」に、Jev を使うこととこの文書への参照を足す

### 5.5 store

新しい store `web/src/store/serviceGroups.ts`(Zustand)。中身は A の純粋な関数を呼ぶだけにする。

```ts
export interface ServiceGroupsState {
  status: 'idle' | 'waitingHolidays' | 'computing' | 'judging' | 'ready'
  /** A の proposeGroups・mergeJevAnswers・editGroups の結果 */
  groups: ServiceGroups | null
  confirmed: boolean
  jevEnabled: boolean                 // §3.6 のスイッチ。既定 true
  jev: { state: 'unused' | 'done' | 'partial' | 'unavailable' | 'failed' | 'stopped' | 'dropped'; response: JevJudgeResponse | null }
  compute(feed: GtfsFeed, holidays: HolidayList | null): void
  edit(edit: GroupEdit): void
  confirm(): void
  stopJev(): void
  dropJev(): void
  reset(): void
}
```

- `resetAll`(`store/reset.ts`)に `useServiceGroupsStore.getState().reset()` を足す(読み込み直しと削除のどちらでも消す)。Jev の要求が飛んでいる間に読み込み直したら、届いた答えを捨てる(要求に番号を付け、`reset` で進める。今の到達圏の計算と同じ考え)
- グループ分けは IndexedDB に保存しない(2026-11-03 の決定)

## 6. 決めておく値と、残っている確かめ

### 6.1 決めておく値

| 値 | 既定 | 根拠と境目の例 |
| --- | --- | --- |
| `regular` の網羅率 | 0.7 以上 | 下:京都 `01004_BUK` 0.66。上:北海道中央バス `S000042` 日祝 0.76・`S000041` 0.79、道北バス 10/29 版 `06` 0.83、北海道中央バス `S000014` 0.84 |
| `partial` の網羅率 | 0.15 以上 | 上:北門バス `S000003`(火曜だけ)0.19、士別軌道 `S000006`(水曜だけ)0.21。下:北海道中央バス `S000015` 0.13、旭川電気軌道 `01` の日祝 0.12、京都 SRV 0.12 以下 |
| 境目の幅 | ±0.05 | 判断材料に書き、Jev に問う順を先にする |
| 重なりが小さい注意 | 0.2 未満 | 主の平日の service に入れたとき |
| Jev の確信が高い | 確信度 0.9 以上、選んだ確率 0.8 以上 | f7 の 01001_A 0.96。試しの1回の `saturday_counterpart` 0.86 は低い |
| 学校の便の印 | 確率 0.7 以上 | f7 の RIT 0.83、01001_A 0.07、試しの 01001_C 0.10 |
| Jev に問う target の上限 | 40 | 京都で平日だけの側 9 + 土曜 5 + 日祝 5 = 19、北海道中央バスで平日だけ・形2で表せない側 7 + 土曜 9 + 日祝 11 = 27 |
| サーバーの上限 | IP ごと 1時間 6・1日 20 要求、全体 1日 2,000 target・100 セント、本文 256 KB、待ち 10 秒・全体 30 秒 | 試しの1回が $0.00036 |

### 6.2 残っている確かめ(利用者に聞く)

1. **Vercel が別の会社(DigitalOcean)に回すこと。** 試しの応答に予備の送り先として出ていた。2026-11-04 に利用者が「TypeSafe だけに限る指定を試し、効けば入れる」と決めた。2026-11-04 に、本文に `providerOptions.gateway.only: ["typesafe-ai"]` を足して1回送った(北海道中央バスの集計を架空の名前に差し替えた `server/tests/fixtures/jev_judge_request.json` の土曜の target。入力 1,408・出力 60 トークン、$0.000059)。HTTP 200、`warnings: []`、`routing.fallbacksAvailable: []`、`routing.planningReasoning` は「Provider set restricted to: typesafe-ai. System credentials planned for: typesafe-ai. Total execution order: typesafe-ai(system)」、`finalProvider: "typesafe-ai"`。口は指定を受け付け、予備の転送先(DigitalOcean)が外れた。中継は本文に `providerOptions: {"gateway": {"only": ["typesafe-ai"]}}` を必ず入れ、README・画面・運営情報のページ・`.env.example`・`docs/deploy.md`・1105 §4.14 の「回すことがある」を「TypeSafe AI に限って送る」に直した。TypeSafe AI が答えないときは、ほかの会社に回らず失敗になる(済み)
2. **データを残さない指定(`zeroDataRetention`)。** 試していない。確かめないなら README に「データの保持は Vercel・TypeSafe の規約による」と書く
3. **新しい質問(§3.3)の答えの質を、実際の口で確かめるか。** 京都 `03001_C`・北海道中央バス `S000027` などで数回(1回約 0.05 円)。確かめないなら、しきい値は f7 と試しの1回の値で始める
4. **形2で表せない service の既定をエラーにしてよいか。** 北海道中央バスで「土曜ダイヤに」を選ぶと、1〜2 便の service のために利用者が「残す」を選ぶ手間が増える
5. **一部の日だけ走る平日の service の既定を「残す」にしてよいか。** 「平日を土曜ダイヤに」の字義どおりなら「なくす」になる
6. **デモに使う GTFS。** 単純な形は道北バス、複雑な形は士別軌道(参照データの 6642 の中にあり、到達圏も見られる。7 service、形2で表せない service あり)、多対1は北海道中央バス(到達圏には 6440・6441 の参照データが要る)を案とした。**ただし士別軌道・北海道中央バスは、今は translations.txt の `tripReferences` で減便の方針を適用できない(§4.7 の表)。** translations の規則を先に入れるか、デモを今適用できる GTFS(道北バス・旭川電気軌道・京都市営バス)にするかを、11/6 15:00 の判断より前に決める
7. **期間に1日も走らない入れ替えに使う service を加えるか外すか。** **決定(2026-11-04、利用者):加えない。** 季節ダイヤ・迂回の版が平日に混ざらないようにするため。主の組・ほかの組とも同じで、警告 `replacementNotActiveSkipped` を出し、画面(減便内容の確認・組の内訳)・確認の結果(確かめること)・変更指示書(組の内訳)に「期間に走らないため加えません」と出す。主の組の入れ替えに使う service がすべて走らないときのエラー `replacementNotActive` は今のまま。結果:北海道中央バスで期間を 10 月にしても、冬ダイヤの `S000041`・`S000042`(11/7〜)の便は 10 月の平日に加わらない。京都で期間を 11/1 から始めると、`03001_C`(10/31 だけ走る迂回の版)の便は加わらず、`01001_C` の 310 便は 11/2 に代わりの便なしでなくなる(その組の入れ替えに使う service がすべて加わらないため。警告の文に添える)。前の扱い(警告 `replacementNotActiveAdded` で加える)と、季節のダイヤだけ外す案は採らない
8. **テストの固定のデータ。** `server/tests/fixtures/jev_judge_request.json` は北海道中央バスの GTFS から集計した事業者名・系統名・行き先を含む(CC BY 4.0。出典は `server/tests/fixtures/README.md`)。リポジトリを公開する前に、このまま入れてよいか、作った名前に置き換えるかを決める。→ **決定(2026-11-04、利用者)**:事業者名・系統名・行き先を架空の名前に差し替えた(形・数は保つ)

## 7. 課題の分け方と取り決め

### 7.1 日程と、第2段を外す切れ目(M6)

| 時期 | 作業 |
| --- | --- |
| 11/4 午後〜11/5 | A・B・C を並行で作る。ファイルが重ならない(A は `web/src/gtfs/groups/`、B は `server/`、C は `web/src/gtfs/edit/`・`web/src/gtfs/validate/`)。C を変えたら `gtfs-reviewer` で確かめる |
| 11/5 | A と C の型をつなぐ(§7.5 の `satisfies` のテスト。後に入れた方が足す)。取り決めの文書(C が 1104、B が 1105) |
| 11/5〜11/6 | D。減便の方針の画面の作り直し(別のワークフロー)のコミットの後に始める |
| 11/6 15:00 | 判断:C が通っていなければ、第2段を外す |
| 11/6 22:00 | 機能凍結 |

**切れ目**:

- 第2段(C)は `pairs?` の後ろに全部ある。外すときは、A の `policyServicesFor` の引数 `{ multiService: false }` で、主の組(主の平日の service と主の入れ替えに使う service)だけを `pairs` 無しで返し、ほかの組・なくす・残すを `notApplied` に入れて返す。D はそれを §5.2・§5.3 の「入れ替えていない」に出す。C の変更は残っていても使われない(`pairs` を渡さなければ今の処理)
- 主の組に入れ替えに使う service が無い GTFS(名士バス・羽幌町)は、第2段を外すと減便の方針を適用できない(今と同じ)
- Jev(B)も外せる。B が間に合わなければ、サーバーが `available: false` を返す(エンドポイントが無ければブラウザは 404 を `unavailable` とみなす)。規則だけで動く

### 7.2 担当の一覧

| 担当 | 中身 | ワークフロー |
| --- | --- | --- |
| A | `web/src/gtfs/groups/` の純粋な計算(判断材料、規則、Jev の要求の組み立て、答えの合わせ方、直し、方針への写し、ブラウザの呼び出し)とテスト | この |
| B | サーバーの中継(`service_groups.py`、設定、回数制限、SQLite、ログ)とテスト。`.env.example`、`docs/interfaces-1105.md` §4 | この |
| C | 形2の編集の複数 service 化(`ops.ts`・`form2.ts`・`diff.ts`・`restore.ts`・`validate/`)とテスト。`docs/interfaces-1104.md` §3・§5・§11 | この |
| D | store、読み込みの手順の表、減便の方針の選択、AI のツールの結果と [画面の状態]、変更指示書・周知文、元のダイヤに戻す版の画面、運営情報のページ、README・`docs/deploy.md`・CLAUDE.md、(必要なら)札幌の参照データ | 後の画面の |

このワークフローは、画面のファイル(`web/src/components/` 以下)、既存の store(`web/src/store/`)、`LoadStep` を触らない。

### 7.3 A:グループ分けの純粋な計算

**ファイル**(すべて新規):

| ファイル | 中身 |
| --- | --- |
| `web/src/gtfs/groups/types.ts` | §7.5 の型 |
| `web/src/gtfs/groups/features.ts` | `computeServiceFeatures(feed: GtfsFeed, holidays: HolidayList \| null): FeedFeatures` |
| `web/src/gtfs/groups/rules.ts` | `proposeGroups(features: FeedFeatures): ServiceGroups`、`THRESHOLDS` |
| `web/src/gtfs/groups/edit.ts` | `editGroups(groups: ServiceGroups, edit: GroupEdit): ServiceGroups`、`resetToProposal(groups, serviceId)`、`canConfirm(groups): boolean` |
| `web/src/gtfs/groups/jevRequest.ts` | `buildJevRequest(features: FeedFeatures, groups: ServiceGroups): { request: JevJudgeRequest; omitted: string[] } \| null`(単純な GTFS と `nothingToChange` では null) |
| `web/src/gtfs/groups/merge.ts` | `mergeJevAnswers(groups: ServiceGroups, response: JevJudgeResponse): ServiceGroups`、`dropJevAnswers(groups): ServiceGroups`、`JEV_CONFIDENCE` |
| `web/src/gtfs/groups/policy.ts` | `policyServicesFor(groups: ServiceGroups, kind: PolicyKind, opts?: { multiService?: boolean }): PolicyServices \| { error: GroupProblem[] }` |
| `web/src/gtfs/groups/jevClient.ts` | `fetchJevStatus(signal?): Promise<JevStatus>`、`judgeServices(request, signal): Promise<JevOutcome>`(fetch。失敗を `noKey`・`rateLimited`・`tooLarge`・`invalid`・`upstream`・`network`・`aborted` に分ける。404 は `unavailable`) |
| 各 `*.test.ts`、`features.verify.test.ts`・`rules.verify.test.ts` | 下の受け入れ条件 |

**受け入れ条件**:

1. 判断材料:手で作るフィードで、calendar だけ・calendar_dates だけ・両方の service、祝日に追加・削除のある service、24 時を超える時刻、空の headsign の数え方が合う。祝日一覧が null なら日曜だけを日祝にする
2. 京都(`data/raw/gtfs/Kyoto_City_Bus_GTFS-20260930.zip`。無ければスキップ):有効期間の日数が平日 125・土曜 26・日祝 34。`01001_A` が平日 121 日・網羅率 0.97。`01001_C` の `runningDates` が `['20261102']`
3. 規則:§2.8 の表の全部の行が、実データ(無ければスキップ)で同じになる(単純かどうか、kind ごとの `mainWeekday`、割り当て、扱い、`unsupported`、使わない service)
4. 単純な GTFS(道北バス2版、沿岸バス、旭川電気軌道)で、`guessServiceChoice` と同じ組になる(`policyServicesFor` が `pairs` 無しで、`weekdayService`・`replacementService` が推定の値と同じ)
5. `policyServicesFor`:主の組が先頭、§4.1 の並び。1組・1つの入れ替えに使う service・残すもの無しのときは `pairs` を入れない。`unsupportedService` が残っていれば `{ error }`。`multiService: false` なら主の組だけで、残りを `notApplied` に入れる。1つの入れ替えに使う service が2つの組に出てこない(M2)
6. 合わせ方:§3.4 の表の全部の行(試しの1回の答え `data/out/jev_playground/` ではなく、テストに写した固定のデータで)。しきい値は1か所の定数
7. 直し:扱いを「残す」にすると印が `edited` になり、Jev の答えを合わせ直しても変わらない。入れ替えに使う service が割り当たっている平日の service は「残す」にできない(`keptHasReplacements`)。`undecided` があると `canConfirm` が false
8. `buildJevRequest`:§3.3 の上限に収める(超えたら target を「境目に近いもの → 規則で決まらないもの → 便の多い順」で選び、残りを `omitted` に入れる)。結果が B の固定のデータ `server/tests/fixtures/jev_judge_request.json` と同じ形(項目の名前が段ごとに同じ)
9. 速さ:京都で `computeServiceFeatures` と `proposeGroups` の合計を測り、テストの出力に出す。1,000 ms を超えたら失敗にする。300 ms を超えたら、D で Web Worker(`gtfs/worker.ts`)に移す
10. `jevClient`:fetch のモックで、成功・各失敗・中断・404

### 7.4 B:サーバーの中継

**ファイル**:`server/src/dispatcher_server/service_groups.py`(新規)、`settings.py`、`ratelimit.py`(`Kind` に `"jev"`)、`store.py`(`jev_usage` の表)、`app.py`(ルーターの読み込み)、`agent_relay.py`(`_client_address` を共通の関数へ)、`.env.example`、`server/tests/test_service_groups.py`(新規)、`server/tests/fixtures/jev_judge_request.json`・`jev_judge_response.json`(新規。§7.5 の例)、`docs/interfaces-1105.md` §4(エンドポイント・設定・ログ・表)。

**受け入れ条件**(Jev は `httpx2` の `MockTransport` で置き換え、実際の口は呼ばない):

1. キーが無ければ `GET` が `available: false`・`reason: "noKey"`、`POST` が 503(日本語)。`DISPATCHER_JEV_URL` のホストが `ai-gateway.vercel.sh` 以外か `https` でなければ `reason: "badUrl"` で、上流に1回も送らない
2. 上流への要求:URL・ヘッダー(§3.2 の5つ。`Authorization` は `Bearer` + キー)・本文が `{state, questions, providerOptions}` だけ(`model` を本文に入れない。`providerOptions` は `{"gateway": {"only": ["typesafe-ai"]}}`)。質問の型は `boolean`(criteria なし)と `choice`。質問の文にブラウザから来た文字列が入らない(service_id と候補の名前を除く)
3. 応答の `results[].sent` が、上流に実際に送った本文とバイト単位で同じ(JSON として同じ)
4. 形の確かめ:知らない項目・上限を超えた数・長さ・`services` に無い service_id で 422、本文が 256 KB を超えると 413。422 の本文に送られた値が入らない
5. 回数制限:IP ごとの1時間・1日で 429(日本語)。全体の1日の target の数と額の上限で、残りの target が `budget`。上限の数は SQLite に残り、アプリを作り直しても(同じ DB で)続く
6. 送り直し:429・503 で2回まで、待ちを空けて送る。10 秒で `timeout`。全体 30 秒で残りを打ち切る(時計とスリープは差し替えられるようにする)
7. 答えの確かめ:名前が足りない・型が違う・候補に無い choice・範囲外の確率・和が合わない確率で `invalid_answer`
8. ログ:caplog を DEBUG にして、正常・422・上流の 500(本文に service_id を入れたもの)の3つを流し、ログに service_id・事業者名・系統名・行き先・キー・上流のエラーの本文が出ない。`httpx2`・`httpcore2`・`httpx`・`httpcore` のロガーが WARNING より上
9. `finalProvider` を `results[].provider` に入れる。`usage.inputTokens` と `costUsd` を合計する
10. 固定のデータ `jev_judge_request.json` を pydantic が受け付け、`jev_judge_response.json` が応答のモデルと合う

### 7.5 型の取り決め

**A と C の間**(`PolicySettings` に入れる値):

```ts
// web/src/gtfs/groups/types.ts(A)。C の ops.ts の PolicySettings の同じ名前の項目と同じ形
export interface PolicyServices {
  kind: PolicyKind
  weekdayService: string
  replacementService: string          // 主の組に入れ替えに使う service が無ければ ''
  pairs?: { weekday: string; replacements: string[] }[]
  keptWeekdayServices?: string[]
  /** multiService: false のときだけ。入れ替えなかった組・なくさなかった service(画面の「入れ替えていない」に出す) */
  notApplied?: { weekday: string; replacements: string[] }[]
}
```

- D は `{ ...without(notApplied), period, excludedRoutes }` で `PolicySettings` を作る。A・C の両方が入ったら、後に入れた方が A のテストに `({ ...policyServicesFor(...), period, excludedRoutes: [] }) satisfies PolicySettings` を足す(`notApplied` を除いた形)
- C の `checkPolicy` は §4.2 で、A の値をもう一度確かめる(A を信じ切らない。AI のツールからも同じ値が来るため)

**A の中の型**(D が使う):

```ts
export type DayKey = 'weekday' | 'saturday' | 'sundayHoliday'
export type Level = 'regular' | 'partial' | 'rare' | 'none'
export type Basis = 'regular' | 'partial' | 'special' | 'noDays'
export type Side = 'weekdayOnly' | 'replacement' | 'both' | 'unrelated' | 'unsupported'
export type Treatment = 'erase' | 'keep'
export type Mark = 'agreed' | 'rule' | 'jev' | 'conflict' | 'undecided' | 'edited'

export interface ServiceFeatures {
  serviceId: string
  name: { head: string; suffix: string }
  tripCount: number
  routeCount: number
  routes: { routeId: string; name: string; trips: number }[]
  routeIds: string[]
  headsigns: string[]
  firstDeparture: string | null
  lastArrival: string | null
  runningDays: Record<DayKey, number> & { total: number }
  coverage: Record<DayKey, number>
  levels: Record<DayKey, Level>
  basis: Basis
  runs: Record<DayKey, boolean>
  runningDates: string[] | null
  /** 網羅率がしきい値から ±0.05 にある区分 */
  nearThreshold: DayKey[]
}

export interface FeedFeatures {
  agency: string | null
  validity: { start: string; end: string }
  daysInPeriod: Record<DayKey, number>
  holidays: 'loaded' | 'missing'
  services: ServiceFeatures[]          // service_id の昇順。便のある service だけ
}

export interface KindRow {
  serviceId: string
  side: Side
  /** replacement の行:便を入れる平日の service。null は使わない、または決まらない(mark で分ける) */
  into: string | null
  intoMark: Mark | null                // replacement の行だけ
  /** weekdayOnly・unsupported の行:扱い。unsupported の既定は null(エラー) */
  treatment: Treatment | null
  basisMark: Mark | null               // weekdayOnly・unsupported の行だけ(Jev の service_kind との合わせ)
  /** 規則の理由の文(定型) */
  reasons: string[]
}

export interface KindGroups {
  kind: PolicyKind
  mainWeekday: string | null
  rows: KindRow[]                      // service_id の昇順。noDays の service は入れない
  problems: GroupProblem[]
}

export interface GroupProblem {
  severity: 'error' | 'warning' | 'info'
  code: 'unsupportedService' | 'undecidedReplacement' | 'keptHasReplacements' | 'nothingToChange' | 'lowRouteOverlap'
  serviceIds: string[]
  message: string
}

export interface ServiceGroups {
  features: FeedFeatures
  simple: boolean
  byKind: Record<PolicyKind, KindGroups>
  /** 規則の案(「案に戻す」に使う) */
  proposal: Record<PolicyKind, KindGroups>
  /** Jev の答え(合わせたもの)。Jev を使わなかった・捨てたときは null */
  jev: JevTargetResult[] | null
}

export type GroupEdit =
  | { kind: PolicyKind; serviceId: string; into: string | null }
  | { kind: PolicyKind; serviceId: string; treatment: Treatment }
  | { kind: PolicyKind; serviceId: string; acceptConflict: true }
```

**A と B の間**(`web/src/gtfs/groups/types.ts` と、B の pydantic のモデルが同じ形):

```ts
export type JevRole = 'weekday' | 'saturday' | 'sundayHoliday'
export interface DayCounts { weekday: number; saturday: number; sundayHoliday: number }

export interface JevJudgeRequest {
  feed: { agency: string | null; period: { start: string; end: string }; daysInPeriod: DayCounts }
  services: JevServiceWire[]           // 60 個まで。targets とその候補だけ
  targets: JevTargetWire[]             // 40 個まで
}
export interface JevServiceWire {
  serviceId: string
  tripCount: number
  routeCount: number
  runningDays: DayCounts & { total: number }
  coverage: DayCounts                  // 小数2桁に丸める
  firstDeparture: string | null        // 'HH:MM'
  lastArrival: string | null
  routes: { name: string; trips: number }[]   // 便数の多い順に 20 まで
  headsigns: string[]                  // 5 つまで
  runningDates: string[] | null        // 運行日 10 日以下のときだけ。'YYYYMMDD'
}
export interface JevTargetWire {
  serviceId: string
  role: JevRole
  /** role が weekday なら空。それ以外は 1〜5 個(その kind の平日だけの service。接尾辞の合うもの → 主の平日の service → 重なりの大きい順) */
  candidates: { serviceId: string; routeOverlap: number }[]
}

export interface JevJudgeResponse {
  model: string                        // 上流の応答の model('typesafe-ai/jev')
  results: JevTargetResult[]
  failures: JevFailure[]
  usage: { inputTokens: number; costUsd: number | null }
}
export interface JevFailure {
  serviceId: string
  role: JevRole
  error: 'timeout' | 'rate_limited' | 'upstream' | 'invalid_answer' | 'budget'
  sent?: { state: unknown; questions: unknown }  // 上流に送った後の失敗だけ(budget など送る前の失敗には無い)
}
export interface JevChoice { choice: string; probabilities: Record<string, number>; confidence: number | null }
export interface JevTargetResult {
  serviceId: string
  role: JevRole
  provider: string | null              // gateway.routing.finalProvider
  sent: { state: unknown; questions: unknown }   // サーバーが上流に送った本文
  serviceKind?: JevChoice              // role が weekday。choice は regular_weekday・limited_weekdays・specific_dates
  schoolService?: { probability: number }        // role が weekday
  weekdayCounterpart?: JevChoice       // role が saturday・sundayHoliday。choice は candidates の serviceId か 'none'
}
```

- 固定のデータ `server/tests/fixtures/jev_judge_request.json`(北海道中央バスの `S000027` を `saturday` で問う1件と、`S000014` を `weekday` で問う1件。値は §2.8 の数)と `jev_judge_response.json` は B が作る。A のテストはこの2つを `new URL('../../../../server/tests/fixtures/jev_judge_request.json', import.meta.url)` で読み(`form2.verify.test.ts` が `data/raw` を読むのと同じ書き方)、項目の名前を段ごとに照らす。B より先に A が入ったときは、ファイルが無ければそのテストをスキップする

### 7.6 C:形2の編集の複数 service 化

**ファイル**:`web/src/gtfs/edit/ops.ts`(型、`pairsOf`・`weekdayServicesOf`、`planOf`、`checkPolicy`)、`form2.ts`(§4.3〜§4.5、`applyRevert` の `services`)、`diff.ts`、`restore.ts`、`validate/edit.ts`、`validate/feed.ts`、`form2.fixture.ts`(足す)、`ops.test.ts`・`form2.test.ts`・`diff.test.ts`・`restore.test.ts`・`validate/edit.test.ts`(足す)、`form2.multi.verify.test.ts`(新規)、`docs/interfaces-1104.md` §3・§5・§11。

**受け入れ条件**:

1. `form2.verify.test.ts`(正解データ)を変えずに通る。今ある `form2.test.ts`・`ops.test.ts` ほかも変えずに通る
2. `pairs` が `[{weekday: wk, replacements: [rp]}]`・`keptWeekdayServices: []` のときの `writeGtfsZip` の結果が、`pairs` 無しのときとバイト単位で同じ(道北バスと手で作るフィードの両方)。report は `pairs` と `addBack.alreadyKept`・`notActive` のほかは同じ
3. 手で作るフィード(`form2.fixture.ts`):主の組 + 接尾辞の組 + 2つの入れ替えに使う service を持つ組 + なくす service + 残す service + 期間に走らない組 + 月〜土の service。便の分け方、trip_id の3つの規則(とくに部分の数がそろわない便の `replace-family-part`、共通の k が2つあるときの一番右、すべての便に共通しない k を使わないこと)、組をまたぐ署名と走る日の包含(S2)、`alreadyKept`(S3)、期間に走らない入れ替えに使う service を加えない `replacementNotActiveSkipped`(主の組も主でない組も。加えない便と同じ署名の平日の便を平日に戻せること)、`pairWeekdayNotActive`、`duplicateService`(M2)、`weekdayServiceRunsOnWeekend`、`badPairs`、`weekdayServicesKept`・`weekdayServicesErased`・`replacementRunsWithWeekday`
4. 主の組に入れ替えに使う service が無い `pairs`(名士バスの形)で、平日の便がなくなり、加わる便が 0、`replacementService` が `''` でもエラーにならない
5. 実データ(`form2.multi.verify.test.ts`。ファイルが無ければスキップ):
   - 京都、土曜に、期間 20261105〜、§2.8 の組:`validateEdit` のエラーが 0、`collisions` が 0、主の組の `rule` が `replace-family-part`・`servicePartIndex` 1、11/11 に走る便が 5,417、`01001_C` と `03001_C` は出力から除かれる
   - 京都、同じ組、期間 20261101〜:エラーが 0、`replacementNotActiveSkipped` が `03001_C`、11/2 に走る便が 5,063(加えていたときの 5,377 から `03001_C` の 314 便を引く)、`01001_C` の組は加わる便 0
   - 北海道中央バス、土曜に、期間 20261005〜20261031:エラーが 0、`replacementNotActiveSkipped` が `S000041`・`S000042`、加わる便の元に冬ダイヤの便が無い
   - 北海道中央バス、土曜に、期間 20261109〜、§2.8 の組(`S000039`・`S000044` は残す):11/11 に走る便が 3,739 で、その便の署名の多重集合が、入力の 11/14 に走る便の署名に残した3便を足したものと同じ
   - 北海道中央バス、日祝に(`S000040` を残す):11/11 に走る便が 3,636
   - 北海道中央バスで `S000039` を `pairs` に入れると `weekdayServiceRunsOnWeekend`
   - 京都(11/5〜・11/1〜・日祝に・平日に戻す便を混ぜた場面)と北海道中央バス(土曜に・日祝に)で、新しい有効期間の**毎日**、出力のその日の便の署名の多重集合が「平日の組でない service の入力の便 + 走る平日の組の入れ替えに使う便 + 除外した系統の便・平日に戻した便」と同じ(`checkEveryDay`。§8.2)
   - translations.txt で `tripReferences` に止まる GTFS の表(§4.7)
6. `validateEdit`:京都で `weekdayNotRunning` が主の組の分だけ出る(大学の便の休みであふれない)
7. 形2を変えたら、サブエージェント `gtfs-reviewer` で確かめ、Skill `gtfs-jp-check` で京都と北海道中央バスの出力 ZIP を確かめる
8. 参照実装 `form2_ref.py` は直さない。`docs/interfaces-1104.md` §11 に「`pairs` の場面と規則 `replace-family-part` は参照実装と照らさない」と書く

### 7.7 D:後の画面のワークフロー

| 課題 | ファイル | 中身 | 依存 |
| --- | --- | --- | --- |
| D1 store | `store/serviceGroups.ts`(新規)、`store/reset.ts` | §5.5。祝日一覧を待つ、計算、Jev(スイッチ・中断・捨てる)、直す、確定、`reset` | A、B |
| D2 読み込みの手順の表 | `components/steps/load/ServiceGroupsCard.tsx`(新規)、`LoadStep.tsx`、`loadText.ts` | §5.1・§3.6。単純な GTFS では1行の要約 | D1 |
| D3 減便の方針の選択 | `components/steps/policy/` の穴埋めの部品 | §5.2。穴埋めの部品の選択肢の口(`options: {value, label}[]`)に `policyServicesFor` の値を渡す | D1。作り直しのコミットの後 |
| D4 AI | `claude/tools.ts`、`claude/screenLines.ts`、`store/chat.ts` | §5.3・§4.6。ツールの定義は変えない | D1、C |
| D5 前後の比較・平日に戻す | `store/edit.ts`(`diffOf`)、`RestoreStep.tsx` | §4.6 | C |
| D6 変更指示書・周知文・元のダイヤに戻す版 | `ChangeOrder.tsx`、`ExportStep.tsx` | §5.3・§4.6。第2段を外したときの書き方(S6) | D1、C |
| D7 出典と送り先 | `DataSources.tsx`、`AboutPage.tsx`、`README.md`、`docs/deploy.md`、`CLAUDE.md` | §5.4。Jev を呼んだときだけ「送り先」の欄 | D1 |
| D8 Web Worker | `gtfs/worker.ts`、`workerClient.ts` | A の速さの測定が 300 ms を超えたときだけ | A |
| D9 札幌の参照データ | `data/`(e-Stat の 6440・6441 の人口メッシュを入手し、加工) | 北海道中央バスで到達圏を見せるときだけ(§4.7) | 利用者の判断(§6.2-6) |

### 7.8 進行中の作業とぶつかる所

| 進行中の作業 | ファイル | ぶつかる課題 | 進め方 |
| --- | --- | --- | --- |
| 減便の方針の画面の穴埋めの形への作り直し(別のワークフロー) | `PolicyStep.tsx`、`policy/PolicyForm.tsx`・`PeriodFields.tsx`・`ServiceFields.tsx`・`periodRange.ts` ほか | D3、D6 | A・B・C はこれらを触らない。D3 は作り直しのコミットの後に始め、選択肢の口に値を渡すだけにする |
| 文書の更新 | `docs/interfaces-1105.md`、`README.md` | B の 1105 §4、D7 | 同じ節を同時に直さない |

## 8. レビューの指摘への対応

### 8.1 設計へのレビュー

| 指摘 | 対応 |
| --- | --- |
| M1 区分と1対1の組では北海道の GTFS を扱えない | §2.2〜§2.7(網羅率の組、方針の種類ごとの役割、多対1の割り当て、形2で表せないものをエラー、単純な GTFS の判定)、§2.8 の期待する結果、§4.1 の型 |
| M2 `01005_MSN` と主の組が同じ入れ替え先になる | 割り当てを重なりで決めない(§2.4)。重複は A の `policyServicesFor` と C の `duplicateService` で確かめる |
| M3 「なくす」が要る | §2.5 の既定。名士バス・北門バス・`01005_MSN` |
| M4 送る中身と自動の送信 | 利用者の決定(§0)で系統名・行き先は送る。止める手段を送る前に置き、送った情報はサーバーが返した本文を見せる(§3.6)。別の会社の口への送り直しを消した(§3.3) |
| M5 京都の到達圏 | §4.7。京都は形2の確認だけ。受け入れ条件から到達圏を外した(§7.6) |
| M6 日程 | §7.1 の並べ方と切れ目 |
| S1 trip_id の置き換えの位置 | §4.4 |
| S2 署名の表の取りこぼし | §4.5 の 5 |
| S3 残す service の便を平日に戻す | §4.5 の `alreadyKept` |
| S4 主でない組の `replacementNotActive` | §4.2 の `replacementNotActiveSkipped`(2026-11-04 の決定で、加える警告から加えない警告に変えた) |
| S5 特別の service を残すと平日ダイヤの日ができる | §2.5 と §4.3 の `weekdayServicesKept` |
| S6 第1段でグループの語を使うと食い違う | 両段を入れるので通常は起きない。第2段を外したときの書き方を §5.3 に書いた |
| S7 食い違いのまま確定できるか | §3.4 の確定の条件 |
| S8 費用の上限 | §3.3(系統 20・候補 5 に絞る、額の1日の上限、少数の IP で使い切れること) |
| S9 ログに中身が残る道 | §3.3 の 422、§3.5、B の受け入れ条件 8 |
| S10 祝日一覧が後から届く | §2.1 |
| S11 `apply_policy` が組の表を受け取れない | §4.6 と D4 |
| nit しきい値の根拠 | §2.8 に北海道の 10 個を足し、§6.1 に境目の例を書いた |
| nit 送り先のホストの一覧 | §3.3(`ai-gateway.vercel.sh` だけ) |
| nit 組の並び | §4.1 |
| nit Jev のぶれ | §3.4 |
| nit 手で直したときの計算し直し | §5.1 と A の `editGroups` |

### 8.2 実装(A・B・C)へのレビュー(2026-11-04)

| 指摘 | 確かめた結果 | 対応 |
| --- | --- | --- |
| must:組ごと除く平日の service の便を「平日に戻した」と報告する | 本当(京都 11/5〜で `08600_01001_1356_C` が `accepted` に入り、出力に無かった) | §4.5 の `notActive`。`keepIds`・押さえる trip_id に入れない。除外した系統の便も `tripIds.kept` に数えない。1104 §5.3 に足した |
| should:translations.txt で止まるのは北海道中央バスだけではない | 本当(7 つの GTFS。§4.7 の表) | 規則は入れていない(利用者の判断。§6.2-6)。表のテストと §4.7・§6.2-6 を直した |
| should:期間に走らない入れ替えに使う service の扱いが組で違う | 本当(北海道中央バス 10/5〜10/31 で主の組の `replacementNotActive` が方針全体を止めた) | 主の組も主でない組と同じ扱いにする。主の組の入れ替えに使う service がすべて走らないときだけエラー。期間に走らない入れ替えに使う service は、2026-11-04 の利用者の決定で加えない(§6.2-7) |
| should:`diffWeekdayTrips` が組ごと除いた service の便を「なくなる便」に数える | 本当(京都 11/5〜の `01001_C` の 310 便) | `activeWeekdayServicesOf(result)` を足した。`store/edit.ts` の `diffOf` は D が直す(§4.6) |
| should:`replacementPartial` が北海道中央バスで誤った警告ばかりになる | 本当 | X の日(土曜・日曜。年末年始を除く)のうち走らない日を数え、組ごとに1つにした。北海道中央バス 11/9〜では `S000049` の 3 日だけ(`S000002`・`S000027` の 1/2 は年末年始なので数えない) |
| should:入れ替えに使う service が平日にも走る場合を止めていない | 本当(エラーが無かった) | `replacementRunsOnWeekday`(calendar の月〜金の列)。京都・北海道中央バスの規則の案では出ない |
| should:実データの照合が1日だけ | 本当 | `checkEveryDay` で新しい有効期間の毎日を照らす(§7.6-5)。照合が誤りを見つけることも確かめた |
| should:`trust_env` が既定の True | 本当(本物の通信では `HTTPS_PROXY` の取っ手が入る) | `trust_env=False`(§3.3)。テストは取っ手が無いことを確かめる |
| should:DigitalOcean に回ることがある | 本当(試しの応答) | 2026-11-04 に `providerOptions.gateway.only: ["typesafe-ai"]` を1回試し、`fallbacksAvailable` が空になった。中継はこの指定を必ず送る(§3.2・§6.2-1) |
| should:額の上限が `cost` の届いたときだけ効く | 本当 | 送る前に見込みの額を足し、`cost` で差を直す(§3.3) |
| should:`_refuse_real_jev` の例外が飲み込まれる | 本当 | 偽物が呼ばれた回数を数え、後片付けで失敗にする |
| should:送った後の失敗に `sent` が無い | 本当 | `failures[].sent`(§3.3・§7.5、1105 §4.14、web の型) |
| should:リダイレクトをたどらないことのテストが無い | 本当 | 301・302・307・308 のテストと、応答にキーが無いことの確かめを足した |
| nit:選択肢の名前にブラウザの service_id が入る | 本当 | 直していない。choice の名前を別名にすると、質問・答えの戻し方・固定のデータ・A の合わせ方を同時に変えることになり、安くない。service_id は制御文字・書式の文字を断り、100 文字まで、回数と額の上限もあるので、被害は小さいままにした |
| nit:対になっていないサロゲート | 本当 | service_id は Cs も断り、系統名・行き先・事業者名もサロゲートだけを断る(422) |
| nit:`_cost_microusd` に上限が無い | 本当 | 1 target $1 を超える値は使わない。並行の分だけ超えうることを 1105 §4.14 に書いた |
| nit:`DISPATCHER_JEV_MODEL` の形を確かめていない | 本当 | `typesafe-ai/` で始まる名前の形のときだけ使う |
| nit:Content-Length の無い本文の 413 のテストが無い | 本当 | 足した |
| nit:IP ごとの値の 0 | 本当 | `.env.example`・`docs/deploy.md`・1105 §4.14 に「0 にすると全員が 429」と書いた |
| nit:§3.3 の httpx | 本当 | `httpx2` に直した(§3.3・§3.5・§7.4) |
| nit:固定のデータの出典 | — | `server/tests/fixtures/README.md` に出典を書いた。事業者名・系統名・行き先は、利用者の決定で架空の名前に差し替えた(§6.2-8) |

