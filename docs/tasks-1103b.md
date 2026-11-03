# 11/3 夜〜11/6 の実装タスク(2回目の指摘 8〜13)

`docs/review-fixes.md` の 8〜13 をタスクに分けた(指示役、11/3)。T24 から番号を続ける。同じ波のタスクは同じファイルを触らない。13(文と語の統一)は、言い換えの表(`docs/wording-draft.md`。agy の Gemini 4 Argon と yomiyasu で作った案)の承認の後に行う。

## 指摘への決め方(指示役、11/3)

- 8.1 処理中のボタン:ボタンの部品(ui/button.tsx)に loading を持たせ、文字を DOM に残したまま invisible にしてスピナーを重ねる(幅が変わらない)。disabled・aria-busy・sr-only の読み上げの文(既定「処理中」)を付ける。ボタンに結び付かない長い処理(到達圏の計算、AI の返答待ち、調査の進み具合、参照データの読み込み)は規則の外にし、今の表示を残す(進み具合を見せる必要があるため)
- 8.2 Attachment:shadcn の公式の @shadcn/attachment を使う(11/3 に shadcn search で確かめた)。出す項目はファイル名・大きさ・状態(読み込み中・読み込み済み・失敗)・サンプルの印・読み込んだ時刻。「取り除く」ボタンは付けない(読み込み直せば置き換わり、編集の履歴が消える確かめを新しく作らずに済む)。大きさと時刻は store/gtfs.ts に持ち、手順を移っても消えないようにする
- 8.3 「または」の区切り:Separator と中央の文字で作る。ファイルの欄は隠した input と「ファイルを選ぶ」ボタンにし、2つのボタンが同じ形で並ぶようにする
- 9.1 周辺の事業者:地図の重心のひし形をやめる(位置に意味が無い)。行の主な中身を (1) 調べた減便・ダイヤ改正・運休の事実(出典・確認日時つきの引用)と (2) 自社の停留所の 300m 以内にある他社の停留所の数と系統名(P11 から、コードが数える)にする。方針が承認済みなら、発車が減る・無くなる停留所の近くの数も出す。300m は周知文の代替手段と同じ距離にそろえる。P11 に時刻が無いことを画面で断る。停留所のデータは facilities/{mesh1}.json の最上位の別の鍵 busstops に入れ、サーバーと取得の回数を増やさない
- 9.2 一覧と地図の結び付き:施設の行と調査の結果のカードに、マウスとキーボードの焦点で強調を付ける。地図は輪と記号の拡大だけで、地図は動かさない(一覧の上でマウスを動かすたびに地図が動くのを避ける)。強調の状態は store/map.ts に置き、一覧と地図のタスクが同じファイルを取り合わないようにする。地図を隠す手順では地図の側は何もしない
- 9.3 一覧の畳み方:まとまりごとに、選ばれた施設の最後の後ろ3件までを出し、残りは「続きを表示(残り N 件)」で開く。選ばれた施設の無いまとまりは最初の5件まで
- 9.4 地図記号:小・中学校は「文」、高等学校(と特別支援学校の扱いは国土地理院の一覧で確かめる)は丸囲みの「文」、病院は国土地理院の病院の記号を自分で描いた SVG にする。専用の記号が無い種類(大学・高専・専修学校、診療所、他社の停留所)は近い記号に枠や文字を添えた独自の形にし、凡例に独自と書く。色は今の Okabe-Ito の配色を残し、形と色の両方で分ける。記号の画像は SVG から作って addImage する(画素の手塗りでは「文」を描けないため)
- 10 カレンダーの文字:セルの「土」「日」「祝」をやめる。色の見分けがつきにくい人への配慮は、読み上げの名前(祝日名・土曜・日曜)、マウスを載せたときの祝日名、選んだ日の下の文、曜日の列の位置で保つ。色は今の赤・青(白地・暗い背景の両方で 4.5:1 を超える)。Notion の配色の決定には、この両立の仕方を指示役が書き足す
- 11 地図の操作盤:比べる日(ボタンで Popover のカレンダー)・時間帯の刻み・地図に出す時間帯を、地図の下の中央の1つの盤にまとめる。運行日の説明はカレンダーと同じ Popover に出す。操作盤は snapshot が無くても出す(運行日の無い日を選んだときに日付を戻せなくなるのを防ぐ)。表と手がかりがこの設定で計算されていることは、影響(到達圏)の表の上の1行で示し、足し戻しの手順の比べる日の文に操作盤の場所を足す(13 の文の直しで)
- 12 調べた結果の使い道:(a) 手がかりの時間帯の窓を、調べた外来の受付時間・始業・終業から施設ごとに決め、読めなければ決め打ちに戻す。読み取りは決まった規則でコードが行う(数はコードが出す方針)。デモの結果で読めるのは主に病院の受付時間。(b) 足し戻しの画面の理由に、調べた要点を出典・確認日時つきで開閉できる形で出す。(c) 長期休業は期間を読み、減便の期間と重なるときに(学)の印の近くに注意を出すだけにし、印は自動で付けない。(d) 周辺の事業者の減便の動きは、周知文案の代替手段の案内と変更指示書に引用として載せる。(e) 確認日時はいつも出し、30 日を超えたら出典で確かめるよう添える
- 13 の進め方:語の表の承認を待ってから始める。主要な語(足し戻し・下書きの ID・消える/入る/残る・手順の名前・主なボタン)は T35 が1つのタスクで全体を替え、その波には T35 だけを置く(まとまりごとに替えると語がずれ、同じ結合テストを複数のタスクが直すことになるため)。続く波で、部品のまとまりごとに文を直す(T36〜T41)。同じ波のタスクは、ほかのタスクのファイルのテストが壊れる変更をせず、T43 に回す。コードの識別子・コメント・テストの説明文は替えない
- 13 と AI:AI の定義(coordinator.md・claude_tools.json)とツールの結果の文・[画面の操作] の行の語は T42 でそろえ、12 の窓の説明の変更とまとめて ant apply を1回にする。[画面の操作] の行とツールの引数の下書きの ID は残し、AI には利用者に ID を言わないよう書く
- 並びの根拠:13 の文の直しは 8〜12 の部品の構造の変更(波1〜3)の後に置く(同じファイルを2回直さないため)。波1は互いに触らない土台(部品、カレンダー、参照データ、計算、記号)、波2は画面の組み替え、波3は波2の store を使う出力、波4〜6が 13

## タスク

### 波 1

#### T24 共通の部品:処理中のボタン、スピナー、Attachment、Popover(指摘8.1・8.2・11の土台)(担当のモデル:sonnet)

