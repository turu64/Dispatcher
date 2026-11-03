# 11/3 夕方〜11/6 の実装タスク(未実装の仕様と、実物を確かめた指摘)

11/3 に指示役が、Notion の仕様のページ、CLAUDE.md の機能スコープ、取り決めの文書の「後で」の項目、今のコードを調べ、`docs/review-fixes.md` の指摘 1〜7 と合わせてタスクに分けた。機能凍結は 11/6 22:00。

- 同じ波(wave)のタスクは、同じファイルを触らない。画面の骨組み(T01)を最初の波に置く
- 「決めること」のうち画面の細部は、下の「指摘への決め方」のとおりに指示役が決めた。利用者にしか決められない点は「利用者に伺う点」

## 指摘への決め方(指示役、11/3)

- 指摘1(カレンダー):日曜・祝日を赤、土曜を青にする(日本のカレンダーの慣例で、運行管理者が見慣れているため)。色だけに頼らず「祝」「土」「日」の文字も付ける(既に色覚に配慮した配色にしているため)。祝日名はマウスを載せたときと、選んだ日の下の文で出す。入力の有効期間の外の日は選べないようにする(選んでも badPeriod・emptyValidity で止まるだけなので、先に防ぐ方が分かりやすい)。各日のダイヤの種類をセルに出すのは見送り、選んだ日の下に「この日は平日ダイヤ」と文で出す(区画が混み、11/6 に間に合わせるため)
- 指摘2(差の表示):先頭に平日の便数の前→後を大きく出し、なくなる・加わる・同じの便数を並べる。全曜日で便がなくなる系統を先頭で強調する(最も重い影響で、見落とすと困るため)。公示の表は「届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)」と言い換え、第46号の下限の印と「運輸支局に確認してください」を1〜2行で説明し、既定で折りたたむ(運行管理者向けの補助情報で、GTFS 担当者には不要なため)
- 指摘3(ステッパー):上の見出しから直接移れ、下に「次へ」「戻る」を置く。GTFS を読み込むまでは先の手順に進めないが、読み込んだ後は自由に移れる(各手順が空の状態の案内を持っており、強い制限は試行錯誤を妨げるため)。手順は 1 読み込み・2 前提情報・3 減便の方針・4 影響(到達圏。日付と時間帯を統合)・5 平日便を戻す・6 出力(GTFS・変更指示書・周知文・停留所の一覧のタブ)。「AI に相談」は左の欄の下に固定でどの手順でも出し、たためる(減便の方針の指示と質問はどの手順からも出るため)。AI の下書きの「手順へ移る」は手順の store の移動につなぐ
- 指摘4(地図の出し分けと幅):地図は読み込み・前提情報・影響・平日便を戻すで出し、減便の方針と出力では隠して左の欄を広げる(減便の方針と出力は表と文が中心で幅が要るため)。地図は消さずに隠し、再表示で resize する(作り直しのコストと状態の消失を避けるため)。区切りのドラッグで幅を変え、最小 320px・最大は窓の 60%、幅は localStorage に覚える(閲覧者ごとの便利機能なのでブラウザの保存で足りる)。運営情報は #/about の別ページにし(ルーターの依存を増やさない)、画面の上の端のリンクから行けるようにする。中身はデータの出典・作品の説明・MIT ライセンス・ハッカソン作品であること・お問い合わせ。OSM の表示は地図の中に残す。連絡先は利用者に確認する
- 指摘5(平日に戻す候補):系統ごとに折りたたみ、全曜日で便がなくなる系統を先頭にする。系統を開くと方向ごとに時刻順に並べ、減便後の最大間隔を添える(1104 §13 の並べ方と同じにして、間隔が空きすぎる所が見えるようにする)。最初は判断材料のある便だけを出し、残りは「ほかの便を見る」で開く。並びは判断材料の数、次に到達圏から外れた区画の人口、次に始発の時刻(人口の重みづけを安く入れられるため)。「AI に候補を聞く」の結果は一覧の先頭に「AI のおすすめ」として出す。地図との連動は見送る(11/6 までの量を抑えるため)
- 指摘6(AI 欄のスクロール):会話のスクロールの箱に overscroll-behavior: contain を付ける。ステッパーで左の欄が手順ごとになり、ページ全体のスクロール自体も減る
- 指摘7(日付と時間帯):表示する時間帯は地図の上の切り替えに移す(計算を変えず、地図と表の強調だけに効くため)。日付と時間帯の幅は計算を変え、表・判断材料・AI の要約にも効くので、地図の側ではなく影響(到達圏)の手順の上部に置き、「変えると表と平日に戻す判断材料も計算し直します」と添える。手順「日付と時間帯」は到達圏にまとめてなくす

## タスク

### 波 1

#### T01 画面の骨組み:ステッパー、地図の出し分けと幅の調整、運営情報の別ページ、AI 欄の固定とスクロール(担当のモデル:opus)

