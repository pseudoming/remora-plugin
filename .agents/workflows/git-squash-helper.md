---
description: 自动合并和整理最近的细碎 Git commit 记录，并与实施计划的当前阶段状态对齐
---

# Remora Git Squash Helper Workflow (Git 阶段提交自动整理工作流)

**Description**: 该工作流定义了在多智能体并行开发或频繁调试导致细碎 commit 较多时，如何自动通过 `git reset --soft` 将最近连续的、简短的 commits 合并成单一的标准 Phase Report 提交，以维护主干 Git Log 的清洁，实现开发提交与规划状态的对齐。

## 1. 触发指令
当满足以下条件之一时，主 Agent 应当执行该工作流：
- 用户显式输入指令：`/git-squash`
- 当前开发阶段的任务（Phase X.Y）执行完毕，在运行 pytest 回归测试全量通过且向用户正式提报交付前。

## 2. 执行动作
在本地 WSL2 环境下（项目根目录下），使用 `run_command` 工具执行以下命令进行 Soft Squash 和信息提取合并。

### 命令行调用规范
```bash
TARGET_DIR="/home/agent/.gemini/config/plugins/remora-plugin"

# 1. 动态获取当前活跃的 artifacts 实施计划路径
PLAN_FILE="$(ls -td /home/agent/.gemini/antigravity/brain/*/artifacts | head -n 1)/implementation_plan.md"

# 2. 提取上一个以 [Phase 开头的 Phase Report 交付哈希
LAST_REPORT_COMMIT=$(git -C "$TARGET_DIR" log --grep="^\[Phase" --format="%H" -n 1 2>/dev/null || true)
if [ -z "$LAST_REPORT_COMMIT" ]; then
    LAST_REPORT_COMMIT=$(git -C "$TARGET_DIR" merge-base HEAD origin/main 2>/dev/null || git -C "$TARGET_DIR" log --reverse --format="%H" | head -n 1)
fi

# 3. 收集这段历史里所有的细碎 commit 消息，拼接为 body
BODY_MSG="Changelog:\n$(git -C "$TARGET_DIR" log --reverse --format="- %s" ${LAST_REPORT_COMMIT}..HEAD)"

# 4. 动态解析实施计划中当前处于开发/待落地阶段的标题
PHASE_TITLE=$(grep -oP '阶段[一二三四五六七八九十百]+（Phase \d+(\.\d+)?）：[^\\[\n]+' "$PLAN_FILE" | head -n 1 || true)
if [ -z "$PHASE_TITLE" ]; then
    PHASE_TITLE="Phase Auto Report"
fi
PHASE_NUM=$(echo "$PHASE_TITLE" | grep -oP 'Phase \d+(\.\d+)?' || echo "Phase 39")
TITLE_TEXT=$(echo "$PHASE_TITLE" | grep -oP '：\K.+' | sed 's/ (.*//g' | xargs || echo "Task Completed")
COMMIT_TITLE="[${PHASE_NUM} Report] ${TITLE_TEXT}"

# 5. 执行 soft reset 并合并重新提交
git -C "$TARGET_DIR" reset --soft ${LAST_REPORT_COMMIT}
echo -e "${COMMIT_TITLE}\n\n${BODY_MSG}" | git -C "$TARGET_DIR" commit -F -
```

## 3. 回复确认
执行完成后，向用户播报合并整理的结果，呈递最新的 git log 状态，例如：
“✅ Git 提交整理完成。已将最近的 X 次细碎提交合并为单个提交：`[Phase X.Y Report] Title`。”
