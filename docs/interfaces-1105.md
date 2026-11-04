# 11/5 の取り決め(アプリ内の Claude を Managed Agents で動かす)

11/5 に作るもの(会話と GTFS の6つのツール)と、11/6 に作るもの(前提情報の調査)の取り決め。土台は `docs/interfaces-1104.md` の §10(Claude のツールの契約)・§8(平日便を戻す)・§11(テスト)で、ここにはそこからの差分と、11/3 に決めたことを書く。食い違ったらこの文書を正とする。

- 前の版(Messages API で毎回の要求を中継する形)は、コミット `b7fd83d` の `docs/interfaces-1105.md` と、ブランチ `wip/messages-api`(書き終えていた中継と会話のコード)に残っている
- API の形は、2026-11-03 に claude-api の資料(`shared/managed-agents-overview.md`・`core.md`・`events.md`・`tools.md`・`multiagent.md`・`client-patterns.md`・`environments.md`、`python/managed-agents/README.md`、`shared/anthropic-cli.md` の ant apply の節、`shared/models.md`)で確かめた。SDK の関数名・引数名は、入れた版の SDK で確かめてから書く。記憶で書かない
- 資料で確かめられなかった点は §12 にまとめた

## 1. 範囲

### 11/5 に作るもの

- エージェントと実行環境の設定ファイル(`agents/coordinator.md`・`agents/researcher.md`・`environments/dispatcher.yaml`。§2)。調査役と workflow run の設定は最初から入れる(11/6 に調整役の版を上げ直さないため)。ただし、調査役の許可(§11 の 4)を後で変えるときや、本物の確かめ(§8)で設定を直すときは、`ant apply` で調整役の版も上がりうる。そのときは `DISPATCHER_AGENT_VERSION` を直す(§2.4)
- server:Managed Agents のセッションの中継(作成・取っ手・ストリーム・送信・終わり。§4)、認証コード、回数制限、ログ、SQLite のセッションの表と 24 時間の掃除、`.env` の読み込み
- web:6つのツールの実行(`web/src/claude/tools.ts`。`wip/messages-api` から流用し、型の確かめを足す)、ストリームの受け取り、[画面の状態]・[画面の操作] の行、チャットの store と画面(§6)、平日便を戻す手順の「AI に候補を聞く」ボタン
- web:平日に戻す判断材料の残り2つ(`onlyServiceAtStop`・`restoresLostCells`。§7)

### 11/5 が遅れたときに、11/6 へ回す順

デモに要るもの(セッションの作成、ストリーム、送信、ブラウザのツール、GTFS の読み込み直しでの `DELETE`、認証コード、取っ手、利用額の表示)は削らない。遅れたら、次の順に 11/6 へ回す。

1. `restoresLostCells` の、Python の計算との照らし合わせ(§7)
2. `Last-Event-ID` からの履歴の送り直し(§4.5 の 5)。答えていない `tool_call` の送り直しだけにする
3. 1回の発言のツールの呼び出しの上限(12 回。§4.7)
4. 料金の台帳と1日の利用額の関門(§4.10・§4.11)。回す前に、Console でワークスペースの月の上限(200 ドル)を付ける

### 11/6 に作るもの

- 調査の対象の一覧を作るコード(国土数値情報の P11・P29・P04 から、停留所の分布の外周に 2km の余白を足した範囲で選ぶ。§3.2)
- サーバーが実行する3つのツールの中身(`get_research_targets`・`get_research_results`・`save_research`)と、調査の結果の表(SQLite)、デモ用の保存済みの結果
- 画面の「前提情報を調べる」と、調査の進み具合・結果の表示
- 11/5 の段階では、この3つのツールが呼ばれたら、サーバーが `is_error` で「この機能はまだ使えません」と返す

### 作らないもの

- Dockerfile・compose・nginx の設定(11/5〜11/6 朝の別の作業。§9 に書き残す)
- 変更指示書・周知文(11/6)
- アプリ内の MCP サーバー

## 2. エージェントと実行環境

### 2.1 全体の形

```
ブラウザ ──(合言葉・取っ手)── server(FastAPI) ──(API キー)── Managed Agents のセッション(1つ)
  GTFS の6つのツールを実行            セッションの作成・削除            調整役 dispatcher-coordinator(Sonnet 5.5)
  発言と [画面の…] の行を送る          ストリームの中継と変換               ├ 調査役 dispatcher-researcher(Haiku 5.5)に1件ずつ頼む
  表示用の発言だけを持つ               調査のツール3つを実行(11/6)         └ workflow run で調査役を並行に走らせる
```

- 1つのセッションで、会話・6つのツール・調査を行う。会話の履歴はセッション(Anthropic の側)が持ち、ブラウザは表示用の発言だけを持つ
- セッションは GTFS の読み込み直しで終える。最後の操作から 24 時間で、サーバーが消す(§4.10)
- GTFS のファイルは送らない。送るのは利用者の文、[画面の…] の行、ツールの結果(便の要約や件数)だけ。セッションの記録(イベントの履歴)は、消すまで Anthropic の側に残る

### 2.2 調整役(`agents/coordinator.md`)

| 項目 | 値 | 理由 |
| --- | --- | --- |
| `name` | `dispatcher-coordinator` | |
| `model` | `{id: claude-sonnet-5-5, effort: medium}` | Sonnet 5.5 の effort の既定は `high`。前の版のおすすめ(`docs/interfaces-1104.md` §12.1-19 の `medium`)を引き継ぐ |
| `tools` | カスタムツール8つ(§3)。`agent_toolset_20260401` は入れない | bash・ファイル操作・Web 検索・Web の読み込みは、どれも持たせない |
| `multiagent` | §2.4 | |
| `system` | ファイルの本文(§5) | |

### 2.3 調査役(`agents/researcher.md`)

| 項目 | 値 | 理由 |
| --- | --- | --- |
| `name` | `dispatcher-researcher` | 調整役は名前と `description` で頼む相手を選ぶ |
| `model` | `{id: claude-haiku-5-5, effort: low}` | 検索・読み込み・抜き出しが中心で、入力が多く推論は軽い。Haiku 5.5 は入力 $0.10・出力 $0.50/100万トークン(1回の入力が 10 万トークン以下のとき) |
| `tools` | `agent_toolset_20260401` を既定で切り(`enabled: false`)、`web_search`・`web_fetch` だけを有効にする。`permission_policy` は `auto`。カスタムツール `save_research`(サーバーが実行) | |
| `web_search` | `user_location: {type: approximate, country: JP, timezone: Asia/Tokyo}` | 日本の施設を探すため |
| `web_fetch` | `max_content_tokens: 8000` | 1回の入力を 10 万トークン以下に保つ(超えると Haiku 5.5 の単価が5倍) |
| `multiagent` | 持たせない | 名簿に入れられるのは `multiagent` の無いエージェントだけ(委任は1段まで) |

- `auto` で、サーバーが判断できずに止まった呼び出し(`agent.tool_use` の `evaluated_permission` が `ask`)には、サーバーが `user.tool_confirmation` で `deny` を返す(見ている人がいないため。資料の Python の README)。`always_allow` にするかは §11 の 4。後で変えると `ant apply` が要り、調整役の版も上がりうる(§2.4)ので、最初の適用の前に決める
- 調査役の呼び出しは、調整役の流れ(セッションの主のスレッドのストリーム)に届く。`save_research` もそこでサーバーが答える(§4.8)

### 2.4 multiagent

```yaml
multiagent:
  type: multiagent_20261001
  subagents: {type: enabled, predefined_agents: [./researcher.md], inline_agents: {type: disabled}}
  workflows: {type: enabled, predefined_agents: [./researcher.md], inline_agents: {type: disabled}}
```

- `inline_agents` は両方とも `disabled`。調整役が自分で定義したエージェント(subagents の inline と、workflow run が定義するエージェント)は、調整役の `tools`(ブラウザで実行する6つを含む)をすべて受け継ぐ。調査の中から GTFS の編集のツールが呼ばれないよう、名簿の調査役だけを使わせる
- `{type: self}` も入れない(調整役の写しは調整役のツールを持つため)
- 名簿の調査役は、自分の設定(model・tools・system)で動く。調整役のツールは受け継がない
- 調整役の版を固定したときに、名簿の調査役の版も固定されるかは、確かめていない(§12)。資料では名簿の書き方で決まる。文字列の ID なら調査役の最新の版、`{type: agent, id, version}` なら書いた版(`version` を省けば、調整役を保存したときの最新)。`ant apply` がパスの名簿をどちらの形に書き換えるかは、資料に無い。適用の後に確かめる(§8 の本物の確かめの 1)
  - どちらの形でも、調査役のファイルを直して `ant apply` すると、調整役も同じ実行で更新されうる(資料:参照するものは同じ実行で更新される)。そのときは調整役の版を確かめて `DISPATCHER_AGENT_VERSION` を直す
- workflow run の上限(サーバーが決める):同時に 64 スレッド、1つの run で 1,000 スレッド、開いている run は1セッションに 10、run の寿命は既定 24 時間。調整役の system で 30 分の上限を付けさせる(§5)
- 名簿で作る子のスレッド(調査役に1件ずつ頼むとき)は、1セッションに 25 本まで。待機中のものも archive するまで数える(workflow run のスレッドは数えない)。終わった調査役のスレッドは、サーバーが片づける(§4.8)

### 2.5 実行環境(`environments/dispatcher.yaml`)

```yaml
name: dispatcher
config: {type: cloud, networking: {type: unrestricted}}
```

- `limited` で `allowed_hosts` が空だと、`web_search`・`web_fetch` は何も返さない(`limited` の `allowed_hosts` は Web のツールにもかかる)。調べる施設・事業者のサイトは前もって並べられないので、`unrestricted` にする
- `unrestricted` は、コンテナからの外向きの通信をすべて許す。ただし、どのエージェントにも bash・ファイル操作を持たせないので、コンテナから外へ出る手段は無い。資料は、この選択を利用者に示して決めてもらうよう求めているので、§11 の 1 で確かめる
- `packages`・`allow_mcp_servers` は使わない

### 2.6 ファイルと ant apply、版の固定

- ファイルの置き場所と名前は `shared/anthropic-cli.md` の「Version-controlled Managed Agents resources」に合わせた(`agents/` の直下の `.md` はエージェント、`environments/` の直下の `.yaml` は実行環境)。`.md` の前置き(YAML)が設定、本文がシステムプロンプト
- 名簿は相対パスで書く(`./researcher.md`)。`ant apply` が参照の順に適用し、ID を埋める(パスの名簿には ant 1.40.0 以上が要る。入っているのは 2.5.0)
- 適用(利用者の承認のうえで。この作業では適用しない):
  ```sh
  ant apply --dry-run -v agents/coordinator.md agents/researcher.md environments/dispatcher.yaml   # 計画を見る
  ant apply agents/coordinator.md agents/researcher.md environments/dispatcher.yaml               # 端末で y を押す(端末が無ければ --yes)
  ```
  - `--yes` は利用者の承認があるときだけ付ける。`--force`・`--prune` は付けない
  - リポジトリ直下に `claude-lock.json` ができるので、コミットする
  - `ant` はサーバーと同じワークスペースの資格情報で動かす(エージェントはワークスペースごと。違うワークスペースで作ると、サーバーのキーから見えない)
  - ファイルを直したら `ant apply` をやり直す。Console や `ant beta:agents update` で直接変えない(次の `ant apply` が止まる)
