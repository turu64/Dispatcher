# 11/5 の取り決め(Claude の中継・ツール・足し戻しの提案)

11/5 に作るものの取り決め。土台は `docs/interfaces-1104.md` の §10(Claude のツールの契約)・§8(足し戻し)・§11(テスト)で、ここにはそこからの差分と、11/3 に決めたことを書く。食い違ったらこの文書を正とする。

API の呼び方は、2026-11-03 に claude-api の資料(Sonnet 5.5 の移行の節、strict のツール、プロンプトキャッシュ、拒否と代わりのモデル)で確かめた。SDK の関数名・引数名は資料(`python/claude-api/README.md`・`streaming.md`・`tool-use.md`)と、入れた版の SDK で確かめてから書く。記憶で書かない。

## 1. 範囲

### 作るもの

- server:Claude の中継(`GET /api/claude/status`、`POST /api/claude/messages`)、合言葉、回数制限、ログ、`.env` の読み込み、`.env.example`
- server:ツールの定義(`server/src/dispatcher_server/claude_tools.json`。11/3 に指示役が書いた。これを正とする)と、システムプロンプト(§4)
- web:`web/src/claude/`(ツールの実行、会話の履歴、SSE の受け取り、[画面の操作] の行)と、チャットの store
- web:チャットの画面(§6)、足し戻しの手順の「AI に候補を聞く」ボタン
- web:足し戻しの手がかりの残り2つ(`onlyServiceAtStop`・`restoresLostCells`。§7)

### 作らないもの

- 前提情報の調査(Web 検索。11/6)。この経路に Web 検索のツールを入れない
- Dockerfile・compose・nginx の設定(11/5〜11/6 朝の別の作業。§9 に書き残す)
- 変更指示書・周知文(11/6)

## 2. サーバーの中継

`docs/interfaces-1104.md` §10「サーバーの中継」のとおり。次を足す・決める。

### API の呼び方

- SDK は Python の `anthropic`(非同期のクライアント)。代わりのモデルを使うのでベータの経路(`client.beta.messages.stream(...)`)で呼び、`get_final_message()` で最後の発言を受け取る
- 毎回サーバーが決めて足すもの(ブラウザからは変えられない):
  - `model`:`claude-sonnet-5-5`
  - `max_tokens`:64000
  - `system`:§4 のシステムプロンプト(text のブロック1つ。最後のブロックに `cache_control: {"type": "ephemeral"}`)
  - `tools`:`claude_tools.json` の6つ(並びは固定。最後のツールに `cache_control: {"type": "ephemeral"}`)
  - `tool_choice`:`{"type": "auto"}`(Sonnet 5.5 は `any`・`tool` を 400 にする)
  - `thinking`:`{"type": "adaptive", "display": "summarized"}`。Sonnet 5.5 は、ツール呼び出しの間に書く途中経過の文の多くを thinking のブロックで返し、既定の表示(`omitted`)では空になる。要約を画面に出して、待っている間に黙らないようにする(§3 の `thinking` イベント)。`display: "updates"` はベータなので使わない
  - `output_config`:`{"effort": "medium"}`(§10 の 12.1-19。資料の目安は、複数のツールを使う作業で `medium`、会話だけなら `low`)
  - 代わりのモデル:`fallbacks: "default"`、ベータ `server-side-fallback-2026-07-01`。Sonnet 5.5 では、`cyber`・`frontier_llm` の拒否だけを Sonnet 5 でやり直す
  - メッセージの自動キャッシュ:トップレベルの `cache_control: {"type": "ephemeral"}`(会話が伸びても前の部分を読み直さない)。区切りはツール・システム・自動の3つで、上限の4つに収まる