- **目標**:ボタンに「処理中」の状態を持たせ、どのボタンも同じ見た目(文字をスピナーに置き換え、幅を変えず、無効にする)にする。8.2 の Attachment と 11 の Popover の部品を shadcn から入れる。後の波のタスクがこの部品だけを使って画面を直せるようにする
- **触るファイル**:`web/src/components/ui/button.tsx`、`web/src/components/ui/button.test.tsx(新規)`、`web/src/components/ui/spinner.tsx(新規)`、`web/src/components/ui/attachment.tsx(新規)`、`web/src/components/ui/popover.tsx(新規)`、`web/src/index.css`
- **受け入れ条件**:
  - components/ui/button.tsx に loading?: boolean と loadingLabel?: string(既定「処理中」)がある。loading のときは disabled、aria-busy="true"、data-loading が付き、元の文字は DOM に残したまま invisible にして幅を保ち、スピナーを中央に重ねる。読み上げ用に sr-only の loadingLabel を出す
  - components/ui/spinner.tsx を shadcn(@shadcn/spinner)から入れ、aria-label を日本語(「読み込み中」)にする。ボタンの中ではスピナーに aria-hidden を付け、role=status を重ねない
  - components/ui/attachment.tsx(@shadcn/attachment)と components/ui/popover.tsx(@shadcn/popover)を入れる。新しい依存パッケージは足さない(radix-ui・cn は導入済み)。attachment が使う shimmer などの utility が index.css に要るなら足す
  - components/ui/button.test.tsx(新規)で、loading のとき disabled・aria-busy・読み上げの名前(loadingLabel)になり、loading でないときは元の名前で押せることを確かめる
  - 既存のボタンの見た目と振る舞いは loading を渡さない限り変わらない。pnpm test・typecheck・lint・build が通る
- **決めたこと**:
  - スピナーだけにし、短い文は添えない(指摘の「文字をスピナーに置き換える」どおり)。文字は invisible で残し、ボタンの幅が変わらないようにする
  - 読み上げには aria-busy と sr-only の文(既定「処理中」、呼ぶ側で「読み込み中」「出力中」などを渡せる)で処理中を伝える
  - shadcn の部品は `pnpm exec shadcn add spinner attachment popover` で入れる(公式のレジストリにあることを 11/3 に shadcn search で確かめた)

#### T25 カレンダーの「土」「日」「祝」の文字をやめ、色だけにする(指摘10)(担当のモデル:sonnet)

- **目標**:日付のセルの下の文字をやめ、日曜・祝日を赤、土曜を青の色だけで示す。色の見分けがつきにくい人への配慮は、読み上げの名前・マウスを載せたときの祝日名・選んだ日の下の文・曜日の列の位置で保つ
- **触るファイル**:`web/src/components/HolidayCalendar.tsx`、`web/src/components/HolidayCalendar.test.tsx`
- **受け入れ条件**:
  - HolidayCalendar.tsx から KIND_MARK とセル内の文字(data-testid=mark-…)をなくす。data-kind は残す
  - 日のボタンの aria-label に種類を入れる(例「2026年11月3日 火曜日、祝日 文化の日」「…、日曜」「…、土曜」)。祝日名は title にも出す
  - 選んだ日の下の文(例「11月3日(火・文化の日)」)は今のまま
  - 選んだ日(主色の背景)では赤・青の文字色を使わず、主色の上の文字色で読める
  - HolidayCalendar.test.tsx を書き直す:mark の testid ではなく data-kind・aria-label・title で、祝日・日曜・土曜・範囲外の disabled を確かめ、セルに「祝」「土」「日」の文字が無いことを確かめる
  - PolicyStep.test.tsx・DateBandStep.test.tsx・ReachStepFlow.test.tsx が通る(日付を aria-label で選んでいるテストがあれば、このタスクの変更で壊れないことを確かめる。壊れるなら aria-label の先頭を今の形のまま保つ)。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 色は今の text-red-700/text-blue-700(白い背景でコントラスト比 6.5:1 前後)と、暗い表示の text-red-400/text-blue-400 のままにする。どちらも 4.5:1 を超える
  - Notion の決定「色の見分けがつきにくい人にも区別できる配色」との両立:セルの文字は一般的なカレンダーに合わせて出さず、区別は読み上げの名前・祝日名(title)・選んだ日の下の文・曜日の列の位置(日曜は左端、土曜は右端)で保つ。指示役が Notion とタスクの記録に書き足す

#### T26 周辺事業者の停留所(P11)の1つずつの位置と系統名を参照データに出し、重なりを数える関数を作る(指摘9.1のデータと計算)(担当のモデル:opus)

- **目標**:事業者の重心ではなく、P11 の停留所ごとの位置・停留所名・事業者・系統名を1次メッシュごとの参照データに出し、編集する GTFS の停留所の近くにある他事業者の停留所と系統を数える純粋な関数を作る
- **触るファイル**:`data/src/dispatcher_data/facilities.py`、`data/tests/test_facilities.py`、`web/src/ref/busstops.ts(新規)`、`web/src/ref/busstops.test.ts(新規)`
- **受け入れ条件**:
  - data/src/dispatcher_data/facilities.py の _read_busstops が bsn(停留所名)と bri/brn(系統名)も読む。facilities/{mesh1}.json に、今の facilities 配列とは別の最上位の鍵 busstops を足す:[{name, lat, lon, operators: [target_id(P11:…)], routes: [系統名…]}]。座標の桁は COORD_DIGITS。今の facilities の形と target_id は変えない
  - data/tests/test_facilities.py に、bri が複数ある停留所・系統名の無い停留所・座標の無い停留所の小さなフィクスチャのテストを足す。uv run pytest -q(data)が通る
  - 実データで加工し直し、道北バスの周辺の1次メッシュのファイルの大きさと停留所の数を報告する(data/out はコミットしない)
  - web/src/ref/busstops.ts(新規)に parseBusstops(file: unknown)(形の確かめつき。busstops が無い古いファイルは空)と、operatorOverlap(ownStops, otherStops, agencyNames, radiusM = 300) がある。kdbush で引き、事業者(target_id)ごとに、近くにある自社の停留所の stop_id の集合・他社の停留所・系統名(重複なし)を返す。自社の事業者は ref/facilities.ts の isOwnOperator で除く
  - 同じファイルに nearOtherStops(lat, lon, otherStops, radiusM):1つの停留所の周りの他社の停留所と系統名を返す関数がある(周知文の代替手段に使う)
  - web/src/ref/busstops.test.ts(新規)で、300m の内外・自社の除外・系統名の重複の除去・壊れた行の読み飛ばしを確かめる。pnpm test・typecheck・lint が通る
  - サーバー(app.py)と server/tests は変えない(同じ facilities/{mesh1}.json で配る)
