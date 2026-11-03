# Dispatcher

運転士の急な欠員で路線バスを減便するときに、減便ダイヤの影響を確かめ、必要な便を平日に戻し、GTFS-JP を出力する Web アプリです。

- 公開先:https://dispatcher.turutaru.com (認証コードは要りません)
- ハッカソン「Built with Claude: Japan 2026」の作品です。期間中(2026年11月2日〜)に新しく作りました
- ソースコードは MIT License です

## 誰の、どんな課題か

使うのは、運行管理者と GTFS 担当者です。運転士が急に足りなくなると、平日の便の一部を休止して、土曜ダイヤや日祝ダイヤで走らせることがあります。このとき、運行管理者は、減便でバスに乗れなくなる場所と時間帯を確かめ、通勤・通学・通院に必要な便を残す判断をします。GTFS 担当者は、その減便を期間限定のダイヤとして GTFS-JP に反映し、検証して出力します。

2つの仕事は、同じ減便の内容を前提にしています。Dispatcher は、減便の方針の適用、到達圏による影響の確認、Claude の提案をもとに便を平日に戻す操作、GTFS-JP の出力と検証を、1つの画面にまとめました。

## 画面の流れ

画面は1つで、左に手順、右に地図があります。手順は上のステッパーで切り替え、順に進めます。

1. **読み込み**:GTFS(ZIP)を選ぶか、「サンプルを読み込む」で道北バスの GTFS を開きます。読み込み・編集・到達圏の計算・検証はすべてブラウザの中で行い、GTFS はサーバーに送りません
2. **前提情報**:停留所の分布の外周に 2km の余白を足した範囲で、周辺の事業者(バス停留所 P11)と学校・病院(P29・P04)を洗い出し、始業・終業、外来の受付時間、減便のお知らせなどを AI が Web で調べます。結果には出典 URL と確認日時が付きます。保存済みの結果(デモ)も選べます
3. **減便の方針**:「平日を土曜ダイヤに」または「平日を日祝ダイヤに」を選び、期間をカレンダーで決めます。入れ替わる便を確かめてから承認します
4. **影響(到達圏)**:時間帯別に、その場所から徒歩で乗れるバスがあるかを地図で見ます。減便前後の差と、一日を通して到達できなくなる区画・発車がなくなる停留所・便がなくなる系統の警告が出ます
5. **平日便を戻す**:保護したい通勤・通学・通院の便を、理由つきで平日側に戻します。候補は系統ごとにまとめ、判断材料(その系統の始発・終発、その時間帯の唯一の便、徒歩圏の学校・病院など)のある便から出します。「AI に候補を聞く」と、AI が理由を添えた下書きを出します
6. **出力**:タブで切り替えます
   - **GTFS**:減便を反映した GTFS-JP を ZIP で出力します。出力の前に検証し、誤りがあれば出力できません。元のダイヤに戻す版(便は元のまま、有効期間を元のダイヤに戻す日〜入力の末日にした版)も作れます
   - **変更指示書**:承認した内容を1枚にまとめ、画面から印刷(PDF)できます
   - **周知文**:停留所ごとの掲示と、告知文の案
   - **停留所の一覧**:停留所ごとの本数・始発・最終便・最大間隔の変化

減便の方針の適用と便を平日に戻す操作は、「元に戻す」「すべて戻す」で取り消せます。元に戻せるのは、この画面に編集の履歴と、読み込んだ元の GTFS がある間だけです。読み込み直すと履歴は消えます。出力した GTFS だけからは元に戻せないので、元の ZIP は保存しておいてください。

左下の「AI に相談」では、減便の方針の指示や質問を文章で送れます。ほとんどの操作はボタンで行えるので、AI を使えないときも、読み込みから出力までひと通り動きます。AI が要るのは、チャットと、前提情報の新しい調査です(保存済みの結果は AI なしで使えます)。

## Claude の使い方

### アプリの中

- **Managed Agents の1つのセッション**で、会話・GTFS のツール・前提情報の調査を行います。エージェントの設定は `agents/`、実行環境は `environments/` にあり、`ant apply` で適用します
  - 調整役(`agents/coordinator.md`):Sonnet 5.5(`claude-sonnet-5-5`)。会話、6つのツール、調査の割り振りを受け持ちます
  - 調査役(`agents/researcher.md`):Haiku 5.5(`claude-haiku-5-5`)。事業者・施設を1つずつ、Web 検索と Web の読み込みで調べます。多数の対象は、調整役が並行に調べさせます
