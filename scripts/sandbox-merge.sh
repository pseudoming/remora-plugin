#!/bin/bash
set -e

# ==========================================================
# Remora Sandbox Merge Utility (沙箱合并工具)
# 作用：根据子代理的 Conversation ID 查找系统为其分配的 Git Worktree 隔离分支，
# 并自动将该分支变动合并回主干工程。这是安全的用完即焚机制的核心闭环。
# ==========================================================

SUBAGENT_CONV_ID=$1
if [ -z "$SUBAGENT_CONV_ID" ]; then
    echo "ERROR: Subagent conversation ID required."
    exit 1
fi

echo "[Remora] Initiating sandbox merge for subagent $SUBAGENT_CONV_ID..."

# Antigravity 系统会将 invoke_subagent (Workspace: branch) 分配在
# .system_generated/worktrees/ 下，并以 subagent-xxx-$SUBAGENT_CONV_ID 为名。
WORKTREE_DIR=$(ls -d /home/agent/.gemini/antigravity/brain/*/.system_generated/worktrees/*$SUBAGENT_CONV_ID* 2>/dev/null | head -n 1)

if [ -z "$WORKTREE_DIR" ]; then
    echo "ERROR: Could not find isolated worktree for $SUBAGENT_CONV_ID. Either it doesn't exist, or it wasn't invoked with 'Workspace: branch'."
    exit 1
fi

echo "[Remora] Found isolated sandbox worktree: $WORKTREE_DIR"

# 切换到工作树提取其临时分支名
BRANCH_NAME=$(git -C "$WORKTREE_DIR" branch --show-current)
if [ -z "$BRANCH_NAME" ]; then
    echo "ERROR: Could not determine branch name in $WORKTREE_DIR"
    exit 1
fi
echo "[Remora] Target branch to merge: $BRANCH_NAME"

# 在 merge 之前，提取物理变更文件列表输出给调用者
echo "[Remora] Detecting physical changed files in sandbox..."
git -C /home/agent/wsl_code/remora diff --name-only main...$BRANCH_NAME | while read -r file; do
    echo "[PHYSICAL_CHANGES] $file"
done

# 在主干上执行合并
cd /home/agent/wsl_code/remora
git merge "$BRANCH_NAME" -m "Merge sandbox changes from subagent $SUBAGENT_CONV_ID"

echo "[Remora] Sandbox branch '$BRANCH_NAME' successfully merged into main tree."
# 注意：暂时不执行 git worktree remove，将其留给 Antigravity 的 lifecycle 垃圾回收。
