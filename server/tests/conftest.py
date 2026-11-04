"""テスト全体の共通の備え。

app を読み込むと、リポジトリ直下の .env(開発の API キーやエージェントの ID が入る)が環境変数に入る。
テストが本物の Anthropic API を呼んだり、開発の設定・開発の SQLite に左右されたりしないよう、
Claude の中継と Jev の中継に関わる環境変数をすべて消し、SQLite をテストごとの一時ファイルにし、
回数の数え上げとセッションの状態を新しくし、クライアントの作成は(各テストが差し替えない限り)失敗させる。
Jev の中継の通信も、既定では断る偽物(httpx2.MockTransport)に差し替える(本物の Jev をテストで呼ばない)。
偽物が呼ばれたら、後片付けでそのテストを失敗にする(中継は送る先の例外を target の失敗として飲み込むので、
例外だけではテストが落ちないため)。
"""

from pathlib import Path

import pytest

import httpx2

from dispatcher_server import agent_relay, agent_session, service_groups, store
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
    "DISPATCHER_PUBLIC",
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
    # Jev の中継(service_groups.py)
    "TYPESAFE_AI_VERCEL_KEY",
    "DISPATCHER_JEV_URL",
    "DISPATCHER_JEV_MODEL",
    "DISPATCHER_JEV_PER_IP_HOUR",
    "DISPATCHER_JEV_PER_IP_DAY",
    "DISPATCHER_JEV_TARGETS_PER_DAY",
    "DISPATCHER_JEV_COST_CENTS_PER_DAY",
)


def _refuse_real_client() -> None:
    raise AssertionError("テストが本物の Anthropic クライアントを作ろうとしました。get_client を差し替えてください")


# 断る偽物が呼ばれた回数(テストごとに数え直す)
_refused_jev_calls: list[str] = []


def _refuse_real_jev(request: httpx2.Request) -> httpx2.Response:
    _refused_jev_calls.append(request.method)
    raise AssertionError("テストが Jev に送ろうとしました。service_groups.transport を差し替えてください")


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
    monkeypatch.setattr(service_groups, "limiter", RateLimiter())
    monkeypatch.setattr(service_groups, "transport", httpx2.MockTransport(_refuse_real_jev))
    _refused_jev_calls.clear()
    yield
    store.reset_stores()
    agent_session.reset_states()
    refused = len(_refused_jev_calls)
    _refused_jev_calls.clear()
    if refused > 0:
        pytest.fail(f"テストが Jev に {refused} 回送ろうとしました。service_groups.transport を差し替えてください(upstream の fixture)")