- **6つのツール**:減便の方針の適用(`apply_policy`)、便を平日に戻す操作(`add_back_trips`)、元に戻す(`undo_edit`)、影響の要約(`summarize_impact`)、便の検索(`search_trips`)、検証(`run_validation`)。ツールはブラウザで実行し、結果をサーバー経由で Claude に返します。定義の正は `server/src/dispatcher_server/claude_tools.json` です
- **数字はコードが出し、Claude は解釈と説明を受け持ちます**。Claude は GTFS を直接書き換えません。編集の操作を下書きとして出し、画面で差分を確かめてから承認すると、ブラウザのコードが適用します。書き換えるたびに検証します
- GTFS のファイルは、Claude にもサーバーにも送りません。Claude に送るのは、利用者の文とツールの結果(便の要約や件数)だけで、サーバーのログに残すのは日時・回数・エラーだけです
- 調査の結果は、公開情報だけを SQLite に一定時間保存して使い回します
- 認証コードなしで公開するため、費用は次の上限で守ります。IP アドレスごとの回数制限、1セッション 3 ドル、全体で1日 6 ドル、Console のワークスペースの月の上限(200 ドル)

### 開発での Claude Code

- **フック**(`.claude/settings.json`):ファイルを編集すると `.claude/hooks/post-edit.sh` が走り、web は `vitest related`、server と data は pytest を実行します
- **Skill** `gtfs-jp-check`(`.claude/skills/`):出力した GTFS が GTFS-JP 第4.0版の主な規則に沿っているかを確かめる手順
- **サブエージェント** `gtfs-reviewer`(`.claude/agents/`):GTFS の編集・出力・到達圏のコードを変えたあとに、別の目で確かめる

## 手元で動かす

必要なもの:Node.js 22、pnpm 10(`corepack enable && corepack install -g pnpm@10`)、uv(Python 3.13)

### 1. 設定ファイル

```bash
cp .env.example .env
```

`.env` は Git に入れません。各項目の意味は `.env.example` に書いてあります。AI を使うときだけ、次の項目が要ります。

| 項目 | 内容 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic の API キー。無ければ AI は使えません |
| `DISPATCHER_AGENT_ID`・`DISPATCHER_AGENT_VERSION`・`DISPATCHER_ENVIRONMENT_ID` | `ant apply` で作った調整役と実行環境の ID と版 |
| `DISPATCHER_SESSION_SECRET` | セッションの取っ手に署名する秘密(32 バイト以上の乱数)。本番では必須です |
| `DISPATCHER_DEV` | 手元の開発では `1`(行頭の `#` を外す)。認証コードと署名の秘密が無くても AI を使えます |

エージェントと実行環境は、自分のワークスペースに作ります。

```bash
ant apply agents/coordinator.md agents/researcher.md environments/dispatcher.yaml
```

`claude-lock.json` から ID(`.resources["./agents/coordinator.md"].id` など)を、`ant apply` の結果から版を、`.env` に写します。リポジトリの `claude-lock.json` は作者のワークスペースの記録です。別のワークスペースで適用したときの動作は確かめていません。

### 2. 参照データ

地図と到達圏には、1次メッシュごとの参照データ(人口、DID、鉄道駅、学校・医療機関・バス停留所、祝日)が要ります。元データを `data/raw/` に置いてから(入手元と置き方は `data/raw/README.md`)、加工します。

```bash
cd data
uv run dispatcher-data        # data/out/ref/ に1次メッシュごとの JSON を書く
uv run dispatcher-holidays    # data/out/ref/holidays.json を書く
```

### 3. サンプル GTFS

「サンプルを読み込む」を使うには、北海道オープンデータプラットフォームの利用フォームに記入してから、道北バスの GTFS を `data/raw/gtfs/dohoku_bus_減便前.zip` に置いてください。置かなくても、手元の GTFS を選んで読み込めます。

### 4. 起動

VS Code では、コマンドパレットの「タスク: タスクの実行」から「開発サーバーを起動」を選ぶと、画面とサーバーが同時に起動します(⇧⌘B でも起動できます)。ターミナルで動かす場合は次のとおりです。

```bash
# 画面(起動時に Vite が表示する URL で開く)
cd web
pnpm install
pnpm dev

# サーバー(別のターミナルで。http://127.0.0.1:8000/api/health)
cd server
uv run dispatcher-server
```

デモ用に保存した調査結果(道北バスの周辺 30 件、`data/demo/research_dohoku.json`)を、サーバーの SQLite に取り込めます。

```bash
cd server
uv run dispatcher-research-seed ../data/demo/research_dohoku.json
```

### テスト

```bash
cd web && pnpm test && pnpm typecheck && pnpm lint && pnpm build
cd server && uv run pytest -q
cd data && uv run pytest -q
```

サンプル GTFS や参照データを使うテストは、ファイルが無ければスキップします。

## Docker で動かす

公開先と同じ構成(nginx が画面を配り、`/api` を FastAPI に中継)を、手元で試せます。開発では使いません。

