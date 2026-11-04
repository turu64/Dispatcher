# 11/5〜11/6 の実装タスク(指摘 14〜24)

`docs/review-fixes.md` の 14〜24 をタスクに分けた(指示役、11/5)。調べた3つの領域ごとに番号を分ける:画面は U01〜U10、AI と判断の補助は A01〜A10、要る運転士の数は D01〜D07。同じ波のタスクは同じファイルを触らない。機能凍結は 11/6 22:00。

## 1. 目的と範囲

- **目的**:11/4 夜の Codex のレビュー(GPT-6.1 Sol が、道北バスで運転士 20 人がインフルエンザで欠勤した前提で操作したもの。全文は `~/.codex/sessions/2026/11/04/rollout-2026-11-04T22-45-17-01a1a6ce-904f-71a3-91b2-ea0895bebd29.jsonl`)と、11/5 の利用者の指摘を、凍結までに画面と AI に反映する
- **範囲**:メモの 14〜24
  - 14 Jev に送るかを AlertDialog で聞く、19 グループ分けの入れ替えを減便の方針で選ぶ、20 削除の確かめを AlertDialog に、21 期間の選び方、23 理由の括弧の補足(画面)
  - 15.1〜15.3 Codex が見つけた AI の不具合、18.2〜18.4 往復・学校病院・便の検索の上限(AI と判断の補助)
  - 16 期間の後のダイヤを出力しない、17 時間帯の区切りの統一(画面と AI の両方)
  - 18.1・24 営業運行時間の前後と、要る運転士の数(勤務の数の下限の目安)と欠員の比較
- **22 デモは道北バスだけ**:受け入れ条件の中心は、道北バスのサンプル(`data/raw/gtfs/dohoku_bus_減便前.zip`。置いてあるので `*.verify.test.ts` はスキップされずに走る)で正しく動き、単純な GTFS としての見た目と出力を保つこと。京都市営バス・北海道中央バスなど、ほかの GTFS での動きは確かめない。service_id のグループ分けと複数の組の入れ替えのコードは残す
- 道北バスは単純な GTFS(groups.simple)なので、14(Jev のダイアログ)と 19(入れ替えの手動の欄)は道北バスの画面には出ない。どちらも「道北バスで今の見た目と出力が変わらないこと」を確かめる

## 2. 指摘への決め方(指示役、11/5)

利用者に伺う点(§6)は、推奨で計画を書き、決定が違えば該当のタスクを直す。次は指示役が推奨どおりに決めた。

- **領域をまたぐ食い違いの解き方**
  - onlyTripInBand の名前:U05(「時間帯(3時間ごと)で唯一の便」)と A03(「時間帯の便がなくなる」)が別の名前を挙げた。A03 の名前を採る(「唯一」が 15.3 の誤りの元なので外す)。判定の区切りは U05 の3時間ごと。A03 の band の名前は diff.ts の START_BANDS(3時間ごと)から作り、NOTICE47_BANDS は使わない。U05 は onlyTripInBand・onlyServiceAtStop の判定だけを直し、この2つの名前は変えない(evening の名前「夕方・夜(15〜21時)」は U05 が直す)
  - A10 の search_trips の説明は「その系統の公示第47号の時間帯」ではなく「その系統の時間帯(3時間ごと)」と書く(17 の決定に合わせる)
  - A04(往復)の帰りの窓 [15:00, 21:00) は、17 の evening の区切り(D5 の 15〜21時)と同じ。どちらかを「直す」ことはしない。行きの窓 [6:00, 9:00) も morning と同じ
  - ツールの定義(claude_tools.json・coordinator.md)を変えるタスク(U06・A10・D06)は、すべて A10 の担当が W5 でまとめて行い、ant apply を1回にする(調整役の版 3 → 4)。U06 と D06 は番号を残し、中身は A10 が実行する
  - claude/tools.ts は U04(W3)→ A07(W4)→ A10(W5)の順に1つずつ直す。D06 の結果の追加(summarize_impact の drivers)は A10 が行う
  - 文書は、D07 のうち CLAUDE.md・README・wording.md の分を U10 にまとめる(W5)。D07 の推定の取り決め(docs/interfaces-1105.md)は、A10 がこのファイルを直した後の W6 で書く
  - D05 の地図の層は map/FacilityLayer.tsx の MapOverlays(registry.ts が読み込む)に差し込む。ファイルの一覧に足した
- **画面**
  - D3(19 の手動の欄):平日の側の service ごとに「入れ替える/入れ替えない」と、入れ替え先1つ(土曜/日祝の service、または「便をなくす」)を選ぶ。自動の案で入れ替え先が複数あれば「03001 ほか 1」と出す。値は今の GroupEdit(into・treatment)に変えて渡し、gtfs/groups は変えない
  - D6(17):到達圏を使う判断材料(onlyServiceAtStop・restoresLostCells)は地図の時間帯の幅に従い、平日便を戻す手順に今の幅(3時間・1時間)を出す
  - D8(21):日を押したら Popover を閉じて穴に焦点を戻す。終了日は開始日より前を選べない。開始日を終了日より後にしたら終了日を空にし、文の下に「終了日を選んでください」と出す。「終了日」を選んだらすぐにカレンダーを開く
  - D9(23):「その他」のときは文の中の入力欄が理由そのもので、括弧は出さない。変更指示書の「メモ」を「補足」に改める。値の形({category, note})は変えない
- **AI と判断の補助**
  - 15.1:発言を送らずに保存済みの調査結果の対象をセッションに登録する経路(POST /api/claude/session/research/known)を作り、セッションを作るたび・結果が増えるたびにブラウザが登録する。今の POST /api/claude/session/research を使うと START_LINE が会話に入り、調整役の「調査を始めたときだけ調べる」規則が動いてしまう
  - 15.2:1回の発言のツールの上限は 12 回のまま。止めた知らせを1回にし、「続きを頼む」と search_trips の offset・hints で呼び出しを減らす。上限を上げると1セッションの上限額(3 ドル)に近づきやすい
  - 18.2:往復の方向は、始発・終着の停留所名(NFKC にして空白を除く)の組で照らす。道北バスは direction_id も parent_station も空で、stop_id では向かい合う停留所を照らせない(逆向きが見つかる系統は、停留所名で 49、stop_id で 17)。日付は地図の操作盤の比較する日付
  - 18.3:学校・病院ごとの、始業・受付の窓に着く便と帰りの窓に出る便の前後の一覧と、判定しないこと(乗車人数・混み具合・鉄道の乗り継ぎ)の断り書きまで。駅の一覧と輸送力の目安は入れない(根拠のデータが無い)
  - 18.4:search_trips の入力に offset(続きから)と hints(判断材料で絞る)を足す。件数の上限は 50 のまま(20KB の上限で、件数を増やしても便が省かれる)
- **要る運転士の数**:欠員の人数は、影響(到達圏)の手順の欄に独立の数の入力欄を置いて入れる(23 の括弧の補足の自由な文からは読まない)。画面に出す場所は影響(到達圏)の手順の新しい欄と、変更指示書・平日便を戻す手順の1行(7つ目の手順は足さない)。AI には既存の summarize_impact の結果で見せる(ツールは6つのまま)

## 3. タスク

各タスクの「受け入れ条件」の末尾の検査(pnpm test・typecheck・lint・build、uv run pytest -q)は、そのタスクが触る側で通す。GTFS の編集・出力・判断材料のコードを変えるタスクは、gtfs-reviewer で確かめる。

### 波 1(11/5 朝〜昼)

#### U01 shadcn の AlertDialog を入れる(指摘14・20の土台)(担当のモデル:haiku)

- **触るファイル**:`web/src/components/ui/alert-dialog.tsx(新規)`、`web/src/components/ui/alert-dialog.test.tsx(新規)`
- **受け入れ条件**:
  - `pnpm exec shadcn add alert-dialog` で入れる。新しい依存パッケージは足さない(radix-ui は導入済み)
  - AlertDialogAction と AlertDialogCancel が今の Button の variant を受け取れる(削除の確かめで destructive を使う)
  - alert-dialog.test.tsx で、開くと role=alertdialog になり最初の焦点が取り消しのボタンに来ること、Escape と取り消しで閉じること、閉じたら開いたボタンに焦点が戻ることを確かめる
  - ほかの InlineConfirm(ApprovalPanel・RestoreStep・PolicyForm の AI の下書きの破棄)は変えない。pnpm test・typecheck・lint・build が通る
- **依存**:なし。**大きさ**:S

#### U05 時間帯の区切りを到達圏の3時間ごとにそろえる(公示第47号の表だけは例外として書く)(指摘17)(担当のモデル:opus)

