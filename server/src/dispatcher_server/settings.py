"""環境変数と .env の読み込み。docs/interfaces-1105.md §4。

値は呼ぶたびに環境変数から読む(モジュールの定数にしない)。テストで環境変数を差し替えられ、
本番で compose の値を変えて再起動したときも、読み込み直しが要らない。
読んだ値はログに出さない。
"""

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# リポジトリの最上位(server/src/dispatcher_server/settings.py から3つ上)。開発時だけ正しい。
REPO_ROOT = Path(__file__).resolve().parents[3]

# SQLite の既定の置き場所(.gitignore の server/*.sqlite3 に入る)。本番は DISPATCHER_DB でボリュームに置く
DEFAULT_DB_PATH = REPO_ROOT / "server" / "dispatcher.sqlite3"

DEFAULT_SESSION_BUDGET_CENTS = 300
DEFAULT_DAILY_COST_CENTS = 600
DEFAULT_SESSION_TTL_HOURS = 24
DEFAULT_SESSIONS_PER_IP_HOUR = 3
DEFAULT_SESSIONS_PER_IP_DAY = 10
DEFAULT_MESSAGES_PER_IP_HOUR = 40
DEFAULT_SESSIONS_PER_DAY = 20
DEFAULT_RESEARCH_MAX_TARGETS = 30
DEFAULT_RESEARCH_CACHE_DAYS = 7

# TypeSafe AI Jev(Vercel AI Gateway 経由)。docs/design-service-groups.md §3.2・§3.3
DEFAULT_JEV_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
DEFAULT_JEV_MODEL = "typesafe-ai/jev"
DEFAULT_JEV_PER_IP_HOUR = 6
DEFAULT_JEV_PER_IP_DAY = 20
DEFAULT_JEV_TARGETS_PER_DAY = 2000
DEFAULT_JEV_COST_CENTS_PER_DAY = 100

_TRUE_VALUES = {"1", "true", "yes", "on"}

# DISPATCHER_SESSION_SECRET が無く DISPATCHER_DEV=1 のときに使う、起動ごとの乱数(再起動で取っ手が無効になる)
_DEV_SESSION_SECRET = secrets.token_bytes(32)


def load_env(path: Path | None = None) -> bool:
    """リポジトリ直下の .env を読む(開発用)。既にある環境変数は上書きしない。

    ファイルが無ければ何もしない(False を返す)。本番(Docker)は環境変数で渡し、.env をイメージに入れない。
    """
    env_path = path if path is not None else REPO_ROOT / ".env"
    if not env_path.is_file():
        return False
    load_dotenv(env_path, override=False)
    return True


def _env(name: str) -> str | None:
    # 空の値(compose で未設定の変数を渡した場合や、.env.example の「KEY=」)は未設定として扱う。
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _flag(name: str) -> bool:
    value = _env(name)
    return value is not None and value.lower() in _TRUE_VALUES


def _count(name: str, default: int) -> int:
    value = _env(name)
    if value is None:
        return default
    try:
        number = int(value)
    except ValueError:
        return default
    return number if number >= 0 else default


def _positive(name: str, default: int) -> int:
    number = _count(name, default)
    return number if number > 0 else default


# ---- Anthropic ----


def anthropic_api_key() -> str | None:
    return _env("ANTHROPIC_API_KEY")


def anthropic_workspace_id() -> str | None:
    return _env("ANTHROPIC_WORKSPACE_ID")


def agent_id() -> str | None:
    """調整役のエージェントの ID(agent_…)。ant apply の後に claude-lock.json から写す。"""
    return _env("DISPATCHER_AGENT_ID")


def agent_version() -> int | None:
    """調整役のエージェントの版(1 以上の整数)。読めなければ None(AI は使えない)。"""
    value = _env("DISPATCHER_AGENT_VERSION")
    if value is None:
        return None
    try:
        number = int(value)
    except ValueError:
        return None
    return number if number >= 1 else None


def environment_id() -> str | None:
    return _env("DISPATCHER_ENVIRONMENT_ID")


# ---- 合言葉・取っ手 ----


def dispatcher_token() -> str | None:
    """合言葉。設定されていれば、Claude の中継はヘッダー X-Dispatcher-Token と照合する。"""
    return _env("DISPATCHER_TOKEN")


def dev_mode() -> bool:
    """DISPATCHER_DEV=1。合言葉と取っ手の秘密が無くても Claude の中継を使えるようにする(開発用の明示)。"""
    return _flag("DISPATCHER_DEV")


def public_mode() -> bool:
    """DISPATCHER_PUBLIC=1。本番で合言葉なしの公開を明示する(docs/tasks-1103.md の「利用者の決定(11/3)」の 2)。

    合言葉が無くても Claude の中継を使えるようにするだけ。DISPATCHER_DEV のほかの緩み(取っ手の秘密を
    起動ごとの乱数にするなど)は許さない。合言葉も設定されていれば、合言葉を求める。
    """
    return _flag("DISPATCHER_PUBLIC")