- **決めたこと**:
  - 停留所は新しいファイルやエンドポイントにせず、facilities/{mesh1}.json の最上位の別の鍵 busstops に入れる。前提情報の手順は既にこのファイルを停留所の外接矩形 +2km の1次メッシュぶん読んでおり、取得を増やさずに済む。parseFacility と mergeFacilityFiles は facilities 配列だけを読むので壊れない
  - 重なりの距離は 300m(周知文の代替手段の「半径 300m 以内」と同じ)。到達圏の区分ごとの距離は使わない(周知文と数がずれないため)
  - P11 には時刻表が無いので、関数は本数・時間帯を返さない。画面の断り書きは T32・T34 が出す
  - VPS の参照データは、T26 の後に指示役が加工し直したものを docs/deploy.md の手順で差し替える

#### T27 調べた受付時間・始業時刻から、学校・病院の時間帯の窓を施設ごとに決め、長期休業の期間を読む(指摘12の計算)(担当のモデル:opus)

- **目標**:足し戻しの手がかり nearFacility の時間帯の窓を、前提情報で調べた外来の受付時間・始業・終業の時刻から施設ごとに決め、読めないときは今の決め打ち(FACILITY_WINDOWS)に戻す。学校の長期休業の期間を読み、減便の期間と重なるかをコードで出す
- **触るファイル**:`web/src/gtfs/edit/facilityHours.ts(新規)`、`web/src/gtfs/edit/facilityHours.test.ts(新規)`、`web/src/gtfs/edit/restore.ts`、`web/src/gtfs/edit/restore.test.ts`、`web/src/store/restoreHintContext.ts`、`web/src/store/restoreHintContext.facilities.test.ts`、`web/src/claude/tools.ts`、`web/src/claude/tools.test.ts`
- **受け入れ条件**:
  - web/src/gtfs/edit/facilityHours.ts(新規)に、調べた事実(label・value)から窓を作る関数がある。病院・診療所は label に「受付|外来|診療」を含む事実の value から最初の時刻の範囲を読み、着く窓 = [受付開始 − 30分, 午前の受付終了]、出る窓 = [午前の受付終了, 最後の受付終了 + 120分]。学校は label に「始業|終業|登校|下校」を含む事実から読み、着く窓 = [始業 − 60分, 始業]、出る窓 = [終業, 終業 + 120分]
  - 時刻の読み方:NFKC で全角の数字とコロンを直し、「8:00〜11:30」「8時30分から」「午前8時30分〜午後5時」「〔午前〕8：00～11：30」を読む。午後は 12 時間を足す。5〜22 時の外や、始まりが終わりより後なら読めないとする
  - 読めなければ FACILITY_WINDOWS に戻し、窓の出どころ(調べた結果 / 既定)を結果に持つ
  - 同じファイルに、長期休業の事実(label に「休業|休暇|休み」)から「M月D日…からM月D日…まで」を読み、減便の期間(YYYYMMDD の範囲)と重なる期間を返す関数がある。年は減便の期間から決める(12月〜1月をまたぐときを含む)。読めなければ空
  - restore.ts の HintFacility に施設ごとの窓と出どころを持たせ、createRestoreHinter が FACILITY_WINDOWS の代わりにそれを使う。nearFacilityText の理由の文に、調べた窓なら「調べた外来の受付 8:00〜11:30 に合わせた窓」のように出どころを入れる(数はコードが出す)
  - store/restoreHintContext.ts が、前提情報の結果(ResearchResult)から窓を作って HintFacility に入れる
  - facilityHours.test.ts(新規)で、data/demo/research_dohoku.json の実際の文(名寄市立総合病院・旭川赤十字病院・市立旭川病院・旭川医科大学病院など)を写したフィクスチャで、読める例・読めない例・既定に戻る例を確かめる。restore.test.ts・restoreHintContext.facilities.test.ts で、調べた窓が手がかりに効くことを確かめる
  - claude/tools.ts の nearby_facilities の説明の文(決め打ちの窓を書いている note)を、施設ごとの窓と出どころを含む形に直し、tools.test.ts を合わせる。claude_tools.json と agents/coordinator.md は変えない(T42 でまとめて直す)
  - gtfs-reviewer に見てもらう。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 窓は調べた値で施設ごとに変え、読めないときは決め打ちに戻す。デモの結果では学校の始業・終業はほぼ「見つからず」で、読めるのは病院の外来の受付時間が中心。それでも学校の規則も入れておく(本番の調査で見つかったときに効く)
  - 時刻の読み取りは正規表現の決まった規則でコードが行い、AI には読ませない(数はコードが出す方針)
  - 長期休業は期間の重なりを出すだけで、休校日運休(学)の印は自動で付けない(読み違えたときに便の扱いを勝手に変えないため)。注意の出し方は T33

#### T28 施設の記号を国土地理院の地図記号に合わせ、色分けを残す。強調する施設の状態を地図の store に置く(指摘9.4と9.2の土台)(担当のモデル:sonnet)

- **目標**:前提情報の地図の記号を、国土地理院の地図記号(小・中学校の「文」、高等学校の丸囲みの「文」、病院の記号)に合わせ、今の色分けも残す。一覧から地図の記号を強調するための状態を store/map.ts に置く
- **触るファイル**:`web/src/map/facilitySymbols.ts(新規)`、`web/src/map/facilityLayers.ts`、`web/src/map/FacilityLayer.tsx`、`web/src/map/FacilityLayer.test.tsx`、`web/src/store/map.ts`
- **受け入れ条件**:
  - map/facilitySymbols.ts(新規)に、記号の種類(小・中学校、高校・特別支援学校、大学・高専・専修学校、病院、診療所、ほかの事業者の停留所)ごとの SVG(自分で描いた path。画像を写さない)と色がある。施設から記号の種類を決める関数は、学校の種別(schoolType)と施設の種類から決める
  - 国土地理院の地図記号の一覧で、大学・高専・専修学校・診療所・特別支援学校に専用の記号があるかを確かめ、結果をファイルの先頭のコメントに書く。無い種類は、近い記号に枠や文字を添えた Dispatcher 独自の形にし、凡例に「(独自の記号)」と出す
  - 地図の記号は、SVG の文字列から Image を作って map.addImage で足す(手で画素を塗る facilityIcon をやめる)。読み込みは非同期なので、足し終えるまでレイヤーを足さない
  - FacilitySymbol は今の props(kind)のまま使え、任意の schoolType で学校の記号を分ける(ResearchStep.tsx はこのタスクでは触らない)。凡例は記号の種類ごとに出す
  - 色は今の Okabe-Ito の配色を種類ごとに残し、形でも区別する(色だけに頼らない)。画面で 16px 前後でも形が分かる
  - store/map.ts に highlightedTargetId: string | null と setHighlighted を足す(9.2 で一覧と地図が使う。このタスクでは地図の側の強調はまだ作らない)
  - FacilityLayer.test.tsx で、記号の種類の決め方・凡例・addImage が種類ごとに呼ばれること(Image は偽物)を確かめる(jsdom には canvas が無いので、SVG の文字列と対応を確かめる)。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 事業者の重心のひし形は T32 でやめ、ほかの事業者の停留所の記号に替える。このタスクでは停留所の記号(独自の小さなひし形)まで用意する
  - 記号の画像は SVG から作る(「文」の字形を画素で手塗りするのは無理があるため)
  - 強調の状態は、一覧(ResearchStep)と地図(FacilityLayer)のどちらとも別のファイル(store/map.ts)に置く