- **目標**:左の欄を手順ごとに1つずつ見せるステッパーにし、手順ごとに地図の表示を切り替え、左右の幅をドラッグで変えられるようにする。データの出典を運営情報の別ページへ移す。後のタスクが App.tsx を触らずに手順を足せる手順の一覧(registry)と手順の store を作る
- **触るファイル**:`web/src/App.tsx`、`web/src/store/steps.ts(新規)`、`web/src/components/steps/registry.ts(新規)`、`web/src/components/layout/(新規:Stepper・SplitPane・StepNav)`、`web/src/components/steps/stepIds.ts`、`web/src/components/StepSection.tsx`、`web/src/components/chat/ChatMessages.tsx`、`web/src/components/chat/ChatPanel.tsx`、`web/src/components/chat/ChatPanel.test.tsx`、`web/src/components/DataSources.tsx`、`web/src/pages/AboutPage.tsx(新規)`、`web/src/map/BaseMap.tsx`、`web/src/index.css`、`web/src/components/steps/ResearchStep.tsx(新規・仮)`、`web/src/components/output/(新規・仮:OutputStep・ChangeOrder・NoticeDraft・StopChangesTable)`、`web/src/components/ui/tabs.tsx(新規、radix-ui は導入済み)`、`web/src/components/steps/EditFlow.test.tsx`、`CLAUDE.md(出典は別ページへのリンクで画面に出す、の書き方)`
- **受け入れ条件**:
  - store/steps.ts に現在の手順と移動(次へ・戻る・見出しから移る)があり、Vitest で、GTFS 未読み込みでは読み込みより先へ進めないこと、読み込み後は見出しから移れることを確かめる
  - 手順の一覧(components/steps/registry.ts)の1項目が {key, title, component, showMap, mapOverlay?} で、App.tsx はこの一覧を描くだけ。手順は 1 読み込み・2 前提情報(仮の空の部品)・3 減便の方針・4 日付と時間帯・5 到達圏・6 平日便を戻す・7 出力(タブの入れ物。中身は GTFS=ExportStep と、変更指示書・周知文・停留所の一覧の仮の空の部品)
  - showMap が false の手順では地図を隠し、左の欄が広がる。地図は消さずに隠し、再表示で map.resize() を呼ぶ(RTL で地図の入れ物が hidden になること)
  - 左右の区切りをドラッグして幅を変えられる(最小 320px、最大は窓の 60%)。幅は localStorage に覚え、読み書きは try/catch で囲む。新しい依存パッケージは足さない(pointer events で作る)
  - stepIds.ts の STEP_IDS は残し、jumpToStep の中身を store の移動に替える。ChatMessages の「手順へ移る」で該当の手順が開くことを ChatPanel.test.tsx で確かめる
  - 「AI に相談」の欄は左の欄の下に固定で、どの手順でも出し、たためる。会話のスクロールの箱に overscroll-behavior: contain を付ける
  - 画面の上の端に「このサイトについて・データの出典」のリンクがあり、#/about で運営情報のページ(データの出典=DataSources の中身、作品の説明、MIT ライセンス、ハッカソン作品であること、お問い合わせ)を開き、戻れる。新しいルーターの依存は入れない。地図の OSM の表示は地図の中に残す
  - index.css に印刷用の土台(@media print で手順の見出し・地図・AI 欄を隠し、.print-area だけを出す)を置く
  - EditFlow.test.tsx・DataSources.test.tsx を新しい骨組みに合わせて通す。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 各手順の部品の props は変えない(PolicyStep・RestoreStep などのテストを書き直さないため)。複数の手順を描くテストには、手順を開く補助関数を用意する
  - 手順の区切りはこの波では今の6つ+前提情報+出力の入れ物のまま。「日付と時間帯」を到達圏にまとめるのは T11
  - お問い合わせの連絡先は利用者の回答(user_questions)待ち。それまでは仮の文言にする

#### T02 PolicyStep の分割(振る舞いは変えない)(担当のモデル:sonnet)

- **目標**:1,142 行の PolicyStep.tsx を、期間の欄・差の表・承認の欄などの別ファイルに分け、T09(差の表示)と T10(期間の欄)を並行で作れるようにする
- **触るファイル**:`web/src/components/steps/PolicyStep.tsx`、`web/src/components/steps/policy/(新規)`
- **受け入れ条件**:
  - components/steps/policy/ に PeriodFields.tsx(期間・減便の方針の種類)、DiffTables.tsx(平日の差・公示第46・47号の表・系統の除外)、ApprovalPanel.tsx(承認・元に戻す)などができ、PolicyStep.tsx はそれらを組むだけになる
  - PolicyStep.test.tsx・EditFlow.test.tsx が変更なしで通る(見た目と文言が変わらない)
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - T01 と同じ波なので、App.tsx・stepIds.ts・EditFlow.test.tsx は触らない

#### T03 祝日の色つきカレンダーの部品(担当のモデル:sonnet)

- **目標**:日付を選ぶ部品 HolidayCalendar を作る。内閣府の祝日一覧で日曜・祝日を赤、土曜を青にし、祝日の名前を出し、範囲の外の日を選べなくする
- **触るファイル**:`web/package.json`、`web/pnpm-lock.yaml`、`web/src/components/ui/calendar.tsx(新規)`、`web/src/components/HolidayCalendar.tsx(新規)`、`web/src/components/HolidayCalendar.test.tsx(新規)`
- **受け入れ条件**:
  - shadcn の Calendar(react-day-picker)を components/ui/calendar.tsx に入れ、HolidayCalendar.tsx が {value, onChange, min?, max?, holidays} を受ける
  - HolidayCalendar.test.tsx で、祝日の日に赤の印と祝日名(title とセル内の「祝」)が付くこと、土曜が青、min・max の外が disabled であること、選んだ日の下に「11月3日(火・文化の日)」のように出ることを確かめる
  - 色だけに頼らず「祝」「土」「日」の文字でも区別する(色覚への配慮)
  - pnpm test・typecheck・lint・build が通る
- **決めたこと**:
  - その日に走るダイヤ(平日・土曜・日祝)をセルに出すのは見送る(セルが混む)。選んだ日の下の文で十分

#### T04 GTFS-JP v4 検証器の残りの規則(担当のモデル:opus)

- **目標**:Skill の規則1〜6と 1104 §12.2・§13 の規則を、validateEdit の結果に足す
- **触るファイル**:`web/src/gtfs/validate/edit.ts`、`web/src/gtfs/validate/feed.ts(新規)`、`web/src/gtfs/validate/*.test.ts`
- **受け入れ条件**:
  - validate/feed.ts(新規)に規則を置き、validateEdit から呼ぶ。規則ごとに edit.test.ts か feed.test.ts に小さなフィクスチャのテストがある
  - error:requiredFileMissing(agency・stops・routes・trips・stop_times・calendar か calendar_dates のどちらか・feed_info)、badCalendarDate(日付不正・exception_type が 1・2 以外)、badTimeFormat(HH:MM:SS でない。24時超は許す)、stopSequenceNotIncreasing、stopIdChanged・routeIdChanged(減便前の stops・routes の id が出力から消えていないこと)
  - warning:feedInfoRows(feed_info が1行でない)、calendarBeyondFeedInfo、時が1桁の時刻など書き方の違い、署名が同じ便の pickup_type・drop_off_type・headsign の不一致(§12.2)
  - info:unusedRoutes・unusedStops(件数つき)
  - サンプル GTFS の verify テスト(無ければスキップ)で、道北バスの main の場面の出力に error が無く、unusedStops が 90 件前後で出ることを確かめる。gtfs-jp-check の Skill の手順で出力 ZIP を確かめ、gtfs-reviewer に見てもらう
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 減便の方針の画面に badCalendar を出す部分は T10(PolicyStep 側)が受け持つ。このタスクは validate/ の中だけ

#### T05 停留所ごとの前後の発車の共通計算(本数・始発・最終便・最大間隔・新しい/なくなる発車時刻)(担当のモデル:opus)

