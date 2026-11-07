import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dispatcher_server.app import app

client = TestClient(app)


@pytest.fixture
def sample_zip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "sample.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("agency.txt", "agency_id,agency_name\n1,テストバス\n")
    monkeypatch.setenv("DISPATCHER_SAMPLE_GTFS", str(path))
    return path


@pytest.fixture
def no_sample(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISPATCHER_SAMPLE_GTFS", str(tmp_path / "missing.zip"))


def test_info_when_available(sample_zip: Path) -> None:
    res = client.get("/api/sample-gtfs")
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert body["name"] == "道北バス"
    assert body["license"] == "CC BY 4.0"
    assert "北海道オープンデータプラットフォーム" in body["source"]


def test_info_when_missing(no_sample: None) -> None:
    res = client.get("/api/sample-gtfs")
    assert res.status_code == 200
    assert res.json()["available"] is False


def test_download_returns_zip(sample_zip: Path) -> None:
    res = client.get("/api/sample-gtfs/download")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert res.content == sample_zip.read_bytes()


def test_download_missing_is_404(no_sample: None) -> None:
    res = client.get("/api/sample-gtfs/download")
    assert res.status_code == 404
    assert "data/raw/gtfs" in res.json()["detail"]
