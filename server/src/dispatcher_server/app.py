import asyncio
import contextlib
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from starlette.convertors import Convertor, register_url_convertor

from . import agent_session
from .agent_relay import router as agent_router
from .settings import load_env

# 開発ではリポジトリ直下の .env を読む(既にある環境変数は上書きしない。ファイルが無ければ何もしない)。
# Claude の中継の設定(API キー・エージェントの ID・合言葉など)は、要求のたびに環境変数から読む
load_env()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # セッションの掃除(起動時と 15 分ごと。docs/interfaces-1105.md §4.10)。終わるときに止める
    task = asyncio.create_task(agent_session.sweep_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Dispatcher server", lifespan=lifespan)
app.include_router(agent_router)

# リポジトリの最上位(server/src/dispatcher_server/app.py から3つ上)。
# 開発時(uv の editable インストール)だけ正しい。本番は環境変数で場所を渡す。
REPO_ROOT = Path(__file__).resolve().parents[3]

# サンプル GTFS(道北バス)。利用者が北海道オープンデータプラットフォームの利用フォームに
# 記入してから、data/raw/gtfs/dohoku_bus_減便前.zip に置く(9/17 作成の版。減便を当てる前のダイヤ)。
# 本番では環境変数で置き場所を渡す
# (Docker ではこのファイルをボリュームでマウントする)。
DEFAULT_SAMPLE_GTFS = REPO_ROOT / "data" / "raw" / "gtfs" / "dohoku_bus_減便前.zip"

SAMPLE_GTFS_INFO = {
    "name": "道北バス",
    "source": "北海道オープンデータプラットフォーム(gtfs-data)",
    "license": "CC BY 4.0",
}

# 参照データ(1次メッシュごとの JSON)。data/ が data/out/ref/ に書き出し、web/ が読む。
# 本番では環境変数 DISPATCHER_REF_DIR で置き場所を渡す。
DEFAULT_REF_DIR = REPO_ROOT / "data" / "out" / "ref"

# 1次メッシュコードは数字4桁だけを受け付ける。パスを組み立てる前に検査する。
# \d は全角数字などにも一致し、$ は末尾の改行にも一致するため、[0-9] と fullmatch を使う。
MESH1_PATTERN = re.compile(r"[0-9]{4}")


def sample_gtfs_path() -> Path:
    return Path(os.environ.get("DISPATCHER_SAMPLE_GTFS", DEFAULT_SAMPLE_GTFS))


def ref_dir_path() -> Path:
    # 空文字の環境変数(compose で未設定の変数を渡した場合など)は未設定として扱う。
    # Path("") は現在のディレクトリになり、そこの 6542.json などを配ってしまう。
    return Path(os.environ.get("DISPATCHER_REF_DIR") or DEFAULT_REF_DIR)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sample-gtfs")
def sample_gtfs_info() -> dict[str, str | bool]:
    return {"available": sample_gtfs_path().is_file(), **SAMPLE_GTFS_INFO}


@app.get("/api/sample-gtfs/download")
def sample_gtfs_download() -> FileResponse:
    path = sample_gtfs_path()
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="サンプル GTFS が見つかりません。data/raw/gtfs/dohoku_bus_減便前.zip に置いてください。",
        )
    return FileResponse(path, media_type="application/zip", filename="dohoku_bus.zip")


REF_MESH1_ERROR = "1次メッシュのコードは数字4桁で指定してください。"


@app.get("/api/ref/{mesh1}")
def ref_data(mesh1: str) -> FileResponse:
    if not MESH1_PATTERN.fullmatch(mesh1):
        raise HTTPException(status_code=404, detail=REF_MESH1_ERROR)
    path = ref_dir_path() / f"{mesh1}.json"
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"1次メッシュ {mesh1} の参照データが見つかりません。data/ の加工で data/out/ref に作ってください。",
        )
    return FileResponse(
        path,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


HOLIDAYS_NOT_FOUND = "祝日一覧が見つかりません。data/ の dispatcher-holidays で data/out/ref に作ってください。"


# 内閣府の祝日一覧(data/ の dispatcher-holidays が作る holidays.json)。参照データと同じ場所に置くので、
# Docker でも同じボリュームで渡せる。/api/ref/{mesh1} は数字4桁だけを受け付けるので、holidays はそちらに入らない。
@app.get("/api/holidays")
def holidays() -> FileResponse:
    path = ref_dir_path() / "holidays.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=HOLIDAYS_NOT_FOUND)
    return FileResponse(
        path,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


class AnyPathConvertor(Convertor[str]):
    """改行を含むすべての文字に一致する経路の型。

    Starlette 標準の path は「.*」で、改行に一致しない。「a/b」と改行が混ざった入力は
    どの経路にも一致せず、英語の Not Found になってしまう。
    """

    regex = r"[\s\S]*"

    def convert(self, value: str) -> str:
        return str(value)

    def to_string(self, value: str) -> str:
        return str(value)


register_url_convertor("anypath", AnyPathConvertor())


# 「../」などの区切り文字を含む入力は {mesh1} の経路に届かない(FastAPI の英語の Not Found になる)。
# ここで同じ日本語の 404 を返す。{mesh1:path} を主経路にしないのは、Starlette の正規表現が
# 末尾の改行を読み飛ばし、「6542%0A」を 6542 として通してしまうため。
@app.get("/api/ref/{rest:anypath}", include_in_schema=False)
def ref_data_rejected(rest: str) -> None:
    raise HTTPException(status_code=404, detail=REF_MESH1_ERROR)
