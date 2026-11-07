# デモ動画の組み立て(第2版、2026-11-07)

`cuts2.json`(カットの表)から `render2.py` が動画を組み立てる。第1版(`../build/`)からの違い:

- 1-1〜4-2 は利用者が作った ElevenLabs の音声(`demo_sozai/dispatcher_elevenlabs_1_1_to_4_2.mp3`、82.2 秒)を、無音の位置の中央(`render2.py` の `INTRO`)でカットに切って使う。カットの尺は音声に合わせる
- 6 以降は macOS の読み上げ(仮、Kyoko・速さ 205、音量 +5dB)。字幕は Notion のコンテの文、読み上げだけ Claude・GTFS などをかなに直す
- 2-1:濃紺の日本列島(`japan-map.html` を `node shot.mjs <URL> japan.png` で撮る。OpenStreetMap Japan のベクトルタイル)の上に数字。「約3.6万人不足」は後から出す
- 2-2:`IMG_0486.MOV` をぼかし(ナンバー・顔が読めないように)、本社 → 運転席へ人のアイコンが動く。テロップの「本社の管理職」を強調
- 4-2:ナレーションの「私は Dispatcher」に合わせて題名(ロゴは未作成)
- 14:Claude Managed Agents の構造の図(セッションと調整役 → 6 つの操作 → 調査役 の順に出す)
- カット 18(構成の図)はなくした

置き場所:このフォルダの中身を作業用のフォルダに写し、`img/`(第1版の画面とプリビズ、`japan.png`)、`tts/`(読み上げと `nar.json`)、`ov/`・`seg/` を作ってから `python3 render2.py`(カットの id を渡すとそのカットだけ作る)。素材と出力の `dispatcher_demo_v2.mp4` はコミットしない。
