# サーバー(FastAPI)。Claude の中継、利用制限、Web 調査結果の使い回し、参照データとサンプル GTFS の配信。
# ビルドの文脈はリポジトリの最上位:docker build -f server/Dockerfile .
# API キー・合言葉などはイメージに入れず、環境変数で渡す。
# サンプル GTFS・参照データ・SQLite は、compose のボリュームで渡す(compose.yaml)。

FROM python:3.13-slim

# uv(Python のパッケージ管理)。ghcr.io に依存しないよう、PyPI から入れる(uv_build の 0.12 系に合わせる)
RUN pip install --no-cache-dir "uv>=0.12.10,<0.13"

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# 先に依存だけ入れる(ソースが変わっても、この層は使い回される)
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY server/src ./src
RUN uv sync --locked --no-dev

# 実行は一般利用者で。SQLite の置き場所は、ボリュームを付けたときに書き込めるよう持ち主を合わせる
RUN useradd --system --uid 10001 --no-create-home dispatcher \
    && mkdir -p /var/lib/dispatcher \
    && chown dispatcher /var/lib/dispatcher
USER dispatcher

ENV DISPATCHER_DB=/var/lib/dispatcher/dispatcher.sqlite3
EXPOSE 8000

# ワーカーは1つ(セッションの状態と回数の数え上げをメモリに持つため。docs/interfaces-1105.md §9)。
# --timeout-graceful-shutdown 3:開いたストリーム(SSE)が閉じるのを待ち続けて止まらなくなるのを防ぐ。
# --no-access-log:IP アドレスなどの生の値をログに残さない
CMD ["uvicorn", "dispatcher_server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-graceful-shutdown", "3", "--no-access-log"]