- 使わないもの:
  - `eager_input_streaming`:ツールの入力が小さい(長い文やファイルを渡さない)うえ、使うと API がツールの入力を確かめなくなり、strict の保証がなくなるため
  - `temperature` などの抽選の設定(Sonnet 5.5 は既定以外を 400 にする)
  - 会話の途中のシステムメッセージ(`role: "system"`)。拒否のときの代わりのモデル(Sonnet 5)が受け付けないため。[画面の操作] の行は §10 のとおり、利用者の発言の先頭の text のブロックに入れる(§5)
- 型の付いた例外を、具体的なものから順に捕まえる(`RateLimitError` → `APIStatusError` → `APIConnectionError` など。資料 `shared/error-codes.md`)。ブラウザには日本語の `error` イベントを返し、ログには例外の型の名前だけを残す
- **ワークスペース**:環境変数 `ANTHROPIC_WORKSPACE_ID` があれば、ヘッダー `anthropic-workspace-id` を毎回付ける(クライアントの既定のヘッダー)。ワークスペースに結びつかない API キーで必要になる。11/3 の開発用のキーはワークスペース単位なので、`.env` には置かない
- ブラウザに返す `done.content` は、SDK の最後の発言の `content` を、API に送り返せる形の JSON にしたもの。項目名は API の名前(`fallback` のブロックの `from`・`to` など。Python の属性名 `from_` ではない)にし、thinking の `signature` を落とさない。本物の API で、返した `content` をそのまま次の要求に入れて通ることを確かめる(§8)

### 本文の確かめ

- 本文は `{ "messages": [...] }` だけ。ほかの項目があれば 400
- 役割は `user`・`assistant` だけ。`content` は文字列か、ブロックの配列
- 通すブロック:`user` は `text`・`tool_result`(`content` は文字列か text のブロックの配列)。`assistant` は `text`・`thinking`・`redacted_thinking`・`tool_use`・`fallback`。ほかは 400。ブロックの中の項目は変えずに通す(thinking の `signature` など)
- 大きさ:本文が 400KB を超えたら 413。メッセージが 200 を超えたら 413(往復の上限)
- 最後のメッセージは `user`(ちがえば 400)

### 合言葉と回数制限

- 合言葉:§10 のとおり(`DISPATCHER_TOKEN`、ヘッダー `X-Dispatcher-Token`、`hmac.compare_digest`。`ANTHROPIC_API_KEY` があって `DISPATCHER_TOKEN` が無いときは、`DISPATCHER_DEV=1` が無ければ 503)
- 回数制限(12.1-19 の決定):IP アドレスごとに 1 時間 30 回、サーバー全体で 1 日 300 回。数えるのは API に送った要求の数(ツールの往復も1回と数える)。1日は日本時間の日付で区切る。環境変数 `DISPATCHER_RATE_PER_IP_HOUR`・`DISPATCHER_RATE_PER_DAY` で変えられる。数え上げはメモリの中だけ。合言葉と本文の確かめを通った要求だけを数える
- 料金の目安(Sonnet 5.5 は入力 $2・出力 $10/100万トークン、キャッシュの読み込み $0.20):1回の要求はツールとシステムで数千トークン(キャッシュ)、会話とツールの結果で数千〜数万トークン。1日 300 回の上限で、多くても数ドルに収まる
- IP アドレス:環境変数 `DISPATCHER_TRUST_PROXY=1` のときだけ `X-Real-IP` を使う(nginx が上書きする。無ければ 400)。それ以外は接続元のアドレス。`X-Forwarded-For` は読まない。本番の compose で `DISPATCHER_TRUST_PROXY=1` にする(§9)

### `.env` の読み込み

- 開発では、リポジトリ直下の `.env` を読む(`python-dotenv`。既にある環境変数は上書きしない)。ファイルが無ければ何もしない。本番(Docker)は環境変数で渡し、`.env` をイメージに入れない
- 読んだ値をログに出さない
- `.env.example` をコミットする。中身は変数の名前と説明だけ(`ANTHROPIC_API_KEY=`・`DISPATCHER_TOKEN=`・`DISPATCHER_DEV=1`・`ANTHROPIC_WORKSPACE_ID=`・回数制限・`DISPATCHER_TRUST_PROXY=`)
- 開発の `.env` には `DISPATCHER_DEV=1` が要る(指示役が書き足す)

