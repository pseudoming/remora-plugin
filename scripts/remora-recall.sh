#!/bin/bash
KEYWORD="$1"
PROJECT_UUID="$2"

# 中文翻译：用法: $0 <关键字> [项目UUID]
if [ -z "$KEYWORD" ]; then
    echo "Usage: $0 <keyword> [project_uuid]"
    exit 1
fi

DB_PATH="$HOME/.gemini/antigravity/sidecar_data/remora-plugin/memory-compactor/data/remora_memory.db"

# 中文翻译：[Remora] 温存储数据库尚未建立
if [ ! -f "$DB_PATH" ]; then
    echo "[Remora] 温存储数据库尚未建立: $DB_PATH"
    exit 1
fi

# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================
# 设计原理一：多维度租户物理隔离与自动反向映射
# ==========================================
# 优先采用参数传入的 project_uuid。
# 若为空，则尝试自动读取当前主干 Agent 的环境变量 ANTIGRAVITY_PROJECT_ID。
# 若依然为空，则从元数据中解析当前活跃的会话 ID (conversationId)，
# 并通过数据库中 watermarks 映射记录反向确定对应的 project_uuid，免去慢速外部 API 调用。
# 若完全无法定位项目，则坚决拒绝检索，防范跨项目数据泄露风险。
if [ -z "$PROJECT_UUID" ]; then
    PROJECT_UUID="$ANTIGRAVITY_PROJECT_ID"
fi

CONV_ID=""
if [ -z "$PROJECT_UUID" ] && [ -n "$ANTIGRAVITY_SOURCE_METADATA" ]; then
    CONV_ID=$(echo "$ANTIGRAVITY_SOURCE_METADATA" | grep -oP '"conversationId":"\K[^"]+')
fi

if [ -n "$CONV_ID" ] && [ -z "$PROJECT_UUID" ]; then
    PROJECT_UUID=$(sqlite3 "$DB_PATH" "SELECT project_uuid FROM watermarks WHERE conversation_id = '${CONV_ID}' LIMIT 1;")
fi

# 中文翻译：[Remora] 错误: 无法获取项目标识，检索被拒绝。
if [ -z "$PROJECT_UUID" ] && [ -z "$CONV_ID" ]; then
    echo "[Remora] 错误: 无法获取项目标识，检索被拒绝。"
    exit 1
fi

# 安全性防范：SQL 注入转义，转义全部单引号以杜绝恶意 SQL 拼接
SQL_SAFE_KEYWORD=$(echo "$KEYWORD" | sed "s/'/''/g")
SQL_SAFE_PROJECT_UUID=$(echo "$PROJECT_UUID" | sed "s/'/''/g")
SQL_SAFE_CONV_ID=$(echo "$CONV_ID" | sed "s/'/''/g")

# 更新被检索命中前置列表的话题的 last_accessed_at 活跃时间戳，防范 GC 误删 (限制为展现的前 10 及前 5 条)
sqlite3 "$DB_PATH" "
UPDATE project_topics 
SET last_accessed_at = CURRENT_TIMESTAMP 
WHERE uuid = '${SQL_SAFE_PROJECT_UUID}'
AND topic_id IN (
    SELECT DISTINCT m.topic_id
    FROM messages m
    JOIN messages_fts fts ON m.id = fts.rowid
    WHERE m.conversation_id IN (
        SELECT conversation_id FROM watermarks WHERE project_uuid = '${SQL_SAFE_PROJECT_UUID}'
        UNION
        SELECT '${SQL_SAFE_CONV_ID}' WHERE '${SQL_SAFE_CONV_ID}' != ''
    )
    AND fts.content MATCH '\"${SQL_SAFE_KEYWORD}\"'
    ORDER BY m.id ASC
    LIMIT 10
    UNION
    SELECT topic_id
    FROM topic_decisions
    WHERE (project_uuid = '${SQL_SAFE_PROJECT_UUID}' OR conversation_id = '${SQL_SAFE_CONV_ID}')
    AND (decision LIKE '%${SQL_SAFE_KEYWORD}%' OR rationale LIKE '%${SQL_SAFE_KEYWORD}%')
    LIMIT 5
);
" > /dev/null 2>&1

# ==========================================
# 设计原理二：混合双通道召回与时序物理升序
# ==========================================
# 通道 A：利用 messages_fts 全文 Trigram 检索口语化原始对话细节，
#         强制使用 ORDER BY m.id ASC 升序排列，解决 FTS5 BM25 相关度排序可能引发的时间线因果混乱（时序错乱）。
#         随后提取匹配消息的 topic_id，反向拉取该话题下的所有 topic_decisions。
#         解决了直接搜索精炼决议时由于“语义盲区”造成的漏检索。
#
# 通道 B：直接对 topic_decisions 的决议与理由进行模糊匹配，
#         确保当用户直接发问关于决议本身时能以最高优先级定位直接命中。

echo "=== FTS5 原始日志召回 (通道 A) ==="
sqlite3 "$DB_PATH" "
SELECT m.role || ': ' || m.content
FROM messages m
JOIN messages_fts fts ON m.id = fts.rowid
WHERE m.conversation_id IN (
    SELECT conversation_id FROM watermarks WHERE project_uuid = '${SQL_SAFE_PROJECT_UUID}'
    UNION
    SELECT '${SQL_SAFE_CONV_ID}' WHERE '${SQL_SAFE_CONV_ID}' != ''
)
AND fts.content MATCH '\"${SQL_SAFE_KEYWORD}\"'
ORDER BY m.id ASC
LIMIT 10;
"

echo -e "\n=== 关联架构决策召回 (通道 A 反向牵引) ==="
sqlite3 "$DB_PATH" "
SELECT '[' || topic_id || '] ' || decision || ' (原因: ' || rationale || ')'
FROM topic_decisions
WHERE (project_uuid = '${SQL_SAFE_PROJECT_UUID}' OR conversation_id = '${SQL_SAFE_CONV_ID}')
AND topic_id IN (
    SELECT DISTINCT m.topic_id
    FROM messages m
    JOIN messages_fts fts ON m.id = fts.rowid
    WHERE m.conversation_id IN (
        SELECT conversation_id FROM watermarks WHERE project_uuid = '${SQL_SAFE_PROJECT_UUID}'
        UNION
        SELECT '${SQL_SAFE_CONV_ID}' WHERE '${SQL_SAFE_CONV_ID}' != ''
    )
    AND fts.content MATCH '\"${SQL_SAFE_KEYWORD}\"'
);
"

echo -e "\n=== 直接匹配架构决策 (通道 B) ==="
sqlite3 "$DB_PATH" "
SELECT '[' || topic_id || '] ' || decision || ' (原因: ' || rationale || ')'
FROM topic_decisions
WHERE (project_uuid = '${SQL_SAFE_PROJECT_UUID}' OR conversation_id = '${SQL_SAFE_CONV_ID}')
AND (decision LIKE '%${SQL_SAFE_KEYWORD}%' OR rationale LIKE '%${SQL_SAFE_KEYWORD}%')
LIMIT 5;
"