- **目標**:B の停留所の一覧、周知文、変更指示書、平日に戻した便の一覧(系統×方向の最大間隔)が共通で使う純粋な計算を作る
- **触るファイル**:`web/src/gtfs/edit/stopDiff.ts(新規)`、`web/src/gtfs/edit/stopDiff.test.ts(新規)`、`web/src/gtfs/edit/stopDiff.verify.test.ts(新規)`
- **受け入れ条件**:
  - gtfs/edit/stopDiff.ts に stopDiff(base, edited, date) があり、stop_id ごとに {before, after}:本数・始発・最終便・最大間隔(分)・系統ごとの発車時刻を返し、added(新しく加わる発車時刻)・removed(なくなる発車時刻)を返す
  - 同じファイルに routeDirectionTimeline(feed, routeId, date):方向(始発→終着の停留所の組)ごとに便を時刻順に並べ、最大間隔を出す関数がある
  - 掲示の差し替えが要る停留所の件数を返す
  - stopDiff.test.ts に小さなフィクスチャのテスト、stopDiff.verify.test.ts でサンプル GTFS(無ければスキップ)の件数が出ること
  - 停留所は stop_id で照合し、減便後に stop_times から消えた停留所も減便前の GTFS から数える(interfaces-1103 追記3)
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 最大間隔は、その日の始発から最終便までの間の発車の間隔の最大(始発前・最終便後は含めない)とする

#### T06 P11・P29・P04 の入手と加工(調査の対象の元データ)(担当のモデル:sonnet)

- **目標**:国土数値情報のバス停留所(P11)・学校(P29)・医療機関(P04)の北海道分を data/raw に入れ、1次メッシュごとの参照データに加工する
- **触るファイル**:`data/src/dispatcher_data/facilities.py(新規)`、`data/src/dispatcher_data/build.py`、`data/tests/test_facilities.py(新規)`、`data/raw/README.md`
- **受け入れ条件**:
  - data/raw/README.md に入手元 URL と日時を書く(CLAUDE.md で利用者が許可済み)
  - data/src/dispatcher_data/facilities.py が data/out の参照データ(DISPATCHER_REF_DIR から配る形)に、1次メッシュごとの施設の JSON を出す。項目は target_id・kind(operator・school・hospital・clinic)・name・municipality・lat・lon と種類の詳細(学校種別、病床数)
  - 病院と診療所は病床数で分ける(20 床以上を hospital、入院設備の有無として扱う)。学校は種別(高校・特別支援・大学・高専・専修・中学など)を持つ
  - P11 は停留所ごとの事業者名から、事業者を対象として集める(1事業者=1対象、位置は停留所の重心)
  - target_id は T07 の決定どおりで、同じ入力なら同じ ID になることを pytest で確かめる
  - build.py から呼べ、data の pytest が通る
- **決めたこと**:
  - target_id は P29:<学校コード>、P04:<名称と所在地を NFKC で整えた文字列の SHA-1 の先頭12桁>、P11:<事業者名を NFKC で整えた文字列>。属性名は実データを読んで確定し、T07 に伝える
  - 2km の外周は、停留所の分布の外接矩形に 2km を足した範囲とする(凸包より簡単で、対象の数は上限 30 件で抑える)

#### T07 前提情報の調査のサーバー側(ツール3つ、research のエンドポイント、デモの結果の取り込み)(担当のモデル:opus)

- **目標**:get_research_targets・get_research_results・save_research の中身と、POST/GET /api/claude/session/research を作る。デモ用の結果を origin: demo で取り込む手段を用意する
- **触るファイル**:`server/src/dispatcher_server/research.py(新規)`、`server/src/dispatcher_server/agent_session.py`、`server/src/dispatcher_server/agent_relay.py`、`server/src/dispatcher_server/store.py`、`server/src/dispatcher_server/settings.py`、`server/pyproject.toml(スクリプトの追加)`、`server/tests/(新規のテストとフィクスチャ)`、`.env.example`
- **受け入れ条件**:
  - server/src/dispatcher_server/research.py が参照データ(DISPATCHER_REF_DIR)から target_id を引いて名前・種類・市町村・位置を入れる。ブラウザが送った名前は使わない。上限 DISPATCHER_RESEARCH_MAX_TARGETS(30)
  - agent_session.py の run_server_tool が MSG_NOT_YET の代わりに3つを実行し、§3.2 の確かめ(target_id が対象にある、facts の source 番号、URL の形と 2,000 字、文字数)で外れたら is_error で日本語の理由を返す
  - demo の行と期限内の行を上書きしない(§3.2 の文言)。保存は 7 日
  - POST /api/claude/session/research(target_ids を受けて対象を決め、[画面の操作] の行を会話に入れる)と GET(対象と保存済みの結果)を agent_relay.py に足し、認証コードと取っ手を確かめる
  - デモ用の結果を JSON から origin: demo で取り込むコマンド(例 uv run dispatcher-research-seed <file>)がある。中身のファイルはこのタスクでは作らない
  - 参照データはテスト用のフィクスチャで pytest を書く(T06 の実データが無くても通る)。uv run pytest -q が通る
  - 本物の API は呼ばない