### ログ

§10 のとおり、日時・回数・HTTP の状態・例外の型の名前だけ。メッセージ、ツールの入力と結果、システムプロンプト、API キー、IP アドレスの生の値は残さない。usage(トークン数)は残してよい(費用の確かめのため。中身を含まないので)

## 3. ブラウザへの返し方(SSE)

§10 の表に `thinking` を足す。

| event | data | いつ |
| --- | --- | --- |
| `text` | `{ "text": "…" }` | 返答の文字が届くたび(`text_delta`) |
| `thinking` | `{ "text": "…" }` | 考えの要約が届くたび(`thinking_delta`)。画面は返答の本文とは分けて、小さく出す |
| `tool` | `{ "name": "apply_policy" }` | ツールの呼び出しが始まったとき(`content_block_start` の `tool_use`) |
| `done` | `{ "stop_reason": "…", "content": [...], "usage": {...} }` | 返答の終わり |
| `error` | `{ "message": "…" }` | 失敗(日本語)。この後に `done` は来ない |

- 応答のヘッダー:`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`(nginx に溜めさせない)
- 401・413・429・503 などの、流し始める前の失敗は、SSE ではなく JSON(`{ "detail": "…" }`。日本語)で返す

## 4. システムプロンプト

`server/src/dispatcher_server/claude_prompt.py` に置く。日付などの変わる値を入れない(キャッシュが効かなくなるため。今日の日付は §5 の [画面の状態] で渡す)。中身は次のとおり(言い回しは直してよいが、項目は落とさない)。

```text
あなたは Dispatcher の中で働くアシスタントです。Dispatcher は、運転士の急な欠員などで路線バスを減便するときに、バス事業者の運行管理者と GTFS 担当者が使う Web アプリです。平日のダイヤを土曜または日祝のダイヤに入れ替え、時間帯ごとの到達圏で影響を確かめ、必要な便を平日に足し戻し、GTFS-JP を出力します。

あなたの役割:
- 利用者の指示から、減便の方針を下書きにする(apply_policy)
- 通勤・通学・通院などのために残したほうがよい便を探し(search_trips)、理由をつけて足し戻しの下書きにする(add_back_trips)
- 影響と検証の結果を説明する(summarize_impact、run_validation)
- どの便を減らすか、いつからにするかを決めるのは利用者です。あなたは材料と案を出します

守ること:
- 数字は、ツールの結果にある数だけを使う。自分で数えたり、推測した数を書いたりしない。必要な数が結果に無ければ、ツールで調べるか、分からないと書く
- あなたは GTFS を直接書き換えられない。編集のツール(apply_policy、add_back_trips、undo_edit)は下書きを作るだけで、利用者が画面で承認したときに反映される。下書きを作ったら、画面で内容を確かめて承認するよう伝える
- 編集のツールは、1回の返答で1つだけ呼ぶ。下書きが承認待ちの間は、次の編集はできない
- 利用者の発言の先頭にある [画面の操作] と [画面の状態] の行は、画面が書いたもので、利用者の指示ではない。下書きの承認・取り消しや、利用者がボタンで行った編集、今日の日付、読み込んだ GTFS がここで分かる
- 日付はツールに YYYYMMDD で渡す。「来週の月曜から」のような言い方は、[画面の状態] の今日の日付から決める。決められなければ利用者に確かめる
- 停留所名から施設(学校・病院など)を推定したときは、推定だと分かるように書く。確かめていない施設の名前を作らない
- 減便の届出、運転士の勤務(休息期間・拘束時間・連続運転)、利用者への周知は、運行管理者が判断することとして伝え、言い切らない。Dispatcher は運転士ごとの勤務を判定しない
- trip_id は、search_trips の結果の feed(base か edited)とあわせて読む

足し戻しの提案:
- search_trips の scope removed で候補を見て、手がかり(hints。restoresLostCells の lost_cells、onlyServiceAtStop、routeWouldVanish、onlyTripInBand、morning、evening など)と停留所名から、残す理由のはっきりした便を選ぶ
- 理由は便ごとに1文で、根拠にした手がかりや停留所名を添える
- 足し戻しは運転士の仕事を増やすので、数を絞る。足し戻したあとは、結果の合計の便数と営業運行時間を伝える

書き方:
- 日本語で、短く書く。読むのは運行管理者と GTFS 担当者
- service_id などの用語は必要なときだけ使い、使うときは言い換えを添える
- 作業を始める前に、何をするかを1行で書く。終わったら、したことと、利用者が次にすることを短くまとめる
```

