# VPS へのデプロイ手順(dispatcher.turutaru.com)

既存の VPS(Docker + nginx)に Dispatcher を出す手順です。利用者が手順書を見て行います。指示役と担当のモデルは VPS に触れません。

各手順に、コマンドの例と「確かめる点」を書いています。VPS の具体的なパスやユーザー名など、利用者の環境で決まる点は「利用者の環境に合わせる」と書きました。例では、置き場所を `/srv/dispatcher`、ユーザーを `deploy` としています。

## 全体の形

```
利用者のブラウザ
  ↓ HTTPS(443)
VPS の既存の nginx(外側)           証明書を持つ。X-Real-IP を付けて中継する
  ↓ HTTP(127.0.0.1:8080)
Docker: web(nginx)                 ビルドした画面を配り、/api を server に中継する
  ↓ HTTP(Docker の中のネットワーク)
Docker: server(FastAPI)            Claude の中継、回数制限、調査結果の使い回し、参照データとサンプルの配信
  ↓ HTTPS
Anthropic API(Managed Agents)
```

- `compose.yaml` は web を `127.0.0.1` にだけ公開します。外から直接つながるのは外側の nginx だけです
- GTFS はサーバーに送られません。サーバーが持つのは、SQLite(調査結果、セッション、1日の利用額)だけです
- 認証コードなしで公開します(2026-11-03 の利用者の決定)。費用は、IP ごとの回数、1セッション $3、1日 $6、Console のワークスペースの月の上限 200 ドルで守ります

## 手順の一覧

1. 前提を確かめる
2. Console でワークスペースの月の上限を付ける
3. リポジトリを取得する
4. 置くファイル(サンプル GTFS と参照データ)
5. 本番の環境変数(`.env`)
6. 起動する
7. デモの調査結果を取り込む
8. 外側の nginx と HTTPS
9. 確かめる
10. 更新と戻し方
11. ログの見方と止め方

---

## 1. 前提を確かめる

VPS で次を確かめます。

```bash
docker --version
docker compose version        # Compose v2(docker compose)であること
nginx -v
df -h /var/lib/docker         # 空きの目安:イメージとビルドで 2GB 以上
free -m                       # 画面のビルド(Vite)に 1GB 前後のメモリがいる。足りなければスワップを足す
sudo systemctl is-enabled docker   # enabled なら VPS の再起動後に自動で戻る(restart: unless-stopped)
```

DNS は、`dispatcher.turutaru.com` の A レコード(IPv6 を使うなら AAAA も)を、この VPS の IP アドレスに向けます。DNS を管理する場所(利用者の環境に合わせる)で設定します。

```bash
dig +short dispatcher.turutaru.com     # VPS の IP アドレスが返ること
```

確かめる点:

- Docker と Compose v2 が動く
- `dispatcher.turutaru.com` が VPS の IP アドレスを返す
- 80 番と 443 番が外から届く(VPS のファイアウォールと、事業者のセキュリティグループ。利用者の環境に合わせる)
- **DNS は「DNS のみ」(CDN を通さない)にする。** Cloudflare のプロキシ(オレンジの雲)などを通すと、外側の nginx から見える接続元が CDN の IP アドレスになり、サーバーの IP ごとの回数制限がすべての利用者で共有されます。CDN を通すときは、外側の nginx に `real_ip_header CF-Connecting-IP;` と CDN の IP の範囲(`set_real_ip_from`)を足してください

サンプル GTFS(道北バス)は、HTTP で誰にでも配ります(`/api/sample-gtfs/download`)。北海道オープンデータプラットフォームの利用フォームで、この配り方が許される条件かどうかは、利用者が確かめてください(CC BY 4.0 なので出典を付ければ再配布できます。画面と README に出典を出しています)。

## 2. Console でワークスペースの月の上限を付ける(デプロイの前に必ず)

認証コードなしで公開するので、費用の最後の歯止めは Anthropic Console のワークスペースの上限です。

1. Anthropic Console を開く
2. エージェントを `ant apply` で作ったワークスペースを開く。ID は `claude-lock.json` の `origin.workspace_id`
3. そのワークスペースの月の利用額の上限を **200 ドル**に設定する。画面の名称と場所(Workspaces や Limits など)は Console の表示に合わせる
4. 本番の API キーを、**同じワークスペースで**作る。別のワークスペースのキーでは、エージェントと実行環境が見つかりません

```bash
# 手元(Mac)で、ワークスペースの ID を確かめる
jq -r '.origin.workspace_id' claude-lock.json
```

確かめる点:

- 月の上限が 200 ドルになっている(Console の画面で見る)
- 本番の API キーが、その上限を付けたワークスペースのキーである
- 上限が Managed Agents の利用(セッションの実行時間と Web 検索)も数えるかは、Console の説明で確かめる。数えない場合は、下の `DISPATCHER_DAILY_COST_CENTS` が主な歯止めになる