def session_secret() -> bytes | None:
    """取っ手の署名の秘密。無ければ、開発(DISPATCHER_DEV=1)では起動ごとの乱数、そうでなければ None。"""
    value = _env("DISPATCHER_SESSION_SECRET")
    if value is not None:
        return value.encode("utf-8")
    if dev_mode():
        return _DEV_SESSION_SECRET
    return None


def trust_proxy() -> bool:
    """DISPATCHER_TRUST_PROXY=1 のときだけ、nginx が付ける X-Real-IP を接続元として読む。"""
    return _flag("DISPATCHER_TRUST_PROXY")


# ---- SQLite ----


def db_path() -> Path:
    value = _env("DISPATCHER_DB")
    return Path(value) if value is not None else DEFAULT_DB_PATH


# ---- セッション・料金・回数 ----


def session_budget_cents() -> int:
    return _positive("DISPATCHER_SESSION_BUDGET_CENTS", DEFAULT_SESSION_BUDGET_CENTS)


def daily_cost_cents() -> int:
    return _count("DISPATCHER_DAILY_COST_CENTS", DEFAULT_DAILY_COST_CENTS)


def session_ttl_hours() -> int:
    return _positive("DISPATCHER_SESSION_TTL_HOURS", DEFAULT_SESSION_TTL_HOURS)


def sessions_per_ip_hour() -> int:
    return _count("DISPATCHER_SESSIONS_PER_IP_HOUR", DEFAULT_SESSIONS_PER_IP_HOUR)


def sessions_per_ip_day() -> int:
    return _count("DISPATCHER_SESSIONS_PER_IP_DAY", DEFAULT_SESSIONS_PER_IP_DAY)


def messages_per_ip_hour() -> int:
    return _count("DISPATCHER_MESSAGES_PER_IP_HOUR", DEFAULT_MESSAGES_PER_IP_HOUR)


def sessions_per_day() -> int:
    return _count("DISPATCHER_SESSIONS_PER_DAY", DEFAULT_SESSIONS_PER_DAY)


def research_max_targets() -> int:
    return _positive("DISPATCHER_RESEARCH_MAX_TARGETS", DEFAULT_RESEARCH_MAX_TARGETS)


def research_cache_days() -> int:
    return _positive("DISPATCHER_RESEARCH_CACHE_DAYS", DEFAULT_RESEARCH_CACHE_DAYS)


# ---- TypeSafe AI Jev(service のグループ分けの確かめ) ----


def jev_api_key() -> str | None:
    """Vercel AI Gateway のキー。Vercel の口(jev_url の確かめを通ったもの)にだけ送る。値はログにも応答にも出さない。"""
    return _env("TYPESAFE_AI_VERCEL_KEY")


def jev_url() -> str:
    """Jev の口。ホストが ai-gateway.vercel.sh で https のときだけ使う(確かめは service_groups.py)。"""
    return _env("DISPATCHER_JEV_URL") or DEFAULT_JEV_URL


def jev_model() -> str:
    """ヘッダー ai-model-id に入れるモデルの名前。"""
    return _env("DISPATCHER_JEV_MODEL") or DEFAULT_JEV_MODEL


def jev_requests_per_ip_hour() -> int:
    return _count("DISPATCHER_JEV_PER_IP_HOUR", DEFAULT_JEV_PER_IP_HOUR)


def jev_requests_per_ip_day() -> int:
    return _count("DISPATCHER_JEV_PER_IP_DAY", DEFAULT_JEV_PER_IP_DAY)


def jev_targets_per_day() -> int:
    """サーバー全体の、日本時間の1日に Jev に問う target の数の上限。0 なら Jev を使わない。"""
    return _count("DISPATCHER_JEV_TARGETS_PER_DAY", DEFAULT_JEV_TARGETS_PER_DAY)


def jev_cost_cents_per_day() -> int:
    """サーバー全体の、日本時間の1日の Jev の額の上限(セント。応答の gateway.cost の合計)。0 なら Jev を使わない。"""
    return _count("DISPATCHER_JEV_COST_CENTS_PER_DAY", DEFAULT_JEV_COST_CENTS_PER_DAY)


# ---- 参照データ ----

# 参照データ(1次メッシュごとの JSON)の既定の置き場所。app.py の DEFAULT_REF_DIR と同じ(開発時だけ正しい)
DEFAULT_REF_DIR = REPO_ROOT / "data" / "out" / "ref"


def ref_dir() -> Path:
    """参照データの置き場所(DISPATCHER_REF_DIR。空の値は未設定として扱う)。前提情報の調査の対象をここから引く。"""
    value = _env("DISPATCHER_REF_DIR")
    return Path(value) if value is not None else DEFAULT_REF_DIR
