#!/usr/bin/env python3
import sys, os, sqlite3, re
from lib.paths import get_db_path

def main():
    if len(sys.argv) < 2:
        print("Usage: remora-recall.py <keyword> [project_uuid]")
        sys.exit(1)
        
    keyword = sys.argv[1]
    project_uuid = sys.argv[2] if len(sys.argv) > 2 else ""
    
    if not project_uuid:
        project_uuid = os.environ.get("ANTIGRAVITY_PROJECT_ID", "")

    conv_id = ""
    if not project_uuid:
        metadata_str = os.environ.get("ANTIGRAVITY_SOURCE_METADATA", "")
        if metadata_str:
            match = re.search(r'"conversationId":"([^"]+)', metadata_str)
            if match:
                conv_id = match.group(1)

    db_path = get_db_path()
    if not os.path.exists(db_path):
        print(f"[Remora] 温存储数据库尚未建立: {db_path}")
        sys.exit(1)
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    if conv_id and not project_uuid:
        cursor.execute("SELECT project_uuid FROM watermarks WHERE conversation_id = ? LIMIT 1", (conv_id,))
        row = cursor.fetchone()
        if row:
            project_uuid = row[0]

    if not project_uuid and not conv_id:
        print("[Remora] 错误: 无法获取项目标识，检索被拒绝。")
        sys.exit(1)

    fts_keyword = f'"{keyword}"'
    match_count = 0

    print("=== FTS5 原始日志召回 (通道 A) ===")
    cursor.execute("""
        SELECT m.role || ': ' || m.content
        FROM messages m
        JOIN messages_fts fts ON m.id = fts.rowid
        WHERE m.conversation_id IN (
            SELECT conversation_id FROM watermarks WHERE project_uuid = ?
            UNION
            SELECT ? WHERE ? != ''
        )
        AND fts.content MATCH ?
        ORDER BY m.id ASC
        LIMIT 10
    """, (project_uuid, conv_id, conv_id, fts_keyword))
    for row in cursor.fetchall():
        match_count += 1
        print(row[0])

    print("\n=== 关联架构决策召回 (通道 A 反向牵引) ===")
    cursor.execute("""
        SELECT '[' || topic_id || '] ' || decision || ' (原因: ' || rationale || ')'
        FROM topic_decisions
        WHERE (project_uuid = ? OR conversation_id = ?)
        AND topic_id IN (
            SELECT DISTINCT m.topic_id
            FROM messages m
            JOIN messages_fts fts ON m.id = fts.rowid
            WHERE m.conversation_id IN (
                SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                UNION
                SELECT ? WHERE ? != ''
            )
            AND fts.content MATCH ?
        )
    """, (project_uuid, conv_id, project_uuid, conv_id, conv_id, fts_keyword))
    
    for row in cursor.fetchall():
        match_count += 1
        print(row[0])

    print("\n=== 直接匹配架构决策 (通道 B) ===")
    cursor.execute("""
        SELECT '[' || topic_id || '] ' || decision || ' (原因: ' || rationale || ')'
        FROM topic_decisions
        WHERE (project_uuid = ? OR conversation_id = ?)
        AND (decision LIKE ? OR rationale LIKE ?)
        LIMIT 5
    """, (project_uuid, conv_id, f"%{keyword}%", f"%{keyword}%"))
    for row in cursor.fetchall():
        match_count += 1
        print(row[0])

    if match_count > 0:
        cursor.execute("""
            UPDATE project_topics SET last_accessed_at = CURRENT_TIMESTAMP
            WHERE uuid = ? 
            AND topic_id IN (
                SELECT topic_id FROM (
                    SELECT DISTINCT m.topic_id, m.id
                    FROM messages m
                    JOIN messages_fts fts ON m.id = fts.rowid
                    WHERE m.conversation_id IN (
                        SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                        UNION
                        SELECT ? WHERE ? != ''
                    )
                    AND fts.content MATCH ?
                    ORDER BY m.id ASC LIMIT 10
                )
                UNION
                SELECT topic_id FROM (
                    SELECT topic_id FROM topic_decisions
                    WHERE (project_uuid = ? OR conversation_id = ?)
                    AND (decision LIKE ? OR rationale LIKE ?)
                    LIMIT 5
                )
            )
        """, (project_uuid, project_uuid, conv_id, conv_id, fts_keyword, project_uuid, conv_id, f"%{keyword}%", f"%{keyword}%"))
        conn.commit()

if __name__ == "__main__":
    main()