### 波 2

#### T29 GTFS の読み込みの欄:処理中のボタン、Attachment での表示、「または」の区切り(指摘8.1・8.2・8.3)(担当のモデル:sonnet)

- **目標**:読み込みの手順で、押したボタンだけをスピナーにし、読み込んだ(読み込み中・失敗した)ファイルを Attachment で見せ、「ファイルを選ぶ」と「サンプルを読み込む」の間に「または」の区切りを置く
- **前に済ませるタスク**:T24
- **触るファイル**:`web/src/components/steps/LoadStep.tsx`、`web/src/components/steps/LoadStep.test.tsx`、`web/src/store/gtfs.ts`、`web/src/store/gtfs.test.ts`
- **受け入れ条件**:
  - 「読み込み中…」の行を出さない。押したボタンが loading(T24)になり、もう一方は disabled になる
  - ファイルの欄は、隠した input type=file と「ファイルを選ぶ」ボタンにする。input は「GTFS の ZIP ファイル」の名前で引けるまま残す(テストで使う)
  - 2つのボタンの間に、横の線と中央の「または」を出す(Separator)
  - ファイルを選んだとき・サンプルを読み込んだときに、Attachment でファイル名・大きさ(KB/MB)・状態(読み込み中・読み込み済み・失敗)・サンプルの印・読み込んだ時刻(HH:MM)を出す。失敗のときは Attachment を error の状態にし、理由はその下に出す
  - 大きさと読み込んだ時刻は store/gtfs.ts に持ち(setLoaded に渡す)、手順を移って戻っても消えない。store/gtfs.test.ts で確かめる
  - LoadStep.test.tsx で、処理中に押したボタンが aria-busy・disabled になり「読み込み中…」の行が無いこと、読み込み後に Attachment にファイル名・大きさ・状態が出ること、失敗のときの表示、「または」の区切りを確かめる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - Attachment に「取り除く」ボタンは付けない。読み込み直せば置き換わり、編集の履歴が消える確かめを新しく作らずに済む
  - ファイルの一覧(表ごとの行数)と feed_info の表示は、今のカードのまま残す
  - サンプルの大きさは、取ってきた ZIP のバイト数から出す

#### T30 出力・AI 欄のボタンを処理中の形に合わせる(指摘8.1)(担当のモデル:haiku)

- **目標**:ボタンに結び付いた処理(GTFS の出力、減便をやめる版の出力、AI への送信、AI に候補を聞く)を、T24 の処理中のボタンにそろえる
- **前に済ませるタスク**:T24
- **触るファイル**:`web/src/components/steps/ExportStep.tsx`、`web/src/components/steps/ExportStep.test.tsx`、`web/src/components/chat/ChatPanel.tsx`、`web/src/components/chat/ChatPanel.test.tsx`、`web/src/components/chat/AskRestoreButton.tsx`
- **受け入れ条件**:
  - ExportStep の2つの出力ボタンが、「出力中…」の文字の代わりに loading(読み上げは「出力中」)になる。ExportStep.test.tsx を合わせる
  - ChatPanel の「送る」が、送信の POST の間(SENDING)だけ loading になり、横の「送っています…」の文を出さない。「AI を準備しています…」と AI の返答待ち・調査の進み具合の表示は今のまま残す。ChatPanel.test.tsx を合わせる
  - AskRestoreButton が、送信の POST の間だけ loading になる
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - ボタンに結び付かない長い処理(到達圏の計算、AI の返答待ち、前提情報の調査の進み具合、参照データ・施設の読み込み)は規則の外にし、今の進み具合の表示を残す

#### T31 比べる日・時間帯の刻み・地図に出す時間帯を、地図の操作盤にまとめる(指摘11)(担当のモデル:opus)

- **目標**:影響(到達圏)の手順の上部にある「比べる日」「時間帯の刻み」を、地図の下の操作盤(今の BandControl)に移し、日付はボタンでカレンダーを開いて選ぶ形にする。表と手がかりがこの設定で計算されていることを手順の側に文で出す
- **前に済ませるタスク**:T24、T25
- **触るファイル**:`web/src/map/BandControl.tsx`、`web/src/map/BandControl.test.tsx`、`web/src/map/ReachLayers.tsx`、`web/src/map/ReachLayers.test.tsx`、`web/src/components/steps/DateBandStep.tsx`、`web/src/components/steps/DateBandStep.test.tsx`、`web/src/components/steps/ReachStep.tsx`、`web/src/components/steps/ReachStep.test.tsx`、`web/src/components/steps/ReachStepFlow.test.tsx`
- **受け入れ条件**:
  - 地図の操作盤(map/BandControl.tsx)に、日付のボタン(例「11月9日(月) ▾」)・時間帯の刻み(3時間ごと/1時間ごと)・地図に出す時間帯の切り替えを1つにまとめる。日付のボタンは Popover(T24)で HolidayCalendar を開き、その下に運行日の説明(ServiceDayInfo:走る service_id、calendar_dates が効いているか)を出す
  - 操作盤は、到達圏の起点(origins)があれば snapshot が無くても出す(運行日の無い日を選んだとき・最初の計算が失敗したときにも日付を変えられる)。ReachLayers の「snapshot が無ければ null」の外に置く
  - 影響(到達圏)の手順から DateBandPanel を外し、表の上に今の設定を1行で出す(例「比べる日:2026年11月9日(月)・3時間ごと。地図の下の操作盤で変えます。変えると、この表・足し戻しの手がかり・AI の影響の要約も計算し直します」)
  - 運行日が無い・選べる日が無いときの注意(今の Alert の文)は、操作盤と手順の両方で見える
  - 方針の承認後に外れたセルが最も多い時間帯を自動で選ぶ動きは保つ。凡例(左上)・施設の凡例(右上)と重ならず、狭い地図では操作盤の中が折り返す
  - BandControl.test.tsx で、日付のボタンを押すとカレンダーが開き、日を選ぶと setDate が呼ばれること、刻みの切り替えで setStepHours が呼ばれること、snapshot が無くても操作盤が出ることを確かめる(Radix の Popover は pointer の事件で開く)。DateBandStep.test.tsx・ReachStep.test.tsx・ReachStepFlow.test.tsx・ReachLayers.test.tsx を新しい置き場所に合わせて書き直す
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 表と手がかりが操作盤の設定で計算されていることは、影響(到達圏)の表の上の1行で示す。足し戻しの手順の「到達圏を比べる日(…)」の文は今もあるので残す(操作盤の場所の案内は 13 の文の直しで足す)
  - 運行日の説明はカレンダーと同じ Popover の中に出す(日付を選ぶときに見るものなので)
  - 操作盤は地図の下の中央のまま。地図を隠す手順(方針・出力)では操作盤も見えない
  - DateBandStep.tsx は ServiceDayInfo と StepPicker の部品の置き場として残してよい(手順の部品としては使わない)

