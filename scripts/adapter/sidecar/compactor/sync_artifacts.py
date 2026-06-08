import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

import json
import hashlib

from adapter.bridge.paths import extract_conv_id
from lib.dao import insert_file_change
from core.filesystem import calculate_md5
from core.storage.connection import get_conn
from core.storage.artifacts import (
    get_artifact_hash, upsert_artifact_hash, delete_artifact_messages,
    insert_artifact_message, upsert_artifact_topic, enqueue_event
)

def scan_and_ingest_artifacts(context):
    """
    双轨制品记忆搜刮：
    大模型每次运行 Stop 离线前被触发。仅计算 artifacts 下 Plan/Walkthrough 文件的 MD5。
    仅在哈希改变时，清空该文件在此项目下的旧同步事实，并把全新 Markdown 原文作为 system 对话
    直接导入 messages 数据库，免去大模型在退出时同步抽取造成的交互延迟（保证开发心流）。
    """
    artifact_dir = context.get('artifactDirectoryPath', '')
    project_uuid = os.environ.get("ANTIGRAVITY_PROJECT_ID", os.environ.get("REMORA_PROJECT_ID", "unknown"))
    if not artifact_dir or not os.path.exists(artifact_dir):
        return

    target_files = ["implementation_plan.md", "walkthrough.md"]
    
    with get_conn() as conn:
        for filename in target_files:
            file_path = os.path.join(artifact_dir, filename)
            if not os.path.exists(file_path):
                continue
                
            current_hash = calculate_md5(file_path)
            
            # 1. 哈希过滤：如果 MD5 没变，直接跳过，耗时 < 1 毫秒
            current_stored = get_artifact_hash(conn, file_path)
            if current_stored == current_hash:
                continue
                
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # 2. 写入或覆盖哈希表
            upsert_artifact_hash(conn, file_path, current_hash)
                
            # 3. 物理一致性同步：将制品原文作为 system 角色事实导入 messages
            #    使用特定的 conversation_id 格式实现项目内物理绑定
            sync_conv_id = f"artifact_sync_{project_uuid}"
            
            # 清除旧事实 (覆盖重写，保证最终一致性)
            delete_artifact_messages(conn, sync_conv_id, filename)
                
            # 物理写入温存储
            # 999900 系列行号为制品专用预留段
            insert_artifact_message(conn, sync_conv_id, 999900 + target_files.index(filename), filename, content, json.dumps(["artifact_topic"]))

            conv_id = extract_conv_id(context.get('transcriptPath', ''))
            if conv_id:
                insert_file_change(project_uuid, conv_id, filename, "artifact")
            # 确保在 project_topics 表中也有此全局约束话题的记录
            upsert_artifact_topic(conn, project_uuid, "artifact_topic", f"Consolidated architecture decisions from {filename}")
                
            # [P0] 极速无感写入事件队列，解决 Hook 挂接大模型延迟问题
            if filename == "implementation_plan.md":
                conn.commit()
                continue # Plan 审批由 check_plan_approval() 独立管线处理
            event_type = f"{filename.split('.')[0]}_sync" # walkthrough_sync 或 task_sync
            enqueue_event(conn, project_uuid, event_type, content)
                
            conn.commit()
            print(f"[Remora] 成功同步制品记忆: {filename}")