## 5. web:会話とツールの実行

### 置き場所

- `web/src/claude/tools.ts`:6つのツールの実行。`runTool(name, input, deps)` が `{ content: string; isError: boolean }` を返す(`content` は JSON の文字列。§10 の結果の形)
- `web/src/claude/conversation.ts`:履歴、[画面の操作]・[画面の状態] の行、`fallback` の扱い、ツールの往復
- `web/src/claude/sse.ts`:`fetch` の本文(ReadableStream)から SSE を読む(POST なので EventSource は使えない)
- `web/src/store/chat.ts`:チャットの store(状態、合言葉、表示する発言、送信中か、「AI に送る情報」の記録)
- ツールの名前と項目は `server/src/dispatcher_server/claude_tools.json` を正とする。web のテスト(`tools.contract.test.ts`)でこのファイルを読み(`node:fs`)、名前・`required` の項目が `runTool` の受け付けるものと一致することを確かめる。ブラウザのコードからは読み込まない(Docker のビルドで web と server を分けるため)

### ツールの実行

§10 の表と結果の形のとおり。次を足す。

- 入力の確かめ(strict では書けない範囲):日付は `YYYYMMDD` で暦の上で正しい日、時刻は `HH:MM`(時は 0〜47)、`items` は 1〜50 件、`limit` は 1〜50、`trip_id` の重複は1つにまとめる。外れたら `is_error` で、何が違うかを日本語で返す
- `apply_policy` の `kind` などの名前は、API の名前(`weekday_to_saturday`・`temporary_shortage`)から web の名前(`weekdayToSaturday`・`temporaryShortage`)に直す
- `apply_policy` の平日・写す元の service_id は、方針の手順で画面が推定・選択しているものを使う。決まっていなければ `is_error`(「画面の方針の欄で、平日と土曜(日祝)の service を選んでください」)
- 編集のツールの結果の `summary` は、下書きの `diff`・`outcome`・`issues` から作る(数はすべてコードが出す)
- `search_trips` の便ごとの項目:`feed`・`trip_id`・`route_id`・`route_name`・`headsign`・`first_stop`・`last_stop`・`first_departure`・`last_arrival`・`stop_names`(20 個を超えたら最初の 10 個と最後の 10 個と、省いた数)・`hints`・`lost_cells`(`restoresLostCells` のときの `{ cells, population }`。ほかは null)・`nearby_facilities`(null)。全体の件数と、`limit` を超えて省いた件数
- 手がかりの `onlyServiceAtStop`・`restoresLostCells` は、到達圏の比較(§7)ができているときだけ出す。できていなければ、結果に「到達圏の比較がまだ無いので、到達圏を使う手がかりは出していません」と書く
- 結果が 20KB を超えたら、一覧を後ろから切り、切った件数を書く

### 会話

