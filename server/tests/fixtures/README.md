# テストの固定のデータ

## jev_judge_request.json・jev_judge_response.json

Jev の中継(`server/src/dispatcher_server/service_groups.py`)のテストに使う、要求と応答の例(`docs/design-service-groups.md` §7.5、`docs/interfaces-1105.md` §4.14)。

- `jev_judge_request.json` の数(運行日の数・網羅率・便数・系統の数・始発と終着の時刻・系統の重なり)と service_id は、北海道中央バスの GTFS から service ごとに集計して加工した値(S000001・S000014・S000027)
  - 出典:北海道オープンデータプラットフォーム「北海道中央バス」の GTFS(CC BY 4.0)。2026-11-03 に利用者が利用フォームに記入してダウンロードしたもの。GTFS そのものはコミットしない(`data/raw/README.md`)
  - 加工:Dispatcher のグループ分けの判断材料に集計した
- 事業者名・系統名・行き先は、架空の名前(事業者は「さくら野交通」)に差し替えた(2026-11-04、利用者の決定)。実在の事業者・系統・停留所とは関係ない。数・件数・並び・項目の形は集計した値のまま。同じ系統名・行き先は、どの service でも同じ架空の名前にしている
- `jev_judge_response.json` の答え(確率・確信度・トークン・額)は、テスト用に作った値で、本物の Jev の答えではない。`sent` は、サーバーが上の要求から組み立てる本文(名前は要求と同じ架空の名前)