- セッションは版を固定して作る:`agent: {type: agent, id: DISPATCHER_AGENT_ID, version: DISPATCHER_AGENT_VERSION}`(§4.3)。デモの録画の日に版が変わらないようにするため
  - ID は `claude-lock.json`(`.resources["./agents/coordinator.md"].id` など)から `.env` に写す。版は `ant apply` の結果(か Console)で確かめて写す。ロックファイルに版が入るかは確かめていない(§12)
  - `ant apply` で版が上がっても、`DISPATCHER_AGENT_VERSION` を書き換えるまで、新しいセッションは前の版で動く。前の版のセッションは、作ったときの版のまま動く

## 3. ツール

### 3.1 ブラウザが実行する6つ

- 名前・説明・入力は `server/src/dispatcher_server/claude_tools.json` を正とする。`apply_policy`・`add_back_trips`・`undo_edit`・`summarize_impact`・`search_trips`・`run_validation`。中身と結果の形は `docs/interfaces-1104.md` §10 のとおり
- カスタムツールの形(`{type: custom, name, description, input_schema}`)にする。カスタムツールに `strict` は無いので外す。11/5 の実装で `claude_tools.json` からも `strict` を消す(保証の無い印を残さない)。`additionalProperties: false`・`enum`・`anyOf` は、入力の形の説明として残す
- strict が無いので、型・必須の項目・余分な項目・範囲・件数は、すべてブラウザで確かめる(§6.3)
- 結果は `user.custom_tool_result` の `content: [{type: text, text: "<JSON の文字列>"}]`。失敗は `is_error: true` で、`status: "error"` と日本語の `message`(§10 の形のまま)

### 3.2 サーバーが実行する3つ(11/6)

名前と入出力だけを決める。中身は 11/6。どれも結果は JSON の文字列で、失敗は `is_error: true`・`{status: "error", message}`。

| 名前 | 持つエージェント | 入力 | 結果 |
| --- | --- | --- | --- |
| `get_research_targets` | 調整役 | なし | `{status: "ok", targets: [{target_id, kind, name, municipality, lat, lon, cached}], total, max_targets}`。`cached` は保存済みなら `{status, checked_at, facts}`(facts は件数)、無ければ `null`。利用者が調査を始めていなければ `targets` は空 |
| `get_research_results` | 調整役 | `target_ids`(文字列の配列 1〜50 件か `null`=今の対象すべて) | `{status: "ok", results: [{target_id, kind, name, status, facts: [{label, value, source}], sources: [{url, title}], note, checked_at, origin}], missing: [target_id]}`。`origin` は `web` か `demo` |
| `save_research` | 調査役 | `target_id`、`status`(`found`・`partial`・`not_found`)、`facts`(`{label, value, source}` の配列。12 件まで)、`sources`(`{url, title}` の配列。1〜5 件、`not_found` なら 0 件でよい)、`note` | `{status: "ok", target_id, checked_at}`。確認日時はサーバーが入れる |

- **対象の一覧はサーバーが持つ**:画面は対象を選んで `POST /api/claude/session/research`(§4.2)に `target_ids` だけを送る。サーバーは自分の参照データ(`DISPATCHER_REF_DIR`)で、ID があることを確かめ、名前・種類・市町村・位置を自分のデータから入れる。ブラウザが送った名前は使わない(Claude に届く対象の文は、サーバーの公開データだけにする)。上限は `DISPATCHER_RESEARCH_MAX_TARGETS`(案 30)。`target_id` の形(`P29:<学校コード>` など)は 11/6 に決める
- **確かめ(サーバー)**:`target_id` がこのセッションの対象にあること、`facts[].source` が `sources` の番号(1 から)に当たること、URL が `http`・`https` で 2,000 字以下、文字数(label 20・value 200・title 100・note 200)。外れたら `is_error` で、何が違うかを日本語で返す
- **保存と使い回し**:調査の結果の表(§4.10)に、`target_id` ごとに1件。ほかのセッションでも使い回す(公開情報だけなので)。保存の期間は `DISPATCHER_RESEARCH_CACHE_DAYS`(案 7 日)。デモ用の保存済みの結果は `origin: demo` で、期間で消さない
- **上書きしない**:`save_research` の `target_id` に、`origin: demo` の行か、期限(`expires_at`)の切れていない行が既にあれば、保存せずに `is_error`(「この対象は保存済みです({checked_at} に確認)。期限が切れるまで調べ直せません」)で答える。置き換えるのは、期限の切れた `web` の行だけ。デモ用の結果が、審査の人が走らせた調査の結果に置き換わらないようにするため
- 調整役は `get_research_targets` で `cached` が `null` の対象だけを調べる。保存済みの対象は、頼まれても期限が切れるまで調べ直さない(system に書く)。デモで「保存済みの結果を使う」ときは、対象がすべて `cached` になるので、Web 検索をしない

### 3.3 定義を1か所に保つ

- `ant apply` は、読むファイルの中の `@`(ほかのファイルの中身を差し込む書き方)を置き換えない(`shared/managed-agents-onboarding-from-url.md`。置き換えるのは、`ant` に流す本文と、構造のあるフラグの値だけ)。また、`claude_tools.json` は `strict` を持ち `type: custom` を持たないので、差し込めても形が合わない。だから写しを置く
- 正は `claude_tools.json`。`agents/coordinator.md` の `tools` の最初の6つは、その写し(`type: custom` を足し、`strict` を除いたもの)。2026-11-03 に、両者が一致することを機械で確かめた
- サーバーのテスト `server/tests/test_agent_files.py`(11/5)で照らす:
  - 調整役の `tools` の最初の6つが、`claude_tools.json` の各ツールから `strict` を除き `type: custom` を足したものと、並びまで一致する
  - サーバーが実行するツールの名前(`SERVER_TOOLS`)が、調整役・調査役のファイルのカスタムツールの名前と一致する。ブラウザのツールの名前と重ならない
  - 調整役に `agent_toolset_20260401` が無い。調査役の toolset は既定で切ってあり、有効なのは `web_search`・`web_fetch` だけ
  - `multiagent` の `inline_agents` が両方 `disabled`、名簿に `self` が無い。調査役に `multiagent` が無い
  - 前置きの YAML は PyYAML で読む(今は uvicorn の依存として入っているだけなので、server の dev の依存に `pyyaml` を足す)
- web のテスト(`tools.contract.test.ts`)は、今までどおり `claude_tools.json` を読んで、名前と `required` を `runTool` と照らす
- 定義を変える手順:`claude_tools.json` を直す → `agents/coordinator.md` を同じに直す → テスト → 利用者の承認で `ant apply` → `DISPATCHER_AGENT_VERSION` を上げる

## 4. サーバーの中継

### 4.1 API の呼び方

- SDK は Python の `anthropic`(非同期のクライアント)。Managed Agents の呼び出しは `client.beta.sessions.*`(SDK がベータのヘッダー `managed-agents-2026-04-01` を付ける)。multiagent・workflow run の型には 1.13.0 以上が要る
- 使う呼び出し(資料の名前。非同期の版での名前と引数は、入れた SDK で確かめる):`sessions.create`、`sessions.retrieve`、`sessions.delete`、`sessions.events.stream(session_id, event_deltas=["agent.message", "agent.thinking"])`、`sessions.threads.list`・`threads.retrieve`・`threads.archive`、`sessions.events.list(session_id)`、`sessions.events.send(session_id, events=[...])`
- エージェントと実行環境は作らない・変えない(`ant apply` の仕事)。`agents.create` をサーバーのコードに書かない
- 型の付いた例外を、具体的なものから順に捕まえる(`RateLimitError` → `BadRequestError` → `APIStatusError` → `APIConnectionError`)。ブラウザには日本語の文を返し、ログには例外の型の名前と HTTP の状態だけを残す
- 環境変数 `ANTHROPIC_WORKSPACE_ID` があれば、ヘッダー `anthropic-workspace-id` を付ける(前の版と同じ。ワークスペースに結びつかないキーのときだけ要る)

### 4.2 エンドポイント

ヘッダー:認証コードは `X-Dispatcher-Token`、セッションの取っ手は `X-Dispatcher-Session`。取っ手を URL に入れない(nginx のアクセスログに残さないため)。失敗は JSON の `{ "detail": "…" }`(日本語)。

| メソッドとパス | 中身 |
| --- | --- |
| `GET /api/claude/status` | `{ available, tokenRequired }`。API キー・エージェントの ID と版・実行環境の ID・取っ手の秘密のどれかが無ければ `available: false`(開発の例外は §4.4。認証コードなしの公開は §4.11) |
| `POST /api/claude/session` | セッションを作る(§4.3)。本文は `{}`。返すのは `{ handle, budget_cents }` |
| `GET /api/claude/session/stream` | ブラウザ向けの長いストリーム(SSE。§4.5・§4.6)。`Last-Event-ID` を付けられる |
| `POST /api/claude/session/events` | 発言・ツールの結果・止める(§4.7) |
| `POST /api/claude/session/research` | 調査の対象を決める(11/6)。本文 `{ target_ids: [...] }`。返すのは正規化した対象の一覧 |
| `GET /api/claude/session/research` | このセッションの対象と、保存済みの結果(11/6。画面の表示とつなぎ直し用) |
| `DELETE /api/claude/session` | セッションを終える(§4.9)。すぐ 202 を返し、削除は裏で行う |

- ブラウザの `fetch` で読む(認証コードと取っ手のヘッダーが要るので `EventSource` は使わない)
- 取っ手の無い要求・違う取っ手は 404(「AI との会話が見つかりません。新しく始めます」)。終えたセッションの取っ手は 410

### 4.3 セッションの作成

- サーバーが決めて送る(ブラウザからは変えられない):
  ```python
  await client.beta.sessions.create(
      agent={"type": "agent", "id": AGENT_ID, "version": AGENT_VERSION},
      environment_id=ENVIRONMENT_ID,
      title="Dispatcher",
      metadata={"app": "dispatcher", "row": row_id},
      budget={"type": "limit", "max_list_cost": {"amount": "300", "currency": "USD"}},
  )
  ```
  - `budget.max_list_cost.amount` はセントの整数の文字列(3 ドルは `"300"`)。`DISPATCHER_SESSION_BUDGET_CENTS`(既定 300)から作る。budget は作るときだけ付けられる
  - `initial_events` は使わない(作るのは最初の発言の前。§6.5)
  - `metadata.row` は SQLite の行の ID(取っ手の ID と同じ。Anthropic のセッションの ID はブラウザに渡さない)