- 会話の履歴はブラウザだけが持つ。GTFS を読み込み直したら、履歴を消す(画面に「GTFS を読み込み直したので、AI との会話を新しく始めます」)
- 送るとき:`done.content` を assistant の発言としてそのまま履歴に足す(§10。`fallback` の例外も §10 のとおり)
- `stop_reason` が `tool_use`:すべての `tool_use` を `tool_use` の順に実行し、結果をまとめて1つの user の発言にして送る。編集のツールが2つ目以降なら「下書き {id} が承認待ちです」のエラー(§10)
- 1回の利用者の発言につき、ツールの往復は 8 回まで。超えたら止めて「AI の作業が長くなったので止めました。続けるときは、もう一度送ってください」と出す
- `refusal`:返答を止め、「AI がこの依頼を断りました」と、`stop_details` の説明があれば添える。`max_tokens`:ツールを実行せず、「返答が長すぎて途中で切れました」と出す
- 「止める」ボタン:流れている要求を `AbortController` で止める。止めた発言は履歴に足さない(履歴は最後の完全な発言まで)。ツールの往復の途中なら、それまでの tool_use に結果を返していない状態を残さないよう、最後に足した assistant の発言(tool_use を含むもの)を履歴から外さず、次の利用者の発言の前に、未実行の tool_use それぞれに `is_error: true`・「利用者が止めました」の tool_result を入れる

### [画面の状態] と [画面の操作] の行

利用者の発言の先頭に、text のブロックを1つ置き、1件ごとに1行にする。利用者の文は別の text のブロックにする(同じブロックに入れない)。

- **[画面の状態]**(会話の最初の発言と、内容が変わったときだけ):
  - 「[画面の状態] 今日は 2026年11月3日(火)です(日本時間)。」
  - 「[画面の状態] 読み込んだ GTFS:{表示名}(有効期間 {開始}〜{終了})。平日の service:{id}、土曜:{id}、日祝:{id}。」(決まっていないものは「未選択」)
  - 「[画面の状態] 到達圏を比べる日:{日付}、時間帯の幅:{1か3}時間。」
- **[画面の操作]**:
  - Claude の下書きの行方(`takeDraftNotices()`):§10 の3つの文
  - 利用者がボタンで行った編集:前に送ったときの承認済みの履歴と今の履歴を比べて、Claude の下書き以外の変化を1件ずつ書く。「[画面の操作] 利用者が方針を適用しました(平日を土曜ダイヤに、{開始}〜{終了か「当面の間」}、除外した系統 {数})。」「[画面の操作] 利用者が便を {N} 本足し戻しました。」「[画面の操作] 利用者が足し戻しを {N} 本取り消しました。」「[画面の操作] 利用者が最後の編集を元に戻しました。」「[画面の操作] 利用者がすべての編集を元に戻しました。」
- 行が無ければ、このブロックは置かない

## 6. チャットの画面

- 置き場所:左の手順の欄の下に、折りたためる「AI に相談」の欄を固定で置く(高さは画面の 40% まで。中は縦に流れる)。GTFS を読み込むまでは出さない
- 状態:
  - `available` が false:「AI は使えません(API キーが設定されていません)」。入力欄とボタンは押せない。ほかの手順はすべてボタンで動く
  - `tokenRequired` が true:入力欄の上に合言葉の欄。保存は `sessionStorage`(読み書きは try/catch。使えなければ毎回入力)。401 なら合言葉の欄に戻し「合言葉が違います」
  - 429:「AI の利用回数の上限に達しました。しばらくしてから使ってください」(サーバーの文をそのまま出してよい)