#### T32 前提情報の手順:周辺事業者を「減便の動き」と「停留所の重なり」で見せ、一覧と地図を結び付け、一覧を畳む(指摘9.1・9.2・9.3、8.1の適用)(担当のモデル:opus)

- **目標**:周辺の事業者を、調べた減便の動きと、自社の停留所の近くにある停留所・系統で見せる。施設の一覧にカーソルや焦点を当てると地図の記号を強調する。一覧は選ばれた施設のあたりまでを出し、残りは「続きを表示」で開く。この手順のボタンを処理中の形にそろえる
- **前に済ませるタスク**:T24、T26、T28
- **触るファイル**:`web/src/components/steps/ResearchStep.tsx`、`web/src/components/steps/ResearchStep.test.tsx`、`web/src/store/research.ts`、`web/src/ref/facilities.ts`、`web/src/ref/facilities.test.ts`、`web/src/map/FacilityLayer.tsx`、`web/src/map/facilityLayers.ts`、`web/src/map/FacilityLayer.test.tsx`
- **受け入れ条件**:
  - store/research.ts が facilities/{mesh1}.json の busstops(T26)も読み、ref/busstops.ts の operatorOverlap で事業者ごとの重なりを持つ。減便の方針を承認済みなら、stopDiff で発車が減る・無くなる自社の停留所のうち、他社の停留所が 300m 以内にある数も出す
  - 事業者の行の主な中身を、(1) 調べた結果のうち label に「減便|ダイヤ改正|運休|特別ダイヤ」を含む事実(出典の番号・確認日時つき)、(2)「こちらの停留所 N か所の 300m 以内に、この事業者の停留所 M か所(系統:…)」にする。断り書き「国土数値情報の停留所には時刻が無いため、本数や時間帯で補えるかは、その事業者の時刻表で確かめてください」を出す
  - 事業者の既定の選び方は、重なりのある事業者を重なりの数の多い順に先にする(重なりの無い事業者は「近くに停留所なし」と出し、後ろに回す)
  - 地図では事業者の重心のひし形をやめ、重なりのある他社の停留所を T28 の記号で出す。凡例に「ほかの事業者の停留所(こちらの停留所から 300m 以内)N か所」を出す
  - 一覧の施設の行(と調査の結果のカード)に mouseenter・focus(キーボードを含む)で setHighlighted、mouseleave・blur で解除する。地図は強調する施設に輪を付け記号を大きくする(別のレイヤーを id で絞る)。地図は動かさない。事業者の行では、その事業者の重なる停留所を強調する
  - 種類ごとのまとまりの中は、選ばれた施設のうち最後のものの後ろ3件までを出し、残りを「続きを表示(残り N 件)」で開く。選ばれた施設の無いまとまりは最初の5件まで。まとまりの開閉の今の決まりは保つ
  - 「前提情報を調べる」(送信の POST の間)・「保存済みの結果(デモ)を使う」(デモの読み込みの間)・「読み込み直す」を T24 の loading にし、「保存済みの結果を読んでいます…」の行をなくす。調査の進み具合の表示は残す
  - ResearchStep.test.tsx・ref/facilities.test.ts・FacilityLayer.test.tsx で、事業者の行の中身と断り書き、既定の選び方の並び、ホバーと焦点で setHighlighted が呼ばれること、地図の強調レイヤーの絞り込み、続きの表示、ボタンの処理中を確かめる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 事業者の点の位置に意味が無いので、地図には重なる他社の停留所だけを出す
  - 強調は輪と記号の拡大だけにし、地図をその位置へ動かさない(一覧の上でマウスを動かすたびに地図が動くと、見ている場所を失うため)
  - 「続きを表示」はまとまりごと(全体ではなく)。選ばれた施設の後ろ3件までを先に見せ、選び足すときの候補も見えるようにする
  - 他事業者の GTFS を読み込んで本数まで見ることはしない(利用者の回答待ち。推奨は見送り)

#### T33 足し戻しの画面に、調べた結果の要点と、長期休業との重なりを出す(指摘12の画面)(担当のモデル:sonnet)

- **目標**:学校・病院の手がかりの理由に、調べた要点(受付時間・始業など)を出典と確認日時つきで出し、学校の長期休業が減便の期間と重なるときは(学)の印の近くに注意を出す
- **前に済ませるタスク**:T27
- **触るファイル**:`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/RestoreStep.test.tsx`、`web/src/components/steps/restore/TripLine.tsx`、`web/src/components/steps/restore/PickLists.tsx`、`web/src/components/steps/restore/CandidateGroups.tsx`
- **受け入れ条件**:
  - 学校・病院の手がかりのある便で、施設ごとに、窓の出どころ(調べた結果 / 既定)と、関係する事実(受付・始業・終業・休業)を出典のリンク・確認日時・デモの印つきで、開閉できる形で出す
  - 確認日時が 30 日より前なら「30日より前の確認です。出典で確かめてください」と添える
  - 足し戻す便に学校の手がかりがあり、T27 の関数で長期休業が減便の期間と重なるとき、(学)のチェックの近くに「期間中に夏季休業(7月24日〜8月24日)が重なります。休校日運休(学)の印を付けるか確かめてください」のように出す。チェックは自動で付けない
  - RestoreStep.test.tsx で、要点と出典の表示、古い確認日時の注意、長期休業の重なりの注意と、チェックが自動で付かないことを確かめる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 調べた要点は、手がかりの理由の文の下に開閉できる形で出す(候補の一覧の行が長くなりすぎないため)
  - 調べた結果は古くなりうるので、確認日時はいつも出し、30 日を超えたら注意を足す

### 波 3

#### T34 周知文の代替手段と変更指示書に、近くの他社の停留所と調べた減便の動きを載せる(指摘12・9.1)(担当のモデル:sonnet)