- 作る前に回数制限を確かめる(§4.11)
- 作ったら、SQLite に行を足し(§4.10)、取っ手を返す

### 4.4 セッションの取っ手

- 形:`v1.<行の ID>.<署名>`。行の ID は 16 バイトの乱数(base64url)。署名は `HMAC-SHA256(DISPATCHER_SESSION_SECRET, "dispatcher-session:v1:" + 行の ID)` の先頭 16 バイト(base64url)。照合は `hmac.compare_digest`
- 署名が合い、SQLite に行があり、終えていない(`ended_at` が空)ときだけ受け付ける。Anthropic のセッションの ID は行から引く
- `DISPATCHER_SESSION_SECRET` が無いとき:`DISPATCHER_DEV=1` なら起動ごとに乱数で作る(再起動で取っ手が無効になる)。そうでなければ AI は使えない(`available: false`)。認証コードなしの公開(`DISPATCHER_PUBLIC=1`。§4.11)でも省けない(11/3 の利用者の決定:`DISPATCHER_DEV` のほかの緩みは本番に持ち込まない)
- 取っ手はブラウザのメモリにだけ置く(`sessionStorage` に置かない。ページを読み込み直したら新しいセッション。§6.5)
- 認証コードは今までどおり、すべての要求で確かめる

### 4.5 ストリーム(つなぎ直しと重なりの除去)

- ブラウザのストリーム1本につき、サーバーが Anthropic のストリームを1本開く。同じ取っ手で新しいストリームが来たら、前の1本を閉じる(サーバーのツールに二重に答えないため)。uvicorn のワーカーは1つ(セッションの状態をメモリに持つため。§9)
- つなぐたび(初めても、つなぎ直しも):
  1. Anthropic のストリームを先に開く(`event_deltas=["agent.message", "agent.thinking"]`。途中経過は種類ごとに頼まないと届かない。`agent.thinking` は考え始めた合図の `event_start` だけが届く。ストリームは開いた後のイベントしか届けない)
  2. `events.list` で履歴を読む
  3. 履歴から、セッションの状態を作り直す:答えていないカスタムツールの呼び出し(`agent.custom_tool_use` のうち、同じ `custom_tool_use_id` の `user.custom_tool_result` が無いもの)、答えていない許可の確認(`agent.tool_use` のうち `evaluated_permission` が `ask` で、同じ `tool_use_id`(イベントの ID)の `user.tool_confirmation` が無いもの)、開いている workflow run(`workflow_run.created` があって `workflow_run.status_ended` が無いもの)、最後の `session.status_idle` の `stop_reason`
  4. 答えていないサーバーのツールの呼び出しに答え、答えていない許可の確認に `deny` を返す(§4.8)。答えていないブラウザのツールの呼び出しは、ブラウザに `tool_call` で送り直す
  5. 履歴のうち `Last-Event-ID` より後のイベントを、変換してブラウザに送る(無ければ送らない。結果の付いたツールの呼び出しは送らない)
  6. ストリームのイベントを、履歴に出た `id` を除いて、届いた順に変換して送る
- 重なりの除去は `id` で行う(履歴とストリームに同じイベントが出るため)。ブラウザに送る SSE の `id:` は Anthropic のイベントの `id`(届いた文字の途中経過には `id` が無いので付けない)。ブラウザも受け取った `id` を覚え、同じものは捨てる
- 15 秒ごとに `: ping` の行を送る(nginx とブラウザに、つながっていると分からせる)
- ブラウザがつながっていない間は、サーバーのツールにも答えない(調査は止まって待つ)。つなぎ直したときか、`message` を受けたとき(§4.7)に答える。画面に「調査の間は、この画面を開いたままにしてください」と出す
- ブラウザがいなくなっても、ブラウザのツールの呼び出しは待つだけで料金はかからない(待機は実行時間に数えない)。24 時間の掃除で消える

### 4.6 ブラウザ向けのイベント

Anthropic のイベントを、画面に要るものだけに絞って変換する。ここに無いイベントは送らない(`span.*`、`agent.thread_message_*`、`agent.thread_context_compacted`、`user.*` の送り返し、調査役のスレッドの中身など)。

| event | data | 元のイベント |
| --- | --- | --- |
| `delta` | `{ message_id, text }` | `event_start`・`event_delta`(`agent.message` の `content_delta` の text)。途中経過で、落ちることがある |
| `message` | `{ message_id, text }` | `agent.message`(text のブロックをつないだもの)。同じ `message_id` の途中経過を、これで置き換える |
| `thinking` | `{}` | `event_start` の `agent.thinking`、`agent.thinking`。中身は無い(考え始めた合図だけ) |
| `tool_call` | `{ id, name, input }` | `agent.custom_tool_use` のうち、ブラウザのツール(§3.1)で、主のスレッドからのもの。`id` はイベントの ID(`sevt_…`) |
| `tool_activity` | `{ name, done }` | サーバーのツールの呼び出し(`done: false`)と、サーバーが答えたとき(`done: true`) |
| `research` | `{ kind, run_id?, name?, phase?, result?, saved?, total? }` | `workflow_run.created`(`run_started`)・`phase_started`・`phase_ended`・`status_idle`(`run_paused`)・`status_ended`(`run_ended`、`result` は `completed`・`stopped`・`error`・ほか)・`workflow_run.error`(`run_error`、`max_workflow_runs_error` も)、`session.thread_created` の調査役(`delegated`)、`save_research` に答えたとき(`saved`。保存した数と対象の数) |
| `status` | `{ state, reason? }` | `session.status_running`(`running`)、`session.status_rescheduled`(`reconnecting`)、`session.status_idle`(`idle`。`reason` は `end_turn`・`requires_action`・`budget_reached`・`retries_exhausted`、サーバーが止めたときは `interrupted`。§4.9)、`session.status_terminated`(`ended`) |
| `usage` | `{ cost_cents, budget_cents }` | `session.usage`、または `session.status_idle` の後にサーバーが `sessions.retrieve` で読んだ `usage.list_cost` |
| `error` | `{ message, code }` | `session.error`、`retries_exhausted`、Anthropic への接続の失敗。`message` は日本語の決まった文で、Anthropic の文は渡さない |

- `tool_call` の `input` は、Claude が書いたものをそのまま渡す(確かめるのはブラウザ。§6.3)
- 調査役や workflow run のスレッドからのブラウザのツールの呼び出しは、名簿と inline の設定で起きないはずだが、来たらサーバーが `is_error`(「このツールは調査の中では使えません」)で答え、ブラウザには送らない
- 応答のヘッダー:`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`

### 4.7 ブラウザからの送信

`POST /api/claude/session/events` の本文は、次の3つのどれか1つ。ほかの項目があれば 400。

| `kind` | 本文 | サーバーが送るもの |
| --- | --- | --- |
| `message` | `{ kind, content: [{type: "text", text}] }`(text のブロック 1〜2 個。2 個のときは1つ目が [画面の…] の行) | `user.message`(`content` はそのまま) |
| `tool_results` | `{ kind, results: [{ custom_tool_use_id, text, is_error }] }`(1〜10 件) | 1件ごとに `user.custom_tool_result`(`{type, custom_tool_use_id, content: [{type: text, text}], is_error}`)。まとめて1回の `events.send` |
| `interrupt` | `{ kind, results? }`(`results` は `tool_results` と同じ形で 0〜10 件) | `results` の1件ごとの `user.custom_tool_result` と、その後ろに `user.interrupt`(`session_thread_id` を付けない)。まとめて1回の `events.send` |

- **呼び出しが待っている間は `user.message` を送らせない**:Anthropic は、呼び出しが待っている間(`requires_action`)の `user.message` を 400 にする。セッションは、どのスレッドの呼び出しが待っていても `requires_action` になる(ブラウザのツール、サーバーのツール、調査役の許可の確認)。だから `message` を受けたら、次の順に確かめる
  1. §4.5 の 4 と同じく、答えていないサーバーのツールの呼び出しに答え、答えていない許可の確認に `deny` を返す
  2. 答えていないブラウザのツールの呼び出しが残っていれば 409(「AI がツールの結果を待っています。少し待ってから送ってください」)。このとき `events.send` は呼ばない
  3. 送る。それでも Anthropic が 400 で断ったら、`sessions.retrieve` で状態を読む。`requires_action` なら 2 と同じ 409、`budget_reached` なら §4.9 の 409、ほかは 502(「AI に送れませんでした。もう一度送ってください」)。Anthropic の文はブラウザに渡さない
  - 画面も、ツールを実行している間は送れなくする
- `tool_results`(と `interrupt` の `results`)の `custom_tool_use_id` は、このセッションの答えていないブラウザのツールの呼び出しでなければ 409。`text` は 32KB まで(ブラウザは 20KB に収める)。`is_error` は真偽値
- `message`:text は合わせて 32KB まで。2 個のときの1つ目は、どの行も `[画面の状態] ` か `[画面の操作] ` で始まること(違えば 400)
- 予算に達したセッション(最後の idle の `stop_reason` が `budget_reached`)への `message` は 409(§4.9)。`tool_results` は受け付ける(予算に達しても、決着の送信は通る)
- 走っている間(`running`)の `message` は受け付ける(Anthropic の側で順に処理される)。止めずに続けて話しかけられる
- 1回の発言につき、ブラウザのツールの呼び出しは 12 回まで。超えたら、サーバーが 13 回目以降に `is_error`(「ツールの呼び出しが多すぎるので止めます」)で答え、同じ `events.send` で後ろに `user.interrupt` を付ける(結果を先に並べる。`user.custom_tool_result` は受け取った時点で処理されるので、別々に送ると、`interrupt` が届く前にモデルがエラーの結果を受けて1回動きうる)。ブラウザに `error`(「AI の作業が長くなったので止めました。続けるときは、もう一度送ってください」)を送る
  - この `interrupt` も、§4.9 の「止めたとき」と同じに扱う(`status` の `reason` を `interrupted` にし、run が開いていれば案内を出す)
- サーバーの再起動の後や、ストリームがつながっていないときに `message`・`tool_results` が来たら、その場で `events.list` を読んで状態を作り直してから確かめる(§4.5 の 3 と同じ作り方)
- 送ったら、行の `last_activity_at` を今にする(§4.10)

### 4.8 サーバーが実行するツールの振り分け