- **触るファイル**:`web/src/gtfs/edit/restore.ts`、`web/src/gtfs/edit/restore.test.ts`、`web/src/gtfs/edit/restore.verify.test.ts`、`web/src/gtfs/edit/diff.ts`、`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/RestoreStep.test.tsx`、`web/src/components/steps/restore/grouping.ts`、`web/src/components/steps/restore/grouping.test.ts`、`web/src/components/steps/policy/DiffTables.tsx`、`web/src/components/steps/policy/DiffTables.test.tsx`、`web/src/components/output/ChangeOrder.tsx(3. の見出しの下の1文だけ)`、`web/src/components/output/ChangeOrder.test.tsx`
- **受け入れ条件**:
  - diff.ts が、3時間ごとの始発の時間帯(START_BANDS と startBandOf)を export する。RestoreStep.tsx:145-155 の手で写した startBandOf と START_BAND_ORDER をやめ、これを使う
  - onlyTripInBand は notice47BandOf ではなく3時間ごとの時間帯で判定する。名前(RESTORE_HINT_LABELS)は変えない(A03 が直す)
  - morning は [6,9) のまま。evening は 15〜21時(D5)にし、RESTORE_HINT_LABELS の名前を「夕方・夜(15〜21時)」にそろえる
  - onlyServiceAtStop・restoresLostCells は地図の時間帯の幅で判定する(D6)。平日便を戻す手順の判断材料の説明に、今の幅(3時間・1時間)を出す
  - 公示第47号の区分は、DiffTables の届出の目安の表と変更指示書の 3. だけに残す。どちらにも「この表だけは公示の区分(6〜9時台は 6:00〜9:59)で数えます。ほかの表と地図は3時間ごとです」の1文を足す
  - FACILITY_WINDOWS と調べた結果の窓は変えない
  - restore.test.ts・RestoreStep.test.tsx・DiffTables.test.tsx・ChangeOrder.test.tsx・grouping.test.ts を直す。restore.verify.test.ts(道北バス)で数が変わる判断材料は、変わった理由をテストのコメントに書く。出力 GTFS は変わらない(form2.verify.test.ts と write.verify.test.ts が通る)
  - AI の説明の文は直さない(A10)。gtfs-reviewer で確かめる。pnpm test・typecheck・lint が通る
- **依存**:なし(§6 の2の決定)。**大きさ**:M

#### U07 減便の期間:終了日を「当面の間/終了日」のセレクトにし、カレンダーは日付を選ぶだけにする(指摘21)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/policy/PeriodFields.tsx`、`web/src/components/steps/policy/periodRange.ts`、`web/src/components/steps/policy/periodRange.test.ts`、`web/src/components/steps/policy/PolicyForm.tsx(PeriodHoles への渡し方と、期間が決まらないときの文だけ)`、`web/src/components/steps/PolicyStep.test.tsx`、`web/src/components/steps/EditFlow.test.tsx(期間の操作の所だけ)`
- **受け入れ条件**:
  - 文は「[開始日] から [当面の間▼]、」と「[開始日] から [終了日▼] [11月14日(土)] までの間、」。終了日の穴は Select(「当面の間」「終了日」)。「終了日」を選ぶと右に日付の穴が出て、カレンダーの Popover が開く
  - Popover の中身は HolidayCalendar だけにする(当面の間のチェック、periodHint、describePeriod、選べる範囲の文、「期間を選び直す」「閉じる」をなくす)。日を押すと日が入り、Popover を閉じ、焦点を穴に戻す(D8)
  - 開始日のカレンダーは入力の有効期間の中で選べる。終了日のカレンダーは開始日より前を選べない(min=開始日)。開始日を終了日より後にしたら終了日を空にし、文の下に「終了日を選んでください」と出す
  - nextPeriod と nextPeriodFor のうち使わなくなるものをテストごと消す。periodDays は残す
  - PolicyForm.tsx の「…当面の間にしてください」の文を新しい選び方に合わせる。初めて開いたときは当面の間。承認済みの方針や AI の下書きに終了日があれば「終了日」とその日を出す
  - 祝日・土日の色、範囲の外を選べないこと、PeriodChecks(出力の有効期間と期間の中の祝日の文)は変えない
  - PolicyStep.test.tsx で、当面の間 → 終了日 → 日付を押す → Escape、開始日を終了日より後にする、AI の下書き(終了日つき)を開く、を確かめる。EditFlow.test.tsx の期間の操作(258〜264 行あたり)を新しい形に直す
  - 道北バスの既定(今日から当面の間)の文と出力は今と同じ。pnpm test・typecheck・lint が通る
- **依存**:なし。**大きさ**:M

#### U09 期間の後のダイヤを出力しない決定に合わせ、元のダイヤに戻す版をなくし、期間の後の注意を言い直す(指摘16)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/ExportStep.tsx`、`web/src/components/steps/ExportStep.test.tsx`、`web/src/components/steps/revertServices.ts(削除)`、`web/src/components/steps/revertServices.test.ts(削除)`、`web/src/gtfs/edit/form2.ts(applyRevert)`、`web/src/gtfs/edit/form2.test.ts`、`web/src/gtfs/edit/form2.multi.test.ts`、`web/src/gtfs/validate/edit.ts(form2Texts の期間の後の1文)`、`web/src/gtfs/validate/edit.test.ts`、`web/src/store/reset.ts(コメントだけ)`
- **受け入れ条件**(§6 の4で (a) のとき):
  - ExportStep から RevertExport・RevertBody と、戻す版の関数(defaultRestoreFrom・revertIssues・revertTimingNotices・revertTexts・revertAttributionOf・revertFileName)をなくす。ExportStep.tsx:293 で足している文もなくす。revertServices.ts と applyRevert をテストごと消す
  - form2Texts の終了日ありの文を次の旨にする:「{翌日} 以降は出力に含まれず、経路検索に便が出なくなります。元のダイヤには自動で戻りません。Dispatcher は期間の後のダイヤを出力しないため、期間が終わる前に、事業者のふだんの手順で元のダイヤの GTFS を公開し直してください。元の ZIP は保存しておいてください」。当面の間の文は変えない
  - 周知文の「元のダイヤに戻す予定」は変えない
  - 道北バスで当面の間のときの出力 ZIP は変わらない(form2.verify.test.ts・write.verify.test.ts が通る)。終了日ありの出力は、文のほかは変わらない
  - gtfs-reviewer で確かめる。pnpm test・typecheck・lint・build が通る
  - (b) のときは form2Texts の文だけを直し、戻す版は残す
- **依存**:なし(§6 の4の決定)。**大きさ**:M

#### A01 止めた知らせ(too_many_tool_calls)と user.interrupt を、1回の発言につき1回だけ出す(サーバー)(指摘15.2)(担当のモデル:sonnet)

- **触るファイル**:`server/src/dispatcher_server/agent_session.py`、`server/tests/test_agent_wire.py`
- **受け入れ条件**:
  - SessionState に「この発言で止めた」印を持たせ、user.message で戻す(observe)。履歴から作り直す rebuild でも、最後の user.message の後に送った interrupt があれば印を立てる
  - settle は over_limit の呼び出しに MSG_TOO_MANY_CALLS の is_error で答え続ける。error の frame(code too_many_tool_calls)と user.interrupt は、印が立っていない最初の1回だけ付ける。events.send が APIError で届かなかったときは印を戻す
  - error の data に limit(12)を足す。文は「AI がこの相談でツールを 12 回使ったので、ここで止めました。続けるときは「続きを頼む」を押してください」の形にし、wording.md の規則に合わせる
  - test_agent_wire.py:12 回のあとに agent.custom_tool_use が4件(並行の呼び出し)届いても、error の frame と interrupt は1つずつで、4件すべてに is_error の結果を返す。次の user.message の後に上限を超えたら、また1回出る
  - MAX_BROWSER_CALLS_PER_MESSAGE は 12 のまま。uv run pytest -q(server)が通る
- **依存**:なし。**大きさ**:S

#### A02 会話の行を送らずに、保存済みの調査結果の対象をセッションに登録する経路を作る(指摘15.1)(担当のモデル:sonnet)

