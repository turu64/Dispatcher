"""Claude の中継の、IP アドレスごとの回数制限。数え上げはメモリの中だけ(再起動で消える)。

docs/interfaces-1105.md §4.11:
- セッションの作成:1 時間(直近 3,600 秒の窓)と 1 日(日本時間の日付)ごとの回数
- 発言(message):1 時間ごとの回数
- サーバー全体のセッションの作成の数は、再起動で 0 に戻らないよう SQLite(agent_sessions)から数える(store.py)

確かめる(check)と数える(record)を分ける。ほかの上限(全体の数・1日の利用額)で断った要求を数えないため。
関数は await を挟まないので、イベントループの上では確かめと加算が切り離されない。
"""

import time
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Literal

# 日本標準時は夏時間が無いので、固定の差で足りる(slim のイメージに tzdata が無くても動く)。
JST = timezone(timedelta(hours=9))

HOUR_SECONDS = 3600
_PRUNE_EVERY = 256

Kind = Literal["session", "message"]
Limited = Literal["hour", "day"]


def jst_day(timestamp: float) -> str:
    """日本時間の日付(YYYY-MM-DD)。"""
    return datetime.fromtimestamp(timestamp, JST).date().isoformat()


class RateLimiter:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        # (種類, 接続元) → 数えた時刻(古い順)。1 日の数え上げのため、最長で 1 日分を持つ
        self._stamps: dict[tuple[Kind, str], deque[float]] = {}
        self._checks = 0

    def reset(self) -> None:
        self._stamps.clear()
        self._checks = 0

    def check(self, kind: Kind, address: str, *, per_hour: int, per_day: int | None = None) -> Limited | None:
        """上限内なら None、上限ならどちらの上限か(1 日の上限を優先)を返す。数えない。"""
        now = self._clock()
        self._checks += 1
        if self._checks % _PRUNE_EVERY == 0:
            self._prune(now)
        stamps = self._trimmed(kind, address, now)
        if per_day is not None:
            today = jst_day(now)
            if sum(1 for stamp in stamps if jst_day(stamp) == today) >= per_day:
                return "day"
        cutoff = now - HOUR_SECONDS
        if per_hour <= 0 or sum(1 for stamp in stamps if stamp > cutoff) >= per_hour:
            return "hour"
        return None

    def record(self, kind: Kind, address: str) -> None:
        now = self._clock()
        self._trimmed(kind, address, now).append(now)

    def _trimmed(self, kind: Kind, address: str, now: float) -> deque[float]:
        stamps = self._stamps.setdefault((kind, address), deque())
        # 日本時間の日付をまたいだもの・1 日より古いものは要らない
        today = jst_day(now)
        cutoff = now - 24 * HOUR_SECONDS
        while stamps and (stamps[0] <= cutoff or (jst_day(stamps[0]) != today and stamps[0] <= now - HOUR_SECONDS)):
            stamps.popleft()
        return stamps

    def _prune(self, now: float) -> None:
        cutoff = now - 24 * HOUR_SECONDS
        for key in [key for key, stamps in self._stamps.items() if not stamps or stamps[-1] <= cutoff]:
            del self._stamps[key]