- `agent.custom_tool_use` の `name` で振り分ける。ブラウザのツール(§3.1)はブラウザへ(§4.6)。サーバーのツール(`SERVER_TOOLS` = §3.2 の3つ)はサーバーが実行し、すぐ `user.custom_tool_result` で答える。知らない名前は `is_error`
- workflow run のスレッドからの呼び出しも、主のスレッドの流れに届く。`requires_action` の idle を待たず、イベントが届いた時点で答える(run の間はセッションが `running` のままで、idle が来ないため)
- 同じ呼び出しに二重に答えない(答えた ID をメモリに持ち、つなぎ直しでは履歴の結果を見る)。run が終わった後の答えは 400 になることがあるので、400 はログに型だけを残して先へ進む
- `get_research_targets`・`get_research_results` は主のスレッドからだけ、`save_research` は調査役のスレッドからだけ受け付ける(違えば `is_error`)。主のスレッドは、つなぐたびに `sessions.threads.list` で `parent_thread_id` が null のものを探し、その ID とイベントの `session_thread_id` を比べて見分ける(主のスレッドのイベントに `session_thread_id` が付くかは資料に無い。§12)。ブラウザのツールの「主のスレッドから」(§4.6)も同じ見分け方
- `agent.tool_use` で `evaluated_permission` が `ask` のもの(調査役の Web のツールが `auto` で止まったとき)は、`user.tool_confirmation` で `deny`(`deny_message`:「確認できる人がいないので、この呼び出しは止めました。ほかの方法で調べてください」)を返す。数をログに残す
- **調査役のスレッドの片づけ**:子のスレッドは1セッションに 25 本まで(§2.4)。サーバーは、子のスレッドの `session.thread_status_idle`(`stop_reason` が `end_turn`)を受けたら、`sessions.threads.retrieve` で `parent_thread_id` が主のスレッドで `workflow_run_id` が null であることを確かめ、`sessions.threads.archive` で片づける(workflow run のスレッドは、run が開いている間は archive できず、25 本にも数えない)。失敗はログに例外の型だけを残す

### 4.9 予算に達したとき・終わったとき・エラーのとき

- **予算に達したとき**(`session.status_idle` の `stop_reason` が `budget_reached`):このセッションでは、もう発言できない(予算を変えれば続けられるが、アプリでは変えない)。ブラウザに `status`(`budget_reached`)を送り、画面は「この会話の AI の利用額が上限({上限} ドル)に達しました。続けるときは『新しく始める』を押してください。GTFS の編集はそのまま残ります。AI はここまでの会話を覚えていません」と出す({上限} は `POST /api/claude/session` が返した `budget_cents` から作る。画面に金額を直接書かない)。答えていないツールの呼び出しがあれば、結果は送ってよい
- **新しく始める**:ブラウザが `DELETE` の後に `POST /api/claude/session`。回数制限(§4.11)にかかる
- **終わったとき**(`session.status_terminated`):行の `ended_at` を入れ、ブラウザに `status`(`ended`)。画面は「AI との会話が終わりました。次に送ると新しく始めます」
- **`retries_exhausted`**:ブラウザに `error`(「AI の処理が続けられなくなりました。もう一度送ってください」)。セッションはそのまま使える
- **`session.error`**:ブラウザに `error`(「AI の処理でエラーが起きました」)。ログには `error.type` だけ
- **止めたとき**(利用者の「止める」と、§4.7 の 13 回目の自動の止め方):止めた後の idle は `end_turn` で、自然に終わったときと区別できない。サーバーが `user.interrupt` を送ったことを覚え、ブラウザに `status` の `reason` を `interrupted` にして送る
  - workflow run は止めても終わらない(一時停止することがある)。run が開いていれば、画面は「調査が止まっているかもしれません。続けるときは『調査を続けて』と送ってください」と出す
- **Anthropic への接続の失敗**(ストリームが切れた):ブラウザに `error`(`code: "upstream"`)を送ってストリームを閉じる。ブラウザはつなぎ直す(§6.4)
- **終える(`DELETE`)**:行の `ended_at` はすぐ入れる(取っ手はすぐ使えなくなる)。削除は裏で次の順に行う。Anthropic のストリームを開いたまま進め、途中で届いた呼び出しにも 1 と同じに答える
  1. 答えていない呼び出しすべてに答える。ブラウザのツールとサーバーのツールは `is_error`(「GTFS が読み込み直されたので止めました」)、許可の確認は `deny`。workflow run が開いていなければ、同じ `events.send` の後ろに `user.interrupt` を付けて 3 へ
  2. workflow run が開いていれば(§4.5 の 3):`user.message`(「調査の run をすべて止めてください。新しい run は始めないでください。」)を送り、開いている run すべての `workflow_run.status_ended` を待つ(60 秒まで)。待ち終えたら `user.interrupt`(run の終わりの知らせを受けた調整役の回を止める)
     - `user.interrupt` は run を終わらせず、run が開いている間の `delete` は断られる(`workflow_run_open`)か、受け付けて run を終わらせる。だから先に調整役に止めさせる。先に `interrupt` を送ると、調整役が run を止める回が来ない
     - 止めるよう頼むと、調整役の回が1回動く(料金は小さい)
     - 最後の idle が `budget_reached` なら `user.message` は 400 になるので、送らずに `user.interrupt` だけを送る
  3. `sessions.retrieve` で `running` でなくなるのを待つ(200ms ごと、2 秒まで。資料の client-patterns の 6) → `sessions.delete`
  4. 断られたら(`running`、`workflow_run_open` など)、行に `delete_pending` を付け、掃除(§4.10)で 1 からやり直す

### 4.10 SQLite の表と掃除

置き場所は `DISPATCHER_DB`(既定 `server/dispatcher.sqlite3`。`.gitignore` 済み)。会話の中身・ツールの入力と結果・IP アドレスは入れない。

```sql
CREATE TABLE agent_sessions (
  row_id TEXT PRIMARY KEY,          -- 取っ手の行の ID
  session_id TEXT NOT NULL,         -- Anthropic のセッションの ID(sesn_…)。ブラウザには渡さない
  agent_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,         -- ISO 8601(UTC)
  last_activity_at TEXT NOT NULL,   -- 最後の操作(作成・発言・ツールの結果・止める・調査の対象)
  last_stream_at TEXT,              -- 最後にブラウザのストリームがつながっていた日時(つないだとき、つながっている間は 60 秒ごと、切れたとき)。1日の利用額の予約(§4.11)
  ended_at TEXT,                    -- 終えた(取っ手が使えなくなった)
  deleted_at TEXT,                  -- Anthropic の側で消えた
  delete_pending INTEGER NOT NULL DEFAULT 0,
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,       -- 最後に読んだ usage.list_cost
  messages INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cost_ledger (day TEXT PRIMARY KEY, cents INTEGER NOT NULL);  -- 日本時間の日付ごとの利用額(§4.11)
CREATE TABLE research_targets (row_id TEXT, target_id TEXT, PRIMARY KEY (row_id, target_id));  -- 11/6
CREATE TABLE research_results (                                                                   -- 11/6。公開情報だけ
  target_id TEXT PRIMARY KEY, kind TEXT, name TEXT, status TEXT,
  facts_json TEXT, sources_json TEXT, note TEXT,
  checked_at TEXT NOT NULL, expires_at TEXT, origin TEXT NOT NULL  -- origin は web か demo
);
```

- **掃除**(サーバーの起動時と、15 分ごと):
  - `last_activity_at` から `DISPATCHER_SESSION_TTL_HOURS`(既定 24)時間たった行、または `delete_pending` の行を、§4.9 の「終える」と同じ手順で消す(アプリのコードが消してよいと利用者が決めた)
  - 消せたら `deleted_at` を入れ、`session_id` を空にする。3 回続けて断られたら、ログに例外の型を残し、次の掃除でまた試す
  - `deleted_at` から 2 日たった行と、その `research_targets` を消す(1日の数え上げが終わってから)
  - `research_results` の `expires_at` を過ぎた行(`origin: web`)を消す
- **料金**:`session.status_idle` を受け取るたびに `sessions.retrieve` で `usage.list_cost` を読み、`cost_cents` との差を `cost_ledger` のその日に足す。ブラウザがいないセッションの idle はサーバーに届かないので、掃除でも、終えていない行と消す前の行を `retrieve` して差を足す
  - workflow run が開いている間は、セッションが `running` のままで idle が来ない(`requires_action` を除く)。だから、サーバーがストリームを持っていて run が開いているセッションは、1 分ごとに `retrieve` する。`message` を受けたときも `retrieve` する
  - それでも台帳は最長で数分遅れる。1日の上限は、この遅れを見込んだ形にする(§4.11)
- **GTFS の読み込み直し**:ブラウザが `DELETE` を送る(§6.5)

### 4.11 認証コード・回数制限・料金の目安

- 認証コード:前の版と同じ(`DISPATCHER_TOKEN`、ヘッダー `X-Dispatcher-Token`、`hmac.compare_digest`)。`ANTHROPIC_API_KEY` があって `DISPATCHER_TOKEN` が無いときは、`DISPATCHER_PUBLIC=1` か `DISPATCHER_DEV=1` が無ければ AI は使えない(設定し忘れて誰でも呼べる状態になるのを防ぐ)
  - **認証コードなしの公開**(11/3 の利用者の決定。docs/tasks-1103.md の「利用者の決定(11/3)」の 2):AI も含めて認証コードなしで公開する。本番は `DISPATCHER_PUBLIC=1` で明示する。`DISPATCHER_PUBLIC` が許すのは認証コードを省くことだけで、取っ手の秘密(§4.4)などほかの設定は省けない。`DISPATCHER_TOKEN` も設定してあれば認証コードを求める(`tokenRequired: true`)。費用は、IP ごとの回数・1セッション $3・1日 $6(下の表)と Console のワークスペースの月の上限 200 ドルで守る
  - サンプル GTFS(`/api/sample-gtfs`)と参照データ(`/api/ref`)は、認証コードの対象に入れない(同じ決定)
- IP アドレス:前の版と同じ(`DISPATCHER_TRUST_PROXY=1` のときだけ `X-Real-IP`。`X-Forwarded-For` は読まない)
- 料金の目安(定価。2026-11-03 の `shared/models.md` と `managed-agents-core.md`):
  - 調整役(Sonnet 5.5。入力 $2・出力 $10・キャッシュの読み込み $0.20/100万トークン):1回のモデルの要求で、入力 2〜3 万トークン(多くはキャッシュ)と出力 1 千トークンとして約 $0.02〜0.03。利用者の発言 10 回(ツールの往復を入れて要求 40 回)で約 $1
  - 調査役(Haiku 5.5。入力 $0.10・出力 $0.50):1つの対象で、Web 検索 3 回($10/1,000 回で $0.03)と、要求 6 回(入力 1.5 万トークン)で約 $0.04。30 件で約 $1.2
  - 実行時間:動いている間だけ $0.08/時間(待機は数えない)。1時間動いても $0.08
  - 1セッション(会話と調査 30 件)で約 $2〜2.5。上限の 3 ドルに収まる
