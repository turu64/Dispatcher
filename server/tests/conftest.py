"""テスト全体の共通の備え。

app を読み込むと、リポジトリ直下の .env(開発の API キーやエージェントの ID が入る)が環境変数に入る。
テストが本物の Anthropic API を呼んだり、開発の設定・開発の SQLite に左右されたりしないよう、
Claude の中継に関わる環境変数をすべて消し、SQLite をテストごとの一時ファイルにし、
回数の数え上げとセッションの状態を新しくし、クライアントの作成は(各テストが差し替えない限り)失敗させる。
"""

from pathlib import Path

import pytest

from dispatcher_server import agent_relay, agent_session, store
from dispatcher_server.ratelimit import RateLimiter

# Claude の中継が読む環境変数と、SDK が環境変数から拾うもの
CLAUDE_ENV_NAMES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_LOG",
    "ANTHROPIC_WORKSPACE_ID",
    "DISPATCHER_AGENT_ID",
    "DISPATCHER_AGENT_VERSION",
    "DISPATCHER_ENVIRONMENT_ID",
    "DISPATCHER_SESSION_SECRET",
    "DISPATCHER_TOKEN",
    "DISPATCHER_DEV",
    "DISPATCHER_TRUST_PROXY",
    "DISPATCHER_DB",
    "DISPATCHER_SESSION_BUDGET_CENTS",
    "DISPATCHER_SESSION_TTL_HOURS",
    "DISPATCHER_SESSIONS_PER_IP_HOUR",
    "DISPATCHER_SESSIONS_PER_IP_DAY",
    "DISPATCHER_MESSAGES_PER_IP_HOUR",
    "DISPATCHER_SESSIONS_PER_DAY",
    "DISPATCHER_DAILY_COST_CENTS",
    "DISPATCHER_RESEARCH_MAX_TARGETS",
    "DISPATCHER_RESEARCH_CACHE_DAYS",
)


def _refuse_real_client() -> None:
    raise AssertionError("テストが本物の Anthropic クライアントを作ろうとしました。get_client を差し替えてください")


@pytest.fixture(autouse=True)
def isolate_claude(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in CLAUDE_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DISPATCHER_DB", str(tmp_path / "dispatcher-test.sqlite3"))
    store.reset_stores()
    agent_session.reset_states()
    monkeypatch.setattr(agent_relay, "limiter", RateLimiter())
    monkeypatch.setattr(agent_session, "get_client", _refuse_real_client)
    monkeypatch.setattr(agent_session, "_clients", {})
    yield
    store.reset_stores()
    agent_session.reset_states()
