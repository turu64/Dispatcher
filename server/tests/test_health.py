from fastapi.testclient import TestClient

from dispatcher_server.app import app


def test_health() -> None:
    client = TestClient(app)
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