- 発言の並び:利用者の文、AI の返答(改行を保つ。Markdown は太字・箇条書きだけを簡単に整える。HTML は解釈しない)、ツールの動き(「方針の下書きを作っています…」「便を探しています…」「影響を計算しています…」「検証しています…」「足し戻しの下書きを作っています…」「元に戻す下書きを作っています…」)、考えの要約(小さく、灰色、折りたたみ。既定は閉じる。流れている間は「考えています…」と最後の1行)
- 下書きができたら、その場に「下書き {id} を作りました。上の欄で確かめて承認してください」と、該当する手順へ移るボタン
- 入力欄:複数行。Enter で改行、Ctrl+Enter(Mac は ⌘+Enter)で送る。送信中は「止める」ボタン
- 「AI に送る情報」:折りたたみ。要求を送るたびに、そのとき足した中身(利用者の文、[画面の…] の行、ツールの結果の JSON)を時刻つきで残す。送る前に、入力欄の下に「送るのは、あなたの文と、画面の状態・操作の行、ツールの結果(便の一覧や件数)です。GTFS のファイルは送りません」と出す
- 足し戻しの手順(`RestoreStep`)に「AI に候補を聞く」ボタンを置く。方針が承認され、AI が使えるときだけ押せる。押すと次の文を送る:「方針で消える平日の便のうち、通勤・通学・通院などのために足し戻したほうがよい便を、手がかりと停留所名から選び、理由をつけて足し戻しの下書きにしてください。数は多くても 10 便くらいにしてください。」
- 文言は画面の日本語の規則(CLAUDE.md)に従う

## 7. 足し戻しの手がかり(11/5 の2つ)

`web/src/gtfs/edit/restore.ts` の `ctx`(`RestoreHintContext`)を使う。`ctx` は到達圏の store の基準と編集後の結果(§7 の比較。同じ起点・同じセル・同じ時間帯)から作る。比較ができていなければ `ctx` を渡さず、この2つは出さない。

- 対象の便:`feed` が base で、比較の日付に基準で走る平日の便。比較の日付に走らない便には、この2つを出さない
- 乗れる停留所:その便の行のうち、`pickup_type` が 1 でなく、最後の行でないもの(到達圏の §7 の「乗れる行」と同じ定義を使う)。出発の時刻(無ければ到着の時刻)が読めない行は除く
- 時間帯:その行の出発の時刻が入る時間帯(比較の時間帯の区切り。6〜24時の外なら数えない)
- `onlyServiceAtStop`:乗れる停留所のどれかで、その時間帯の編集後の出発の数が 0(基準では、少なくともこの便の分の出発がある)
- `restoresLostCells`:乗れる停留所 s と、その時間帯 b の組ごとに、s のまわりの「減便で外れた」セル(時間帯 b で、基準では到達できて、編集後では到達できないセル)のうち、s からの直線距離がそのセルの区分のバス停の距離(都市部・郊外・中山間の分数 × 80m/分。到達圏の計算と同じ値と同じ距離の測り方)以内のもの。便全体で、(セル, 時間帯) の組を重ねずに数える
  - `lostCells.cells`:戻るセルの数(セルの重なりを除いた数。同じセルが2つの時間帯で戻るときも1と数える)
  - `lostCells.population`:そのセルの推計人口の合計(同じセルは1回だけ)
  - `restoresLostCells` は `cells` が 1 以上のときに出す
  - この便だけを足し戻したときの値で、ほかの便の足し戻しとの重なりは考えない(画面とツールの説明にそう書く)
- 鉄道駅は数えない(足し戻すのはバスの便なので)。ただし「外れたセル」は駅を含めた到達圏の比較の結果を使う(駅で到達できるセルは外れない)
- 時間がかかるので、候補の一覧をまとめて計算する関数にする(停留所ごとのまわりのセルを1回だけ探す)。道北バスの main の場面(候補約 300 便)で、画面が止まらない速さ(目安 200ms 以内。Web Worker に移すかは測ってから決める)
- 画面:足し戻しの候補の手がかりの表示に2つを足す(`RESTORE_HINT_LABELS` は 11/4 に用意済み)。`restoresLostCells` は「外れたセルが戻る({cells} セル、約 {population} 人)」と出す
- 実データの確かめ:道北バスの main の場面で、`restoresLostCells` の値を独立の Python の計算(到達圏の verify と同じ作り方)と照らす。少なくとも 10 便で一致すること

## 8. テスト

