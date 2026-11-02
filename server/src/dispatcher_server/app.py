import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

app = FastAPI(title="Dispatcher server")

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


def sample_gtfs_path() -> Path:
    return Path(os.environ.get("DISPATCHER_SAMPLE_GTFS", DEFAULT_SAMPLE_GTFS))


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
