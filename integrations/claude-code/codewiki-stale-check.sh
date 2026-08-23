#!/usr/bin/env bash
# codewiki-stale-check.sh — SessionStart hook (opt-in)
#
# 检测本项目下 docs/*/manifest.yml 里的 base_commit 是否落后于当前 HEAD，
# 若有陈旧模块则提示用户跑 /codewiki --update；否则静默退出。
#
# 节流规则：
#   - 每 branch 30 分钟内已检查过 → skip
#   - 每 session 已提示过 → skip
#   - 最多列 5 个陈旧模块，超出显示 "... N more"
#
# 不主动执行 /codewiki，只输出提示；不阻塞会话。
#
# 启用方式见同目录 README.md。

set -eu

# 项目根：Claude Code 传入的 CLAUDE_PROJECT_DIR，兜底用当前 pwd
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# 无 docs/ 或非 git 仓库 → 静默退出
[ -d "$PROJECT_DIR/docs" ] || exit 0
git -C "$PROJECT_DIR" rev-parse HEAD >/dev/null 2>&1 || exit 0

CURRENT_HEAD=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null)
CURRENT_BRANCH=$(git -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "detached")

# 节流目录（不进入 git）
CODEWIKI_STATE_DIR="$PROJECT_DIR/.codewiki"
mkdir -p "$CODEWIKI_STATE_DIR" 2>/dev/null || exit 0

# 节流 1: branch 级 30 分钟
LAST_CHECK_FILE="$CODEWIKI_STATE_DIR/.last-check-${CURRENT_BRANCH//\//_}"
NOW=$(date +%s)
THROTTLE_SECONDS=1800  # 30 min
if [ -f "$LAST_CHECK_FILE" ]; then
  LAST_TS=$(cat "$LAST_CHECK_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST_TS)) -lt $THROTTLE_SECONDS ]; then
    exit 0
  fi
fi

# 节流 2: session 级。Claude Code hook payload 从 stdin 传 session_id；
# 环境变量仅作为兼容兜底。拿不到 session_id 时不写全局 unknown 标记。
STDIN_SESSION_ID=""
if [ ! -t 0 ]; then
  HOOK_INPUT=$(cat 2>/dev/null || true)
  STDIN_SESSION_ID=$(printf '%s' "$HOOK_INPUT" | sed -nE 's/.*"session(_id|Id)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' | head -1)
fi
SESSION_ID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$STDIN_SESSION_ID}}"
SAFE_SESSION_ID=$(printf '%s' "$SESSION_ID" | sed 's/[^A-Za-z0-9._-]/_/g')
SESSION_MARK_FILE=""
if [ -n "$SAFE_SESSION_ID" ]; then
  SESSION_MARK_FILE="$CODEWIKI_STATE_DIR/.session-notified-${SAFE_SESSION_ID}"
fi
if [ -n "$SESSION_MARK_FILE" ] && [ -f "$SESSION_MARK_FILE" ]; then
  exit 0
fi

# 遍历所有 docs/*/manifest.yml
STALE_MODULES=()
for manifest in "$PROJECT_DIR"/docs/*/manifest.yml; do
  [ -f "$manifest" ] || continue
  MODULE_DIR=$(dirname "$manifest")
  MODULE_NAME=$(basename "$MODULE_DIR")
  # 跳过 .archive 目录里的老 manifest
  case "$MODULE_DIR" in *.archive*) continue ;; esac
  # 抽取 base_commit（简单 grep + sed，兼容带引号或不带引号）
  BASE_COMMIT=$(grep -E '^base_commit:' "$manifest" 2>/dev/null | head -1 | sed -E 's/^base_commit:[[:space:]]*['"'"'"]?([a-f0-9]+)['"'"'"]?.*/\1/' || echo "")
  [ -n "$BASE_COMMIT" ] || continue
  if [ "$BASE_COMMIT" != "$CURRENT_HEAD" ]; then
    SHORT_BASE=$(echo "$BASE_COMMIT" | cut -c1-7)
    SHORT_HEAD=$(echo "$CURRENT_HEAD" | cut -c1-7)
    STALE_MODULES+=("$MODULE_NAME (base=$SHORT_BASE, head=$SHORT_HEAD)")
  fi
done

# 无 stale → 更新节流后静默退出
if [ ${#STALE_MODULES[@]} -eq 0 ]; then
  echo "$NOW" > "$LAST_CHECK_FILE"
  exit 0
fi

# 输出提示（最多 5 条）
MAX=5
TOTAL=${#STALE_MODULES[@]}
echo "[codewiki] 以下模块知识库已陈旧（base_commit ≠ 当前 HEAD）："
DISPLAY_COUNT=$(( TOTAL < MAX ? TOTAL : MAX ))
i=0
while [ $i -lt $DISPLAY_COUNT ]; do
  echo "  - ${STALE_MODULES[$i]}"
  i=$((i + 1))
done
if [ $TOTAL -gt $MAX ]; then
  REMAINING=$((TOTAL - MAX))
  echo "  ... $REMAINING more"
fi
echo "需要精确知识库时运行：/codewiki --update"

# 更新节流
echo "$NOW" > "$LAST_CHECK_FILE"
if [ -n "$SESSION_MARK_FILE" ]; then
  touch "$SESSION_MARK_FILE"
fi

exit 0