`docs/interfaces-1104.md` §11「Claude のツールと中継」のテストに、次を足す。

- server(`server/tests/test_claude.py`。Anthropic の SDK は偽物に差し替え、API は呼ばない):
  - 「status は API キーと合言葉の有無を返す」
  - 「要求に、モデル・max_tokens・system・tools・thinking・effort・fallbacks・キャッシュの区切りをサーバーが入れる」(偽物が受け取った引数を確かめる)
  - 「text・thinking・tool・done の SSE を、届いた順に流す」「流している途中の例外は error のイベントになり、ログには例外の型の名前だけが残る」
  - 「done の content は API の項目名(fallback の from・to)で、thinking の signature を落とさない」
  - 「最後が user でない本文は 400」「ほかの項目がある本文は 400」「メッセージが 200 を超えたら 413」
  - 「DISPATCHER_TRUST_PROXY が無いときは X-Real-IP を使わない」
  - 「ANTHROPIC_WORKSPACE_ID があればヘッダーを付ける」
  - 「.env を読むが、既にある環境変数は上書きしない」
- web(`web/src/claude/*.test.ts`):
  - §11 の7つ
  - 「ツールの名前と required の項目が claude_tools.json と一致する」
  - 「SSE の区切り(複数の行・途中で切れたチャンク)を正しく読む」
  - 「[画面の状態] は最初の発言と、変わったときだけ入る」「利用者がボタンで足し戻した便の数を [画面の操作] の行にする」
  - 「止めたあとの次の発言で、未実行の tool_use に『利用者が止めました』の結果を入れる」
  - 「ツールの往復が 8 回を超えたら止める」
- 手がかり(`web/src/gtfs/edit/restore.test.ts` ほか):手で作った小さなフィードと到達圏の結果で、2つの手がかりの有無と `lostCells` の数。比較の日付に走らない便には出ないこと。降車だけの停留所を数えないこと
- 本物の API(指示役が最後に1〜2回だけ行う。料金がかかるので、テストには入れない):ブラウザから「平日を土曜ダイヤにしてください。期間は 11/9 から当面の間」と送り、`apply_policy` の下書き → 承認 → 次の発言で [画面の操作] の行が入り、返した `content` が 400 にならないこと

## 9. 後で(11/6 のデプロイの作業に渡す)

- nginx:`/api/claude/` は `proxy_buffering off;`(SSE を溜めない)、`proxy_read_timeout` を長めに(数分)、`proxy_set_header X-Real-IP $remote_addr;`
- compose:`DISPATCHER_TRUST_PROXY=1`、`DISPATCHER_TOKEN`(合言葉)、`ANTHROPIC_API_KEY` を環境変数で渡す。`DISPATCHER_DEV` は付けない
- 本番の API キーは、Dispatcher 用のワークスペースに結びついたキーにし、ワークスペースに使用量の上限を付ける

## 10. 11/3 に決めたこと(指示役)

1. effort は `medium`、回数制限は IP ごとに 1 時間 30 回・全体で 1 日 300 回(12.1-19。環境変数で変えられる)
2. 途中経過は、thinking を要約(`display: "summarized"`)で受け取り、SSE の `thinking` で画面に出す(§13 の「`thinking.display`」)
3. [画面の操作] の行は、会話の途中のシステムメッセージにせず、§10 のとおり利用者の発言の先頭に置く(代わりのモデルが受け付けないため)。[画面の状態] の行を足し、今日の日付と GTFS をここで渡す(システムプロンプトに変わる値を入れないため)
4. `eager_input_streaming` は使わない(§2)
5. メッセージの自動キャッシュを使う(§13 の「最後の user の発言にも `cache_control`」)
6. `X-Real-IP` は `DISPATCHER_TRUST_PROXY=1` のときだけ使う
7. ツールの定義は `claude_tools.json` を正とし、web はテストで照らす
8. ツールの往復は1回の発言につき 8 回まで