## 3. リポジトリを取得する

リポジトリ(turu64/Dispatcher)は、提出の直前まで非公開です。次のどれかで VPS に取得します。

### 3-A. デプロイキーを使う(推奨。VPS にだけ読み取りの権限を渡す)

```bash
# VPS で
ssh-keygen -t ed25519 -f ~/.ssh/dispatcher_deploy -C "dispatcher-vps" -N ""
cat ~/.ssh/dispatcher_deploy.pub     # 公開鍵を表示する
```

GitHub の turu64/Dispatcher を開き、Settings → Deploy keys → Add deploy key で、この公開鍵を貼る。「Allow write access」は付けません。

```bash
# VPS で。~/.ssh/config に追記する
cat >> ~/.ssh/config <<'EOF'
Host github-dispatcher
  HostName github.com
  User git
  IdentityFile ~/.ssh/dispatcher_deploy
  IdentitiesOnly yes
EOF

sudo mkdir -p /srv/dispatcher && sudo chown "$USER": /srv/dispatcher     # 置き場所は利用者の環境に合わせる
git clone git@github-dispatcher:turu64/Dispatcher.git /srv/dispatcher
cd /srv/dispatcher
git checkout develop        # デプロイする枝を決める(下の注)
```

### 3-B. 手元から送る(GitHub に VPS を結びつけたくないとき)

```bash
# 手元(Mac)で、コミット済みの内容だけを送る
cd ~/Documents/GitHub/Dispatcher
git archive --format=tar.gz --prefix=Dispatcher/ develop | ssh deploy@<VPS> 'mkdir -p /srv && tar xzf - -C /srv && mv /srv/Dispatcher /srv/dispatcher'
```

この方法では、VPS に `.git` が無く、更新と戻し方が手作業になります。3-A を勧めます。

### 3-C. リポジトリを公開した後

```bash
git clone https://github.com/turu64/Dispatcher.git /srv/dispatcher
```

### デプロイする枝

CLAUDE.md の取り決めでは、作業は `develop` で行い、`main` は利用者が指示したときだけ `develop` から取り込みます。どちらを VPS に出すかは利用者が決めます。決めたら、出したコミットを控えておきます。

```bash
git -C /srv/dispatcher rev-parse --short HEAD     # 出したコミット。戻すときに使う(手順 10)
```

確かめる点:

- `compose.yaml`、`web/Dockerfile`、`server/Dockerfile`、`deploy/nginx.conf`、`.env.example` が VPS にある
- `git status` がきれい(VPS の上では書き換えない)

## 4. 置くファイル

次の2つはコミットされていないので、利用者が VPS に置きます。どちらも、リポジトリの中の場所に置くと、`compose.yaml` の既定の値のまま使えます。別の場所に置くときは、`.env` の `DISPATCHER_SAMPLE_DIR` と `DISPATCHER_REF_HOST_DIR` で渡します(利用者の環境に合わせる)。

| 置くもの | VPS の場所(既定) | コンテナの中 | 元(手元の Mac) |
| --- | --- | --- | --- |
| 道北バスの GTFS(9/17 作成の版) | `/srv/dispatcher/data/raw/gtfs/dohoku_bus_減便前.zip` | `/data/sample/dohoku_bus_減便前.zip` | `data/raw/gtfs/dohoku_bus_減便前.zip` |
| 参照データ(1次メッシュごとの JSON、`facilities/`、`holidays.json`) | `/srv/dispatcher/data/out/ref/` | `/data/ref/` | `data/out/ref/`(約 2.6MB) |

`減便後.zip`(比較用)は配る必要がありません。置かないでください(`data/raw/gtfs` をまるごと読み取り専用でマウントするので、置くと中に見えます)。

```bash
# 手元(Mac)で
cd ~/Documents/GitHub/Dispatcher
ssh deploy@<VPS> 'mkdir -p /srv/dispatcher/data/raw/gtfs /srv/dispatcher/data/out/ref'
rsync -av "data/raw/gtfs/dohoku_bus_減便前.zip" deploy@<VPS>:/srv/dispatcher/data/raw/gtfs/
rsync -av --delete data/out/ref/ deploy@<VPS>:/srv/dispatcher/data/out/ref/
```

参照データを最新にしたいときは、手元で先に作り直します(`cd data && uv run dispatcher-data && uv run dispatcher-holidays`。`data/README.md`)。

### 読める権限(uid 10001)

server のコンテナは、一般利用者 `dispatcher`(uid 10001)で動きます。マウントしたファイルは、この利用者が読める必要があります。ほかの利用者に読み取りの権限(ファイルは 644、ディレクトリは 755)を付けます。

