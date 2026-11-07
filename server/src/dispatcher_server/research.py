"""周辺の施設の調査(サーバーの側。2026-11-07 に「前提情報の調査」から改名)。docs/interfaces-1105.md §3.2・§4.2・§4.10、docs/tasks-1103.md の T07。

- 調査の対象は、サーバーの参照データ(DISPATCHER_REF_DIR)の施設・事業者から target_id で引く。
  名前・種類・市町村・位置はサーバーのデータを使い、ブラウザや Claude が送った名前は使わない
- サーバーが実行する3つのツール(get_research_targets・get_research_results・save_research)の中身
- デモ用の保存済みの結果を JSON から origin: demo で取り込むコマンド(dispatcher-research-seed)

参照データの形(T06 の data/src/dispatcher_data/facilities.py が書き出す):
    DISPATCHER_REF_DIR/facilities/*.json(T06 の出力。1次メッシュごとの {mesh1}.json)と DISPATCHER_REF_DIR/*.json の
    うち、最上位がオブジェクトで "facilities" の配列を持つもの(holidays.json などの "facilities" の無いファイルは読み飛ばす)。
    配列の要素は {"target_id", "kind", "name", "municipality", "lat", "lon", ...種類の詳細}
    - target_id:P29:<学校コード>、P04:<名称と所在地を NFKC で整えた文字列の SHA-1 の先頭12桁>、
      P11:<事業者名を NFKC で整えた文字列>
    - kind:operator・school・hospital・clinic
    - municipality が空文字なら null にする。detail などほかの項目は読まない
    - 同じ target_id が複数のファイルにあれば(事業者は停留所のある1次メッシュすべてに入る)、
      facilities/ を先に、それぞれの中はファイル名の順に読んで最初のものを使う(位置はその1次メッシュの停留所の重心)
    形の合わない要素は読み飛ばす(数だけをログに残す)

デモ用の結果のファイルの形(dispatcher-research-seed <file>):
    [{"target_id", "status", "facts": [{"label", "value", "source"}], "sources": [{"url", "title"}],
      "note", "checked_at"}] か、{"results": [同じ]}
    - checked_at は時差つきの ISO 8601(例 2026-11-06T10:00:00+09:00)。実際に調べた日時を入れる
    - kind・name・origin があっても読まない(種類と名前はサーバーの参照データから入れる)
    - 確かめは save_research と同じ(対象がこの会話の対象にあることの代わりに、参照データにあることを確かめる)
    - 1件でも外れたら1件も入れない。同じ target_id の行は、web でも demo でも置き換える
    dispatcher-research-seed --export <file> で、今ある使える結果をこの形で書き出せる(本物の調査を1回走らせた結果を
    デモ用にするときに使う)

ログに残すのは数だけ。target_id・名前・調査の結果は書かない(§4.12)。
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import settings
from .ratelimit import JST
from .store import get_store, iso

logger = logging.getLogger("dispatcher_server.research")

TARGET_KINDS = ("operator", "school", "hospital", "clinic")
# 施設・事業者の JSON を探す場所(DISPATCHER_REF_DIR からの相対)
FACILITY_GLOBS = ("facilities/*.json", "*.json")
STATUSES = ("found", "partial", "not_found")
TOOL_NAMES = ("get_research_targets", "get_research_results", "save_research")

# target_id の形(T06 の決定)。制御文字を含まず、200 字まで
TARGET_ID_PATTERN = re.compile(r"P(?:29|04|11):[^\x00-\x1f\x7f]{1,200}")
MAX_TARGET_ID_CHARS = 204
MAX_NAME_CHARS = 200

# §3.2 の上限
MAX_FACTS = 12
MAX_SOURCES = 5
MAX_RESULT_IDS = 50
# 1回の調査で送れる周辺のバス事業者の数の上限。学校・病院などの上限(DISPATCHER_RESEARCH_MAX_TARGETS)とは別に数える
# (2026-11-07 に利用者の指示で、事業者は上限なしに選べるようにした。費用は1セッションの上限額で守り、これは入力の大きさの守りだけ)
MAX_OPERATOR_TARGETS = 50
MAX_LABEL_CHARS = 20
MAX_VALUE_CHARS = 200
MAX_TITLE_CHARS = 100
MAX_NOTE_CHARS = 200
MAX_URL_CHARS = 2000
# 1つの確かめの失敗の文に並べる数
MAX_PROBLEMS = 5

SAVE_KEYS = frozenset({"target_id", "status", "facts", "sources", "note"})
FACT_KEYS = frozenset({"label", "value", "source"})
SOURCE_KEYS = frozenset({"url", "title"})
# デモ用の結果のファイルで、あっても読まない項目(--export が書き出す)
SEED_IGNORED_KEYS = frozenset({"kind", "name", "origin"})

START_LINE = "[画面の操作] 利用者が周辺の施設の調査を始めました(対象 {count} 件)。"

MSG_NO_REF = "調査の対象の参照データがありません。data/ の加工で施設・事業者のデータを作ってください"
MSG_TOOL_FAILED = "調査のデータを読めませんでした。もう一度試してください"
MSG_ALREADY_SAVED = "この対象は保存済みです({checked_at} に確認)。期限が切れるまで調べ直せません"


class ResearchInputError(Exception):
    """ブラウザに返す失敗(HTTP の状態と日本語の文)。"""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ---- 参照データ ----


@dataclass(frozen=True)
class Target:
    target_id: str
    kind: str
    name: str
    municipality: str | None
    lat: float
    lon: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "target_id": self.target_id,
            "kind": self.kind,
            "name": self.name,
            "municipality": self.municipality,
            "lat": self.lat,
            "lon": self.lon,
        }


def _number(value: Any, low: float, high: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        return None
    return number


def _parse_target(item: Any) -> Target | None:
    if not isinstance(item, dict):
        return None
    target_id = item.get("target_id")
    kind = item.get("kind")
    name = item.get("name")
    municipality = item.get("municipality")
    if not isinstance(target_id, str) or not TARGET_ID_PATTERN.fullmatch(target_id):
        return None
    if kind not in TARGET_KINDS:
        return None
    if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_CHARS:
        return None
    if municipality is not None and (not isinstance(municipality, str) or len(municipality) > MAX_NAME_CHARS):
        return None
    lat = _number(item.get("lat"), -90.0, 90.0)
    lon = _number(item.get("lon"), -180.0, 180.0)
    if lat is None or lon is None:
        return None
    return Target(target_id, str(kind), name.strip(), municipality or None, lat, lon)


_index_cache: dict[str, tuple[tuple[Any, ...], dict[str, Target]]] = {}


def _files_signature(ref_dir: Path) -> tuple[tuple[Any, ...], list[Path]]:
    try:
        # facilities/ を先に、それぞれの中はファイル名の順に読む
        paths = [path for pattern in FACILITY_GLOBS for path in sorted(ref_dir.glob(pattern)) if path.is_file()]
    except OSError:
        return (), []
    signature: list[tuple[str, int, int]] = []
    for path in paths:
        try:
            stat = path.stat()
        except OSError:
            continue
        signature.append((path.relative_to(ref_dir).as_posix(), stat.st_mtime_ns, stat.st_size))
    return tuple(signature), paths


def load_targets(ref_dir: Path | None = None) -> dict[str, Target]:
    """参照データの施設・事業者を target_id で引ける形にする。ファイルが変わるまでは読み直さない。"""
    directory = ref_dir if ref_dir is not None else settings.ref_dir()
    key = str(directory)
    signature, paths = _files_signature(directory)
    cached = _index_cache.get(key)
    if cached is not None and cached[0] == signature:
        return cached[1]
    index: dict[str, Target] = {}
    skipped = 0
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("research 参照データを読めませんでした file=%s", path.name)
            continue
        facilities = data.get("facilities") if isinstance(data, dict) else None
        if not isinstance(facilities, list):
            continue
        for item in facilities:
            target = _parse_target(item)
            if target is None:
                skipped += 1
                continue
            index.setdefault(target.target_id, target)
    if skipped:
        logger.warning("research 形の合わない施設を読み飛ばしました count=%d", skipped)
    _index_cache[key] = (signature, index)
    return index


def reset_cache() -> None:
    """テスト用:読んだ参照データを忘れる。"""
    _index_cache.clear()


# ---- 形 ----


def display_time(stamp: str) -> str:
    """保存した UTC の ISO 8601 を、日本時間の ISO 8601(秒まで)にする。"""
    try:
        moment = datetime.fromisoformat(stamp)
    except ValueError:
        return stamp
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(JST).isoformat(timespec="seconds")


def _loads_list(text: str | None) -> list[Any]:
    try:
        value = json.loads(text or "[]")
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _cached(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "status": row["status"],
        "checked_at": display_time(row["checked_at"]),
        "facts": len(_loads_list(row["facts_json"])),
    }


def _result(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "target_id": row["target_id"],
        "kind": row["kind"],
        "name": row["name"],
        "status": row["status"],
        "facts": _loads_list(row["facts_json"]),
        "sources": _loads_list(row["sources_json"]),
        "note": row["note"] or "",
        "checked_at": display_time(row["checked_at"]),
        "origin": row["origin"],
    }


def _ids_text(ids: list[str]) -> str:
    shown = "、".join(ids[:MAX_PROBLEMS])
    return shown + (f" ほか {len(ids) - MAX_PROBLEMS} 件" if len(ids) > MAX_PROBLEMS else "")


def _problems_text(head: str, problems: list[str]) -> str:
    shown = "。".join(problems[:MAX_PROBLEMS])
    rest = f"。ほか {len(problems) - MAX_PROBLEMS} 件" if len(problems) > MAX_PROBLEMS else ""
    return f"{head}{shown}{rest}"


# ---- このセッションの対象 ----


def session_targets(row_id: str, now: float | None = None) -> dict[str, Any]:
    """このセッションの対象と、保存済みかどうか(get_research_targets の結果と同じ形)。"""
    now = time.time() if now is None else now
    store = get_store()
    index = load_targets()
    ids = [target_id for target_id in store.research_target_ids(row_id) if target_id in index]
    rows = store.valid_research_results(ids, now)
    targets = [{**index[target_id].as_dict(), "cached": _cached(rows.get(target_id))} for target_id in ids]
    return {"status": "ok", "targets": targets, "total": len(targets), "max_targets": settings.research_max_targets()}


def session_overview(row_id: str, now: float | None = None) -> dict[str, Any]:
    """GET /api/claude/session/research:このセッションの対象と、保存済みの結果。"""
    now = time.time() if now is None else now
    view = session_targets(row_id, now)
    ids = [target["target_id"] for target in view["targets"]]
    rows = get_store().valid_research_results(ids, now)
    results = [_result(rows[target_id]) for target_id in ids if target_id in rows]
    return {
        "targets": view["targets"],
        "results": results,
        "missing": [target_id for target_id in ids if target_id not in rows],
        "saved": len(results),
        "total": view["total"],
        "max_targets": view["max_targets"],
    }


def progress(row_id: str, now: float | None = None) -> dict[str, int]:
    """このセッションの対象のうち、使える結果のある数(research の saved の SSE)。"""
    now = time.time() if now is None else now
    ids = get_store().research_target_ids(row_id)
    return {"saved": len(get_store().valid_research_results(ids, now)), "total": len(ids)}


def parse_start_ids(value: Any) -> list[str]:
    """POST /api/claude/session/research の target_ids を確かめ、参照データにある対象の ID の並び(重なりを除く)を返す。

    上限は、周辺のバス事業者(operator)以外が DISPATCHER_RESEARCH_MAX_TARGETS 件、事業者が MAX_OPERATOR_TARGETS 件。
    """
    max_targets = settings.research_max_targets()
    max_all = max_targets + MAX_OPERATOR_TARGETS
    if not isinstance(value, list) or not value or len(value) > max_all * 2:
        raise ResearchInputError(400, f"target_ids は 1〜{max_all} 件の文字列の配列にしてください")
    ids: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not item or len(item) > MAX_TARGET_ID_CHARS:
            raise ResearchInputError(400, "target_ids の各要素は target_id の文字列にしてください")
        if item not in seen:
            seen.add(item)
            ids.append(item)
    index = load_targets()
    if not index:
        raise ResearchInputError(503, MSG_NO_REF)
    unknown = [target_id for target_id in ids if target_id not in index]
    if unknown:
        raise ResearchInputError(400, f"参照データに無い対象があります:{_ids_text(unknown)}")
    operators = sum(1 for target_id in ids if index[target_id].kind == "operator")
    others = len(ids) - operators
    if others > max_targets:
        raise ResearchInputError(400, f"調べる対象(周辺のバス事業者を除く)は {max_targets} 件までにしてください(選んだのは {others} 件)")
    if operators > MAX_OPERATOR_TARGETS:
        raise ResearchInputError(400, f"調べる周辺のバス事業者は {MAX_OPERATOR_TARGETS} 件までにしてください(選んだのは {operators} 件)")
    return ids


def parse_known_ids(value: Any) -> list[str]:
    """POST /api/claude/session/research/known の target_ids を確かめ、参照データにある対象の ID の並び(重なりを除く)を返す。

    上限は get_research_results と同じ MAX_RESULT_IDS(調べる対象の上限 DISPATCHER_RESEARCH_MAX_TARGETS ではない)。
    """
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_RESULT_IDS:
        raise ResearchInputError(400, f"target_ids は 1〜{MAX_RESULT_IDS} 件の文字列の配列にしてください")
    for item in value:
        if not isinstance(item, str) or not item or len(item) > MAX_TARGET_ID_CHARS:
            raise ResearchInputError(400, "target_ids の各要素は target_id の文字列にしてください")
    ids = list(dict.fromkeys(value))
    index = load_targets()
    if not index:
        raise ResearchInputError(503, MSG_NO_REF)
    unknown = [target_id for target_id in ids if target_id not in index]
    if unknown:
        raise ResearchInputError(400, f"参照データに無い対象があります:{_ids_text(unknown)}")
    return ids


def register_known(row_id: str, target_ids: list[str], now: float | None = None) -> dict[str, int]:
    """保存済みの結果(demo か、期限の切れていない web)がある対象だけを、このセッションの対象の後ろに足す。

    会話には何も入れない(調整役の「調査を始めたときだけ調べる」規則を動かさないため)。返すのは
    registered(この要求で新しく足した数。既に対象にあった ID と、使える結果の無い ID は数えない)と
    total(足した後のこのセッションの対象の数)。
    """
    now = time.time() if now is None else now
    store = get_store()
    rows = store.valid_research_results(target_ids, now)
    usable = [target_id for target_id in target_ids if target_id in rows]
    registered = store.add_research_targets(row_id, usable, now)
    return {"registered": registered, "total": len(store.research_target_ids(row_id))}


def start_line(count: int) -> str:
    """調査を始めたことを会話に入れる [画面の操作] の行(docs/interfaces-1105.md §6.2)。"""
    return START_LINE.format(count=count)


# ---- 保存する結果の確かめ ----


def _text_problem(value: Any, label: str, max_chars: int, *, allow_empty: bool) -> str | None:
    if not isinstance(value, str):
        return f"{label} は文字列にしてください"
    if not allow_empty and not value.strip():
        return f"{label} が空です"
    if len(value) > max_chars:
        return f"{label} は {max_chars} 字までにしてください({len(value)} 字)"
    return None


def _url_problem(value: Any, label: str) -> str | None:
    message = f"{label} は http か https の URL({MAX_URL_CHARS:,} 字まで)にしてください"
    if not isinstance(value, str) or not value or len(value) > MAX_URL_CHARS:
        return message
    if any(char.isspace() or ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return message
    try:
        parts = urlsplit(value)
    except ValueError:
        return message
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return message
    return None


def check_record(data: Any, *, extra_keys: frozenset[str] = frozenset()) -> list[str]:
    """save_research の入力(とデモ用の結果の1件)の形を確かめ、外れた点を日本語で返す。target_id の有無は呼ぶ側が見る。"""
    if not isinstance(data, dict):
        return ["入力はオブジェクトにしてください"]
    problems: list[str] = []
    missing = sorted(SAVE_KEYS - set(data))
    if missing:
        problems.append(f"足りない項目があります:{'、'.join(missing)}")
    unknown = sorted(set(data) - SAVE_KEYS - extra_keys)
    if unknown:
        problems.append(f"知らない項目があります:{'、'.join(unknown[:MAX_PROBLEMS])}")
    if "target_id" in data and (not isinstance(data["target_id"], str) or not data["target_id"]):
        problems.append("target_id は文字列にしてください")
    status = data.get("status")
    if "status" in data and status not in STATUSES:
        problems.append("status は found・partial・not_found のどれかにしてください")

    sources = data.get("sources")
    source_count = 0
    if "sources" in data:
        minimum = 0 if status == "not_found" else 1
        if not isinstance(sources, list) or not minimum <= len(sources) <= MAX_SOURCES:
            problems.append(f"sources は {minimum}〜{MAX_SOURCES} 件の配列にしてください(not_found なら 0 件でよい)")
        else:
            source_count = len(sources)
            for number, source in enumerate(sources, start=1):
                label = f"sources の {number} 件目"
                if not isinstance(source, dict) or set(source) != SOURCE_KEYS:
                    problems.append(f"{label} は url と title だけのオブジェクトにしてください")
                    continue
                for problem in (
                    _url_problem(source["url"], f"{label}の url"),
                    _text_problem(source["title"], f"{label}の title", MAX_TITLE_CHARS, allow_empty=True),
                ):
                    if problem:
                        problems.append(problem)

    facts = data.get("facts")
    if "facts" in data:
        if not isinstance(facts, list) or len(facts) > MAX_FACTS:
            problems.append(f"facts は {MAX_FACTS} 件までの配列にしてください")
        else:
            for number, fact in enumerate(facts, start=1):
                label = f"facts の {number} 件目"
                if not isinstance(fact, dict) or set(fact) != FACT_KEYS:
                    problems.append(f"{label} は label・value・source だけのオブジェクトにしてください")
                    continue
                for problem in (
                    _text_problem(fact["label"], f"{label}の label", MAX_LABEL_CHARS, allow_empty=False),
                    _text_problem(fact["value"], f"{label}の value", MAX_VALUE_CHARS, allow_empty=False),
                ):
                    if problem:
                        problems.append(problem)
                source = fact["source"]
                if isinstance(source, bool) or not isinstance(source, int) or not 1 <= source <= source_count:
                    if source_count:
                        problems.append(f"{label}の source は sources の番号(1〜{source_count})にしてください")
                    else:
                        problems.append(f"{label}の source に当たる sources がありません")

    if "note" in data:
        problem = _text_problem(data["note"], "note", MAX_NOTE_CHARS, allow_empty=True)
        if problem:
            problems.append(problem)
    return problems


def _clean_record(data: dict[str, Any]) -> dict[str, Any]:
    """確かめた入力から、保存する項目だけを取り出す。"""
    return {
        "status": data["status"],
        "facts": [{"label": f["label"], "value": f["value"], "source": f["source"]} for f in data["facts"]],
        "sources": [{"url": s["url"], "title": s["title"]} for s in data["sources"]],
        "note": data["note"],
    }


# ---- ツール(§3.2) ----


def _ok(payload: dict[str, Any]) -> tuple[str, bool]:
    return json.dumps(payload, ensure_ascii=False), False


def _error(message: str) -> tuple[str, bool]:
    return json.dumps({"status": "error", "message": message}, ensure_ascii=False), True


def _tool_get_targets(row_id: str, tool_input: Any, now: float) -> tuple[str, bool]:
    if tool_input not in (None, {}):
        return _error("get_research_targets は入力を取りません")
    return _ok(session_targets(row_id, now))


def _tool_get_results(row_id: str, tool_input: Any, now: float) -> tuple[str, bool]:
    if not isinstance(tool_input, dict) or set(tool_input) != {"target_ids"}:
        return _error("入力は target_ids だけのオブジェクトにしてください")
    session_ids = get_store().research_target_ids(row_id)
    requested = tool_input["target_ids"]
    if requested is None:
        ids = session_ids
    else:
        if not isinstance(requested, list) or not 1 <= len(requested) <= MAX_RESULT_IDS:
            return _error(f"target_ids は 1〜{MAX_RESULT_IDS} 件の文字列の配列か null にしてください")
        if not all(isinstance(item, str) for item in requested):
            return _error("target_ids の各要素は文字列にしてください")
        ids = list(dict.fromkeys(requested))
        known = set(session_ids)
        outside = [target_id for target_id in ids if target_id not in known]
        if outside:
            return _error(
                f"この会話の調査の対象ではない target_id があります:{_ids_text(outside)}。"
                "get_research_targets の target_id を使ってください"
            )
    rows = get_store().valid_research_results(ids, now)
    return _ok(
        {
            "status": "ok",
            "results": [_result(rows[target_id]) for target_id in ids if target_id in rows],
            "missing": [target_id for target_id in ids if target_id not in rows],
        }
    )


def _tool_save(row_id: str, tool_input: Any, now: float) -> tuple[str, bool]:
    problems = check_record(tool_input)
    if not problems and tool_input["target_id"] not in get_store().research_target_ids(row_id):
        problems.append("target_id がこの会話の調査の対象にありません。頼まれた対象の target_id をそのまま使ってください")
    if problems:
        return _error(_problems_text("save_research の入力が正しくありません。", problems))
    target_id = tool_input["target_id"]
    target = load_targets().get(target_id)
    if target is None:
        return _error("この対象は参照データにありません。保存できません")
    record = _clean_record(tool_input)
    saved, existing = get_store().save_research_result(
        target_id=target_id,
        kind=target.kind,
        name=target.name,
        now=now,
        cache_days=settings.research_cache_days(),
        **record,
    )
    if not saved:
        checked_at = display_time(existing["checked_at"]) if existing else "以前"
        return _error(MSG_ALREADY_SAVED.format(checked_at=checked_at))
    logger.info("research 結果を保存しました facts=%d sources=%d row=%s", len(record["facts"]), len(record["sources"]), row_id)
    return _ok({"status": "ok", "target_id": target_id, "checked_at": display_time(iso(now))})


_TOOLS = {
    "get_research_targets": _tool_get_targets,
    "get_research_results": _tool_get_results,
    "save_research": _tool_save,
}


def run_tool(name: str, row_id: str, tool_input: Any, now: float | None = None) -> tuple[str, bool]:
    """サーバーが実行するツールの1回。結果の JSON の文字列と is_error を返す。スレッドの見分けは呼ぶ側が済ませる。"""
    handler = _TOOLS.get(name)
    if handler is None:
        return _error("このツールはありません")
    try:
        return handler(row_id, tool_input, time.time() if now is None else now)
    except Exception as exc:  # noqa: BLE001 - 中身はログに残さず、型だけを残して決まった文で答える
        logger.warning("research ツールの失敗 name=%s type=%s row=%s", name, type(exc).__name__, row_id)
        return _error(MSG_TOOL_FAILED)


# ---- デモ用の結果の取り込み(dispatcher-research-seed) ----


def _parse_checked_at(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    return iso(moment.timestamp())


def read_seed_file(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """デモ用の結果のファイルを読み、確かめる。(入れる行, 外れた点) を返す。外れた点があれば行は使わない。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return [], [f"ファイルを読めません:{path}"]
    except ValueError:
        return [], ["JSON として読めません"]
    items = data.get("results") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        return [], ["結果の配列(または {\"results\": [...]})が空か、ありません"]
    index = load_targets()
    if not index:
        return [], [MSG_NO_REF]
    rows: list[dict[str, Any]] = []
    problems: list[str] = []
    seen: set[str] = set()
    for number, item in enumerate(items, start=1):
        label = f"{number} 件目"
        item_problems = check_record(item, extra_keys=SEED_IGNORED_KEYS | {"checked_at"})
        checked_at = _parse_checked_at(item.get("checked_at")) if isinstance(item, dict) else None
        if isinstance(item, dict) and checked_at is None:
            item_problems.append("checked_at は時差つきの ISO 8601(例 2026-11-06T10:00:00+09:00)にしてください")
        if not item_problems:
            target_id = item["target_id"]
            target = index.get(target_id)
            if target is None:
                item_problems.append(f"target_id {target_id} が参照データにありません")
            elif target_id in seen:
                item_problems.append(f"target_id {target_id} が2回あります")
            else:
                seen.add(target_id)
                rows.append(
                    {"target_id": target_id, "kind": target.kind, "name": target.name, "checked_at": checked_at, **_clean_record(item)}
                )
        problems.extend(f"{label}:{problem}" for problem in item_problems)
    return rows, problems


