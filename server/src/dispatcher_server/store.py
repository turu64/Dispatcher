"""サーバーの SQLite。docs/interfaces-1105.md §4.10。

- agent_sessions:セッションの取っ手の行(Anthropic のセッションの ID はブラウザに渡さない)
- cost_ledger:日本時間の日付ごとの利用額(セント。定価で数えた額)
- research_targets・research_results:前提情報の調査(11/6。公開情報だけ)

会話の中身・ツールの入力と結果・IP アドレスは入れない。
時刻は UTC の ISO 8601 で、同じ書き方にそろえる(文字列の大小で比べるため)。
"""

import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .ratelimit import JST, jst_day

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_sessions (
  row_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT,
  deleted_at TEXT,
  delete_pending INTEGER NOT NULL DEFAULT 0,
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cost_ledger (day TEXT PRIMARY KEY, cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS research_targets (row_id TEXT, target_id TEXT, PRIMARY KEY (row_id, target_id));
CREATE TABLE IF NOT EXISTS research_results (
  target_id TEXT PRIMARY KEY, kind TEXT, name TEXT, status TEXT,
  facts_json TEXT, sources_json TEXT, note TEXT,
  checked_at TEXT NOT NULL, expires_at TEXT, origin TEXT NOT NULL
);
"""

# 消した行を残す期間(1日の数え上げが終わってから消す)
DELETED_ROW_KEEP = timedelta(days=2)


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="microseconds")


def _jst_day_bounds(day: str) -> tuple[str, str]:
    start = datetime.fromisoformat(day).replace(tzinfo=JST)
    end = start + timedelta(days=1)
    return start.astimezone(UTC).isoformat(timespec="microseconds"), end.astimezone(UTC).isoformat(
        timespec="microseconds"
    )


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        # FastAPI は同期の関数を別のスレッドで動かすので、1つの接続を鍵で守って使い回す
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def _all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params).fetchall()]

    # ---- agent_sessions ----

    def insert_session(self, row_id: str, session_id: str, agent_version: int, now: float) -> None:
        stamp = iso(now)
        self._execute(
            "INSERT INTO agent_sessions (row_id, session_id, agent_version, created_at, last_activity_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (row_id, session_id, agent_version, stamp, stamp),
        )

    def get_session(self, row_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM agent_sessions WHERE row_id = ?", (row_id,))
        return rows[0] if rows else None

    def touch(self, row_id: str, now: float, *, messages: int = 0, tool_calls: int = 0) -> None:
        self._execute(
            "UPDATE agent_sessions SET last_activity_at = ?, messages = messages + ?, tool_calls = tool_calls + ?"
            " WHERE row_id = ?",
            (iso(now), messages, tool_calls, row_id),
        )

    def mark_ended(self, row_id: str, now: float) -> None:
        self._execute(
            "UPDATE agent_sessions SET ended_at = ? WHERE row_id = ? AND ended_at IS NULL", (iso(now), row_id)
        )

    def mark_deleted(self, row_id: str, now: float) -> None:
        self._execute(
            "UPDATE agent_sessions SET deleted_at = ?, session_id = '', delete_pending = 0,"
            " ended_at = COALESCE(ended_at, ?) WHERE row_id = ?",
            (iso(now), iso(now), row_id),
        )

    def mark_delete_failed(self, row_id: str) -> int:
        """削除が断られた。delete_pending を付け、続けて断られた回数を返す。"""
        self._execute(
            "UPDATE agent_sessions SET delete_pending = 1, delete_attempts = delete_attempts + 1 WHERE row_id = ?",
            (row_id,),
        )
        row = self.get_session(row_id)
        return int(row["delete_attempts"]) if row else 0

    def sessions_created_on(self, day: str) -> int:
        """日本時間の日付 day に作ったセッションの数(消した行も、掃除で消えるまでは数える)。"""
        start, end = _jst_day_bounds(day)
        rows = self._all(
            "SELECT COUNT(*) AS n FROM agent_sessions WHERE created_at >= ? AND created_at < ?", (start, end)
        )
        return int(rows[0]["n"])

    def reserved_cents(self, budget_cents: int) -> int:
        """消していないセッションごとの(予算 − 最後に読んだ利用額)の合計。"""
        rows = self._all("SELECT cost_cents FROM agent_sessions WHERE deleted_at IS NULL")
        return sum(max(budget_cents - int(row["cost_cents"]), 0) for row in rows)

    def rows_to_sweep(self, now: float, ttl_hours: int) -> list[dict[str, Any]]:
        """消す行:最後の操作から ttl_hours たった行、終えた(DELETE を受けた)行、delete_pending の行。"""
        cutoff = iso(now - ttl_hours * 3600)
        return self._all(
            "SELECT * FROM agent_sessions WHERE deleted_at IS NULL"
            " AND (last_activity_at < ? OR ended_at IS NOT NULL OR delete_pending = 1)"
            " ORDER BY created_at",
            (cutoff,),
        )

    def live_rows(self) -> list[dict[str, Any]]:
        """終えていない(取っ手が使える)行。"""
        return self._all("SELECT * FROM agent_sessions WHERE deleted_at IS NULL AND ended_at IS NULL")

    # ---- cost_ledger ----

    def record_cost(self, row_id: str, cost_cents: int, now: float) -> int:
        """最後に読んだ利用額を cost_cents にし、増えた分をその日(日本時間)の台帳に足す。足した額を返す。"""
        with self._lock:
            row = self._conn.execute("SELECT cost_cents FROM agent_sessions WHERE row_id = ?", (row_id,)).fetchone()
            if row is None:
                return 0
            delta = cost_cents - int(row["cost_cents"])
            if delta <= 0:
                return 0
            self._conn.execute("UPDATE agent_sessions SET cost_cents = ? WHERE row_id = ?", (cost_cents, row_id))
            self._conn.execute(
                "INSERT INTO cost_ledger (day, cents) VALUES (?, ?)"
                " ON CONFLICT(day) DO UPDATE SET cents = cents + excluded.cents",
                (jst_day(now), delta),
            )
            return delta

    def ledger_cents(self, day: str) -> int:
        rows = self._all("SELECT cents FROM cost_ledger WHERE day = ?", (day,))
        return int(rows[0]["cents"]) if rows else 0

    # ---- 掃除 ----

    def purge(self, now: float) -> tuple[int, int]:
        """消してから 2 日たった行(と、その調査の対象)、期限の切れた web の調査の結果を消す。消した数を返す。"""
        cutoff = iso(now - DELETED_ROW_KEEP.total_seconds())
        with self._lock:
            old = [
                row["row_id"]
                for row in self._conn.execute(
                    "SELECT row_id FROM agent_sessions WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,)
                ).fetchall()
            ]
            for row_id in old:
                self._conn.execute("DELETE FROM research_targets WHERE row_id = ?", (row_id,))
                self._conn.execute("DELETE FROM agent_sessions WHERE row_id = ?", (row_id,))
            expired = self._conn.execute(
                "DELETE FROM research_results WHERE origin = 'web' AND expires_at IS NOT NULL AND expires_at < ?",
                (iso(now),),
            ).rowcount
        return len(old), expired

    # ---- research_results(11/6) ----

    def get_research_result(self, target_id: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM research_results WHERE target_id = ?", (target_id,))
        return rows[0] if rows else None

    def save_research_result(
        self,
        *,
        target_id: str,
        kind: str,
        name: str,
        status: str,
        facts: list[dict[str, Any]],
        sources: list[dict[str, Any]],
        note: str,
        now: float,
        cache_days: int,
        origin: str = "web",
    ) -> tuple[bool, dict[str, Any] | None]:
        """調査の結果を保存する。保存したら (True, None)。

        origin: demo の行か、期限の切れていない行が既にあれば、保存せずに (False, 既にある行) を返す
        (§3.2 の「上書きしない」)。置き換えるのは、期限の切れた web の行だけ。
        """
        stamp = iso(now)
        expires = None if origin == "demo" else iso(now + cache_days * 86400)
        with self._lock:
            existing = self._conn.execute(
                "SELECT * FROM research_results WHERE target_id = ?", (target_id,)
            ).fetchone()
            if existing is not None:
                existing_row = dict(existing)
                still_valid = existing_row["expires_at"] is None or existing_row["expires_at"] >= stamp
                if existing_row["origin"] == "demo" or still_valid:
                    return False, existing_row
            self._conn.execute(
                "INSERT OR REPLACE INTO research_results (target_id, kind, name, status, facts_json, sources_json,"
                " note, checked_at, expires_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    target_id,
                    kind,
                    name,
                    status,
                    json.dumps(facts, ensure_ascii=False),
                    json.dumps(sources, ensure_ascii=False),
                    note,
                    stamp,
                    expires,
                    origin,
                ),
            )
        return True, None


_stores: dict[str, Store] = {}
_stores_lock = threading.Lock()


def get_store() -> Store:
    """DISPATCHER_DB の場所の Store(同じ場所のあいだは使い回す)。"""
    from . import settings

    path = settings.db_path()
    key = str(path)
    with _stores_lock:
        store = _stores.get(key)
        if store is None:
            store = _stores[key] = Store(path)
        return store


def reset_stores() -> None:
    """テスト用:開いている Store を閉じて忘れる。"""
    with _stores_lock:
        for store in _stores.values():
            store.close()
        _stores.clear()