- **触るファイル**:`server/src/dispatcher_server/agent_relay.py`、`server/src/dispatcher_server/research.py`、`server/src/dispatcher_server/store.py`、`server/tests/test_agent_relay.py`、`server/tests/test_research.py`、`server/tests/test_store.py`、`web/src/claude/research.ts`、`web/src/claude/research.test.ts`
- **受け入れ条件**:
  - POST /api/claude/session/research/known(本文は target_ids だけ)を足す。取っ手と認証は start_research と同じ。user.message は送らず、_check_message_limits も数えない
  - target_ids は 1〜MAX_RESULT_IDS(50)件の文字列。参照データに無い ID は 400。使える結果(origin demo、または期限の切れていない web)がある ID だけを登録する。今の対象は消さずに後ろへ足し、重なりは除く
  - store.py に、置き換えずに足す関数を作る(set_research_targets はそのまま)。返答は {registered, total}
  - デモの行を seed → known で登録 → run_tool('get_research_results', {target_ids: null}) で結果が返ることを確かめる。登録前は空。結果の無い ID・参照データに無い ID・取っ手の無い要求の扱いも確かめる。ログには数だけを残す
  - web/src/claude/research.ts の ResearchApi に registerKnown(targetIds) を足し、research.test.ts で送る本文と失敗(ClaudeRequestError)を確かめる
  - ツールの定義は変えない(A10)。uv run pytest -q、pnpm test・typecheck・lint が通る
- **依存**:なし。**大きさ**:M

#### A04 系統の方向ごとの始発・終発と、帰りの方向の便の欠けを数える純粋な関数(指摘18.2)(担当のモデル:opus)

- **触るファイル**:`web/src/gtfs/edit/roundTrip.ts(新規)`、`web/src/gtfs/edit/roundTrip.test.ts(新規)`、`web/src/gtfs/edit/roundTrip.verify.test.ts(新規)`
- **受け入れ条件**:
  - roundTripCheck(base, edited, date, options) を作る。方向は始発・終着の停留所名(NFKC にして空白を除く)の組。逆向きは同じ系統 → ほかの系統の順に探し、どこにも無い系統(循環・片道)は noReverse として数だけ返す
  - 方向ごとに減便前と減便後の便数・始発時刻・終発時刻を返す。問題は4種類:directionVanishes(前 1 便以上、後 0 便)、noReturn(後に行きの方向に朝の窓 [6:00, 9:00) の便があり、逆向きに帰りの窓 [15:00, 21:00) の便が 0。前は 1 便以上あったときだけ)、lastEarlier(終発が 30 分以上早まる)、firstLater(始発が 30 分以上遅くなる)
  - 窓とずれの分数は options で渡せる。既定の窓は 17 の morning・evening と同じ(§2)
  - 比較する日付に平日ダイヤが走らないときは、理由つきの空の結果を返す
  - roundTrip.test.ts:同じ系統の往復、別の系統の逆向き、循環、朝だけ残して帰りが 0、名前は同じで stop_id が違う停留所
  - roundTrip.verify.test.ts(道北バス。zip が無ければスキップ):平日を土曜ダイヤにした減便後で、逆向きのある系統 49(同じ系統 42、ほかの系統 7)、noReverse 16 を確かめ、問題の数を報告する
  - gtfs-reviewer で確かめる。pnpm test・typecheck・lint が通る
- **依存**:なし。**大きさ**:M

#### A05 学校・病院ごとに、始業・受付の窓に着く便と帰りの窓に出る便の前後を数える純粋な関数(指摘18.3)(担当のモデル:sonnet)

- **触るファイル**:`web/src/gtfs/edit/facilityAccess.ts(新規)`、`web/src/gtfs/edit/facilityAccess.test.ts(新規)`
- **受け入れ条件**:
  - facilityAccess(base, edited, date, facilities, stops) を作る。facilities は restore.ts の HintFacility(型を読むだけ。restore.ts は U05 が同じ波で直すので触らない)
  - 施設の徒歩圏の乗り降りできる停留所に、着く窓の中に着く便と、出る窓の中に出る便を、前後で数える。施設ごとに便の数、窓の中で最も遅く着く時刻・最も早く出る時刻(前後)、窓と出どころ(調べた結果/既定)を返す
  - 問題は arriveLost(着く便が前 1 以上・後 0)と departLost(出る便が前 1 以上・後 0)。施設の優先順位(priority_rank)、距離の順に並べる
  - 返す値の note に「窓は、決めた時刻に間に合う時間帯の目安で、乗り継ぎ・混み具合は見ない」旨を入れる
  - facilityAccess.test.ts:調べた窓の病院、既定の窓の学校、徒歩圏に停留所が無い施設、乗り降りできない行。data/demo/research_dohoku.json の病院の受付時間を写したフィクスチャも使う。駅は入れない
  - pnpm test・typecheck・lint が通る
- **依存**:なし。**大きさ**:M

#### D01 減便前・減便後の平日の営業運行時間の総量と削減量を出す純粋な関数(指摘18.1)(担当のモデル:sonnet)

- **触るファイル**:`web/src/gtfs/edit/serviceHours.ts(新規)`、`web/src/gtfs/edit/serviceHours.test.ts(新規)`、`web/src/gtfs/edit/serviceHours.verify.test.ts(新規)`
- **受け入れ条件**:
  - フィードとその日に走る service の集合(lib/serviceDay.ts で日付から求める)から、便の数・営業運行時間の合計(分。restoreTotals と同じ数え方)・時刻が読めない便の数・最初の出発と最後の到着('HH:MM')を返す関数と、前後を受けて前・後・削減量(分と割合)を返す関数
  - 便を時刻順の区間({tripId, dep 秒, arr 秒, firstStopId, lastStopId})にする関数も同じファイルに置く(D02 が使う。stop_times の索引は1回だけ作る)
  - serviceHours.test.ts:空の時刻・24時を超える時刻・その日に走らない service の除外
  - serviceHours.verify.test.ts(zip が無ければスキップ):9/17版 平日 447 便 400.7h(06:10〜22:37)、土曜 361 便 337.2h、10/29版 平日 381 便 351.8h(±0.1h)
  - restoreTotals と画面は変えない。pnpm test・typecheck・lint が通る
- **依存**:なし。**大きさ**:S

### 波 2(11/5 午後〜夕方)

#### U02 Jev に送るかを、規則で決まらないときだけ AlertDialog で聞く(自動で送るのをやめる)(指摘14)(担当のモデル:sonnet)

- **触るファイル**:`web/src/store/serviceGroups.ts`、`web/src/store/serviceGroups.test.ts`、`web/src/components/steps/load/JevConsentDialog.tsx(新規)`、`web/src/components/steps/load/ServiceGroupsCard.tsx`、`web/src/components/steps/load/ServiceGroupsCard.test.tsx`、`web/src/components/steps/load/serviceGroupsText.ts`、`web/src/components/steps/load/JevSwitch.tsx(削除)`、`web/src/components/steps/LoadStep.tsx(JevSwitch の import と描画の1行を消すだけ)`、`web/src/components/steps/LoadStep.test.tsx`
- **受け入れ条件**:
  - store:JevState に「利用者の答えを待つ」状態(awaitingConsent)を足す。runJev は simple・buildJevRequest===null の分かれ道を今のまま通り、送る直前(checking の前)で止まる。acceptJev() で checking→sending、declineJev() で off にし、message「Jev に送らず、規則だけで分けました。」を出す。askJev は awaitingConsent でも受け付ける。読み込み直しと削除(reset)ではこの状態を捨てる
  - jevEnabled・setJevEnabled・JevSwitch.tsx をなくし、LoadStep から JevSwitch を外す(§6 の5)
  - JevConsentDialog(U01)は awaitingConsent のときに開く。書くこと:規則で決まらない service の数、送り先(JEV_DESTINATION)、送る情報(JEV_SENT_SCOPE。系統名・行き先を含む service ごとの集計)、経路(JEV_ROUTING_NOTE)、上限で問い合わせない数(omitted)。ボタンは「Jev に送る」「送らずに規則だけで進める」。断ったあとも JevPanel の「Jev に問い合わせる」から送れる。「今後は聞かない」は付けない
  - 道北バス:groups.simple のため notNeeded のままで、ダイアログは出ない。読み込みの手順の見た目は、スイッチが消えることのほかは変わらない(単純な GTFS で role=alertdialog が無いことをテストで確かめる)
  - serviceGroups.test.ts で、単純でない GTFS では答えの前に fetchStatus・judge が呼ばれないこと、accept で呼ばれること、decline で呼ばれずに off になること、待っている間に reset されたら何も送らないことを確かめる
  - 運営情報の「データの送り先」は、送ったとき(sent)だけ出るまま。pnpm test・typecheck・lint・build が通る
- **依存**:U01。**大きさ**:M