```bash
# VPS で
cd /srv/dispatcher
chmod -R a+rX data/raw/gtfs data/out/ref
ls -ln data/raw/gtfs data/out/ref | head      # ファイルが -rw-r--r--、ディレクトリが drwxr-xr-x
namei -m /srv/dispatcher/data/raw/gtfs/dohoku_bus_減便前.zip     # 上の階層(/srv など)も x(通り抜け)が付いていること
```

SELinux が有効な VPS(Rocky Linux など)では、マウントに `:z` が要ることがあります。そのときは `compose.yaml` を直さず、利用者の環境に合わせて対応を決めてください。

ファイル名は日本語(減便前)です。起動した後に、コンテナの中から読めることを確かめます(手順 9)。

確かめる点:

- 2つの場所にファイルがある。`data/out/ref` に `6542.json` など、`facilities/`、`holidays.json` がある
- 他の利用者に読み取りの権限が付いている

## 5. 本番の環境変数(`.env`)

リポジトリ直下に `.env` を作ります。`compose.yaml` が自動で読み、コンテナに渡します。`.env` はコミットされず、イメージにも入りません(`.dockerignore`)。

```bash
cd /srv/dispatcher
cp .env.example .env
chmod 600 .env
${EDITOR:-nano} .env
```

決めてほしい値は次のとおりです。

| 変数 | 本番の値 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 手順 2 のワークスペースで作った API キー |
| `DISPATCHER_PUBLIC` | `1`(認証コードなしで公開する) |
| `DISPATCHER_TOKEN` | 空のまま(認証コードを使うときだけ設定) |
| `DISPATCHER_AGENT_ID` | `claude-lock.json` の `.resources["./agents/coordinator.md"].id` |
| `DISPATCHER_AGENT_VERSION` | `claude-lock.json` の同じ項目の `version`(11/5 の時点で `3`。ツールの定義の変更(11/6 の A10)を `ant apply` したら `4`。手順 10 の「エージェントを更新したとき」) |
| `DISPATCHER_ENVIRONMENT_ID` | `claude-lock.json` の `.resources["./environments/dispatcher.yaml"].id` |
| `DISPATCHER_SESSION_SECRET` | 32 バイト以上の乱数(下のコマンド) |
| `ANTHROPIC_WORKSPACE_ID` | 空のまま(ワークスペース単位のキーでは要りません) |
| `DISPATCHER_PORT` | `8080`(外側の nginx が中継する先。VPS の別のアプリが 8080 を使っているなら変える) |
| `DISPATCHER_SESSION_BUDGET_CENTS` | `300`(1セッション $3) |
| `DISPATCHER_DAILY_COST_CENTS` | `600`(全体の1日 $6。審査の日だけ `1200` などに上げる) |
| `DISPATCHER_SESSIONS_PER_IP_HOUR` / `_DAY` | `3` / `10` |
| `DISPATCHER_MESSAGES_PER_IP_HOUR` | `40` |
| `DISPATCHER_SESSIONS_PER_DAY` | `20` |
| `DISPATCHER_RESEARCH_MAX_TARGETS` | `30` |
| `DISPATCHER_RESEARCH_CACHE_DAYS` | `7` |
| `TYPESAFE_AI_VERCEL_KEY` | Vercel AI Gateway のキー(TypeSafe AI Jev を使うとき。空なら service のグループ分けは規則だけで動く) |
| `DISPATCHER_JEV_PER_IP_HOUR` / `_DAY` | `6` / `20`(GTFS の読み込み1回が1要求。`0` にすると全員が断られる) |
| `DISPATCHER_JEV_TARGETS_PER_DAY` | `2000`(全体の1日に Jev に問う service の数) |
| `DISPATCHER_JEV_COST_CENTS_PER_DAY` | `100`(全体の1日の Jev の額。$1。送る前に見込んだ額を数え、応答の額で直す。並行の数の分だけ超えうる) |

`TYPESAFE_AI_VERCEL_KEY` を書くと、利用者のデータの送り先が Anthropic のほかに1つ増えます(画面の運営情報のページ `#/about` と README にも書いてあります)。

- 送り先:TypeSafe AI Jev(TypeSafe AI)。Vercel AI Gateway(`ai-gateway.vercel.sh`)を経由します。キーは Vercel にだけ送ります
- 送る時:GTFS を読み込んだあと、ブラウザが自動で1回送ります。service_id の分け方が単純な GTFS(道北バスなど)では送りません。利用者は、手順「読み込み」のファイルを選ぶ欄の上のスイッチで止められ、送っている間も中断でき、得た答えを捨てられます
- 送る中身:service ごとの集計(service_id、運行日の数と走る日の割合、便数、系統名と系統ごとの便数、行き先、始発と終着の時刻、運行日が 10 日以下の service の日付、事業者名、有効期間)。GTFS のファイル・停留所の位置・時刻表そのものは送りません
- TypeSafe AI に限って送ります。中継は Vercel に転送先を TypeSafe AI だけに限る指定(`providerOptions.gateway.only`)を送り、ほかの会社(指定なしの試しの応答では DigitalOcean が予備にあった)には回させません。TypeSafe AI が答えないときは、確かめが失敗になります(2026-11-04 に確かめた。`docs/design-service-groups.md` §6.2-1)。データの保持は Vercel と TypeSafe AI の規約によります