- **目標**:周知文案の代替手段の案内に、停留所の近くにある他社の停留所と系統を足し、周辺の事業者の減便の動き(調べた結果)を出典つきで添える。変更指示書にも周辺の事業者の動きを短く載せる
- **前に済ませるタスク**:T26、T27、T32
- **触るファイル**:`web/src/gtfs/edit/notice.ts`、`web/src/gtfs/edit/notice.test.ts`、`web/src/components/output/NoticeDraft.tsx`、`web/src/components/output/NoticeDraft.test.tsx`、`web/src/components/output/ChangeOrder.tsx`、`web/src/components/output/ChangeOrder.test.tsx`
- **受け入れ条件**:
  - gtfs/edit/notice.ts の代替手段の材料に、nearOtherStops(T26)で、掲示する停留所の 300m 以内の他社の停留所・事業者・系統名を足す(純粋な関数のまま、引数で他社の停留所を受ける)。notice.test.ts で確かめる
  - NoticeDraft の代替手段の欄に、他社の停留所と系統を出し、「時刻は各事業者の時刻表で確かめてください」と添える。その事業者に調べた減便の動きがあれば、事実・出典・確認日時を引用として出す(要約や推測はしない)
  - ChangeOrder に「周辺の事業者の動き(前提情報で調べた結果)」の短い欄を足し、減便の動きの事実を出典と確認日時つきで出す。調べていなければ欄に「調べていません」と出す。A4 縦1枚の印刷に収まるか確かめる
  - NoticeDraft.test.tsx・ChangeOrder.test.tsx で表示を確かめる。gtfs-reviewer に見てもらう。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 周辺の事業者の減便の動きは、周知文案(代替手段の案内)と変更指示書の両方に載せる。どちらも調べた事実の引用にとどめ、AI に文を書かせない
  - 他社の停留所の距離は周知文の自社の代替手段と同じ 300m

### 波 4

#### T35 語の表の主要な語を、画面全体で一度に置き換える(指摘13の土台。語の表の承認の後)(担当のモデル:opus)

- **目標**:利用者が承認した語の表のうち、複数の部品やテストにまたがる語(「足し戻し」、下書きの ID の見せ方、「消える・入る・残る」、手順の名前、主なボタンの名前)を、画面全体と全テストで一度にそろえる。共通の文言のファイル(editText.ts・editParts.tsx・editActions.ts)の文も、表と書き方の決まりに従って直す
- **前に済ませるタスク**:T29、T30、T31、T32、T33、T34
- **触るファイル**:`docs/wording.md(新規)`、`web/src/components/steps/registry.ts`、`web/src/components/layout/`、`web/src/components/steps/editText.ts`、`web/src/components/steps/editParts.tsx`、`web/src/components/steps/editActions.ts`、`web/src/(claude/ を除く、表の語を含むすべての画面のファイルとテスト)`
- **受け入れ条件**:
  - 語の表を docs/wording.md(新規)に写し、表の版(承認日)を書く
  - web/src のうち claude/ を除くすべての画面の文(JSX の文字、文言の定数、画面に出る例外の文)で、表の「今の語」を「直した語」に替える。コードの識別子(addBack・RestoreStep など)とコメントは替えない
  - 下書きの ID(d1 など)を画面に出さない(利用者の回答による)。AI に送る [画面の操作] の行の ID は残す(T42 の担当)
  - 手順の名前(registry.ts・各手順の見出し・ステッパー・「手順へ移る」)を表に合わせる
  - editText.ts・editParts.tsx・editActions.ts の文を、表と書き方の決まりに従って書き直す
  - この変更で壊れるテスト(App.test・EditFlow.test・各部品のテスト)をすべて直す。pnpm test・typecheck・lint・build が通る
  - 直した語の一覧(ファイルと件数)を報告する
- **決めたこと**:
  - 語の表の承認(user_questions)を待ってから始める。承認が無ければこのタスク以降(T35〜T44)は始めない
  - 主要な語は1つのタスクで全体を一度に替える(部品ごとに替えると、まとまりの間で語がずれ、同じテストを複数のタスクが直すことになるため)。この波はこのタスクだけにする
  - コードの識別子・テストの説明文(it の文)・コメントは替えない(凍結前に差分を増やさない)

### 波 5

#### T36 文の直し:読み込み・前提情報・骨組み・運営情報(指摘13)(担当のモデル:sonnet)

- **目標**:書き方の決まりに従い、読み込み・前提情報・画面の骨組み・運営情報の説明・注意・エラーの文を、短く自然な文に直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/steps/LoadStep.tsx`、`web/src/components/steps/ResearchStep.tsx`、`web/src/components/StepSection.tsx`、`web/src/components/DataSources.tsx`、`web/src/components/dataSourceRows.ts`、`web/src/pages/AboutPage.tsx`、`web/src/App.tsx`、`web/src/map/FacilityLayer.tsx`、`web/src/ref/facilities.ts`、`web/src/store/research.ts`、`web/src/store/priority.ts`、`web/src/store/gtfs.ts`、`web/src/gtfs/load.ts`、`web/src/gtfs/parse.ts`、`web/src/gtfs/holidays.ts`、`web/src/gtfs/calendar.ts`、`web/src/gtfs/departures.ts`、`web/src/gtfs/workerClient.ts`、`web/src/gtfs/worker.ts`、`web/src/lib/dates.ts`、`上のファイルのテスト(LoadStep.test・ResearchStep.test・DataSources.test・dataSourceRows.test・FacilityLayer.test・facilities.test・load.test・parse.test・holidays.test・calendar.test・departures.test)`
- **受け入れ条件**:
  - 表と書き方の決まり(docs/wording.md)に従い、受け持ちのファイルの画面の文を直す。数の出し方(コードが出す数)と、GTFS・法令の語(service_id・feed_version など)は変えない
  - 受け持ちのファイルのテストを合わせる。App.test・EditFlow.test・ReachStepFlow.test が確かめている文と、ほかのタスクのファイルの文言の定数は変えない(変えたいものは報告して T43 に回す)
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波の T37〜T42 とファイルを分ける。ほかのタスクのファイルのテストが壊れる変更はしない

#### T37 文の直し:減便の方針(指摘13)(担当のモデル:sonnet)

- **目標**:方針の手順(期間・ダイヤの種類・差の表示・届出の目安・承認)の文を、書き方の決まりに従って直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/steps/PolicyStep.tsx`、`web/src/components/steps/policy/`、`web/src/store/edit.ts`、`web/src/gtfs/edit/diff.ts`、`web/src/gtfs/edit/services.ts`、`web/src/components/steps/PolicyStep.test.tsx`、`web/src/components/steps/policy/DiffTables.test.tsx`、`web/src/store/edit.test.ts`、`web/src/gtfs/edit/diff.test.ts`、`web/src/gtfs/edit/services.test.ts`
- **受け入れ条件**:
  - 表と書き方の決まりに従い、受け持ちのファイルの画面の文を直す。数・GTFS と法令の語・公示の番号の説明は崩さない
  - 受け持ちのファイルのテストを合わせる。App.test・EditFlow.test の確かめている文と、editText.ts などの共通の文言(T35 で直したもの)は変えない
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波のほかのタスクとファイルを分ける