#### U08 減便の理由の直後に、括弧で補足を書けるようにする(指摘23)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/policy/PolicyForm.tsx(ReasonHole と、文の下の補足の欄)`、`web/src/components/steps/PolicyStep.test.tsx`、`web/src/components/output/ChangeOrder.tsx(「メモ」の欄の名前だけ)`、`web/src/components/output/ChangeOrder.test.tsx`
- **受け入れ条件**:
  - 区分(3つ)を選ぶと、理由の Select の直後に「(」入力欄「)」が出る(placeholder「補足(任意)例:インフルエンザ 20 人」、aria-label「減便の理由の補足」、field-sizing で書いた長さに合わせる)。文の下の補足の欄(PolicyForm.tsx:304-323)はなくす
  - 「その他」のときは文の中の入力欄が理由そのもので、括弧は出さない(D9)。区分とその他を切り替えても、補足とその他の文は互いに持ち越さない
  - 値の形({category, note})と承認の欄の「区分(note)」は変えない。変更指示書の欄の名前「メモ」を「補足」にする
  - PolicyStep.test.tsx で、区分を選ぶ → 括弧の中に書く → 対象便を確かめる、で reason.note に入ること、その他のときに括弧が出ないこと、AI の下書きの note が括弧に入って開くことを確かめる
  - 道北バスで理由を選ばないときの見た目は変わらない。pnpm test・typecheck・lint が通る
- **依存**:U07(PolicyForm.tsx・PolicyStep.test.tsx の順)、U05(ChangeOrder.tsx の順)。**大きさ**:S

#### A03 判断材料の名前から「唯一の便」をやめ、時間帯と系統の便数をコードが出す(指摘15.3)(担当のモデル:opus)

- **触るファイル**:`web/src/gtfs/edit/restore.ts`、`web/src/gtfs/edit/restore.test.ts`、`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/RestoreStep.test.tsx`、`web/src/components/steps/restore/TripLine.tsx`、`docs/wording.md(判断材料の名前の行だけ)`
- **受け入れ条件**:
  - 識別子(onlyTripInBand・onlyServiceAtStop など)は変えない
  - RESTORE_HINT_LABELS:onlyTripInBand は「時間帯の便がなくなる」、onlyServiceAtStop は「停留所の発車がなくなる」。RestoreStep.tsx の説明文の「停留所で唯一の便」もそろえ、wording.md の該当の行も直す
  - RestoreHintDetail に2つを足す。band:onlyTripInBand のときに {label: U05 の3時間ごとの時間帯の名前(START_BANDS。例「6〜9時」), before: その系統・時間帯の減便前の平日の便数, after: 減便後の便数}。ほかは null。routeTrips:{before, after}(その系統の平日の便数)
  - hintSentence(hint, detail) を export する。例:「6〜9時に、この系統の便が減便後 0 便になります(減便前 3 便)」「系統の平日の始発です(系統の平日 11 便。方向は分けていません)」。数はすべて detail から入れる
  - TripLine の判断材料に時間帯の名前を添える(例「時間帯の便がなくなる(6〜9時)」)
  - restore.test.ts:同じ系統・同じ時間帯の 3 便がすべてなくなるとき、3 便とも onlyTripInBand で band.before=3・after=0。1 便でも残れば付かない。routeTrips が平日の便数と合う
  - gtfs-reviewer で確かめる。pnpm test・typecheck・lint が通る
- **依存**:U05。**大きさ**:M

#### A06 チャットの store:セッションを作るたびに調査結果の対象を登録し、[画面の状態] に前提情報の行を足す。止めた知らせを1つにし、「続きを頼む」を付ける(指摘15.1・15.2)(担当のモデル:sonnet)

- **触るファイル**:`web/src/store/chat.ts`、`web/src/store/chat.test.ts`、`web/src/claude/screenLines.ts`、`web/src/claude/screenLines.test.ts`、`web/src/components/chat/ChatMessages.tsx`、`web/src/components/chat/ChatPanel.test.tsx`
- **受け入れ条件**:
  - 前提情報の store に結果がある target_id(デモと Web の両方)を registerKnown(A02)で登録する。登録するのは、session.start() が created を返したとき(予算に達して新しく始めたときも)と、セッションがある間に結果が増えたとき。同じセッションに同じ集まりを2度送らない。失敗しても送信は止めず、researchError に短い文を出す。research store は deps(knownResearchTargets)で渡し、循環 import を作らない
  - ScreenState に research を足し、stateLines に「[画面の状態] 前提情報:調査の結果 30 件(保存済みの結果(デモ)を含む)。get_research_results で読めます。」を足す。件数が変わったときだけ送る。0 件なら出さない
  - error の code too_many_tool_calls を受けたら知らせを1件だけ出す。同じ発言の中で続いても重ねない。そのあと idle の reason interrupted が来ても「止めました」を足さない
  - その知らせに「続きを頼む」ボタンを付ける。押すと「続けてください。」を送り、extraLines に「[画面の操作] 利用者が、止まった作業の続きを頼みました。」を入れる
  - chat.test.ts:デモを読み込んでから最初の発言をしたときに登録 → 送信の順、作り直したときにまた登録、error が4回来ても項目は1つで「止めました」が出ない、「続きを頼む」の送信。screenLines.test.ts に前提情報の行。ChatPanel.test.tsx でボタンの表示と送信
  - pnpm test・typecheck・lint が通る
- **依存**:A01、A02。**大きさ**:L

#### D02 その日に要る勤務の数の下限の目安を出す推定の関数と、入力の運用番号の数(参考)(指摘24)(担当のモデル:opus)

- **触るファイル**:`web/src/gtfs/edit/duties.ts(新規)`、`web/src/gtfs/edit/duties.test.ts(新規)`、`web/src/gtfs/edit/duties.verify.test.ts(新規)`
- **受け入れ条件**:
  - estimateDuties(legs, stopCoords, params, places?) を作る。便を出発の秒の順(同じなら trip_id の昇順)に並べ、条件を満たす勤務のうち最後の便の到着が最も遅いものに足し、無ければ新しい勤務を作る(何度動かしても同じ結果)
  - つなぎの条件:同じ停留所(停留所名が同じか 300m 以内)は折り返し 5 分以上。別の停留所は折り返し+回送(直線距離×1.3 を 20km/h)。回送は運転時間に入れる
  - 法令の条件(既定値、params で変えられる。改善基準告示 第5条。`docs/research/dia-planning.md` 4.5・4.6):拘束(出庫前の点呼 30 分〜入庫後の点呼 15 分。営業所があれば最寄りの営業所との回送を足す)13 時間以内(15 時間に切り替え可)、運転 9 時間以内、連続運転 4 時間以内で 10 分以上のすき間の合計 30 分で連続を戻す。places に休憩施設があれば、休憩施設・営業所の 300m 以内のすき間だけを休憩に数える(既定はどこでも休憩)。事業場外の休憩 3 時間の上限は任意の条件(既定は使わない)
  - 結果:勤務の数、勤務ごとの拘束・運転・便の数・始まり/終わりの停留所、使った仮定の一覧(画面と変更指示書にそのまま出せる形)、車両の数の下限(回送ありで便をつないだ数と、同時に営業運行中の便の最大)
  - operatorRunsOf(feed, serviceId):trip_id が5つの部分で4つ目が service_id の形(interfaces-1104 §5.4)のときだけ先頭の部分の種類の数を返し、それ以外は null(減便前の入力にだけ使う参考の値)
  - duties.test.ts:拘束の上限で分かれる、連続 4 時間で分かれる/30 分の休憩でつながる、回送が間に合わないと分かれる、休憩施設の外のすき間は休憩に数えない、入力の順を変えても同じ結果
  - duties.verify.test.ts(zip が無ければスキップ):9/17版 平日 75〜90、土曜 50〜65、10/29版 平日 60〜75、平日→土曜の差 18〜32(試算は 82・57・68)。operatorRunsOf が 101・72・86
  - pnpm test・typecheck・lint が通る
- **依存**:D01。**大きさ**:M

### 波 3(11/5 夜〜11/6 朝)

#### U03 「読み込んだ GTFS を削除」の確かめを AlertDialog にする(指摘20)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/LoadStep.tsx`、`web/src/components/steps/LoadStep.test.tsx`、`web/src/components/steps/loadText.ts`、`web/src/App.test.tsx(削除の操作の所だけ)`
- **受け入れ条件**:
  - 削除のボタンで AlertDialog(U01)が開く。見出し「読み込んだ GTFS を削除しますか」、本文は今の deleteConfirmMessage、ボタンは「削除する」(destructive)と「やめる」
  - InlineConfirm と confirmingDelete の下の欄は LoadStep からなくす。削除したら焦点を「ファイルを選ぶ」に移し、やめたら削除のボタンに戻す。読み込みを始めたらダイアログを閉じる
  - LoadStep.test.tsx を role=alertdialog で書き直す:削除する → resetAll('delete') と同じ初期化、やめる → 何も消えない。App.test.tsx の「読み込んだ GTFS を削除したら…」をダイアログの「削除する」を押す形に直す
  - 道北バスのサンプルを読み込んだときの見た目は、削除のボタンを押すまで変わらない。pnpm test・typecheck・lint が通る