次の変数は書きません。

- `DISPATCHER_DEV`:開発用の緩みです。`compose.yaml` はこの変数をコンテナに渡さないので、`.env` に書いても効きませんが、書かないでください
- `DISPATCHER_TRUST_PROXY`:`compose.yaml` が `1` に固定しています。`.env` では要りません
- `DISPATCHER_DB`・`DISPATCHER_SAMPLE_GTFS`・`DISPATCHER_REF_DIR`:`compose.yaml` がボリュームの中の場所を渡しています
- `DISPATCHER_JEV_URL`・`DISPATCHER_JEV_MODEL`:既定(`https://ai-gateway.vercel.sh/v4/ai/evaluation-model`・`typesafe-ai/jev`)のままにします。`DISPATCHER_JEV_URL` に `https` の `ai-gateway.vercel.sh` 以外を書くと、キーを送らないよう Jev は使えない扱いになります。`DISPATCHER_JEV_MODEL` が `typesafe-ai/` で始まらない・形が違うときは、既定のモデルを使います(同じキーで別のモデルを呼ばないため)

値の取り出し方です。

```bash
cd /srv/dispatcher

# claude-lock.json から ID と版を表示する(手元の Mac で確かめて、VPS の .env に写してもよい)
jq -r '.resources["./agents/coordinator.md"].id'          claude-lock.json
jq -r '.resources["./agents/coordinator.md"].version'     claude-lock.json
jq -r '.resources["./environments/dispatcher.yaml"].id'   claude-lock.json

# 取っ手の署名の秘密を作って .env の行に書く(画面に表示しない)。.env.example に空の行があるので、追記ではなく置き換える
sed -i "s|^DISPATCHER_SESSION_SECRET=.*|DISPATCHER_SESSION_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')|" .env
```

API キー(`ANTHROPIC_API_KEY`・`TYPESAFE_AI_VERCEL_KEY`)は、シェルの履歴に残らないよう、エディタで `.env` に直接書いてください。

確かめる点:

- `.env` の `DISPATCHER_AGENT_VERSION` が `claude-lock.json` の調整役の `version` と同じ
- `DISPATCHER_SESSION_SECRET` の行が1つで、値が空でない(`grep -c '^DISPATCHER_SESSION_SECRET=.' .env` が 1。値は画面に出さない)
- `.env` の権限が 600、`git status` に `.env` が出ない
- `DISPATCHER_SESSION_SECRET` を変えると、開いている会話の取っ手がすべて無効になる。運用中は変えない

## 6. 起動する

```bash
cd /srv/dispatcher
docker compose up -d --build
docker compose ps
```

最初のビルドは、画面の依存パッケージとイメージの取得で数分かかります。

確かめる点:

- `docker compose ps` で server が `healthy`、web が `running`(server が healthy になってから web が起動する)
- `curl -s http://127.0.0.1:8080/api/health` が `{"status":"ok"}`(`DISPATCHER_PORT` を変えたときはその番号で)
- `docker compose logs server | tail` にエラーが出ていない
- `ss -ltn | grep 8080` で、`127.0.0.1:8080` だけが開いている(`0.0.0.0` ではない)

## 7. デモの調査結果を取り込む

画面の平日便を戻す手順の「判断材料を調べる」(2026-11-07 に前提情報の手順から移した)にある「保存済みの結果(デモ)を使う」は、サーバーの SQLite に入れた結果を読みます。`data/demo/research_dohoku.json`(道北バスの周辺の 25 件。コミット済み)を取り込みます。

`data/` はイメージに入っていないので、ファイルをコンテナにコピーしてから、server のコンテナの中で取り込みます。

```bash
cd /srv/dispatcher
docker compose cp data/demo/research_dohoku.json server:/tmp/research_dohoku.json
docker compose exec server dispatcher-research-seed /tmp/research_dohoku.json
```

取り込みは、同じ対象の行を置き換えるので、何度行っても同じ結果になります。コンテナを作り直しても、SQLite は名前つきのボリューム(`dispatcher-db`)に残るので、取り込み直しは要りません。ボリュームを消したときだけ、もう一度取り込みます。

確かめる点:

- 出力が「デモ用の調査の結果を 25 件入れました(origin: demo。…)」
- 「取り込めませんでした」と出たときは、参照データ(`data/out/ref/facilities/`)が `/data/ref` にあるか確かめる。取り込みは参照データに無い対象を断ります
- `curl -s http://127.0.0.1:8080/api/research/demo | jq '.results | length'` が 25

## 8. 外側の nginx と HTTPS

VPS の既存の nginx に、`dispatcher.turutaru.com` の設定を足します。設定ファイルの置き場所(`/etc/nginx/conf.d/` か `sites-available/`)と、nginx の入れ方は、利用者の環境に合わせます。

要点は4つです。

1. `proxy_set_header X-Real-IP $remote_addr;` を付ける。サーバーの回数制限は、この値だけを接続元として読みます(`DISPATCHER_TRUST_PROXY=1`)。クライアントが送った X-Real-IP は、ここで上書きされます
2. `/api/claude/session/stream`(AI の会話のストリーム)は `proxy_buffering off;` と長い `proxy_read_timeout`
3. HTTPS はここで終端する(certbot など)
4. アクセスログに IP アドレスを残さない

最初は HTTP だけの設定にして、certbot に HTTPS の設定を足させます。

```nginx
# /etc/nginx/conf.d/dispatcher.turutaru.com.conf(置き場所は利用者の環境に合わせる)
server {
    listen 80;
    listen [::]:80;
    server_name dispatcher.turutaru.com;

    # アクセスログに IP アドレスを残さない(案 A:ログを取らない)
    access_log off;
    # 案 B:IP を含まない形式で残す(log_format は http の中、つまり conf.d の外の nginx.conf か、ここのファイルの先頭に書く)
    #   log_format dispatcher_noip '$time_iso8601 $status $request_method $uri $body_bytes_sent $request_time';
    #   access_log /var/log/nginx/dispatcher.access.log dispatcher_noip;
    # error_log には、エラーのときだけ接続元が載る。残したくなければ重大なエラーだけにする
    error_log /var/log/nginx/dispatcher.error.log crit;

    # AI の会話のストリーム(SSE)。ためずに流し、長く開いたままにする
    location = /api/claude/session/stream {
        proxy_pass http://127.0.0.1:8080;      # DISPATCHER_PORT と同じ番号
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        # client_max_body_size は既定の 1m のままでよい(画面が送る本文は 400KB 以下。GTFS は送られない)
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx

# HTTPS(certbot を使う場合。入れ方は利用者の環境に合わせる)
sudo certbot --nginx -d dispatcher.turutaru.com --redirect
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run          # 自動更新が動くこと
```

certbot は `listen 443 ssl` と証明書の行を足し、80 番を 443 番へ転送する設定にします。足された設定でも、上の `location` と `access_log`・`error_log` が残っていることを確かめます。HTTP のサーバーブロックが2つに分かれたときは、両方に `access_log off;` を付けます。

### 内側の nginx が外側の IP を信じる範囲

web コンテナの nginx(`deploy/nginx.conf`)は、`127.0.0.1` と、プライベートアドレス(10/8・172.16/12・192.168/16)から来た接続の X-Real-IP だけを接続元として扱います。Docker の公開ポートを通ると、外側の nginx からの接続は Docker のブリッジの IP アドレスから来たように見えます。普通は 172.16/12 に入ります。

```bash
docker network inspect dispatcher_default | jq -r '.[0].IPAM.Config[].Subnet'   # ネットワーク名は docker network ls で確かめる
ip -4 addr show docker0 | grep inet                                           # 既定のブリッジ
```

どちらも 10/8・172.16/12・192.168/16 のどれかに入っていることを確かめます。入っていないとき(`default-address-pools` を変えている場合など)は、X-Real-IP が読まれず、すべての利用者が1つの IP として数えられます。そのときは、`deploy/nginx.conf` に `set_real_ip_from` を足す必要があります(この手順書では直しません。指示役に伝えてください)。

確かめる点:

- `sudo nginx -T 2>/dev/null | grep -n 'X-Real-IP'` に、`/api/` と `/api/claude/session/stream` の両方の行が出る(無いと、全利用者が1つの IP として数えられる)
- `curl -I http://dispatcher.turutaru.com/` が 301(HTTPS へ転送)
- `curl -I https://dispatcher.turutaru.com/` が 200
- ブラウザで鍵のマークが付く(証明書が dispatcher.turutaru.com 用)
- ブラウザで数回開いた後、`sudo grep -rF dispatcher.turutaru.com /var/log/nginx/` に、自分の IP アドレスを含む行が無い(案 A なら、この名前のアクセスログが無い。ほかのサイトの共通のログ `access.log` に出ていないことも見る)

## 9. 確かめる

外から(手元の Mac など、VPS の外)で確かめます。