```bash
# 手順1で作った .env をそのまま使う(cp .env.example .env で作り直さない。API キーが消える)
# AI まで試すなら、.env に DISPATCHER_PUBLIC=1 と DISPATCHER_SESSION_SECRET(32 バイト以上の乱数)の2つを書く。
# compose は DISPATCHER_DEV をコンテナに渡さないので、DISPATCHER_DEV=1 だけでは AI は使えない
DISPATCHER_PORT=8080 docker compose up -d --build
```

http://127.0.0.1:8080 で開きます。`DISPATCHER_PORT` の既定は 8080 で、127.0.0.1 にだけ公開します。

- 画面の `web` と、API の `server` の2つのコンテナです。HTTPS は、VPS の nginx が終端します
- API キーなどの秘密はイメージに入れません。`.env` か環境変数で渡します
- サンプル GTFS は `data/raw/gtfs/`、参照データは `data/out/ref/` を、読み取り専用でマウントします。場所は `DISPATCHER_SAMPLE_DIR`・`DISPATCHER_REF_HOST_DIR` で変えられます
- SQLite は名前つきのボリューム `dispatcher-db` に置くので、コンテナを作り直しても残ります
- 認証コードなしで公開するときは、`DISPATCHER_PUBLIC=1` を渡します(dispatcher.turutaru.com はこの設定です)。認証コードを求めたいときは、`DISPATCHER_TOKEN` を渡します
- VPS への公開の手順(外側の nginx、SSE、X-Real-IP、Console の月の上限、デモの調査結果の取り込みなど)は [docs/deploy.md](docs/deploy.md) にあります。この節だけでは足りません

## 平日に戻した便の trip_id の注意

平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の土曜(日祝)ダイヤの運用とは対応しません。trip_id から運用を読む仕組みを使っている場合は、確かめてください。同じ画面の出力の手順にも、同じ注意が出ます。

## リポジトリの構成

| ディレクトリ | 中身 |
| --- | --- |
| `web/` | 画面(React、Vite、TypeScript)。GTFS の処理、到達圏の計算、検証もここで行う |
| `server/` | Claude の中継、利用制限、調査結果の保存、参照データとサンプル GTFS の配信(Python、FastAPI) |
| `data/` | 参照データ(北海道)の加工スクリプト(Python)。デモ用の調査結果は `data/demo/` |
| `agents/`・`environments/` | アプリ内の Claude のエージェントと実行環境の設定(`ant apply` で適用) |
| `deploy/`・`compose.yaml` | nginx の設定と、本番の構成 |
| `docs/` | 設計の取り決めとタスクの記録。VPS への公開の手順は `docs/deploy.md` |

## データの出典

画面の「このサイトについて」と同じ内容です。

| データ | 出典 | 利用条件 |
| --- | --- | --- |
| GTFS(道北バスなど) | 北海道オープンデータプラットフォーム | CC BY 4.0 |
| 人口(令和2年国勢調査 地域メッシュ統計、250m) | e-Stat(政府統計の総合窓口)を加工して作成 | 政府標準利用規約 |
| 人口集中地区(A16、2020年) | 国土数値情報(国土交通省)を加工して作成 | 国土数値情報利用約款(商用可) |
| 鉄道駅(N02、2025年度) | 国土数値情報(国土交通省)を加工して作成 | CC BY 4.0 |
| バス停留所(P11、2022年度) | 国土数値情報(国土交通省)を加工して作成 | CC BY 4.0 |
| 学校(P29、2023年度) | 国土数値情報(国土交通省)を加工して作成 | CC BY 4.0 |
| 医療機関(P04、2020年度) | 国土数値情報(国土交通省)を加工して作成 | CC BY 4.0 |
| 国民の祝日(内閣府) | 内閣府「国民の祝日について」の祝日一覧(syukujitsu.csv)を加工して作成 | 公共データ利用規約(第1.0版) |
| 背景地図 | OpenStreetMap Japan のベクトルタイル | © OpenStreetMap Contributors |

画面では、バス停留所・学校・医療機関の行は前提情報の手順で施設を読み込んだときに、祝日の行は祝日の一覧を読み込めたときに出します。

出力する GTFS(サンプルの道北バスから作ったもの)の出典:元データ:道北バス GTFS(北海道オープンデータプラットフォーム)。ライセンス:CC BY 4.0(https://creativecommons.org/licenses/by/4.0/deed.ja)。Dispatcher で減便を反映して加工しています(加工日時は出力した日時)。出力も CC BY 4.0 のままで、ZIP に同じ内容の `ATTRIBUTION.md` を入れます。利用者が読み込んだ GTFS から作ったときは、`ATTRIBUTION.md` には加工した旨と加工日時だけを書きます。元の GTFS の出典と利用条件は、元の提供者の表示に従って示してください。

## ご意見・不具合

GitHub のリポジトリの Issues にお寄せください。

## ライセンス

MIT License(`LICENSE`)。データの利用条件は、上の「データの出典」のとおりです。
