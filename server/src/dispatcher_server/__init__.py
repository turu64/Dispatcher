"""Dispatcher のサーバー。

役割は次の4つだけに限る(計算はすべてブラウザで行う)。
- Claude(Managed Agents のセッション)の中継。APIキーをブラウザに渡さない
- 利用制限(合言葉と IP アドレスごとの回数)
- Web 調査結果の使い回し(SQLite)
- 北海道の参照データとサンプル GTFS(道北バス)の配信

中継で受け取った GTFS の中身はログに残さない。
"""


def main() -> None:
    import uvicorn

    uvicorn.run("dispatcher_server.app:app", host="127.0.0.1", port=8000, reload=True)
