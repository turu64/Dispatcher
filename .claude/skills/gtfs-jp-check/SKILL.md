---
name: gtfs-jp-check
description: Dispatcher が出力した GTFS(減便を反映したもの)が GTFS-JP 第4.0版の主な規則と、入力 GTFS の作り方に沿っているかを確かめる。GTFS の読み込み・編集・出力のコードを変えたとき、出力 ZIP を確認したいとき、検証器(web/src/gtfs/validate)の規則を足すときに使う。
---

# GTFS-JP の出力確認

Dispatcher の出力 GTFS を確かめる手順です。規則の正は GTFS-JP 第4.0版の仕様書です。迷ったら仕様書を確認し、推測で規則を作らないでください。

## 1. 自動検証を走らせる

```bash
cd web && pnpm exec vitest run src/gtfs
```

- 検証器は `web/src/gtfs/` にあります(TypeScript、ブラウザでも同じコードが動く)。
- サンプル GTFS(`data/raw/gtfs/*.zip`)を使うテストは、ファイルが無ければスキップされます。スキップされたら、そのことを報告に書いてください。

## 2. 検証器が見る規則(実装済みかどうかは検証器のコードで確認)

1. 必須ファイルがそろっている(agency、stops、routes、trips、stop_times、calendar または calendar_dates、feed_info など)
2. 参照の整合:trips.route_id、trips.service_id、stop_times.trip_id、stop_times.stop_id が、参照先に存在する
3. 日付は YYYYMMDD、時刻は HH:MM:SS。24時を超える時刻(25:10:00 など)を正しく扱う
4. stop_times の stop_sequence が便ごとに増えていく
5. calendar と calendar_dates:exception_type は 1(追加)か 2(除外)。減便期間の外で、元のダイヤが変わっていない
6. feed_info の版番号(feed_version)が更新されている

## 3. 減便の反映として確かめること(検証器では見きれない部分)

- **入力の作り方に従っているか**:入力が calendar 中心なら calendar 中心、calendar_dates 中心ならそのまま。service_id の付け方も入力に合わせる
- **期間の外は元のまま**:減便期間の前後の日付で、運行する便の集合が入力と同じ
- **期間の中**:平日に、方針で選んだダイヤ(土曜または日祝)の便が走り、足し戻した便だけが平日側に残る
- **祝日**:内閣府の祝日一覧に基づく日付の扱いが、入力と矛盾しない
- **元に戻せる**:編集の履歴から入力と同じ GTFS に戻せる

## 4. 報告の形

- 問題ごとに、ファイル名、行(または trip_id・service_id)、規則、直し方を書く
- 検証器の不足(見るべきなのに見ていない規則)を見つけたら、別にまとめる
- 実行したコマンドと、スキップしたテストを書く