- **依存**:U01、U02(LoadStep.tsx の順)。**大きさ**:S

#### U04 グループ分けの入れ替えの設定を減便の方針の詳しい設定へ移す。既定は案のまま一括で入れ替え、手動では service ごとに選ぶ(指摘19)(担当のモデル:opus)

- **触るファイル**:`web/src/components/steps/load/ServiceGroupsCard.tsx`、`web/src/components/steps/load/ServiceGroupsCard.test.tsx`、`web/src/components/steps/load/serviceGroupsText.ts`、`web/src/components/steps/policy/GroupReplaceFields.tsx(新規)`、`web/src/components/steps/policy/GroupReplaceFields.test.tsx(新規)`、`web/src/components/steps/policy/PolicyForm.tsx`、`web/src/components/steps/PolicyStep.groups.test.tsx`、`web/src/store/serviceGroups.ts`、`web/src/store/serviceGroups.test.ts`、`web/src/gtfs/groups/view.ts(groupedPolicyServices の confirmed の引数だけ)`、`web/src/gtfs/groups/view.verify.test.ts`、`web/src/components/steps/stepIds.ts`、`web/src/claude/tools.ts(groupsUnconfirmedNote だけ)`、`web/src/claude/tools.groups.test.ts`、`web/src/claude/screenLines.ts(未確定の行だけ)`、`web/src/claude/screenLines.groups.test.ts`
- **受け入れ条件**:
  - 読み込みの手順:ServiceGroupsCard は分けた結果だけを読める形で出す(service_id・平日/土曜/日祝の側・走る日・便数・印・判断材料の開閉、Jev の欄)。扱い・入れる先の Select、「Jev の値を使う」「規則の値のまま進める」「案に戻す」、「このグループ分けで進める」は出さない
  - 確定のしくみをなくす(§6 の5)。groupedPolicyServices は confirmed を見ず、Jev の答えを待っている間だけ unconfirmed にする。store の confirm・tableRequest・showTable・UNCONFIRMED_BY_JEV、stepIds の jumpToServiceGroups とその3つのボタン、PolicyForm の groups-unconfirmed の警告を消すか言い換える
  - 減便の方針の詳しい設定(groupMode のとき):GroupReplaceFields に「自動(グループ分けのとおり。既定)」と「手動で選ぶ」を置く。自動では今の PairList を出す。手動では、今の方針の種類について、平日の側の service(weekdayOnly・unsupported)ごとに「入れ替える/入れ替えない」と入れ替え先(D3)を選ぶ。値は store.edit(GroupEdit の into・treatment)に変えて渡し、gtfs/groups の rules・edit・policy は変えない。食い違いの行の「規則の値のまま進める」「案に戻す」は手動の欄に移す
  - 決まらない行(undecided)があるときは、今の groupErrors(undecidedReplacement)の文と「手動で選ぶ」を開くボタンを出す
  - tools.ts の groupsUnconfirmedNote と screenLines の未確定の行を、Jev を待っている間だけに直す
  - 道北バス:groupedPolicyServices が null のままで、減便の方針の手順は今の ServiceSelect の形。出力は変わらない(form2.verify・view.verify・rules.verify・write.verify が通る)。読み込みの手順は要約の1行と「表を開く」のまま、表が読む専用になるだけ
  - PolicyStep.groups.test.tsx に、単純でない固定データで、確定を押さずに対象便を確かめられること、手動で入れ替えないにした平日の service が keptWeekdayServices に入ること、手動で入れ替え先を変えた組が pairs に出ることを足す
  - gtfs-reviewer で確かめる。pnpm test・typecheck・lint・build が通る
- **依存**:U02、U07、U08(PolicyForm.tsx の順)、A06(screenLines.ts の順)。**大きさ**:L

#### A08 チャットに、AI が確かめた便の件数(対象の件数と確かめた件数)を出す(指摘18.4)(担当のモデル:sonnet)

- **触るファイル**:`web/src/store/chat.ts`、`web/src/store/chat.test.ts`、`web/src/components/chat/ChatMessages.tsx`、`web/src/components/chat/ChatPanel.test.tsx`
- **受け入れ条件**:
  - search_trips が ok のとき、ツールの項目の文を「便を探しました(なくなる便 292 便のうち 50 便)」の形にする。数は結果の total・returned、scope の名前は画面の語
  - 1回の相談(user.message から次の user.message まで)で、scope ごとに AI に返した trip_id の集まりと最新の total を持つ。返答の終わりに「この相談で AI が確かめた便:なくなる便 292 便のうち 100 便」を1行出す。条件を付けずに探した結果があるときだけ出し、条件で絞った結果は件数だけを添える
  - A06 の「続きを頼む」の [画面の操作] の行に、確かめた件数を入れる(例「なくなる便 292 便のうち 100 便を確かめ済み」)
  - chat.test.ts と ChatPanel.test.tsx で、件数の文、相談ごとに数え直すこと、続きの行の件数を確かめる。pnpm test・typecheck・lint が通る
- **依存**:A06。**大きさ**:M

#### A09 手順「平日便を戻す」に、往復の確かめと、学校・病院に着く便の確かめの一覧を出し、判定しないことを断る(指摘18.2・18.3)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/restore/RoundTripPanel.tsx(新規)`、`web/src/components/steps/restore/RoundTripPanel.test.tsx(新規)`、`web/src/components/steps/restore/FacilityAccessPanel.tsx(新規)`、`web/src/components/steps/restore/FacilityAccessPanel.test.tsx(新規)`、`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/RestoreStep.test.tsx`、`README.md(「できないこと」の数行だけ)`
- **受け入れ条件**:
  - RoundTripPanel:今の版(承認待ちの下書きがあれば下書き)と減便前を、比較する日付(地図の下の操作盤)で比べる。行は系統 → 方向(始発 → 終着)ごとに前後の便数・始発・終発。並びは、方向の便がなくなる、帰りの方向の便が 0、終発が早まる、始発が遅くなるの順
  - 行から、その系統の候補のまとまりを開ける(今の CandidateGroups の開き方)。noReverse の系統は「循環・片道のため往復を確かめていない系統 N」と数だけ出す
  - FacilityAccessPanel:施設名・種類・窓(調べた結果/既定)・着く便と出る便の前後の数・最も遅く着く時刻を、arriveLost・departLost の施設から出す。施設を読めていないときは理由を出す
  - 断り書き「乗車人数・混み具合・鉄道との乗り継ぎの時刻は、データが無いため判定していません。窓は始業・受付の時刻からの目安です」を出し、README.md の「できないこと」にも同じ趣旨を書く
  - 比較する日付に平日ダイヤが走らないときは、今の判断材料と同じ形で理由を出す。文は wording.md に従う
  - 新しいテスト2つと RestoreStep.test.tsx で、道北バスに似たフィクスチャの表示・並び・開く操作を確かめる。pnpm test・typecheck・lint・build が通る
- **依存**:A03(RestoreStep.tsx の順)、A04、A05。**大きさ**:M

#### D03 影響(到達圏)の手順に「要る運転士の数(目安)」の欄を足し、欠員の人数を入れて足りるかを出す(指摘24・18.1)(担当のモデル:sonnet)

- **触るファイル**:`web/src/store/drivers.ts(新規)`、`web/src/store/drivers.test.ts(新規)`、`web/src/components/steps/reach/DriverPanel.tsx(新規)`、`web/src/components/steps/reach/DriverPanel.test.tsx(新規)`、`web/src/components/steps/reach/driverText.ts(新規)`、`web/src/components/steps/reach/driverText.test.ts(新規)`、`web/src/components/steps/ReachStep.tsx(差し込みの1行と import だけ)`
- **受け入れ条件**:
  - store/drivers.ts(Zustand、メモリだけ):欠員の人数(その日に乗務できない運転士の数。0〜999 の整数、空も可)、仮定(拘束 13/15 時間、点呼の分、回送の速さ)、営業所・車庫・休憩施設の一覧(型と空の配列だけ。D05 で使う)。GTFS を読み込み直すと欠員と施設は消える
  - DriverPanel:比較する日付の、減便前・減便後の (1) 便の数と営業運行時間の総量・削減量(D01)、(2) 勤務の数の目安と差(D02)、(3) 入力の運用番号の数(減便前だけ、取れたときだけ「参考」)を表で出す。減便後の GTFS が無ければ減便前だけ
  - 欠員を入れると「減便で減る勤務の数(目安)N ≥ 欠員 M → 足りる目安」/「あと K 足りない目安」を出す。判定は差(前−後)と欠員の比較だけ。比較する日付が平日でないときは前後で差が無い旨を出す
  - 断り書き(driverText.ts):下限の目安であること、改善基準告示 第5条の上限(拘束 13 時間・運転 9 時間・連続運転 4 時間)で区切ったこと、休息期間・休日・予備の要員・36協定・実際の仕業と交番は事業者の判断であること、営業所を置かないときは出入庫の回送を 0 としていること
  - 仮定は「仮定を変える」の開閉の中で変えられ、変えると計算し直す
  - 画面の文は wording.md の語に従い「あなた」を使わない。DriverPanel.test.tsx で前後の表・足りる/足りない・平日でない日の文を確かめる。pnpm test・typecheck・lint・build が通る