```bash
H=https://dispatcher.turutaru.com

curl -s  $H/api/health                                  # {"status":"ok"}
curl -s  $H/api/sample-gtfs                             # {"available":true,"name":"道北バス",...}
curl -s  $H/api/claude/status                           # {"available":true,"tokenRequired":false}
curl -s  $H/api/service-groups                          # {"available":true,"provider":"TypeSafe AI Jev","via":"Vercel AI Gateway","reason":null}
curl -s  $H/api/research/demo | jq '.results | length'  # 30
curl -s  $H/api/holidays -o /dev/null -w '%{http_code}\n'      # 200
curl -s  $H/api/ref/6542 -o /dev/null -w '%{http_code}\n'      # 200(道北バスの範囲のメッシュ)
curl -s  $H/api/sample-gtfs/download -o /tmp/dohoku.zip && unzip -l /tmp/dohoku.zip | tail -3     # ZIP の中身が見える(約 900KB)
```

VPS の上で、コンテナの中から日本語のファイル名が読めることと、権限を確かめます。

```bash
cd /srv/dispatcher
docker compose exec server id                          # uid=10001(dispatcher)
docker compose exec server ls -l /data/sample /data/ref | head
docker compose exec server env | grep -E '^DISPATCHER_(PUBLIC|TRUST_PROXY|AGENT_VERSION|DEV)='   # PUBLIC=1・TRUST_PROXY=1・AGENT_VERSION=(claude-lock.json の調整役の version)が出て、DEV は出ないこと
docker compose exec server sh -c 'test -n "$TYPESAFE_AI_VERCEL_KEY" && echo jev-key-set'    # jev-key-set(値は出さない)
```

`env` を全部出さないでください(API キーが画面に出ます)。

ブラウザで `https://dispatcher.turutaru.com/` を開いて確かめます。

1. 「サンプルを読み込む」で道北バスが読み込まれ、出典が出る
2. 平日便を戻す手順の「判断材料を調べる」を開き、保存済みの結果(デモ)が選べて、25 件が出る(減便の方針を承認する前でも開ける)
3. 減便の方針(平日を土曜ダイヤに)を適用し、地図に到達圏が出る
4. 出力の手順で ZIP を出力でき、検証に error が出ない
5. **AI が使える状態になる**(AI の欄に「AI は使えません」が出ない)。最初の発言の後に「AI を準備しています…(最初は 15 秒ほどかかります)」が出て、そのあと会話できる
6. **会話を1回だけ試す。** 「減便の方針の候補を2行で教えて」のような短い質問を1回送り、返事が流れて表示されること(約数セント)
7. 返事の後、AI の欄を開いたまま 2 分待つ。ストリームが切れず、次の発言も送れる(ブラウザの開発者ツールの Network で `/api/claude/session/stream` が開いたまま)

確かめる点:

- `/api/claude/status` の `available` が `true`。`false` のときは、次のどれかが `.env` に無いか、空です:API キー、エージェントの ID・版、実行環境の ID、取っ手の秘密、`DISPATCHER_PUBLIC`(認証コードを使わないとき)。画面は、原因によらず「AI は使えません(API キーが設定されていません)」と出すので、画面の文では原因が分かりません。`available` が `false` のときだけ、次のコマンドで本当の理由が返ります(設定が足りないと 503 で断られ、セッションは作られません。`available` が `true` のときは**本物のセッションが作られる**ので実行しないでください)

```bash
curl -s -X POST -H 'content-type: application/json' -d '{}' $H/api/claude/session
```
- 認証コード(`DISPATCHER_TOKEN`)を設定しないので、AI の中継は 401 にならない。「認証コードが無いと 401」を確かめたいときだけ、`DISPATCHER_TOKEN` を一時的に設定する(`tokenRequired` が `true` になる)
- `/api/service-groups` の `reason` が `noKey` ならキーが空、`badUrl` なら `DISPATCHER_JEV_URL` が Vercel の口でない、`dailyLimit` なら全体の1日の上限に達している(日本時間の翌日に戻る)。北海道中央バスなど単純でない GTFS を読み込むと、画面が自動で1回 Jev に問う(1 service あたり約 $0.0004)
- 1回の会話の後、Console で利用額が増えている。サーバーの1日の額も増えている:

```bash
docker compose exec server python -c "import sqlite3; print(sqlite3.connect('/var/lib/dispatcher/dispatcher.sqlite3').execute('select day, cents from cost_ledger order by day desc limit 7').fetchall())"
# Jev の1日の数と額(マイクロドル)
docker compose exec server python -c "import sqlite3; print(sqlite3.connect('/var/lib/dispatcher/dispatcher.sqlite3').execute('select day, targets, cost_microusd from jev_usage order by day desc limit 7').fetchall())"
```

## 10. 更新と戻し方

### 更新

