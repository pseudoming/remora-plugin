#!/usr/bin/env python3
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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

    from lib import dao
    
    if not dao.check_db_exists():
        print(f"[Remora] 温存储数据库尚未建立")
        sys.exit(1)

    if conv_id and not project_uuid:
        uuid = dao.get_project_uuid_by_conv(conv_id)
        if uuid:
            project_uuid = uuid

    if not project_uuid and not conv_id:
        print("[Remora] 错误: 无法获取项目标识，检索被拒绝。")
        sys.exit(1)

    fts_keyword = keyword
    match_count = 0

    print("=== FTS5 原始日志召回 (通道 A) ===")
    logs = dao.recall_fts5_logs(project_uuid, conv_id, fts_keyword)
    for log in logs:
        match_count += 1
        print(log)

    print("\n=== 关联架构决策召回 (通道 A 反向牵引) ===")
    decisions_fts = dao.recall_decisions_by_fts5_topic(project_uuid, conv_id, fts_keyword)
    for d in decisions_fts:
        match_count += 1
        print(d)

    print("\n=== 直接匹配架构决策 (通道 B) ===")
    like_decisions = dao.recall_decisions_by_like(project_uuid, conv_id, fts_keyword)
    for d in like_decisions:
        match_count += 1
        print(d)

    if match_count > 0:
        dao.touch_topics_accessed_by_recall(project_uuid, conv_id, fts_keyword)

if __name__ == "__main__":
    main()
