#!/usr/bin/env bash
# Edit / Write の後に、編集したファイルに関係するテストを実行する。
# 失敗したら exit 2 で結果を Claude に返す。
#
# - web/ の TS/TSX:vitest related(編集したファイルを読み込むテストだけ)
#   GTFS-JP の検証は web/src/gtfs/ のテストとして書くため、ここで一緒に走る。
#   サンプル GTFS(data/raw/gtfs/*.zip)を使うテストは、ファイルが無ければスキップする作りにする。
# - server/ と data/ の Python:pytest
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
file="$(jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] && exit 0

rel="${file#"$root"/}"
out=""
status=0

case "$rel" in
  web/*.ts | web/*.tsx)
    [ -d "$root/web/node_modules" ] || exit 0
    target="${rel#web/}"
    out="$(cd "$root/web" && pnpm exec vitest related --run --passWithNoTests "$target" 2>&1)"
    status=$?
    ;;
  server/*.py)
    out="$(cd "$root/server" && uv run --quiet pytest -q 2>&1)"
    status=$?
    ;;
  data/*.py)
    out="$(cd "$root/data" && uv run --quiet pytest -q 2>&1)"
    status=$?
    ;;
  *)
    exit 0
    ;;
esac

# pytest はテストが1件も無いと 5 を返す。これは失敗として扱わない。
if [ "$status" -ne 0 ] && [ "$status" -ne 5 ]; then
  {
    echo "テストが失敗しました($rel の編集後)。"
    echo "$out" | tail -40
  } >&2
  exit 2
fi
exit 0
