"""エージェントの設定ファイルとツールの定義の照らし合わせ。docs/interfaces-1105.md §3.3。

正は server/src/dispatcher_server/claude_tools.json。agents/coordinator.md の tools の最初の6つはその写し。
"""

import json
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

from dispatcher_server.agent_session import SERVER_TOOLS, browser_tool_names

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS = REPO_ROOT / "agents"


def front_matter(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), f"{path.name} は YAML の前置きで始まっていません"
    head, _, body = text[4:].partition("\n---\n")
    assert body.strip(), f"{path.name} の本文(システムプロンプト)が空です"
    data = yaml.safe_load(head)
    assert isinstance(data, dict)
    return data


def tool_definitions() -> list[dict[str, Any]]:
    text = resources.files("dispatcher_server").joinpath("claude_tools.json").read_text(encoding="utf-8")
    return json.loads(text)


def custom_names(agent: dict[str, Any]) -> list[str]:
    return [tool["name"] for tool in agent["tools"] if tool.get("type") == "custom"]


def test_coordinator_first_six_tools_are_the_json_without_strict_plus_type_custom() -> None:
    coordinator = front_matter(AGENTS / "coordinator.md")
    expected = []
    for tool in tool_definitions():
        copy = {key: value for key, value in tool.items() if key != "strict"}
        expected.append({"type": "custom", **copy})
    assert coordinator["tools"][:6] == expected


def test_server_tool_names_match_the_agent_files_and_do_not_overlap_browser_tools() -> None:
    coordinator = front_matter(AGENTS / "coordinator.md")
    researcher = front_matter(AGENTS / "researcher.md")
    browser = [tool["name"] for tool in tool_definitions()]
    assert set(browser) == browser_tool_names()
    server_in_files = [name for name in custom_names(coordinator) if name not in browser] + custom_names(researcher)
    assert sorted(server_in_files) == sorted(SERVER_TOOLS)
    assert not set(SERVER_TOOLS) & set(browser)
    assert custom_names(coordinator)[:6] == browser


def test_coordinator_has_no_toolset_and_researcher_has_only_web_tools() -> None:
    coordinator = front_matter(AGENTS / "coordinator.md")
    researcher = front_matter(AGENTS / "researcher.md")
    assert all(tool.get("type") == "custom" for tool in coordinator["tools"])
    toolsets = [tool for tool in researcher["tools"] if tool.get("type") == "agent_toolset_20260401"]
    assert len(toolsets) == 1
    toolset = toolsets[0]
    assert toolset["default_config"]["enabled"] is False
    enabled = sorted(config["name"] for config in toolset.get("configs", []) if config.get("enabled"))
    assert enabled == ["web_fetch", "web_search"]


def test_multiagent_rosters_have_no_inline_agents_and_no_self() -> None:
    coordinator = front_matter(AGENTS / "coordinator.md")
    researcher = front_matter(AGENTS / "researcher.md")
    multiagent = coordinator["multiagent"]
    assert multiagent["type"] == "multiagent_20261001"
    for member in ("subagents", "workflows"):
        block = multiagent[member]
        assert block["inline_agents"] == {"type": "disabled"}
        for entry in block["predefined_agents"]:
            assert entry != {"type": "self"} and entry != "self"
            assert not (isinstance(entry, dict) and entry.get("type") == "self")
    assert "multiagent" not in researcher