```bash
cd /srv/dispatcher
git -C . rev-parse --short HEAD                  # 今のコミットを控える(戻すときに使う)
git fetch origin
git checkout develop && git pull --ff-only       # デプロイする枝(手順 3)
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8080/api/health
```

- 画面だけの変更でも、web のイメージを作り直します。ビルドの層は使い回されるので、2 回目からは速くなります
- 参照データやサンプルを入れ替えるときは、手順 4 の rsync をやり直します。server の再起動は要りません(ファイルが変われば読み直します。ブラウザは参照データを最大 1 時間覚えます)
- `.env` を直したときは `docker compose up -d`(変えたコンテナだけ作り直されます)。`restart` では `.env` の変更を読み直しません
- SQLite のボリューム(`dispatcher-db`)は残ります。デモの調査結果の取り込み直しは要りません
- 更新の間は、開いている AI の会話のストリームが切れます。画面が自動でつなぎ直します

### エージェントを更新したとき(利用者が手元で `ant apply` をした後)

1. 手元で `claude-lock.json` の調整役の `version` を確かめる
2. VPS の `.env` の `DISPATCHER_AGENT_VERSION` を直し、`docker compose up -d`
3. 新しいセッションから新しい版を使う。開いているセッションは、前の版のまま動く

**画面の手順や [画面の状態] の行の名前を変えた版も、画面の公開と同じデプロイで行います。** 例:11/7 の手順の並びの改めでは、画面が「[画面の状態] 周辺の施設の調査:…」(前は「前提情報:…」)を送り、手順2を「運行の前提」と呼ぶ。調整役の定義もこれに合わせて直したので、`ant apply` で版を上げ(版 7)、`DISPATCHER_AGENT_VERSION` を新しい版にしてから web を公開する。前の版の調整役のままだと、無い手順「前提情報」へ案内し、保存済みの調査の結果に気づかずに新しく調査を始めることがある

**ツールの定義が変わる版は、サーバーの版の更新と画面の公開を同じデプロイで行います。** ツールの定義の正は `server/src/dispatcher_server/claude_tools.json` で、入力を確かめるのは画面(`web/src/claude/tools.ts`)なので、調整役の版と画面のコードは対になっています。

- 例:調整役の版 4(11/6 の A10)は、`search_trips` の入力に `offset`・`hints` を足し、`summarize_impact` の結果の `drivers`(要る運転士の数(目安))を読む。新しい画面は、版 3 の調整役が2つの項目を送らなくても受け付ける(なければ `null` として読む)。古い画面は版 4 の調整役が送る `offset`・`hints` を「知らない項目」として断るので、版 4 だけを先に使うと便の検索がすべて失敗になる
- 手順:
  1. 手元で `ant apply`(利用者の承認のうえで)し、`claude-lock.json` の調整役の `version`(版 4)をコミットする。ツールの定義を変えたコミットと同じ枝に入れる
  2. VPS で、そのコミットを取得して `.env` の `DISPATCHER_AGENT_VERSION` を新しい版にする
  3. `docker compose up -d --build` を1回だけ実行する(web と server のイメージを作り直し、server は新しい `.env` を読む)。画面を先に、版を後に、と分けない
  4. 画面を読み込み直してから AI に相談し、`search_trips` の結果に `next_offset` があること、`summarize_impact` の結果に `drivers` があることを確かめる(「AI に送る情報」で見られる)
- 戻すときは、コードを前のコミットに戻すのと同じデプロイで `DISPATCHER_AGENT_VERSION` も前の版に戻す(版 3 の調整役と新しい画面の組は動くが、版 4 の調整役と古い画面の組は動かない)

### 戻し方

```bash
# コードを前のコミットに戻す
cd /srv/dispatcher
git checkout <前のコミット>           # 更新の前に控えたもの
docker compose up -d --build
```

- エージェントの版を戻すときは、`.env` の `DISPATCHER_AGENT_VERSION` を前の値に戻して `docker compose up -d`
- 環境変数を戻すときは、`.env` を直して `docker compose up -d`
- SQLite の内容は、コードを戻しても残ります。表の形が変わる更新があったときは、先にバックアップを取ります:

```bash
docker volume ls | grep dispatcher-db        # ボリュームの名前を確かめる(例:dispatcher_dispatcher-db)
docker run --rm -v dispatcher_dispatcher-db:/v -v "$PWD":/b alpine tar czf /b/dispatcher-db-$(date +%Y%m%d-%H%M).tgz -C /v .
```

### 緊急に AI だけを止める(費用が心配なとき)

```bash
# .env の ANTHROPIC_API_KEY を空にする(行は消さずに値だけ消す)
${EDITOR:-nano} .env
docker compose up -d
curl -s https://dispatcher.turutaru.com/api/claude/status      # {"available":false,...}
```