- **依存**:D01、D02。**大きさ**:M

### 波 4(11/6 午前)

#### A07 AI のツールの結果に、判断材料の文・時間帯・系統の便数と、往復の欠け・学校病院の着く便の欠けを足す(入力は変えない)(指摘15.3・18.2・18.3)(担当のモデル:opus)

- **触るファイル**:`web/src/claude/tools.ts`、`web/src/claude/tools.test.ts`
- **受け入れ条件**:
  - search_trips の便ごとに hint_texts(A03 の hintSentence の文の配列)、band(onlyTripInBand のときの時間帯の名前と前後の便数)、route_weekday_trips(系統の前後の平日の便数)を足す。hints の識別子の配列は残す
  - notes に「判断材料の名前と hint_texts は、時間帯・停留所・系統の全体のどれについての判断材料かを書いたもの。「唯一の便」とは書かず、hint_texts の言い方を使う」を足す
  - summarize_impact に round_trip(A04。種類ごとの件数、上位 20 件に系統・方向・前後の始発と終発、noReverse の系統の数)と facility_access(A05。arriveLost・departLost の施設の上位 20 件と窓・出どころ。施設を読めていなければ null と理由)を足す
  - 20KB を超えないよう、ほかの一覧より先にこの2つの一覧を後ろから省き、省いた数を書く
  - TOOL_INPUT_KEYS と claude_tools.json は変えない(A10)
  - tools.test.ts で、band と hint_texts、round_trip、facility_access、20KB を超えるときの省き方を確かめる。gtfs-reviewer で確かめる。pnpm test・typecheck・lint が通る
- **依存**:A03、A04、A05、U04(tools.ts の順)。**大きさ**:M

#### D04 変更指示書と平日便を戻す手順に、営業運行時間の前後・勤務の数の目安・欠員を載せる(指摘24・18.1)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/output/DriverSummary.tsx(新規)`、`web/src/components/output/DriverSummary.test.tsx(新規)`、`web/src/components/output/ChangeOrder.tsx(差し込みの数行と import だけ)`、`web/src/components/output/ChangeOrder.test.tsx`、`web/src/components/steps/RestoreStep.tsx(差し込みの1行だけ)`、`web/src/components/steps/RestoreStep.test.tsx`
- **受け入れ条件**:
  - DriverSummary:営業運行時間の前・後・削減量、勤務の数の目安の前・後・差、欠員の人数(入れたときだけ)と判定、使った仮定を1つのまとまりで出す。印刷(PDF)で切れない
  - ChangeOrder.tsx に差し込む。今の「平日に戻した便の営業運行時間」の文は残す
  - RestoreStep.tsx の平日に戻した便の合計の文の近くに、勤務の数の目安の今の値と欠員との比較を1行出す(便を戻すたびに更新)
  - DriverSummary.test.tsx・ChangeOrder.test.tsx・RestoreStep.test.tsx が通る。pnpm test・typecheck・lint・build が通る
- **依存**:D03、A09(RestoreStep.tsx の順)、U08(ChangeOrder.tsx の順)。**大きさ**:S

#### D05 営業所・車庫・休憩施設を足す(地図で置く/停留所から選ぶ)、JSON で書き出し・読み込み、推定に使う(指摘24)(担当のモデル:sonnet)

- **触るファイル**:`web/src/components/steps/reach/PlacesEditor.tsx(新規)`、`web/src/components/steps/reach/PlacesEditor.test.tsx(新規)`、`web/src/lib/placesFile.ts(新規)`、`web/src/lib/placesFile.test.ts(新規)`、`web/src/map/PlacesLayer.tsx(新規)`、`web/src/map/PlacesLayer.test.tsx(新規)`、`web/src/map/FacilityLayer.tsx(MapOverlays に差し込む1行と import だけ)`、`web/src/store/drivers.ts`、`web/src/components/steps/reach/DriverPanel.tsx`
- **受け入れ条件**:
  - 種類は営業所(出入庫と点呼の場所。休憩も取れる)・車庫(出入庫の場所)・休憩施設(休憩を取れる場所)。名前・種類・緯度経度を持つ
  - 足し方:(1)「地図で置く」を押して地図を1回押す(置く間はほかの地図の操作を邪魔しない。Esc でやめる)、(2) 停留所の名前で検索して選ぶ。消す・名前を変えるができる
  - メモリだけに持つ(サーバーに送らない、IndexedDB と localStorage は使わない)。placesFile.ts で JSON に書き出し・読み込み(形と範囲を確かめ、壊れた行は読み飛ばして件数を出す)
  - 推定(D02 の places)に渡す。置く前と後で勤務の数がどう変わったかを DriverPanel に出す
  - 地図では種類ごとに記号と色を分け、凡例に「利用者が置いた場所」と出す。地図を隠す手順では何も出さない
  - 道北バスの営業所の位置は既定に入れない(§6 の3)。各テストと pnpm test・typecheck・lint・build が通る
- **依存**:D03。**大きさ**:M

### 波 5(11/6 午後。ant apply は利用者の承認の後)

#### A10 AI のツールの定義と調整役の規則をまとめて直し、ant apply を1回で版を上げる(U06・D06 を含む)(指摘15・16・17・18・24)(担当のモデル:opus)

- **触るファイル**:`server/src/dispatcher_server/claude_tools.json`、`agents/coordinator.md`、`claude-lock.json`、`web/src/claude/tools.ts`、`web/src/claude/tools.test.ts`、`web/src/claude/tools.contract.test.ts`、`server/tests/test_agent_files.py`、`docs/interfaces-1105.md`、`docs/deploy.md`
- **受け入れ条件**:
  - (18.4)search_trips の入力に offset(0 以上の整数か null)と hints(判断材料の識別子の配列か null。どれか1つを持つ便に絞る)を足す。TOOL_INPUT_KEYS と型・範囲の確かめも直す。結果に offset と next_offset(続きが無ければ null)を足す。並びは同じ入力なら毎回同じ(compareByHints の後に trip_id)。tools.test.ts で、offset で重ならず漏れないこと、hints の絞り込み、不正な値のエラーを確かめる
  - (15.3・17。U06 の分)search_trips の説明:onlyTripInBand は「平日に戻さないと、その系統の時間帯(3時間ごと。band)の便が減便後 0 便になる(同じ時間帯の便が複数あれば、どれにも付く)」。onlyServiceAtStop・restoresLostCells は画面の時間帯の幅で判定、firstTripOfRoute・lastTripOfRoute は方向を分けない、evening は 15〜21時。hint_texts・band・route_weekday_trips・offset・next_offset を書く。tools.ts:224 の窓の説明と、ツールの結果の文で区切りを書いている所も合わせる
  - (16。U06 の分)apply_policy の end_date の説明に、終了日を決めるとその翌日から出力に便が無いこと、元のダイヤには自動で戻らないこと、Dispatcher は期間の後の GTFS を出力しないことを足す
  - (18.2・18.3)summarize_impact の説明に round_trip と facility_access を書く。(24。D06 の分)summarize_impact の結果に drivers({date, serviceHours:{before, after, reductionMin}, duties:{before, after, diff}, shortage, verdict, assumptions})を足し、add_back の結果の note(tools.ts:490)の「必要な運転士の人数ではありません」を、勤務の数の目安は summarize_impact で見られる旨に直す。D03 を入れないときは drivers を足さない
  - (15.1)get_research_targets の説明を「利用者が調査を始めたとき、または保存済みの結果(デモを含む)を読み込んだときの対象」に直す
  - coordinator.md の規則に足す:(1) 判断材料は hint_texts の言い方で書き「唯一の便」と書かない。系統の便数は route_weekday_trips を使う。(2) 画面の語の表に onlyTripInBand「時間帯の便がなくなる」・onlyServiceAtStop「停留所の発車がなくなる」・firstTripOfRoute「系統の始発」・lastTripOfRoute「系統の終発」。(3) omitted_over_limit が 0 より大きいときは時間帯を刻んで探し直さず、hints か next_offset を使い、対象の件数と確かめた件数を書く。(4) 朝の便を平日に戻す下書きの前後で round_trip を見て帰りの方向の欠けを伝え、facility_access の施設も添える。(5) [画面の状態] に前提情報の行があれば get_research_results で読む。(6) 公示第47号の区分は届出の目安の表だけで使う。(7) 運転士の数は「目安」「下限」として言い切らず、休息期間・予備の要員・実際の仕業は事業者の判断と添える
  - coordinator.md は claude_tools.json の写しのまま(test_agent_files.py と tools.contract.test.ts が通る)
  - docs/interfaces-1105.md に書き足す:§3.2 の known の経路、§4.7 の止める知らせは1回だけ、§6.3 の search_trips の offset と hints
  - テストが通ってから、利用者の承認を得て ant apply を1回だけ行う(--yes は利用者の承認があるときだけ)。上がった版(4)を .env の DISPATCHER_AGENT_VERSION(コミットしない)と docs/deploy.md に書き、claude-lock.json をコミットする。サーバーの版の更新と web の公開を同じデプロイで行うことを docs/deploy.md に書く
  - pnpm test・typecheck・lint、uv run pytest -q が通る