- 回数制限の案(IP ごとの数え上げはメモリの中。全体のセッションの作成の数は、再起動で 0 に戻らないよう `agent_sessions` の `created_at` から数える。1日は日本時間の日付で区切る。認証コードを通った要求だけを数える):

| 項目 | 案 | 環境変数 |
| --- | --- | --- |
| IP ごとのセッションの作成 | 1 時間 3 回、1 日 10 回 | `DISPATCHER_SESSIONS_PER_IP_HOUR`・`DISPATCHER_SESSIONS_PER_IP_DAY` |
| IP ごとの発言(`message`) | 1 時間 40 回 | `DISPATCHER_MESSAGES_PER_IP_HOUR` |
| 全体のセッションの作成 | 1 日 20 回 | `DISPATCHER_SESSIONS_PER_DAY` |
| 全体の1日の利用額 | 600 セント($6) | `DISPATCHER_DAILY_COST_CENTS` |
| 1セッションの利用額 | 300 セント($3) | `DISPATCHER_SESSION_BUDGET_CENTS` |
| 1回の調査の対象 | 30 件 | `DISPATCHER_RESEARCH_MAX_TARGETS` |

- 月の上限(Notion の決定、200 ドル)との関係:
  - セッションの数だけで抑えると、1日 20 回 × 3 ドル = 60 ドル/日、月 1,800 ドルまで行きうる。数では抑えきれない
  - 台帳(`cost_ledger`)の合計だけで抑えても足りない。台帳に額が入るのは `retrieve` の後で、workflow run の間は最長で数分遅れる(§4.10)。その間に作られたセッションは、どれも関門を通り、それぞれ 3 ドルまで使える。最悪は、上の 60 ドル/日と変わらない
  - だから新しいセッションの関門は**予約の形**にする。「今日の台帳の合計」+「消していない(`deleted_at` が空の)セッションごとの(予算 − 最後に読んだ `cost_cents`)」+「新しいセッションの予算」が `DISPATCHER_DAILY_COST_CENTS` を超えるなら、作成を 429 にする。セッションは予算を超えて使えないので、1日の額はこの上限を大きくは超えない
  - `message` は、今日の台帳の合計が上限に達したら 429 にする(ツールの結果と止めるは通す)。文は「今日の AI の利用額の上限に達しました。日本時間の翌日になってから使ってください」
  - **閉じ損ねたセッション**(11/3 の利用者の決定の 1):最後の操作(`last_activity_at`)からも、最後にストリームがつながっていた日時(`last_stream_at`。一度もつながっていなければ `created_at`)からも 30 分たった行は、残りの予算ではなく使った額だけを予約に数える。使った額は台帳に入っている(idle のたびと掃除の `retrieve`。§4.10)ので、予約の和には 0 を足す(`cost_cents` を足すと台帳と二重に数える)。戻ってきてつなぎ直すか発言すれば、また残りの予算を数える(取っ手はそのまま使え、会話を続けられる)。行は消さない(24 時間の掃除まで残す)
  - 600 セント/日なら月 180 ドルに収まる。ただし予約の形では、3 ドルのセッションを同時に2つまでしか開けない(使わずに開いたままの画面も、ストリームがつながっている間は1つ分を取る。閉じ損ねた画面は 30 分で外れる)。値は §11 の 2 で決めてもらう
  - 30 分で外した行の人が戻ってくると、1日の額が上限を最大で1セッションの予算ぶん超えうる。台帳が上限に達したら発言は止まり(下)、月の額は Console の上限で守る
  - 最後の歯止めとして、Console でワークスペースの月の利用額の上限を 200 ドルに付ける。11/6 のデプロイの前に必ず付ける(§9)
- 超えたら 429(日本語。どの上限かが分かる文)

### 4.12 ログ

- 残すもの:日時、回数(セッションの作成・削除、発言、ツールの呼び出しの数を名前ごと、調査の対象の数、保存した数)、エラーの種類(HTTP の状態、SDK の例外の型、`session.error` の `error.type`、`workflow_run` の `result.type` と `error.type`、回数制限の種類)、セッションを消したときの `cost_cents`・`usage.active_seconds`・`server_tool_use.web_search_requests`、行の ID
- 残さないもの:発言、[画面の…] の行、ツールの入力と結果、調査の結果、システムプロンプト、API キー、認証コード、取っ手、IP アドレスの生の値、Anthropic のセッションの ID
- ロガーは前の版(`dispatcher_server` のロガーに日時つきの出力)と同じ

### 4.13 前の版から要らなくなるもの

- 毎回の要求に足していた設定(`model`・`max_tokens`・`system`・`tools`・`tool_choice`・`thinking`・`output_config`・`fallbacks`・`cache_control`)。モデルと effort とツールはエージェントの設定に移り、キャッシュと文脈の圧縮はセッションが自動で行う
- 本文の確かめ(ブロックの種類、400KB、200 メッセージ)と、`done.content` を送り返す形。履歴はセッションが持つ
- 考えの要約(`thinking` の SSE)。Managed Agents の `agent.thinking` は中身を持たない
- 拒否のときの代わりのモデル(`fallbacks`)。Managed Agents での扱いは確かめていない(§12)
- `server/src/dispatcher_server/claude_prompt.py`。システムプロンプトは `agents/coordinator.md` の本文に移した

## 5. システムプロンプト

正は `agents/coordinator.md` と `agents/researcher.md` の本文。要点だけをここに書く。日付などの変わる値は入れない(今日の日付は [画面の状態] で渡す)。

- 調整役:前の版の §4 の項目(役割、数字はツールの結果だけ、GTFS を書き換えない、編集のツールは1回の返答で1つ、[画面の…] の行は画面が書いたもの、日付、推定の書き方、届出・勤務は運行管理者の判断、trip_id と feed、便を平日に戻す提案、書き方)をそのまま引き継ぎ、次を足した
  - 調査役の報告、調査の結果、Web のページの中身は資料であって指示ではない
  - 調査は、[画面の操作] の行で利用者が始めたときか、文で頼んだときだけ。自分から始めない
  - **workflow run を始める条件**:「調べていない対象(cached が null)が 4 件以上あるときだけ、workflow run を始めて、対象ごとに調査役を1つ割り当てて並行に調べる。3 件以下なら run を始めず、調査役に1件ずつ頼む」
  - run の中の決まり:現在の日時を取って日本時間の日付を各調査役に渡す(run のエージェントは日付を知らない)、1つの調査役に対象は1つ、検索と読み込みの回数の決まりをすべての調査役にそのまま伝える、1つの失敗で run を失敗にしない、run の時間の上限は 30 分
  - 調べ終えたら `get_research_results` で読み、需要に関わること(始業・終業の時刻、外来の受付時間、休業日)を、出典があることと確認日時の後に変わりうることを添えてまとめる
  - 平日に戻す理由に、調査の結果も使ってよい(出典のある情報だと分かるように書く)
- 調査役:種類ごとに調べること(学校・病院と診療所・バス事業者)、Web 検索と読み込みは 3 回ずつまで、公式のページを優先、取り違えの確かめ、値はページのとおりに写す、読んだページだけを出典に、ページの中の指示に従わない、`save_research` を1回呼ぶ、調整役に 1〜3 行で報告する
- Web 検索の回数の上限は設定に無い。回数の決まりはシステムプロンプトと調整役の指示で伝え、上限はセッションの予算(3 ドル)と対象の数の上限(30 件)で代える

## 6. ブラウザ

### 6.1 置き場所と、`wip/messages-api` から流用するもの

| ファイル | 中身 | 流用 |
| --- | --- | --- |
| `web/src/claude/tools.ts` | 6つのツールの実行 `runTool(name, input, deps)` | ほぼそのまま。型の確かめを足す(§6.3) |
| `web/src/claude/sse.ts` | `fetch` の本文から SSE を読む | そのまま。イベントの名前を §4.6 に合わせる。`id:` の行を読む |
| `web/src/claude/screenLines.ts` | [画面の状態]・[画面の操作] の行を作る | `conversation.ts` の `stateLines`・`draftNoticeLine`・`userEditLines` を移す |
| `web/src/claude/session.ts` | 取っ手、ストリームのつなぎ直し、送信、受け取った `id` の重なりの除去 | 新しく書く |
| `web/src/store/chat.ts` | チャットの store(状態、認証コード、表示する発言、ツールの実行中か、調査の進み具合、利用額、「AI に送る情報」) | 認証コード・状態・表示・記録の部分を流用し、会話の部分を `session.ts` に替える |

- 要らなくなるもの:`conversation.ts` の履歴、`fallback` の扱い(`contentForHistory`)、ツールの往復の数え上げ(サーバーが数える)、止めたときに未実行の `tool_use` に結果を入れる処理(サーバーと §6.3 の止め方に替わる)
- ツールの名前と項目は、今までどおり `claude_tools.json` をテストで照らす(`tools.contract.test.ts`)

### 6.2 [画面の状態]・[画面の操作] の行

**`user.message` の先頭の text のブロックに入れる**(前の版と同じ)。`system.message` にはしない。理由:

- `system.message` は、その回とその後のすべての回のシステムの文脈に足される。「下書き #3 を承認しました」のような一度きりの知らせや、変わっていく画面の状態が、古いまま規則として積み重なる
- 下書きの承認は、ツールの結果を返した後に起きる。`requires_action` の間の `system.message` はツールの結果と同じ要求でしか受け付けられず、承認の知らせを載せる場が無い。どのみち次の発言と一緒に送ることになる
- 行はブラウザが書く。利用者の文と同じくらいの信頼しかないものを、システムの文脈という強い場所に置かない
- 前の版の行を作るコードがそのまま使える

決まり(前の版のとおり):

- 行は1件ごとに1行。利用者の文は別の text のブロックにする。行が無ければこのブロックを置かない
- **[画面の状態]**(セッションの最初の発言と、内容が変わったときだけ):今日の日付(日本時間)、読み込んだ GTFS(表示名・有効期間・平日・土曜・日祝の service)、到達圏を比較する日付と時間帯の幅
- **[画面の操作]**:Claude の下書きの行方(`takeDraftNotices()` の3つの文)、利用者がボタンで行った編集(前に送ったときの承認済みの履歴と今の履歴を比べる)。11/6 に「[画面の操作] 利用者が前提情報の調査を始めました(対象 {N} 件)。」を足す
- 「前に送った」の記録は、セッションごとに持つ。新しいセッションの最初の発言には、[画面の状態] をすべてと、承認済みの編集の要約(「[画面の操作] これまでに承認された編集:減便の方針の承認(平日を土曜ダイヤに、{開始}〜{終了})、平日に戻した便 {N} 便。」。除外した系統があれば、期間の後に「、除外した系統 {n}」が入る)を入れる(予算に達して新しく始めたときに、AI が今の状態を前提にできるように)