def export_results(path: Path, now: float | None = None) -> int:
    """今ある使える結果を、デモ用の結果のファイルの形で書き出す。書き出した数を返す。"""
    now = time.time() if now is None else now
    results = [_result(row) for row in get_store().all_valid_research_results(now)]
    path.write_text(json.dumps({"results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return len(results)


def run_seed(argv: list[str]) -> int:
    """dispatcher-research-seed の中身(テストから呼ぶ)。終了コードを返す。"""
    parser = argparse.ArgumentParser(
        prog="dispatcher-research-seed",
        description="デモ用の周辺の施設の調査の結果を、JSON から origin: demo で取り込む(期限で消えず、調査で上書きされない)",
    )
    parser.add_argument("file", type=Path, nargs="?", help="取り込む JSON のファイル")
    parser.add_argument("--export", type=Path, metavar="FILE", help="取り込む代わりに、今ある結果をこの形で書き出す")
    args = parser.parse_args(argv)
    if args.export is not None:
        if args.file is not None:
            parser.error("--export のときは、取り込むファイルを指定しないでください")
        count = export_results(args.export)
        print(f"調査の結果を {count} 件書き出しました:{args.export}")
        return 0
    if args.file is None:
        parser.error("取り込む JSON のファイルを指定してください")
    rows, problems = read_seed_file(args.file)
    if problems:
        print("取り込めませんでした(1件も入れていません)。", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    count = get_store().seed_research_results(rows)
    print(f"デモ用の調査の結果を {count} 件入れました(origin: demo。期限で消えず、調査で上書きされません)")
    return 0


def seed_main() -> int:
    """uv run dispatcher-research-seed <file>。開発ではリポジトリ直下の .env を読み、サーバーと同じ SQLite に入れる。"""
    settings.load_env()
    return run_seed(sys.argv[1:])