- **依存**:A01、A02、A03、A06、A07、A08、U05、U09、D03。**大きさ**:M

#### U06 AI のツールの説明と調整役の文を、時間帯の区切りと期間の後の扱いに合わせる(指摘17・16)

- 中身は A10 の「U06 の分」に入れた。A10 の担当が実行する(ant apply を1回にするため)

#### D06 AI の影響の要約(summarize_impact)の結果に、営業運行時間と勤務の数の目安・欠員を足す(指摘24)

- 中身は A10 の「D06 の分」に入れた。A10 の担当が実行する(tools.ts を W3〜W5 で1つずつ直す順と、ant apply を1回にするため)

#### U10 決めたことを文書に写す(D07 の CLAUDE.md・README・wording.md の分を含む)(指摘14・16・17・19・20・21・23・24)(担当のモデル:sonnet)

- **触るファイル**:`docs/design-service-groups.md`、`docs/interfaces-1104.md`、`docs/wording.md`、`docs/review-fixes.md`、`CLAUDE.md`、`README.md`
- **受け入れ条件**:
  - design-service-groups.md の §3.6(Jev のスイッチと自動の送信 → ダイアログで聞く)と §5.1・§5.2(確定 → 減便の方針の自動/手動)を直す
  - interfaces-1104.md の §12.1-3 と 738・1417 行あたり(元のダイヤに戻す版)を §6 の4の決定に合わせる
  - wording.md:「元のダイヤに戻す版」の行に、なくしたこと(またはその扱い)を書く。要る運転士の数(目安)・勤務の数・営業運行時間・欠員の人数・営業所・車庫・休憩施設を足す
  - CLAUDE.md:時間帯と判断材料の記述に、3時間ごとにそろえたことと公示第47号の例外を足す。機能スコープの「やらない」の「仕業・交番の再現」を「実際の仕業・交番の再現(1日の勤務の数の下限の目安は出す)」に直し、B に「営業運行時間の前後と、要る運転士の数(勤務の数の下限の目安)と欠員の比較。営業所・車庫・休憩施設を置ける」を足す(入れた範囲に合わせる)。「あれば作る」の車両運用の推測は、D02 で車両の数の下限を出すならそれに合わせる。Notion の決定事項と食い違うときは、指示役が Notion も直す
  - README の機能の一覧に、入れた機能を足す
  - review-fixes.md の 14〜24 に「対応:U0x / A0x / D0x」を足す
  - 文書の語は wording.md に従う
- **依存**:U02、U03、U04、U05、U07、U08、U09、D03(入れた範囲が決まってから)。**大きさ**:S

### 波 6(11/6 夕方。凍結の前)

W6 は文書だけで、コードとツールの定義は変えない。コードの最後の波と、ただ1回の ant apply は W5 の A10。

#### D07 要る運転士の数の推定の取り決めを書く(CLAUDE.md・README・wording.md の分は U10)(指摘24)(担当のモデル:haiku)

- **触るファイル**:`docs/interfaces-1105.md`
- **受け入れ条件**:
  - 推定の取り決め(区間の作り方、つなぎの条件、法令の上限と出典、既定の仮定値と変えられる値、決まった並び、運用番号の数は減便前の入力だけの参考、営業所などの JSON の形)を1節で書く
  - A10 が書き足した節を壊さない。文書の語は wording.md に従う
- **依存**:A10(同じファイルの順)、D02、D03(D05 を入れたら D05)。**大きさ**:S

## 4. 波とファイルの持ち主

同じ波のタスクは、次の表のファイルのほかを触らない。ほかのタスクのファイルのテストが壊れる変更が要るときは、報告して次の波に回す。

| 波 | タスク | ファイルの持ち主(主なもの) |
| --- | --- | --- |
| W1 | U01 | ui/alert-dialog.tsx・.test.tsx |
| | U05 | gtfs/edit/restore.ts・restore.test・restore.verify.test、gtfs/edit/diff.ts、steps/RestoreStep.tsx・.test、restore/grouping.ts・.test、policy/DiffTables.tsx・.test、output/ChangeOrder.tsx・.test |
| | U07 | policy/PeriodFields.tsx、policy/periodRange.ts・.test、policy/PolicyForm.tsx、steps/PolicyStep.test.tsx、steps/EditFlow.test.tsx |
| | U09 | steps/ExportStep.tsx・.test、steps/revertServices.ts・.test(削除)、gtfs/edit/form2.ts・form2.test・form2.multi.test、gtfs/validate/edit.ts・.test、store/reset.ts |
| | A01 | server agent_session.py、tests/test_agent_wire.py |
| | A02 | server agent_relay.py・research.py・store.py、tests/test_agent_relay.py・test_research.py・test_store.py、web claude/research.ts・.test |
| | A04 | gtfs/edit/roundTrip.ts・.test・.verify.test(新規) |
| | A05 | gtfs/edit/facilityAccess.ts・.test(新規) |
| | D01 | gtfs/edit/serviceHours.ts・.test・.verify.test(新規) |
| W2 | U02 | store/serviceGroups.ts・.test、load/JevConsentDialog.tsx(新規)、load/ServiceGroupsCard.tsx・.test、load/serviceGroupsText.ts、load/JevSwitch.tsx(削除)、steps/LoadStep.tsx・.test |
| | U08 | policy/PolicyForm.tsx、steps/PolicyStep.test.tsx、output/ChangeOrder.tsx・.test |
| | A03 | gtfs/edit/restore.ts・restore.test、steps/RestoreStep.tsx・.test、restore/TripLine.tsx、docs/wording.md |
| | A06 | store/chat.ts・.test、claude/screenLines.ts・.test、chat/ChatMessages.tsx、chat/ChatPanel.test.tsx |
| | D02 | gtfs/edit/duties.ts・.test・.verify.test(新規) |
| W3 | U03 | steps/LoadStep.tsx・.test、steps/loadText.ts、App.test.tsx |
| | U04 | load/ServiceGroupsCard.tsx・.test、load/serviceGroupsText.ts、policy/GroupReplaceFields.tsx・.test(新規)、policy/PolicyForm.tsx、steps/PolicyStep.groups.test.tsx、store/serviceGroups.ts・.test、gtfs/groups/view.ts・view.verify.test、steps/stepIds.ts、claude/tools.ts・tools.groups.test、claude/screenLines.ts・screenLines.groups.test |
| | A08 | store/chat.ts・.test、chat/ChatMessages.tsx、chat/ChatPanel.test.tsx |
| | A09 | restore/RoundTripPanel.tsx・.test、restore/FacilityAccessPanel.tsx・.test(新規)、steps/RestoreStep.tsx・.test、README.md |
| | D03 | store/drivers.ts・.test、reach/DriverPanel.tsx・.test、reach/driverText.ts・.test(新規)、steps/ReachStep.tsx |
| W4 | A07 | claude/tools.ts・tools.test.ts |
| | D04 | output/DriverSummary.tsx・.test(新規)、output/ChangeOrder.tsx・.test、steps/RestoreStep.tsx・.test |
| | D05 | reach/PlacesEditor.tsx・.test、lib/placesFile.ts・.test、map/PlacesLayer.tsx・.test(新規)、map/FacilityLayer.tsx、store/drivers.ts、reach/DriverPanel.tsx |
| W5 | A10(U06・D06 を含む) | claude_tools.json、agents/coordinator.md、claude-lock.json、claude/tools.ts・tools.test・tools.contract.test、server tests/test_agent_files.py、docs/interfaces-1105.md、docs/deploy.md |
| | U10(D07 の一部を含む) | docs/design-service-groups.md・interfaces-1104.md・wording.md・review-fixes.md、CLAUDE.md、README.md |
| W6 | D07 | docs/interfaces-1105.md |