### 6.3 ツールの実行

- `tool_call` を受け取ったら、受け取った順に `runTool` を実行する。同じ `id` は2回実行しない。答えていない呼び出しがある間は、入力欄の送るボタンを押せなくする
- **結果を残して送り直す**:送る結果は、`id` ごとにメモリに残す(このセッションの間)。同じ `id` の `tool_call` がまた届いたら(つなぎ直しでサーバーが送り直したとき)、実行せずに残した結果を送る。`apply_policy` などの編集のツールは、実行し直すと下書きが二重になるため
  - `tool_results` の POST が通信の失敗で落ちたら、1・2・4 秒の間をおいて3回までやり直す。やり直しが 409(答える呼び出しが無い)なら、届いていたものとして扱う
- 1回の idle で複数の呼び出しが来たとき(並べて呼ばれたとき)は、全部を実行してから、まとめて1回の `tool_results` で送る。編集のツールの2つ目以降は、今までどおり「下書き {id} が承認待ちです」の結果になる
- **型の確かめ**(strict が無いので、全部ブラウザで。外れたら `is_error` で、何が違うかを日本語で返す。前の版の確かめに足すもの):
  - `input` がオブジェクトであること。`required` の項目がそろっていること(前の版にある)と、**知らない項目が無いこと**(`additionalProperties: false` の代わり。`add_back_trips` の `items` の各要素も)
  - 型:文字列・真偽値・整数・配列・`null` の別を項目ごとに確かめる(前の版にある)。`enum` の外の値(`kind`・`scope`・`reason_category`・`step_hours`)を受け付けない(前の版にある)
  - 長さ:`reason_note`・`reason` は 200 字まで、`stop_name` は 100 字まで、`route_ids`・`excluded_route_ids` は 200 件まで、入力の全体は 16KB まで
  - 範囲:日付は `YYYYMMDD` で暦の上で正しい日、時刻は `HH:MM`(時は 0〜47)、`items` は 1〜50 件、`limit` は 1〜50(前の版にある)
- 結果が 20KB を超えたら、一覧を後ろから切り、切った件数を書く(前の版にある `fitResult`)
- 「止める」:ツールを実行している間なら、実行を止め、答えていない呼び出しすべての `is_error`(「利用者が止めました」)を `interrupt` の `results` に入れて送る(§4.7。主のスレッドの `requires_action` を `interrupt` が閉じるかは資料に無いので、結果で決着させる。結果と `interrupt` を1回で送り、その間にモデルが動かないようにする)

### 6.4 画面

前の版の §6 の画面(認証コードの欄、発言の並び、下書きの知らせ、入力欄、「AI に送る情報」、「AI に候補を聞く」ボタン)を引き継ぐ。変えるところと足すところ:

- **置き場所**(11/4 に変更):左の欄の上の端のタブ(「編集」と「AI に相談」。名前は「左の欄の表示」)で切り替える。「編集」は手順のステッパー・手順の中身・「戻る」「次へ」、「AI に相談」は会話を左の欄の高さいっぱいに出す(会話の箱が伸び、入力欄は下に固定。折りたたみは無い。地図を隠す手順では幅を抑えて中央にそろえる)。タブは GTFS を読み込む前から出す。読み込むまでの「AI に相談」は、案内と手順「読み込み」を開くボタンだけ(会話は GTFS の読み込みで始まるため)。どちらのタブの中身も消さずに隠す(入力中の文、スクロールの位置、手順の入力中の値を残す)。地図はタブと関係なく、手順のとおりに出す。GTFS を読み込み直したら「編集」に戻す(`web/src/store/sidePanel.ts`、`web/src/components/layout/SidePanel.tsx`)
- **タブの自動の切り替え**:手順のボタンから AI に文を送ったとき(「AI に候補を聞く」など、利用者の文が会話に増えたとき)は「AI に相談」に切り替える。AI が下書きを作ったときは切り替えない。代わりに「編集」のタブの名前の横に「承認待ち」の印を出し(承認待ちの下書きがある間)、下書きの知らせの「編集で確かめる」で「編集」のタブに移って承認する手順を開く
- **タブの印**:「編集」のタブを開いている間、AI が返答していれば「AI に相談」のタブの名前の横にスピナー(読み上げは「返答中」)、見ていない発言(AI の返答・下書きの知らせ・エラー)があれば点(読み上げは「新しい発言あり」)を出す。「AI に相談」のタブを開いたら消す。「編集」のタブを開いている間は会話の箱が隠れて読み上げられないので、下書き・返答の終わり・エラーを、タブの列の中の見えない `role="status"` で知らせる
- **考えています…**:利用者が送ってから、`thinking`・`delta`・`tool_call` を受け取っている間、最後に「考えています…」と出す。考えの要約は出さない(中身が届かないため)。`status` の `running` だけでは出さない(workflow run が開いている間は、調整役が返答を終えてもセッションが `running` のままになるため。その間は調査の進み具合を出す)
- **返答の文字**:`delta` で途中まで出し、`message` で置き換える(途中経過は落ちることがあるので、`message` を正とする)
- **ツールの動き**:前の版の文(「減便の方針の下書きを作っています…」など)。サーバーのツールは「調査の対象を読んでいます…」「調査の結果を読んでいます…」
- **調査の進み具合**(11/6):前提情報の欄に「調べています {saved} / {total} 件」、run の段階の名前、終わったら「調べ終えました」「一部を調べられませんでした」。調査の間は「調査の間は、この画面を開いたままにしてください」
- **送れないとき**:ツールを実行している間は送るボタンを押せない(「AI がツールの結果を待っています」)。409 が返ったら、入力欄の文を残して同じ文を出す
- **上限に達したとき**:予算(§4.9 の文と「新しく始める」ボタン)、1日の上限・回数制限(サーバーの文をそのまま)
- **利用額**:入力欄の下に小さく「この会話の AI の利用額 約 ${cost} / 上限 ${budget}」(`usage`。定価で数えた額。上限は `budget_cents` から作り、金額を直接書かない)
- **AI に送る情報**:送るたびに、送った中身(利用者の文、[画面の…] の行、ツールの結果の JSON)を時刻つきで残す。送る前に入力欄の下に「送るのは、利用者の文と、画面の状態・操作の行、ツールの結果(便の一覧や件数)です。GTFS のファイルは送りません」と出す。調査を始めるときは「調べる施設・事業者の名前と位置(国土数値情報)を送り、AI が Web で検索します」を足す
- **AI を準備しています…**(T15):送ってから、新しいセッションの最初のストリームがつながるまで(セッションを作っている間と最初の接続を待つ間。最初の接続は 15 秒ほどかかる。§9)、会話の下に「AI を準備しています…(最初は 15 秒ほどかかります)」と出す。この間は「送っています…」を重ねない。つながった後の発言とつなぎ直しでは出さない
- **つなぎ直し**:ストリームが切れたら、1・2・4・8 秒(以後 8 秒ごと)でつなぎ直す。`Last-Event-ID` に最後に受け取った `id` を付ける。つなぎ直している間は「つなぎ直しています…」
- 文言は画面の日本語の規則(CLAUDE.md)に従う

### 6.5 セッションを始める・終える

- **始める**:最初に送るとき(発言、「AI に候補を聞く」、11/6 の「前提情報を調べる」)に `POST /api/claude/session` で作り、ストリームをつないでから送る(ストリームを先に開く)。GTFS を読み込んだだけでは作らない
- **GTFS を読み込み直したとき**:ツールの実行を止め、`DELETE /api/claude/session` を送り(`fetch` の `keepalive: true`)、取っ手を捨て、表示を消して「GTFS を読み込み直したので、AI との会話を新しく始めます」と出す。次に送るときに新しいセッションを作る
- **ページを閉じる・読み込み直すとき**:`pagehide` で `DELETE` を `keepalive: true` で送る(届かなくても 24 時間の掃除で消え、1日の利用額の予約からは 30 分で外れる。§4.11)。取っ手はメモリにしか無いので、読み込み直した後は新しいセッションになる
- **新しく始める**(予算に達したときなど):`DELETE` の後に作り直す

## 7. 平日に戻す判断材料(11/5 の2つ)

前の版のまま。

`web/src/gtfs/edit/restore.ts` の `ctx`(`RestoreHintContext`)を使う。`ctx` は到達圏の store の減便前と減便後の結果(§7 の比較。同じ起点・同じ区画(セル)・同じ時間帯)から作る。比較ができていなければ `ctx` を渡さず、この2つは出さない。

- 対象の便:`feed` が base で、比較の日付に減便前で走る平日の便。比較の日付に走らない便には、この2つを出さない
- 乗れる停留所:その便の行のうち、`pickup_type` が 1 でなく、最後の行でないもの(到達圏の §7 の「乗れる行」と同じ定義を使う)。出発の時刻(`departure_time`)が空か読めない行は除く(到達圏の出発の数と同じ。到着の時刻では代えない。11/3 に指示役が直した)
- 時間帯:その行の出発の時刻が入る時間帯(比較の時間帯の区切り。6〜24時の外なら数えない)
- `onlyServiceAtStop`:乗れる停留所のどれかで、その時間帯の減便後の出発の数が 0(減便前では、少なくともこの便の分の出発がある)
- `restoresLostCells`:乗れる停留所 s と、その時間帯 b の組ごとに、s のまわりの「減便で到達圏から外れた」区画(時間帯 b で、減便前では到達できて、減便後では到達できない区画)のうち、s からの直線距離がその区画の区分のバス停の距離(都市部・郊外・中山間の分数 × 80m/分。到達圏の計算と同じ値と同じ距離の測り方)以内のもの。便全体で、(区画, 時間帯) の組を重ねずに数える
  - `lostCells.cells`:戻る区画の数(区画の重なりを除いた数。同じ区画が2つの時間帯で戻るときも1と数える)
  - `lostCells.population`:その区画の推計人口の合計(同じ区画は1回だけ)
  - `restoresLostCells` は `cells` が 1 以上のときに出す
  - この便だけを平日に戻したときの値で、ほかの便を平日に戻す操作との重なりは考えない(画面とツールの説明にそう書く)
- 鉄道駅は数えない(平日に戻すのはバスの便なので)。ただし「到達圏から外れた区画」は駅を含めた到達圏の比較の結果を使う(駅で到達できる区画は外れない)
- 時間がかかるので、候補の一覧をまとめて計算する関数にする(停留所ごとのまわりの区画を1回だけ探す)。道北バスの main の場面(候補約 300 便)で、画面が止まらない速さ(目安 200ms 以内。Web Worker に移すかは測ってから決める)
- 画面:平日に戻す候補の判断材料の表示に2つを足す(`RESTORE_HINT_LABELS` は 11/4 に用意済み)。`restoresLostCells` は「到達圏が戻る({cells} 区画、約 {population} 人)」と出す
- 実データの確かめ:道北バスの main の場面で、`restoresLostCells` の値を独立の Python の計算(到達圏の verify と同じ作り方)と照らす。少なくとも 10 便で一致すること