#### T38 文の直し:影響(到達圏)・地図・カレンダー(指摘13)(担当のモデル:sonnet)

- **目標**:影響(到達圏)の手順、地図の凡例と操作盤、カレンダーの文を、書き方の決まりに従って直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/steps/ReachStep.tsx`、`web/src/components/steps/DateBandStep.tsx`、`web/src/map/BandControl.tsx`、`web/src/map/ReachLayers.tsx`、`web/src/map/MapLegend.tsx`、`web/src/map/BaseMap.tsx`、`web/src/map/layers.ts`、`web/src/map/compareData.ts`、`web/src/components/HolidayCalendar.tsx`、`web/src/reach/`、`web/src/store/reach.ts`、`上のファイルのテスト(ReachStep.test・DateBandStep.test・ReachStepFlow.test・BandControl.test・ReachLayers.test・MapLegend.test・layers.test・compareData.test・HolidayCalendar.test・reach/*.test・store/reach.test)`
- **受け入れ条件**:
  - 表と書き方の決まりに従い、受け持ちのファイルの画面の文を直す。足し戻しの手順の「比べる日」の文で、操作盤の場所を案内する文は T39 が足す
  - 受け持ちのファイルのテストを合わせる(ReachStepFlow.test はこのタスクが受け持つ)。App.test・EditFlow.test の確かめている文は変えない
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波のほかのタスクとファイルを分ける

#### T39 文の直し:足し戻し(表の直した語の手順)(指摘13)(担当のモデル:sonnet)

- **目標**:足し戻しの手順の候補の一覧・手がかりの理由・休校日運休の印・AI に候補を聞くの文を、書き方の決まりに従って直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/steps/RestoreStep.tsx`、`web/src/components/steps/restore/`、`web/src/components/chat/AskRestoreButton.tsx`、`web/src/gtfs/edit/restore.ts`、`web/src/gtfs/edit/facilityHours.ts`、`web/src/store/restoreHintContext.ts`、`web/src/components/steps/RestoreStep.test.tsx`、`web/src/gtfs/edit/restore.test.ts`、`web/src/gtfs/edit/facilityHours.test.ts`、`web/src/store/restoreHintContext.test.ts`、`web/src/store/restoreHintContext.facilities.test.ts`
- **受け入れ条件**:
  - 表と書き方の決まりに従い、受け持ちのファイルの画面の文を直す。手がかりの名前(RESTORE_HINT_LABELS)と理由の文(nearFacilityText など)は、AI にも渡るので、T42 と語をそろえる(表に従う)
  - 比べる日の説明に、地図の下の操作盤で変えられることを足す
  - 受け持ちのファイルのテストを合わせる。App.test・EditFlow.test の確かめている文は変えない
  - pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波のほかのタスクとファイルを分ける。restore.ts の理由の文は AI の search_trips の結果にも入るので、T42 と同じ語を使う

#### T40 文の直し:出力(GTFS・変更指示書・周知文・停留所の一覧)と検証のメッセージ(指摘13)(担当のモデル:sonnet)

- **目標**:出力の手順の各タブと、検証器・書き出し・編集の操作のメッセージの文を、書き方の決まりに従って直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/steps/ExportStep.tsx`、`web/src/components/output/`、`web/src/gtfs/edit/notice.ts`、`web/src/gtfs/edit/form2.ts`、`web/src/gtfs/edit/ops.ts`、`web/src/gtfs/edit/stopDiff.ts`、`web/src/gtfs/edit/signature.ts`、`web/src/gtfs/validate/`、`web/src/gtfs/write.ts`、`上のファイルのテスト(ExportStep.test・output/*.test・notice.test・form2.test・ops.test・stopDiff.test・validate/*.test・write.test)`
- **受け入れ条件**:
  - 表と書き方の決まりに従い、受け持ちのファイルの画面の文を直す。周知文と告知文の雛形は、運輸規則第17条の項目と「法定の様式ではありません」の断りを保つ。検証の規則の名前(コード)は変えない
  - 受け持ちのファイルのテストを合わせる。App.test・EditFlow.test の確かめている文は変えない
  - gtfs-reviewer に、検証のメッセージの意味が変わっていないかを見てもらう。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波のほかのタスクとファイルを分ける

#### T41 文の直し:AI に相談の欄(指摘13)(担当のモデル:sonnet)

- **目標**:AI に相談の欄の画面の文(合言葉、準備中、送信、止める、会話の終わり、調査の進み具合)を、書き方の決まりに従って直す
- **前に済ませるタスク**:T35
- **触るファイル**:`web/src/components/chat/ChatPanel.tsx`、`web/src/components/chat/ChatMessages.tsx`、`web/src/components/chat/SentLog.tsx`、`web/src/components/chat/chatStatus.ts`、`web/src/store/chat.ts`、`web/src/components/chat/ChatPanel.test.tsx`、`web/src/store/chat.test.ts`
- **受け入れ条件**:
  - 表と書き方の決まりに従い、受け持ちのファイルの画面の文を直す。store/chat.ts の文言の定数のうち、ResearchStep などほかのタスクのテストが確かめているものは変えない(報告して T43 に回す)
  - ChatPanel.test.tsx・store/chat.test.ts を合わせる。pnpm test・typecheck・lint が通る
- **決めたこと**:
  - 同じ波のほかのタスクとファイルを分ける

#### T42 AI の定義と AI に渡す文を、画面の語にそろえる(指摘13・12。ant apply は利用者の承認の後)(担当のモデル:opus)

- **目標**:調整役のシステムプロンプト・ツールの説明・ツールの結果の文・[画面の操作] と [画面の状態] の行を、語の表と画面の語にそろえる。12 の施設ごとの時間帯の窓の説明も同時に直し、ant apply を1回で済ませる
- **前に済ませるタスク**:T35、T27
- **触るファイル**:`agents/coordinator.md`、`server/src/dispatcher_server/claude_tools.json`、`server/tests/test_agent_files.py`、`web/src/claude/tools.ts`、`web/src/claude/screenLines.ts`、`web/src/claude/session.ts`、`web/src/claude/research.ts`、`web/src/claude/sse.ts`、`web/src/claude/tools.test.ts`、`web/src/claude/tools.contract.test.ts`、`web/src/claude/screenLines.test.ts`、`web/src/claude/session.test.ts`
- **受け入れ条件**:
  - agents/coordinator.md と server/src/dispatcher_server/claude_tools.json(と web 側の写し)の語を表に合わせる。nearFacility・nearby_facilities の説明を、施設ごとの窓(調べた結果 / 既定)の形に直す
  - AI が利用者に下書きの ID を言わず、画面の呼び方(表に従う)で話すよう、システムプロンプトに書く。ツールの引数と [画面の操作] の行の ID はそのまま残す(AI がツールを呼ぶのに要るため)
  - claude/tools.ts のツールの結果・エラーの文と、画面に出る進み具合の文(apply_policy などの「…を作っています…」)、claude/screenLines.ts の行の文、claude/session.ts・research.ts・sse.ts の画面に出る文を表に合わせる
  - server/tests/test_agent_files.py(写しの一致)、tools.test.ts・tools.contract.test.ts・screenLines.test.ts・session.test.ts を合わせる。uv run pytest -q(server)と pnpm test・typecheck・lint が通る
  - ant apply の手順(適用するファイル、DISPATCHER_AGENT_VERSION の直し方、claude-lock.json の更新)を報告に書く。ant apply は利用者の承認の後に利用者が行う(このタスクでは実行しない)。本物の API は呼ばない
- **決めたこと**:
  - 12(施設ごとの窓)と 13(語)の定義の変更をまとめ、ant apply と調整役の版の更新を1回にする
  - agents/researcher.md は、利用者向けの文が無ければ変えない(調査役は利用者と話さない)

### 波 6

#### T43 文の直しの仕上げ:結合テストの文、残りの語の走査、agy での確かめ(指摘13)(担当のモデル:sonnet)

- **目標**:波5で回された結合テスト(App.test・EditFlow.test)にかかわる文を直し、古い語が画面に残っていないことをテストで確かめ、直した文の一部を agy(yomiyasu)にもう一度見せて確かめる
- **前に済ませるタスク**:T36、T37、T38、T39、T40、T41、T42
- **触るファイル**:`web/src/App.test.tsx`、`web/src/components/steps/EditFlow.test.tsx`、`web/src/wording.test.ts(新規)`、`(回された文のある web/src のファイル)`
- **受け入れ条件**:
  - T36〜T41 が回した文を直し、App.test.tsx・EditFlow.test.tsx を合わせる
  - web/src/wording.test.ts(新規)で、claude/ を含む web/src のテスト以外のファイルのうち、コメントの行を除いた文に、語の表の「今の語」(例「足し戻し」「下書き d」「消える 」など、表に従う)が残っていないことを確かめる。例外は表に書いたものだけ
  - 直した文から手順ごとに数件を選び、agy の Gemini(gemini-4-argon-high か gemini-3.8-flash-high)に yomiyasu で見せ、指摘と対応を報告する(結果のファイルはスクラッチパッドに置き、リポジトリに入れない)
  - pnpm test・typecheck・lint・build が通る
- **決めたこと**:
  - 古い語の走査はテストとして CI で走らせ、凍結の後に戻らないようにする

#### T44 文書を画面の語に合わせる(指摘13)(担当のモデル:haiku)

- **目標**:利用者が決めた範囲で、README・CLAUDE.md などの文書の語を画面の語に合わせる
- **前に済ませるタスク**:T35
- **触るファイル**:`README.md`、`CLAUDE.md`
- **受け入れ条件**:
  - 利用者の回答の範囲で、README.md の画面の説明・手順の名前を表に合わせる
  - CLAUDE.md に「画面と AI では語の表(docs/wording.md)の語を使う」と、今の語との対応を1か所に書く(業務の語を残す範囲は利用者の回答に従う)
  - 過去の取り決めの文書(docs/interfaces-*.md・tasks-1103.md)は記録なので書き換えない
  - Notion の「決めておくべき事項」に語の表の決定を書き足すことを、指示役への報告に書く
- **決めたこと**:
  - T43 とファイルが重ならないので同じ波に置く

## 見送るもの

- 他事業者の GTFS を合算した代替手段の判定(本数・時間帯で補えるか)。利用者の回答待ちで、推奨は見送り
- 長期休業の期間から休校日運休(学)の印を自動で付けること(注意を出すだけにする)
- 一覧のホバーで地図をその施設の位置へ動かすこと(輪と拡大だけにする)
- 読み込んだ GTFS の Attachment の「取り除く」ボタン(読み込み直しで置き換える)
- コードの識別子(addBack・RestoreStep など)・コメント・テストの説明文の語の置き換え
- 過去の取り決めの文書(docs/interfaces-*.md・tasks-1103.md)の語の書き換え
- 調べた結果の文から、学校の始業・終業以外の時刻(面会時間など)を手がかりに使うこと
- T26 の参照データの加工し直しに合わせた VPS の参照データの差し替え(指示役が docs/deploy.md の手順で行う)と、T42 の ant apply(利用者の操作)

## 利用者に伺う点

- agy が作っている語の表と書き方の決まりを確かめて、採否を決めてください。とくに「足し戻し」の言い換えをどうしますか。T35 以降(指摘13の実装)は、この承認を待って始めます。凍結(11/6 22:00)に間に合わせるには、11/5 の昼までの承認が要ります(推奨:表の案どおりに採る(「足し戻し」も言い換える)。指摘のとおり Dispatcher の造語は運行管理者・GTFS 担当者に通じにくく、画面と AI を1つの表でそろえれば、文書の側は対応表で結べるため)
- 画面に下書きの ID(d1 など)を出しますか(推奨:画面には出さない。利用者は ID を使う場面が無く、承認待ちの提案は同時に1つしかないため。AI がツールを呼ぶための ID は内部に残す)
- 語を変えたあと、文書をどこまで合わせますか(推奨:画面・AI・README を変え、CLAUDE.md と Notion には今の語との対応を1か所に書く。審査の人が読む README と画面をそろえつつ、過去の取り決めの文書(記録)は書き換えずに済むため)
- AI の定義(agents/coordinator.md・claude_tools.json)を、語の表と、調べた結果による時間帯の窓に合わせて直し、ant apply で調整役の版を上げてよいですか(適用は利用者の手元で行い、DISPATCHER_AGENT_VERSION を直します)(推奨:12 と 13 の分をまとめて1回 ant apply する。AI が利用者に話す語と画面の語がそろい、適用の手間も1回で済むため)
- 周辺の事業者が減便を補えるかを本数まで見るために、北海道オープンデータプラットフォームの他事業者の GTFS(旭川電気軌道など)を入手して読み込みますか(利用フォームの記入が要ります)(推奨:見送る。凍結まで約3日で、2つ目のフィードの読み込み・状態・到達圏の作り直しが要り、利用フォームの記入も済んでいないため。停留所の重なりと時刻表で確かめる旨の断り書きで、運行管理者が判断できる)