サンプルの読み込み、地図、編集、出力はそのまま動きます(AI はボタンの外の補助です)。あわせて、Console で API キーを無効にします。全部を止めるときは `docker compose stop` です。

Jev だけを止めるときは、同じように `.env` の `TYPESAFE_AI_VERCEL_KEY` を空にして `docker compose up -d` します(`/api/service-groups` が `"reason":"noKey"` になり、画面は規則だけで service を分けます)。

## 11. ログの見方

server のログは、日時・回数・エラーの種類だけです。発言、ツールの入力と結果、調査の結果、Jev に送った判断材料と答え(service_id・系統名・行き先を含む)、API キー、取っ手、IP アドレスの生の値は残りません(`docs/interfaces-1105.md` §4.12)。web の nginx はアクセスログを残しません(`access_log off`)。uvicorn も `--no-access-log` で動いています。

```bash
cd /srv/dispatcher
docker compose logs --since 1h server           # 直近 1 時間
docker compose logs -f --tail 100 server        # 流して見る
docker compose logs web | tail                  # web の nginx のエラー(起動、中継の失敗)
```

見るときの目印です。

| 探す文字列 | 意味 |
| --- | --- |
| `agent セッションを作りました` | 会話が始まった(1行が1セッション) |
| `agent 要求を断りました status=429 reason=…` | 回数制限か、1日の利用額の上限に達した(`reason` で種類が分かる) |
| `agent 要求を断りました status=503 reason=unavailable` | AI の設定が足りない(手順 5 の値) |
| `agent 要求を断りました status=400 reason=real_ip` | この構成では普通は出ない(内側の nginx は、どの `/api` の要求にも X-Real-IP を付ける)。内側の nginx を通らずに server に届いたときに出る |
| `agent エラー where=… type=… status=…` | Anthropic API の呼び出しの失敗 |
| `agent session.error type=…` | セッションの中のエラー |
| `research ツールの失敗` | 調査の保存などの失敗 |
| `jev 判定しました targets=… answered=… failures=… statuses=… providers=…` | Jev に問うた(1行が1回の読み込み)。`failures` は失敗の種類ごとの数、`providers` は転送先(転送先を TypeSafe AI に限っているので `typesafe-ai` だけのはず。ほかが出たら Vercel が指定を守らなかったので、`docs/design-service-groups.md` §6.2-1 を見直す) |
| `jev 要求を断りました status=… reason=…` | Jev の中継が断った(`noKey`・`badUrl`・`jev_day_total`・`rate_jev_ip_hour`・`rate_jev_ip_day`・`shape`・`reference`・`body_size` など) |

```bash
docker compose logs server | grep -E 'WARNING|reason=' | tail -50
```

外側の nginx で `proxy_set_header X-Real-IP` を忘れても、400 は出ません。内側の nginx が自分の見た接続元(Docker のブリッジの IP アドレス)を X-Real-IP に入れるので、全利用者が1つの IP として数えられ、回数制限を共有します。ログでは、別々の利用者なのに `status=429 reason=rate_session_ip_hour`(または `rate_session_ip_day`)が早く出ることで気づけます。本物の会話を試す前に、設定のほうを確かめてください(手順 8)。

```bash
sudo nginx -T 2>/dev/null | grep -n 'X-Real-IP'     # dispatcher.turutaru.com の /api/ と /api/claude/session/stream の両方に出ること
```

Docker のログは、既定では大きさの上限がありません。長く運用するときは、`/etc/docker/daemon.json` で `log-driver: json-file`・`log-opts: {"max-size": "10m", "max-file": "3"}` を設定し、Docker を再起動します(VPS 全体の設定なので、利用者の環境に合わせて判断してください)。

## 付録 A. 最後の確認(デプロイの完了)

- [ ] Console のワークスペースの月の上限が 200 ドル
- [ ] DNS が VPS を向き、HTTPS で開ける(HTTP は HTTPS に転送される)
- [ ] `.env` に `DISPATCHER_PUBLIC=1` と、API キー・エージェントの ID と版・実行環境の ID・取っ手の秘密がある。`DISPATCHER_DEV` は無い
- [ ] `/api/claude/status` が `available: true`
- [ ] サンプルの読み込み、減便の方針の適用、出力 ZIP、デモの調査結果が動く
- [ ] AI の会話を1回行い、ストリームが2分以上つながっている
- [ ] アクセスログ(外側の nginx)に IP アドレスが残らない
- [ ] 出したコミットを控えた

## 付録 B. 関係する文書

- `compose.yaml`、`web/Dockerfile`、`server/Dockerfile`、`deploy/nginx.conf`、`.env.example`
- `docs/interfaces-1105.md` §4.11(回数制限と料金)、§4.12(ログ)、§9(デプロイの作業に渡す点)
- `docs/tasks-1103.md` の「利用者の決定(11/3)」