## 8. テスト

本物の API は呼ばない。server は Anthropic の SDK のクライアントを偽物に差し替える(`sessions.create`・`retrieve`・`delete`・`events.stream`・`events.list`・`events.send` を、決めたイベントの列を返し、受け取った引数を記録する偽物にする)。

### server(`server/tests/test_agent_relay.py` ほか)

- 設定ファイル(`test_agent_files.py`):§3.3 の5つ
- status:API キー・エージェントの ID と版・実行環境の ID・取っ手の秘密・認証コードの有無で `available`・`tokenRequired` が変わる。`DISPATCHER_DEV=1` のときだけ秘密が無くても動く。`DISPATCHER_PUBLIC=1` は認証コードが無くても動くが、秘密は省けない
- 予約:最後の操作とストリームから 30 分たった行は残りの予算を数えない。ストリームは、つないだとき・つながっている間・切れたときに `last_stream_at` を記録する。前の版の SQLite には列を足す
- 作成:偽物が受け取った `agent` が `{type: agent, id, version}`、`environment_id`、`budget` が `{"type": "limit", "max_list_cost": {"amount": "300", "currency": "USD"}}`、`initial_events` が無い。SQLite に行ができる。IP ごと・全体の回数で 429。全体の回数は再起動(アプリを作り直す)の後も数えられている
- 1日の利用額:消していないセッションの予約(予算 − 最後に読んだ額)と台帳の合計で、上限を超える作成が 429。台帳が上限に達した後の `message` は 429 で、`tool_results` と `interrupt` は通る
- 認証コード:どのエンドポイントも、認証コードが無いか違えば 401
- IP アドレス:`DISPATCHER_TRUST_PROXY` が 1 でないとき、`X-Real-IP` を変えても回数制限をすり抜けられない
- 取っ手:署名を1文字変えると 404、別の行の ID に元の署名を付けても 404、終えた行は 410。取っ手が URL・ログに出ない
- ストリームの変換:偽物の `events.stream` が受け取った `event_deltas` が `agent.message`・`agent.thinking` の2つ。`event_start`・`event_delta` → `delta`、`agent.message` → `message`、`event_start` の `agent.thinking` と `agent.thinking` → `thinking`、ブラウザのツールの `agent.custom_tool_use` → `tool_call`(`id` はイベントの ID)、`workflow_run.*` → `research`、`session.status_idle` の4つの `stop_reason` → `status`、`session.error` → `error`(Anthropic の文を含まない)。表に無いイベントは送らない
- つなぎ直し:履歴とストリームに同じ `id` があっても1回だけ送る。`Last-Event-ID` より前は送らない。答えていないブラウザのツールの呼び出しを送り直し、結果の付いた呼び出しは送らない。答えていないサーバーのツールに1回だけ答え、答えていない `ask` の確認に1回だけ `deny` を返す
- 送信:答えていないブラウザのツールがあるときの `message` は 409(偽物の `events.send` は呼ばれない)。答えていないサーバーのツールか `ask` の確認だけがあるときの `message` は、先にそれらに答えてから `user.message` を送る。偽物が `user.message` を 400 で断り `retrieve` が `requires_action` を返すと 409。`interrupt` の `results` は、結果が先、`user.interrupt` が後ろの1回の `events.send` になる。知らない `custom_tool_use_id` の結果は 409。予算に達した後の `message` は 409、`tool_results` は通る。項目の多い本文・大きすぎる本文は 400・413。1つ目のブロックが [画面の…] で始まらない2ブロックは 400
- ツールの呼び出しの上限:13 回目の `is_error` と `user.interrupt` が1回の `events.send` に、結果が先の順で入る。その後の idle の `status` の `reason` が `interrupted`
- サーバーのツール:run のスレッド(`session_thread_id` 付き)からの `save_research` に、idle を待たずに答える。二重に答えない。11/5 の段階では3つとも「まだ使えません」の `is_error`。調査役の `ask` の呼び出しに `deny` を返す
- 調査の中からのブラウザのツール:子のスレッドや run のスレッドからの `apply_policy` などの `agent.custom_tool_use` に、サーバーが `is_error` で答え、ブラウザの SSE に `tool_call` が出ない
- 調査の結果の上書き(11/6):`origin: demo` の行か期限の切れていない行がある `target_id` への `save_research` は `is_error` で、表は変わらない。期限の切れた `web` の行は置き換わる
- 子のスレッドの片づけ:`workflow_run_id` が null の子のスレッドの `session.thread_status_idle`(`end_turn`)で `threads.archive` が呼ばれる。run のスレッドと主のスレッドでは呼ばれない
- 終える:run が開いていなければ、答えていないツールの `is_error` と `user.interrupt` が1回の `events.send` → `retrieve` → `delete`。run が開いていれば、結果 → run を止めるよう頼む `user.message` → `workflow_run.status_ended` を待つ → `user.interrupt` → `retrieve` → `delete`。`budget_reached` なら `user.message` を送らない。`delete` が断られたら `delete_pending`
- 掃除:24 時間たった行を消す。新しい行は消さない。3回断られてもログに型だけを残して続ける
- 料金:`session.status_idle` の後の `retrieve` の `list_cost` の差が `cost_ledger` に足される
- ログ:発言・ツールの入力と結果・取っ手・セッションの ID・IP アドレスがログに出ない(`caplog` で確かめる)
- `.env` の読み込みは前の版のテストを引き継ぐ

### web(`web/src/claude/*.test.ts`・`web/src/store/chat.test.ts`)

- `docs/interfaces-1104.md` §11 の7つと、前の版の `tools.test.ts`・`tools.contract.test.ts`
- 型の確かめ:知らない項目、`items` の要素の知らない項目、型の違い、長すぎる文字列・多すぎる配列を `is_error` にする
- SSE の区切り(複数の行・途中で切れたチャンク・`id:` の行)を正しく読む(前の版の `sse.test.ts`)
- `delta` を `message` で置き換える。同じ `id` のイベントを2回受け取っても1回だけ扱う
- `tool_call` を順に実行し、まとめて `tool_results` で送る。同じ `id` を2回実行しない。実行している間は送れない
- 送り直された `tool_call`(同じ `id`)には、実行せずに残した結果を送る。`tool_results` の POST が通信の失敗で落ちたらやり直し、やり直しの 409 は届いたものとして扱う
- 「止める」で、答えていない呼び出しの「利用者が止めました」を `results` に入れた `interrupt` を1回で送る
- [画面の状態] はセッションの最初の発言と、変わったときだけ入る。新しいセッションの最初の発言に、承認済みの編集の要約が入る。利用者がボタンで平日に戻した便の数が [画面の操作] の行になる
- GTFS を読み込み直すと `DELETE` を送り、表示と取っ手を消す
- 予算に達したら入力欄を閉じ、「新しく始める」を出す

### 本物の確かめ(指示役が最後に行う。料金がかかるので、テストには入れない)

1. 利用者に `ant apply --dry-run -v`(§2.6)の計画を見せ、承認をもらってから適用する。`claude-lock.json` ができること、調整役の名簿に調査役が入ったこと。適用の後に `ant beta:agents retrieve` で調整役を読み、`multiagent` の `predefined_agents` が `{type: agent, id, version}` か文字列の ID かを見る(§2.4。文字列なら、調査役の版は調整役の版で固定されない)
2. `.env` に ID と版を入れ、ブラウザから「平日を土曜ダイヤにしてください。期間は 11/9 から当面の間」と送る。`apply_policy` の `tool_call` → 下書き → 承認 → 次の発言で [画面の操作] の行が入る
3. ツールを実行している間に送ろうとして 409 にならず画面で止まること、ストリームを手で切ってつなぎ直しても、ツールの呼び出しが1回だけ実行されること
4. 11/6 の後:対象 5 件ほどで調査を走らせ、workflow run の `research` のイベント、`save_research` の保存、`usage` の利用額(目安 $0.5 以下)を確かめる。`auto` のままなら、断られた Web のツールの呼び出しは調査役のスレッドにしか出ないので、`not_found`・`partial` の数と、run のスレッドを1つ `sessions.threads.events.list` で読んだ結果で、許可の設定が調査を妨げていないかを見る(妨げていれば §11 の 4)
5. GTFS を読み込み直して、`DELETE` で Console のセッションが消えること

## 9. 後で(11/6 のデプロイの作業に渡す)

- nginx:`/api/claude/session/stream` は `proxy_buffering off;`、`proxy_read_timeout 3600s;`(長いストリーム)。`proxy_set_header X-Real-IP $remote_addr;`
- uvicorn のワーカーは1つ(セッションの状態と回数の数え上げをメモリに持つため)。`--timeout-graceful-shutdown 3` を付ける(開いたストリームが閉じるのを待ち続けて、止まらなくなるため。11/3 に開発の自動の読み込み直しで起きた。開発の `main()` には付けた)。アクセスログは `--no-access-log`(IP の生の値を残さない)
- 閉じ損ねたセッション(ブラウザが落ちた、`pagehide` の DELETE が届かなかった)は、24 時間の掃除まで1日の利用額の予約(§4.11)を持ち続ける。$6/日では2つで新しいセッションが作れなくなる(11/3 のブラウザでの確かめで、サーバーが読み込み直しの途中で DELETE が届かず、2つ残った)。**決まった(11/3 の利用者の決定の 1。T15 で作った)**:最後の操作から 30 分ストリームがつながっていない行は、使った額だけを予約に数える(§4.10 の `last_stream_at`、§4.11)
- 最初のストリームを開くのに 15 秒ほどかかった(11/3 のブラウザでの確かめ。新しいセッションの最初の接続は Anthropic の側の準備を待つ)。**決まった(T15 で作った)**:送ってから最初のストリームがつながるまで、AI の欄に「AI を準備しています…(最初は 15 秒ほどかかります)」を出す。GTFS を読み込んだ時点でセッションを作る案は採らない(開いたままの画面が1日の利用額の予約を取るため)
- compose:`DISPATCHER_TRUST_PROXY=1`、`ANTHROPIC_API_KEY`、`DISPATCHER_AGENT_ID`・`DISPATCHER_AGENT_VERSION`・`DISPATCHER_ENVIRONMENT_ID`、`DISPATCHER_SESSION_SECRET` を環境変数で渡す。認証コードなしで公開する(11/3 の利用者の決定の 2)ので `DISPATCHER_PUBLIC=1` を渡し、`DISPATCHER_TOKEN` は空にする(認証コードを使うときだけ渡す)。`DISPATCHER_DEV` は付けない。SQLite(`DISPATCHER_DB`)はボリュームに置く
- 本番の API キーは、エージェントを作ったのと同じワークスペースのキーにする。Console で、そのワークスペースの月の利用額の上限を 200 ドルに付ける(デプロイの前に必ず。§4.11)
- `ant apply` は利用者の手元で行う(CI では行わない。`--yes` は利用者の承認なので)