- **決めたこと**:
  - target_id の形は T06 の decisions のとおりに固定する
  - 調整役・調査役の定義(agents/*.md・claude_tools.json)は変えない(変えると ant apply が要る)

#### T08 Dockerfile・compose・nginx と CI のビルド(担当のモデル:sonnet)

- **目標**:web のビルドを nginx が配り /api を FastAPI に中継する構成を作り、ローカルで一度起動して確かめる
- **触るファイル**:`web/Dockerfile(新規)`、`server/Dockerfile(新規)`、`compose.yaml(新規)`、`deploy/nginx.conf(新規)`、`.dockerignore(新規)`、`.github/workflows/ci.yml`
- **受け入れ条件**:
  - web/Dockerfile(ビルドして nginx で配る)、server/Dockerfile(uv、uvicorn はワーカー1・--timeout-graceful-shutdown 3・--no-access-log)、compose.yaml、deploy/nginx.conf、.dockerignore がある
  - nginx の /api/claude/session/stream に proxy_buffering off・proxy_read_timeout 3600s、/api 全体に proxy_set_header X-Real-IP $remote_addr
  - compose で DISPATCHER_TRUST_PROXY=1・DISPATCHER_TOKEN・ANTHROPIC_API_KEY・DISPATCHER_AGENT_ID・AGENT_VERSION・ENVIRONMENT_ID・DISPATCHER_SESSION_SECRET を環境変数で渡す。DISPATCHER_DEV は付けない。API キーはイメージに入れない
  - DISPATCHER_SAMPLE_GTFS(日本語のファイル名)・DISPATCHER_REF_DIR・DISPATCHER_DB をボリュームで渡す
  - ローカルで 8000 以外(例 8080)で公開して起動し、/api/health、/api/sample-gtfs で日本語のファイル名のサンプルが読めること、画面が開くことを確かめる(AI の本物の呼び出しはしない)
  - .github/workflows/ci.yml に pnpm build を足す
- **決めたこと**:
  - src のファイルは触らない。HTTPS は VPS の既存の nginx で終端する前提にし、compose の nginx は内側で HTTP を受ける(T21 で VPS の構成に合わせる)

### 波 2

#### T09 減便の方針の「差」の表示の作り直し(指摘2)(担当のモデル:sonnet)

- **目標**:減便の方針の手順で、何がどれだけ変わるかが一目で分かるようにし、公示第46・47号の表に説明を付ける
- **前に済ませるタスク**:T01、T02
- **触るファイル**:`web/src/components/steps/policy/DiffTables.tsx`、`web/src/components/steps/policy/DiffTables.test.tsx(新規)`
- **受け入れ条件**:
  - 先頭に平日の便数の前→後を大きく出し、なくなる・加わる・同じの便数を並べる
  - 全曜日で便がなくなる系統を先頭に強調して出す
  - 公示の表の見出しを「届出の目安:時間帯ごとの便数(北海道運輸局 公示第47号の区分)」にし、第46号の下限の印(▼)の意味と「届出の区分は運輸支局に確認してください」を1〜2行で添える。表は既定で折りたたむ
  - DiffTables.test.tsx(新規)で、見出し・説明・折りたたみ・全曜日ゼロの系統が先頭に出ることを確かめる
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - PolicyStep.test.tsx と editText.ts は T10 が受け持つ。文言はこのファイルの中に置く

#### T10 減便の期間の欄:カレンダーへの置き換え(指摘1)と、期間がおかしい理由・calendar の日付不正の表示(担当のモデル:sonnet)

- **目標**:期間の開始日・終了日を祝日の色つきカレンダーにし、期間がおかしいときに理由を欄の下に出す
- **前に済ませるタスク**:T01、T02、T03、T04
- **触るファイル**:`web/src/components/steps/policy/PeriodFields.tsx`、`web/src/components/steps/PolicyStep.tsx`、`web/src/components/steps/PolicyStep.test.tsx`、`web/src/components/steps/editText.ts`
- **受け入れ条件**:
  - 開始日・終了日に HolidayCalendar を使う。選べる範囲は入力の有効期間(開始日は入力の末日まで)
  - 終了日が開始日より前、開始日が入力の末日より後のときに、badPeriod・emptyValidity の理由を期間の欄の下に出す(PolicyStep.test.tsx で確かめる)
  - calendar の日付が不正な平日の service があるとき、weekdayNotActive の文に「日付の正しくない calendar の行は数えていません」を足すか badCalendar を出す(テストあり)
  - pnpm test・typecheck・lint が通る

#### T11 日付と時間帯の置き場所(指摘7)と、比較する日付のカレンダー(担当のモデル:sonnet)

- **目標**:表示する時間帯を地図の上の操作に移し、日付と時間帯の幅は到達圏の手順にまとめる。手順「日付と時間帯」をなくす
- **前に済ませるタスク**:T01、T03
- **触るファイル**:`web/src/components/steps/DateBandStep.tsx`、`web/src/components/steps/DateBandStep.test.tsx`、`web/src/components/steps/ReachStep.tsx`、`web/src/components/steps/ReachStep.test.tsx`、`web/src/components/steps/registry.ts`、`web/src/map/BandControl.tsx(新規)`、`web/src/map/ReachLayers.tsx`、`web/src/map/MapLegend.tsx`、`web/src/store/reach.ts`
- **受け入れ条件**:
  - 地図の上に時間帯の切り替え(1h/3h の帯のボタン)を置き、地図の塗り分けと到達圏の表の強調行が連動する
  - 比較する日付は HolidayCalendar で選ぶ。日付と時間帯の幅は到達圏の手順の上部に置き、「変えると表・平日に戻す判断材料・AI の影響の要約も計算し直します」と添える
  - 手順の一覧から「日付と時間帯」を外し、到達圏の手順が「影響(到達圏)」になる。減便の方針の承認後に到達圏から外れた区画(セル)が最も多い時間帯を自動で選ぶ動きは保つ
  - DateBandStep.test.tsx・ReachStep.test.tsx を合わせて通し、地図の上の切り替えのテストを足す
  - pnpm test・typecheck・lint が通る

#### T12 平日に戻す候補の一覧の整理(指摘5)と休校日運休（学）のチェック(担当のモデル:sonnet)

- **目標**:293 便の縦の一覧を、系統ごとのまとまりと判断材料のある便の先出しで選びやすくする。平日に戻す便に(学)の印を付けられるようにする
- **前に済ませるタスク**:T01、T05
- **触るファイル**:`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/RestoreStep.test.tsx`、`web/src/components/steps/restore/(新規・必要なら)`
- **受け入れ条件**:
  - 候補を系統ごとに折りたたんで出し、全曜日で便がなくなる系統を先頭にする。系統を開くと方向ごとに時刻順に並び、減便後の最大間隔(分)を添える(T05 の routeDirectionTimeline)
  - 最初は判断材料のある便だけを出し、残りは「ほかの便を見る」で開く。並びは判断材料の数、次に到達圏から外れた区画の人口、次に始発の時刻
  - 「AI に候補を聞く」の結果がある便を、一覧の先頭の「AI のおすすめ」にまとめる
  - 平日に戻す便ごとに「休校日運休（学）」のチェックがあり、addBack の schoolDaysOnly に渡る
  - RestoreStep.test.tsx で、折りたたみ・先出し・AI のおすすめ・(学)のチェックが addBack に渡ることを確かめる
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 地図で停留所や区画を押して候補を絞る連動は見送る(deferred)

#### T13 feed_version の入力欄、trip_id の注意、読み込み時の feed_info 表示(担当のモデル:sonnet)

- **目標**:出力の画面で feed_version を利用者が入れられるようにし、trip_id の注意の1行を出す。読み込みの手順に feed_version・有効期間・service_id の構成を出す
- **前に済ませるタスク**:T01、T04
- **触るファイル**:`web/src/components/steps/ExportStep.tsx`、`web/src/components/steps/ExportStep.test.tsx`、`web/src/gtfs/edit/form2.ts`、`web/src/gtfs/edit/form2.test.ts`、`web/src/store/edit.ts`、`web/src/components/steps/LoadStep.tsx`
- **受け入れ条件**:
  - 出力の画面に feed_version の入力欄があり、既定は今の規則(12 桁なら generatedAt、それ以外は {入力}_dispatcher_{generatedAt})。入れた値が出力 ZIP の feed_info に入る(ExportStep.test.tsx・form2.test.ts)
  - 入れた値が入力以下なら feedVersionNotIncreasing の注意が出る
  - 出力の画面に「平日に戻した便の trip_id は元の平日ダイヤのままで、trip_id の運用番号は出力の土曜ダイヤの運用とは対応しません」を出す
  - 読み込みの手順に feed_version・有効期間・service_id ごとの便数を出す
  - gtfs-reviewer に見てもらう。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - feed_version の上書きは Form2Options に任意の feedVersion を足して渡す(書き出しの後で書き換えない。検証が同じ値を見るため)

#### T14 B 停留所ごとの本数・最終便・最大間隔の変化の一覧(担当のモデル:sonnet)

- **目標**:出力の手順のタブ「停留所の一覧」に、停留所ごとの前後の比較を出す
- **前に済ませるタスク**:T01、T05
- **触るファイル**:`web/src/components/output/StopChangesTable.tsx`、`web/src/components/output/StopChangesTable.test.tsx(新規)`
- **受け入れ条件**:
  - 停留所ごとに本数・始発・最終便・最大間隔を前→後で並べ、変化の大きい順に並べられる
  - 新しく加わる発車時刻となくなる発車時刻を出し、「掲示より早い発車は早発になりえます」の注意を添える
  - 掲示を差し替える停留所の件数を出す
  - 停留所名で絞り込める
  - StopChangesTable.test.tsx で表示を確かめる。pnpm test・typecheck・lint が通る

#### T15 閉じ損ねたセッションの予約の扱いと「AI を準備しています…」(担当のモデル:sonnet)

- **目標**:デプロイの前に決めること(1105 §9)を作る
- **前に済ませるタスク**:T01、T07
- **触るファイル**:`server/src/dispatcher_server/store.py`、`server/src/dispatcher_server/agent_relay.py`、`server/tests/`、`web/src/store/chat.ts`、`web/src/components/chat/ChatPanel.tsx`、`web/src/components/chat/ChatPanel.test.tsx`
- **受け入れ条件**:
  - 利用者の回答の規則で reserved_cents を数える(推奨:最後の操作から 30 分ストリームがつながっていない行は、残りの予算ではなく使った額だけを予約に数える)。sessions の表に最後にストリームがつながっていた日時を持ち、pytest で確かめる
  - 最初のストリームがつながるまで、AI の欄に「AI を準備しています…(最初は 15 秒ほどかかります)」を出す(ChatPanel.test.tsx)
  - uv run pytest -q と pnpm test・typecheck・lint が通る
- **決めたこと**:
  - GTFS を読み込んだ時点でセッションを先に作る案は採らない(開いたままの画面が1日の利用額の予約を取るため)。準備中の表示で待ってもらう

### 波 3

#### T16 前提情報の手順の画面、施設の地図表示、出典の行、重要拠点の優先順位(担当のモデル:sonnet)

- **目標**:手順「前提情報」で、停留所の外周 +2km の対象を選んで調査を始め、進み具合と結果(出典 URL と確認日時)を見られるようにする
- **前に済ませるタスク**:T01、T06、T07、T15
- **触るファイル**:`web/src/components/steps/ResearchStep.tsx`、`web/src/components/steps/ResearchStep.test.tsx(新規)`、`web/src/components/steps/registry.ts`、`web/src/ref/facilities.ts(新規)`、`web/src/store/research.ts(新規)`、`web/src/store/priority.ts(新規)`、`web/src/store/chat.ts`、`web/src/map/FacilityLayer.tsx(新規)`、`web/src/components/dataSourceRows.ts`、`web/src/components/dataSourceRows.test.ts`
- **受け入れ条件**:
  - 参照データから施設を読み(ref/facilities.ts)、停留所の外接矩形 +2km の対象を種類ごとに一覧にして選べる(上限 30 件、既定は優先順位の上から)
  - 「前提情報を調べる」で POST /api/claude/session/research を呼び、進み具合と結果(事実・出典 URL・確認日時・origin)を出す。「保存済みの結果(デモ)を使う」を選べる
  - 重要拠点の既定の優先順位(1 入院設備のある病院 … 10 観光地)を store/priority.ts に定数で持ち、画面で並べ替えられる。データの無い種類(空港・福祉施設・役所・商業施設・郵便局・観光地)は「データ未対応」と出す
  - 前提情報の手順で、地図に施設を種類ごとの記号で出す(手順の一覧の mapOverlay)
  - dataSourceRows.ts に P11・P29・P04 の行を、使ったときだけ出す(dataSourceRows.test.ts)
  - research の API はモックして RTL・Vitest で確かめる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 人工透析施設などの拠点を手で足す機能は見送る(deferred)

#### T17 B 変更指示書(1枚に印刷)(担当のモデル:sonnet)

- **目標**:出力の手順のタブ「変更指示書」に、承認した内容を1枚にまとめ、画面から PDF に印刷できるようにする
- **前に済ませるタスク**:T01、T05、T09、T12、T13
- **触るファイル**:`web/src/components/output/ChangeOrder.tsx`、`web/src/components/output/ChangeOrder.test.tsx(新規)`
- **受け入れ条件**:
  - 欄:減便の理由の区分とメモ、減便の方針(種類・期間・除外した系統)、承認の日時と承認者(利用者か AI の下書きか)、保護する便と理由と(学)の印、系統×公示第47号の時間帯の新旧の回数、平日に戻した便の集計と勤務の確認欄、届出・公示の欄(運輸支局に確かめた結果、届出日、公示日、実施日、7日を切るときの理由。手書き用の空欄)、GTFS の欄(feed_version、公開予定日、§5.10 の文言)、周知の欄(掲示を差し替える停留所の件数)
  - 「印刷する」で window.print を呼び、@media print で A4 縦1枚に収まる(T01 の印刷の土台を使う)
  - 数字はコードが出す(diff.ts・stopDiff.ts・編集の履歴)
  - ChangeOrder.test.tsx で欄の中身を確かめる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 補助系統の要件の欄は入れない(取り決めに入っていない案)

#### T18 B 周知文案(停留所ごとの掲示、代替手段の案内)(担当のモデル:sonnet)

- **目標**:出力の手順のタブ「周知文」に、停留所ごとの掲示文と、運輸規則第17条の5項目を雛形にした告知文を出し、印刷できるようにする
- **前に済ませるタスク**:T01、T05、T12
- **触るファイル**:`web/src/gtfs/edit/notice.ts(新規)`、`web/src/gtfs/edit/notice.test.ts(新規)`、`web/src/components/output/NoticeDraft.tsx`、`web/src/components/output/NoticeDraft.test.tsx(新規)`
- **受け入れ条件**:
  - gtfs/edit/notice.ts(純粋な関数)で、停留所ごとに系統ごとの期間中の発車時刻を作る。頻繁な系統(1時間に4本以上)は始発・終発と間隔で表す。(学)の便に印を付ける。stop_id で照合する(notice.test.ts)
  - 掲示文に公示日・実施日の欄と、7日を切るときの理由の欄を置く
  - 告知文は第17条の5項目(変更の内容・実施日・理由など)を雛形にし、「法定の様式ではありません」と添える
  - 代替手段の案内は、同じ停留所・半径 300m 以内の停留所に期間中も残る自社の便と、自由記入の欄で作る
  - 停留所を選んで1枚ずつ印刷できる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - AI に文案を書かせる機能は入れない(数字はコードが出す原則。雛形の差し込みで足りる)

### 波 4

#### T19 学校・病院を平日に戻す判断材料につなぐ(nearby_facilities と新しい判断材料)(担当のモデル:opus)

- **目標**:前提情報の施設を使い、通学・通院の便を理由つきで候補に出す
- **前に済ませるタスク**:T12、T16
- **触るファイル**:`web/src/gtfs/edit/restore.ts`、`web/src/gtfs/edit/restore.test.ts`、`web/src/store/restoreHintContext.ts`、`web/src/claude/tools.ts`、`server/src/dispatcher_server/claude_tools.json`、`agents/coordinator.md`、`web/src/components/steps/RestoreStep.tsx`
- **受け入れ条件**:
  - restore.ts に判断材料 nearFacility を足す:便の停留所から徒歩圏(到達圏の分数と同じ距離)にある学校・病院で、学校は始業前(7〜9時着)・下校(14〜18時発)、病院は 8〜11時着・11〜16時発に当たる便。理由の文に施設名と種類を入れる(restore.test.ts)
  - 判断材料の並びに重要拠点の優先順位(store/priority.ts)を使う
  - search_trips の nearby_facilities に施設(名前・種類・距離、調査の結果があれば要点)を入れる(tools.test.ts)。claude_tools.json と agents/coordinator.md の説明を直し、server のテストで写しの一致を確かめる
  - 平日便を戻す画面の判断材料の表示に新しい判断材料を出す
  - 変えた定義の ant apply は利用者が手元で行い、DISPATCHER_AGENT_VERSION を直す(手順を書いて渡す)
  - gtfs-reviewer に見てもらう。pnpm test・typecheck・lint・uv run pytest -q が通る
- **決めたこと**:
  - 時間帯の窓は既定値として定数に置く(画面での変更は作らない)

#### T20 README の仕上げと CLAUDE.md の合わせ込み(担当のモデル:sonnet)

- **目標**:提出に向けて README を完成させ、CLAUDE.md を実装と合わせる
- **前に済ませるタスク**:T08、T16、T19
- **触るファイル**:`README.md`、`CLAUDE.md`
- **受け入れ条件**:
  - README から「(開発中)」を外し、公開 URL、審査員向けの認証コードの伝え方、Claude の使い方(Managed Agents の調整役・調査役、6つのツール、開発での Claude Code のフック・Skill・サブエージェント)、Docker での起動、手元で動かす手順(.env.example のコピー、ant apply、参照データの加工)、trip_id の注意の1行、P11・P29・P04 の出典(加工した旨)を書く
  - CLAUDE.md の構成から Dexie.js を外す(利用者が了承した場合)、出典は別ページで出す書き方、手順の並びを実装に合わせる
  - 画面の出典(AboutPage)と README の出典が一致する

#### T21 凍結時点の版でのローカルの Docker 確認と VPS へのデプロイ(担当のモデル:sonnet)

- **目標**:機能凍結の版を dispatcher.turutaru.com に出す
- **前に済ませるタスク**:T08、T15、T16、T17、T18、T19
- **触るファイル**:`compose.yaml`、`deploy/nginx.conf`
- **受け入れ条件**:
  - ローカルで 8000 以外のポートで compose を起動し、サンプルの読み込み・減便の方針の適用・出力 ZIP・前提情報の手順(デモの結果)が動くことを確かめる
  - VPS で起動し、HTTPS で開けること、認証コードが無いと AI の中継が 401 になること、ストリームが切れないこと(nginx の設定)を確かめる
  - 利用者の操作(DNS・証明書・Console の月の上限 200 ドル・本番の環境変数)が済んでいることを確認する

#### T22 提出前チェック(機械的な確認)(担当のモデル:haiku)

- **目標**:公開と提出の前に、キーや既存コードが混ざっていないことを確かめる
- **前に済ませるタスク**:T20
- **触るファイル**:なし
- **受け入れ条件**:
  - git の全履歴で API キーらしい文字列(sk-ant- など)と .env が見つからない(git log -p の走査の結果を報告)
  - 既存の自作アプリ由来のファイルが無いこと(最初のコミットの日付が期間内であることを含む)
  - 画面の運営情報のページと README に出典がそろっている
  - CI が緑

#### T23 (時間があれば)元のダイヤに戻す版の出力(担当のモデル:opus)

- **目標**:減便前のフィードのまま feed_version を新しくし、有効期間を「元のダイヤに戻す日〜入力の末日」にした版を出力できるようにする
- **前に済ませるタスク**:T13、T04
- **触るファイル**:`web/src/gtfs/edit/form2.ts`、`web/src/components/steps/ExportStep.tsx`、`web/src/components/steps/ExportStep.test.tsx`
- **受け入れ条件**:
  - 出力の画面に「元のダイヤに戻す版を出力する」があり、元のダイヤに戻す日を選べる。便は変えず、§5.6・§5.7 の切り詰めと feed_info の規則で出す(form2.test.ts・ExportStep.test.tsx)
  - 検証器(T04)で error が無い
  - 22:00 までに終わらなければ取りやめ、画面の注意文のままにする
- **決めたこと**:
  - T19 と同じ波だが触るファイルは重ならない

## 残りの項目と判断

| 優先度 | 項目 | 判断 |
| --- | --- | --- |
| P0 | 手順をステッパーに分ける(指摘3)・地図の出し分けと幅の調整・出典を運営情報の別ページへ(指摘4)・AI 欄のスクロール(指摘6) | 実装する。ほかの画面のタスクの土台なので wave 1 に置く(T01) |
| P0 | 日付の欄を祝日の色つきカレンダーに替える(指摘1)と、減便の期間がおかしい理由・calendar の日付不正の表示(1104 §13) | 実装する。部品は T03、減便の方針の欄への組み込みと理由の表示は T10、比較する日付の欄は T11 |
| P0 | 減便の方針の「差」の表示の改善と公示第46・47号の説明(指摘2) | 実装する(T09)。先に PolicyStep を分割(T02)して T10 と並行できるようにする |
| P0 | 平日に戻す候補の一覧の整理(指摘5)と休校日運休（学）のチェック | 実装する(T12)。最大間隔は T05 の共通計算を使う |
| P0 | 「日付と時間帯」の設定の置き場所(指摘7) | 実装する(T11)。表示する時間帯は地図の上の操作へ、日付と時間帯の幅は到達圏の手順に統合 |
| P0 | 前提情報の調査:P11・P29・P04 の入手と加工、停留所の外周 +2km の対象抽出 | 実装する(T06) |
| P0 | 前提情報の調査:サーバーのツール3つの中身と POST/GET /api/claude/session/research | 実装する(T07)。target_id の形をこのタスクで先に固定し、T06 と並行させる |
| P0 | 前提情報の調査:画面の手順「前提情報」、施設の地図表示、出典の行(P11・P29・P04)、重要拠点の既定の優先順位 | 実装する(T16)。優先順位は既定の10段階を定数で持ち並べ替え可能に。データの無い種類は「データ未対応」と出す |
| P0 | 前提情報の調査:デモ用の保存済みの結果(origin: demo) | 取り込みの仕組みは T07、画面の選択肢は T16 で作る。中身は本物の調査を1回走らせて作る必要があり費用がかかるので、利用者に確認する(user_questions) |
| P0 | 学校・病院を平日に戻す判断材料につなぐ(nearby_facilities) | 実装する(T19)。claude_tools.json を直すと ant apply が要るので利用者に確認する |
| P0 | GTFS-JP v4 検証器の残りの規則(必須ファイル、時刻・日付の形、stop_sequence、badCalendarDate、feedInfoRows、unusedRoutes・unusedStops、calendarBeyondFeedInfo、stop_id・route_id を変えていないこと) | 実装する(T04) |
| P0 | feed_version の入力欄、trip_id の注意の1行、読み込み時の feed_info 表示 | 実装する(T13)。feed_info 表示は小さいので同じタスクに入れる |
| P0 | 停留所ごとの前後の発車(本数・始発・最終便・最大間隔・新しく加わる/なくなる発車時刻)の共通計算 | 実装する(T05)。指摘5・B の一覧・周知文・変更指示書が共通で使うので wave 1 |
| P0 | Dockerfile・compose・nginx と CI へのビルドの追加 | 実装する(T08)。src を触らないので wave 1 |
| P0 | 閉じ損ねたセッションの予約の扱いと「AI を準備しています…」 | 実装する(T15)。予約の規則は費用に関わるので利用者に確認する。準備中の表示は指示役が決めてよい(出す) |
| P0 | VPS へのデプロイとローカルでの起動の確かめ | 実装する(T21)。DNS・HTTPS・Console の月の上限・本番の環境変数は利用者の操作 |
| P0 | README の仕上げ(公開 URL、認証コードの伝え方、Claude の使い方、Docker、trip_id の注意、P11・P29・P04 の出典)と CLAUDE.md の合わせ込み | 実装する(T20) |
| P0 | 提出前チェック(API キーが履歴に無いこと、既存コードの混入なし、出典の表示) | 実装する(T22) |
| P0 | 公開時の認証コードの範囲(サンプル GTFS・参照データの配信) | 利用者に確認する(user_questions)。推奨どおり対象外なら変更なし。対象にするなら T08 で app.py と LoadStep を直す |
| P0 | リポジトリの公開(turu64/Dispatcher) | T22 の確認のあとに利用者が公開する。時期を確認する(user_questions) |
| P1 | B 停留所ごとの本数・最終便・最大間隔の変化の一覧 | 実装する(T14)。計算は T05 |
| P1 | B 変更指示書(承認した内容を1枚に、画面から PDF に印刷) | 実装する(T17)。補助系統の要件の欄は案なので入れない |
| P1 | B 周知文案(停留所ごとの掲示、代替手段の案内) | 実装する(T18)。代替手段は同じ停留所・近くの停留所に残る自社の便と自由記入で出す(他事業者の合算はしない) |
| P2 | 元のダイヤに戻す版の出力 | 時間があれば作る(T23、wave 4 の最後)。§5.6・§5.7 の切り詰めと feed_info の規則を流用でき、作る量が小さいため。間に合わなければ画面の注意文のまま |
| P2 | 人口による重みづけ | 平日に戻す候補の並びの第2キーに到達圏から外れた区画の人口を使う分だけ T12 で入れる。それ以上(到達圏の比較全体の重みづけ)は見送る:仕様が決まっておらず、凍結まで約3日しかない |
| P2 | 車両運用の推測(必要な車両数の下限) | 見送る:仕様も根拠資料も無く(dia-planning で車両の制約を調べていない)、A・B の残りを優先する |
| P2 | 他事業者の GTFS を合算した代替手段の判定 | 見送る:2つ目のフィードの読み込み・状態・到達圏の作り直しが要り、他事業者の GTFS の入手(利用フォーム)も済んでいない |
| P2 | IndexedDB(Dexie)への保存と画面から消す機能 | 見送る:作るかどうかが未決で、デモに要らない。CLAUDE.md の構成の記述と食い違うので、外してよいか利用者に確認する |
| P2 | 便を指すほかの表(transfers など)を書き換えて減便の方針を適用する | 見送る:道北バスに当たらず、止めているので誤った GTFS は出ない |
| P2 | 比較の初日の前日の扱い | 見送る:道北バスは 24:00 以降の時刻が 0 行で影響しない |
| P2 | §13 のそのほか(出力の読み直しの trip_id、jp_parent_route_id でまとめる、differsOnlyInPickup) | 見送る:道北バスに当たらず、誤った GTFS にはならない |
| P2 | 系統単位で「期間中は走らせない」操作(季節運行の系統) | 見送る:今は PolicyStep の文で促している。新しい EditOp が要り、検証・元に戻すまで広がる |
| P2 | dia-planning の案(オフピーク0回の警告、補助系統の印と要件、季節運行の属性、公示第47号の往路・復路別) | 見送る:取り決めに入っていない案で、入れるには先に仕様を決める必要がある |
| P0 | デモ動画・提出フォームの文面と副題 | コードのタスクではない。機能凍結の後(11/6 夜〜11/7)に利用者と指示役で行う(deferred に記載) |

## 見送るもの

- 車両運用の推測(必要な車両数の下限):仕様も根拠資料も無い
- 他事業者の GTFS を合算した代替手段の判定:2つ目のフィードの読み込みと入手が要る。周知文の代替手段は自社の便と自由記入で代える
- 人口による重みづけのうち、平日に戻す候補の並びの第2キー(T12)より先のもの
- IndexedDB(Dexie.js)への保存と画面から消す機能:未決で、CLAUDE.md の構成の記述と食い違っている(利用者に確認)
- 便を指すほかの表(transfers・attributions・translations)の書き換え:道北バスに当たらず、今は checkPolicy で止めている
- 比較の初日の前日の扱い:道北バスは 24:00 以降の時刻が 0 行
- Dispatcher の出力を読み直したときの trip_id、jp_parent_route_id でまとめる、differsOnlyInPickup:道北バスに当たらない
- 系統単位で「期間中は走らせない」操作(季節運行の系統):今は減便の方針の画面の文で促す
- dia-planning の案(オフピーク0回の警告、補助系統の印と要件、季節運行の属性、公示第47号の往路・復路別):取り決めに入っていない
- 平日に戻す候補と地図の連動(停留所や区画を押して絞り込む)
- カレンダーのセルに各日のダイヤの種類を出すこと
- 重要拠点を手で足す機能(人工透析施設など)と、データの無い種類(空港・福祉施設・役所・商業施設・郵便局・観光地)の参照データ
- 元のダイヤに戻す版の出力(T23)は 11/6 22:00 までに終わらなければ取りやめる
- デモ動画(台本 11/6、収録・音声合成・編集 11/7)と提出フォームの文面・副題:コードの外の作業で、凍結の後に行う。Claude 利用の下書きは Managed Agents に直す
- 利用者の操作:Console のワークスペースの月の上限 200 ドル、VPS の DNS・HTTPS、本番の環境変数、ant apply

## 利用者の決定(11/3)

上の「利用者に伺う点」への答え。

1. **閉じ損ねたセッションの予約**:最後にストリームがつながってから 30 分たった行は、使った額だけを予約に数える((a))。T15 で作る
2. **認証コード**:AI も含めて認証コードなしで公開する。サンプル GTFS・参照データも認証コードなし。費用は、IP ごとの回数・1セッション $3・1日 $6・Console のワークスペースの月の上限 200 ドルで守る。サーバーは、API キーがあって認証コードが無いときに止める今の作り(開発の `DISPATCHER_DEV=1` だけが例外)を、本番で認証コードなしを明示する設定(例 `DISPATCHER_PUBLIC=1`)で通すように直す。`DISPATCHER_DEV` の他の緩み(取っ手の秘密を起動ごとの乱数にするなど)は本番に持ち込まない。T15 で作る。CLAUDE.md と Notion の「認証コード必須」の記述を直す
3. **お問い合わせ**:GitHub の Issues(turu64/Dispatcher)。運営情報のページに載せる
4. **デモ用の調査結果**:本物の調査を1回走らせて作る(道北バスの周辺で 30 件まで、約 $1.2)。T16 の後、11/6 に指示役が行う
5. **学校・病院と AI**:`claude_tools.json` と `agents/coordinator.md` の説明を直し、`ant apply` で調整役の版を上げる(T19)。適用の前に、計画を利用者に見せて承認をもらう
6. **ブラウザ内の保存(IndexedDB・Dexie.js)**:見送る。CLAUDE.md の構成から Dexie.js を外し、Notion の記述も合わせる
7. **リポジトリの公開**:提出の直前(11/7)。公開の操作は利用者が行うか、そのときに指示する

## 利用者に伺う点

- 閉じ損ねたセッション(ブラウザが落ちた、閉じる知らせが届かなかった)の1日の利用額の予約を、どう扱いますか。今は 24 時間の掃除まで残りの予算を予約し続けるので、$6/日では2つ残ると新しい会話を始められません(docs/interfaces-1105.md §9)(推奨:(a)。戻ってきた人が会話を続けられ、費用の上限も守れる。月の上限は Console の 200 ドルで別に守られる)
- 公開するとき、サンプル GTFS のダウンロード(/api/sample-gtfs/download)と参照データ(/api/ref)を認証コードの対象に入れますか(推奨:対象に入れない。どちらも CC BY 4.0・政府標準利用規約で出典を付ければ再配布でき、費用がかかるのは AI の中継だけのため。認証コードを知らない人も地図と編集を試せる)
- 運営情報のページの「お問い合わせ」に何を載せますか(推奨:GitHub の Issues。個人のメールアドレスを出さずに済み、リポジトリの公開と同時に使える)
- デモ用の保存済みの調査結果を作るために、本物の調査を1回(道北バスの周辺で 30 件まで、約 $1.2)走らせてよいですか。出典 URL と確認日時つきの結果が要るため、手書きでは作れません(推奨:走らせる。デモで Web 検索を待たずに見せられ、審査の人が走らせた調査で結果が置き換わることもない(demo の行は上書きされない))
- 学校・病院を平日に戻す判断材料につなぐ(T19)ために、claude_tools.json と agents/coordinator.md の nearby_facilities の説明を直します。直すと ant apply が要り、調整役の版が上がります。手元で ant apply をしてもらえますか(推奨:直して ant apply する。AI が候補の理由に施設名を挙げられ、デモの柱 A4 の「理由つき」が強くなる)
- 編集の履歴などを IndexedDB(Dexie.js)に保存する機能は見送り、CLAUDE.md の構成から Dexie.js を外してよいですか(推奨:見送って外す。デモに要らず、作るかどうかも未決(docs/interfaces-1104.md §13)のまま。今は依存にも入っていない)
- リポジトリ(turu64/Dispatcher)をいつ公開しますか(推奨:凍結と T22 の直後。Notion の決定(必須機能 A がそろったら公開)に沿い、提出の当日に慌てずに済む)