- 何度も触るファイルの順:RestoreStep.tsx は U05 → A03 → A09 → D04。ChangeOrder.tsx は U05 → U08 → D04。PolicyForm.tsx は U07 → U08 → U04。claude/tools.ts は U04 → A07 → A10。screenLines.ts は A06 → U04。store/chat.ts は A06 → A08。LoadStep.tsx は U02 → U03。store/serviceGroups.ts・ServiceGroupsCard.tsx は U02 → U04。store/drivers.ts・DriverPanel.tsx は D03 → D05。README.md は A09 → U10。docs/wording.md は A03 → U10。docs/interfaces-1105.md は A10 → D07
- 時刻は目安。W5 の ant apply は利用者の承認を待つので、承認が遅れても U10 は先に進める。凍結の前の通しの確かめ(道北バスで読み込み → 出力、AI の相談3通)は 11/6 20:00 から行う

## 5. 凍結(11/6 22:00)に間に合わないときに外せる切れ目

上から順に外す。道北バスのデモ(22)に出ないものほど先に外す。

1. **D05(営業所・車庫・休憩施設)**:推定は places 無し(どこでも休憩、出入庫の回送 0)で動く。断り書きは D03 にある
2. **U04 の (3) 手動の欄**:道北バスは groupedPolicyServices が null で、手動の欄は画面に出ない。外すときは (1)(2)(読み込みの表を読む専用にし、確定をなくす)だけを入れ、減便の方針の詳しい設定は今の PairList のまま。U04 をまるごと外すときは、読み込みの表の編集と確定がそのまま残る(道北バスの見た目は変わらない)
3. **A08(件数の表示)と A09(往復・学校病院の一覧の画面)**:A04・A05・A07 は残し、AI の summarize_impact には round_trip・facility_access を出す。A09 を外したら README の「できないこと」の数行は U10 が書く
4. **A05 と A07 の facility_access**:往復の確かめ(A04)だけを残す
5. **A10 の入力の追加(offset・hints)**:ant apply が凍結までにできないときは、A10 から入力の追加と定義の文の変更を外し、結果の追加(A07)だけで出す(版 3 のまま。調整役が hint_texts を知らなくても、notes の1文で伝わる)。A01・A06 の止める知らせの直しは、定義を変えずに効く
6. **D04 → D03 の「仮定を変える」欄**:D03 の表と欠員の判定は残す。D04 を外したら変更指示書には今の「平日に戻した便の営業運行時間」の文だけが出る

外さないもの:U01〜U03・U05・U07〜U09(利用者の指摘と決定そのもの)、A01・A02・A03・A06(Codex が見つけた3つの不具合)、D01・D02・D03(デモの筋「欠員 20 人に対して、平日を土曜にすると足りる目安、10/29 版の形では足りない目安」)

## 6. 利用者に伺う点

重要なものから並べる。返答が無いときは推奨で進める。

1. **凍結までに入れる範囲と、外す順**(推奨:§3 の全部を目標にし、遅れたら §5 の順に外す。とくに D05 と U04 の手動の欄は、道北バスのデモに出ないので最初に外す。Codex が見つけた不具合(A01・A02・A03・A06)と、要る運転士の数の D01〜D03 は必ず入れる。D01〜D03 だけで「欠員 20 人に対して平日を土曜にすると足りる目安、10/29 版の形(平日に 25 便戻す)では足りない目安」というデモの筋が立つため)
2. **時間帯の区切り(17・15.3)**:到達圏の3時間ごと(6〜9、9〜12、…、21〜24時)にそろえ、公示第47号の区分(6〜9時台、10〜14時台、…)は届出の目安の表(減便の方針と変更指示書の 3.)だけに残して区切りが違うことを1文で書く。判断材料の evening(帰りの便)は 15〜21時(3時間の帯2つ)にする。判断材料の画面の名前から「唯一」を外し、onlyTripInBand は「時間帯の便がなくなる」、onlyServiceAtStop は「停留所の発車がなくなる」にする(推奨:このとおり。食い違っているのは onlyTripInBand(第47号の区分なのに名前で分からない)と evening(15〜19時)だけで、変更が最も小さい。18時で切ると 18時台の帰りの便が判断材料から落ちる。「唯一」は同じ時間帯のなくなる便すべてに付く判断材料の名前として誤りで、AI がそれを写した)
3. **要る運転士の数の出し方(24)**:便を時刻順に勤務へつなぎ、改善基準告示の上限(拘束 13 時間・運転 9 時間・連続運転 4 時間)と点呼・回送の仮定で区切った勤務の数を主に出し、減便前の入力の運用番号の数(平日 101・土曜 72)を参考に並べる。欠員の判定は「減便で減る勤務の数(前−後)」と「その日に乗務できない運転士の数」の比較だけにする。拘束は 13 時間を既定にし、15 時間に切り替えられる。道北バスの営業所の位置は既定に入れない(推奨:このとおり。絶対数は仮定で ±20% 動くが、同じ仮定での前後の差は推定 −14(82→68)と事業者の運用番号 −15(101→86)がそろう。車庫の位置は公式に確かめられておらず、営業所の有無で勤務の数が +9〜+21 動くので、確かめていない位置を既定にすると数を誤って見せる)
4. **元のダイヤに戻す版(16)**:出力の手順の「元のダイヤに戻す版」をなくし、期間の後の注意を「元のダイヤには自動で戻らない。期間が終わる前に、事業者のふだんの手順で元のダイヤの GTFS を公開し直す。元の ZIP は保存しておく」と言い直す(推奨:なくす。11/5 の決定「期間の後に元のダイヤに戻す GTFS は Dispatcher からは出力しない」に、この版はそのまま当たる。残すと決定と画面が食い違ったままになる。U09 はこの返答を待って進める)
5. **Jev のスイッチとグループ分けの確定(14・19)**:読み込みの手順の「Jev に送る」スイッチをなくし、規則で決まらないときに毎回ダイアログで聞く(「今後は聞かない」は付けない)。グループ分けの「確定」(「このグループ分けで進める」)もなくし、減便の方針の「対象便を確かめる」を最後の確かめにする(推奨:このとおり。送る前にダイアログで聞けばスイッチと役割が重なり、ブラウザに保存しない決定もあるので読み込みのたびに聞くほうが同意としてはっきりする。表の値はもともと規則と Jev の案なので確定を押す手間が減るだけで、決まらない行は今の groupErrors で止められる。道北バスはどちらも画面に出ない)
6. **ant apply(A10)**:AI のツールの定義と調整役の規則の変更(15・16・17・18・24 の分)を W5 でまとめ、テストが通ったあと1回だけ ant apply して調整役の版を 3 から 4 に上げてよいか。適用の前に差分を見せる(推奨:1回にまとめる。版は DISPATCHER_AGENT_VERSION で固定しており、上げるたびに .env・docs/deploy.md・claude-lock.json を直し承認も要る。凍結の前日に何度も上げるとデモの録画の日の版がぶれる)

### 利用者の決定(11/5)

1〜6 はすべて推奨のとおり(2026-11-05 に利用者が回答)。とくに、要る運転士の数は推奨の出し方で、道北バスの営業所の位置は既定に入れない。時間帯は到達圏の3時間ごとにそろえる。元のダイヤに戻す版はなくす。Jev のスイッチとグループ分けの確定はなくし、規則で決まらないときに毎回ダイアログで聞く。AI の定義の変更は W5 で1回の ant apply(差分を見せてから)。

## 7. 見送るもの

- ほかの GTFS(京都市営バス・北海道中央バスなど)での確かめ(22)
- Jev のダイアログの「今後は聞かない」
- 期間の後に元のダイヤに戻す GTFS の出力(16。§6 の4の返答による)
- 乗車人数・混み具合・鉄道との乗り継ぎの判定、駅の徒歩圏の着く便の一覧、区間ごとの輸送力の目安(18.3。データが無い)
- search_trips の件数の上限の引き上げ、1回の発言のツールの上限(12 回)の引き上げ
- 判断材料の識別子(onlyTripInBand など)の改名
- 運転士ごとの割り当て・交番・休息期間(日をまたぐ)の推定、7つ目の手順、7つ目のツール
- 道北バスの営業所・車庫の位置を既定に入れること