## 10. 11/3 の決定

### 利用者の決定(Notion「決めておくべき事項」の「11/3 の決定」の 15。正)

1. アプリ内の Claude は Managed Agents に全面移行する。会話・6つのツール・調査を1つのセッションで行う
2. 調整役(会話と6つのツール)は `claude-sonnet-5-5`。施設・事業者ごとの Web 検索は `claude-haiku-5-5` の調査役。多数の対象はバックグラウンドの workflow run で並行に調べる
3. GTFS の6つのツールはブラウザで実行する(カスタムツール。サーバーが中継)。GTFS のファイルは送らない。調査の結果はサーバーの SQLite に出典 URL と確認日時つきで保存して使い回す
4. 組み込みのツールは Web 検索と Web の読み込みだけで、調査役だけに持たせる。bash・ファイル操作は切る
5. セッションは GTFS の読み込み直しで終え、最後の操作から 24 時間でサーバーが消す(アプリのコードが `sessions.delete` を呼んでよい)
6. 1セッションの料金の上限は 3 ドル。Web 検索の回数の上限は設定に無いので、この上限と調べる対象の数の上限で代える
7. Messages API の中継はブランチ `wip/messages-api` に残す(参考)。`tools.ts` は流用し、型の確かめを足す

### 指示役が決めたこと(この文書)

1. 調整役は組み込みのツールを持たない。調査役は `web_search`・`web_fetch` だけ(`auto`)。multiagent は名簿・workflow run とも調査役だけで、`inline_agents` は両方 `disabled`、`self` は入れない(§2.3・§2.4)
2. effort は調整役 `medium`、調査役 `low`(§2.2・§2.3)
3. workflow run は、調べていない対象が 4 件以上のときだけ。3 件以下は調査役に1件ずつ頼む(§5)
4. ツールの定義の正は `claude_tools.json`。調整役のファイルは写しで、server のテストで照らす(`ant apply` はファイルの中の `@` を置き換えないため。§3.3)
5. サーバーが実行するツールは `get_research_targets`・`get_research_results`・`save_research` の3つ。対象の一覧はサーバーが自分の参照データで作り直す(§3.2)
6. セッションは版を固定して作る。ID と版は環境変数で渡す(§2.6・§4.3)
7. 取っ手は HMAC の署名つきで、ヘッダーで送る。ページを読み込み直したら新しいセッション(§4.4・§6.5)
8. ブラウザとのストリームは1本。つなぐたびに履歴と重ね、`id` で重なりを除く。答えていないツールの呼び出しを送り直す(§4.5)
9. 呼び出しが待っている間の `user.message` はサーバーが止める。サーバーのツールと許可の確認には先に答え、ブラウザのツールが残っていれば 409(§4.7)
10. [画面の状態]・[画面の操作] の行は `user.message` の先頭の text のブロックに入れ、`system.message` は使わない(§6.2)
11. 回数制限は、セッションの作成と発言の数に加えて、全体の1日の利用額で抑える(§4.11)
12. 1回の発言につき、ブラウザのツールの呼び出しは 12 回まで(§4.7)
13. セッションを終えるときは、開いている workflow run を調整役に止めさせてから消す(§4.9)
14. 調査役に1件ずつ頼んだ子のスレッドは、終わったらサーバーが archive する(§4.8)
15. 調査の結果は、`demo` の行と期限の切れていない行を上書きしない(§3.2)
16. 新しいセッションの関門は、1日の利用額を予約の形で数える(§4.11。値は §11 の 2)
17. ブラウザはツールの結果を `id` ごとに残し、送り直された呼び出しには残した結果を送る(§6.3)
18. ツールの結果と `user.interrupt` を送るときは、1回の `events.send` に結果を先に並べる(§4.7・§4.9)

## 11. 利用者に決めてもらう点

**利用者の決定(11/3)**:1〜7 はすべて推奨のとおり。2 は予約の形にし、審査の日だけ1日の額を環境変数で上げる((a))。Console でワークスペースの月の利用額の上限を 200 ドルに付ける(利用者が自分で操作する。11/6 のデプロイの前)。4 は `always_allow`(`agents/researcher.md` を直した)。

1. **実行環境の通信を `unrestricted` にしてよいか**(推奨:`unrestricted`)。`limited` では、許すホストを前もって並べないと Web 検索も読み込みも何も返さず、調べる施設・事業者のサイトは並べられない。`unrestricted` はコンテナからの外向きの通信をすべて許すが、どのエージェントも bash・ファイル操作を持たないので、コンテナから外へ出る手段は無い。代わりの案は `limited` で、自治体・学校・病院の既知のドメインだけを並べる(調べられる範囲が狭くなる)
2. **回数制限と1日の利用額の値**(推奨:§4.11 の表。全体の1日の利用額 $6、月 180 ドル)。あわせて、Console でワークスペースの月の利用額の上限を 200 ドルに付けてよいか(推奨:付ける。11/6 のデプロイの前に)
   - 1日の利用額は予約の形で数える(§4.11)。台帳だけでは workflow run の間に数分遅れ、最悪は 20 回 × 3 ドル = 60 ドル/日になるため。予約の形では、$6/日・1セッション $3 だと、同時に開けるセッションは2つまで(開いたままの画面も1つ分を取る)
   - 審査の期間に足りないときの案:(a) 審査の日だけ1日の額を上げる(例 $12 で同時に4つ。月の上限は Console の 200 ドルで守る) (b) 予約をやめ、台帳と Console の月の上限だけにする。1セッションの予算を下げる案は、利用者の決定(§10 の 6、3 ドル)と食い違うので挙げない。推奨は (a)
3. **調査の対象の数の上限と、結果を使い回す期間**(推奨:1回の調査で 30 件、7 日)。30 件で調査の料金は約 $1.2
4. **調査役の Web のツールの許可**(最初の `ant apply` の前に決める。今のファイルは `auto`)
   - `auto`:サーバーが判断できずに止めた呼び出しには、サーバーが `deny` を返す。multiagent では、子のスレッドの呼び出しを後押しできるのは主のスレッドの `user.message` だけで、調整役の頼みは後押しにならない。Anthropic が断った呼び出しは主の流れに届かないので、断られた数をサーバーは数えられない
   - `always_allow`:止まることも断られることもない。読むだけのツールで、調査役の文脈にあるのは対象の名前・市町村・日付と読んだページだけなので、外へ漏れて困るものは無い
   - 後で変えると `ant apply` が要り、調整役の版も上がりうる(§2.4)。`DISPATCHER_AGENT_VERSION` を直す
   - 推奨:`always_allow`。決まったら `agents/researcher.md` の `default_config` の `permission_policy` を変える
5. **画面に利用額を出すか**(推奨:出す。「この会話の AI の利用額 約 $0.42 / 上限 $3」。定価で数えた額で、請求額とは違うことがある)
6. **「止める」で調査も止めるか**(推奨:止める。`interrupt` は全部のスレッドに効き、workflow run は一時停止する。続けるときは「調査を続けて」と送る)
7. **ページを読み込み直したときに、会話を続けるか**(推奨:続けない。新しいセッションにする。GTFS と編集の状態がブラウザに残るかと合わせて決める必要があり、11/7 までに作る理由が小さい)

## 12. 資料で確かめられなかった点

- 名簿の調査役の版が、調整役の版で固定されるか:`ant apply` がパスの名簿を、文字列の ID と `{type: agent, id, version}` のどちらに書き換えるかは資料に無い(§2.4。§8 の本物の確かめの 1 で見る)
- 名簿の相対パスの書き方:資料の例は1つのディレクトリに1つのエージェントの形(`../researcher/agent.md`)。`agents/` の直下に2つ並べる形での `./researcher.md` は、「名前を書いたファイルからの相対パス」の決まりから書いた。`ant apply --dry-run` で確かめる
- `claude-lock.json` にエージェントの版が入るか(ID が入ることは資料にある)
- 組み込みのツールを1つも持たない調整役が、workflow run を始められるか(委任のツールは自動で付くと資料にあるが、組み込みのツールが無い例は無い)
- カスタムツールの `input_schema` で `anyOf`・`enum`・`additionalProperties` を受け付けるか(資料の例は `type`・`properties`・`required` だけ)
- workflow run が開いている(セッションが `running` のまま)ときに送った `user.message` を、調整役が run の終わりを待たずに処理するか
- 主のスレッドがカスタムツールの結果を待っている(`requires_action`)ときの `user.interrupt` が、その呼び出しを閉じるか(資料にあるのは子のスレッドの場合だけ。§6.3 では先に結果を返す)
- 主のスレッドのイベントに `session_thread_id` が付くか(資料にあるのは、子のスレッドから主の流れに届くイベントに付くことだけ。§4.8 では `sessions.threads.list` で主のスレッドの ID を確かめる)
- `auto` で断られた調査役の呼び出しは主の流れに届かない(資料にある)ので、断られた数をサーバーは数えられない
- 子のスレッドの `session.thread_status_idle` に、スレッドを見分ける `session_thread_id` が付くか(§4.8 では、それを `threads.retrieve` に渡して `workflow_run_id` を読む形にした)。archive した調査役のスレッドへ、調整役が後から頼もうとしたときの扱い
- 終えるときに run を止めるよう頼む `user.message` で、60 秒のうちに run が終わるか(§4.9。終わらなければ `delete` が断られ、掃除でやり直す)
- ツールの結果と `user.interrupt` を1回の `events.send` に入れたとき、並びのとおりに処理され、その間にモデルが動かないか(§4.7・§4.9。`interrupt` は列の先に割り込むとだけ資料にある)
- `session.usage` がいつ届くか(資料にあるのは予算に達したときの直前だけ。§4.10 では idle のたびに `retrieve` で読む)
- `web_search` の `user_location` で `country: JP` を受け付けるか(検索の提供元によっては断られると資料にある)
- 拒否(`refusal`)のときの扱いと、代わりのモデルが Managed Agents にあるか(Haiku 5.5 には Messages API のサーバー側の代わりのモデルが無いと資料にある)
- 非同期の SDK での関数名と引数(`event_deltas`、`events.list` のページ送り、`types[]` での絞り込み)。入れた版の SDK で確かめる
- 料金の目安(§4.11)は、トークン数を見積もった粗い値。本物の確かめ(§8 の 4)で `usage` と照らす
