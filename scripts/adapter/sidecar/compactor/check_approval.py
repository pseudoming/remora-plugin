import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

import json
import re


def check_plan_approval(conn, project_uuid):
    """
    [P0] Plan 审批判定窗口扫描 (手术刀精准化改造)
    不再直接执行 blanket UPDATE 造成旧决策污染性锁定。
    改为：识别到审批信号后，极速向 remora_event_queue INSERT 对应 plan_approval_sync 事件，
    将其并入事件消费管线，通过 LLM 进行高精度的「审批消息 + Plan 原文 -> 待确认 Decisions」映射。
    """
    # 1. 查找 implementation_plan.md 最后哈希变更时间
    cursor = conn.execute(
        "SELECT last_updated FROM artifact_hashes WHERE file_path LIKE '%implementation_plan.md' LIMIT 1"
    )
    row = cursor.fetchone()
    if not row:
        return
    t_plan_change = row[0]

    # 2. 拉取此时间点之后的全部用户输入消息
    cursor = conn.execute(
        "SELECT content FROM messages WHERE timestamp > ? AND role IN ('USER', 'USER_INPUT', 'USER_EXPLICIT', 'user')", (t_plan_change,)
    )
    user_messages = [r[0] for r in cursor.fetchall()]

    # 3. 加权关键词扫描
    approval_keywords = ["同意", "执行吧", "批准", "启动吧", "开始执行", "可以执行", "没问题", "approve", "confirm"]
    has_approval = False
    for msg in user_messages:
        if any(kw in msg for kw in approval_keywords):
            if not re.search(r'(不|拒绝|拒绝执行)\s*(' + '|'.join(approval_keywords) + ')', msg):
                has_approval = True
                break

    # 4. 生成 plan_approval_sync 事件，交付事件消费管线统一精准匹配
    if has_approval:
        # 获取 Plan 的最新原文
        cursor = conn.execute(
            "SELECT content FROM messages WHERE conversation_id = ? AND role = 'implementation_plan.md' LIMIT 1",
            (f"artifact_sync_{project_uuid}",)
        )
        plan_content_row = cursor.fetchone()
        plan_content = plan_content_row[0] if plan_content_row else ""
        
        payload_data = {
            "user_approval_context": "\n".join(user_messages),
            "plan_content": plan_content
        }
        
        conn.execute(
            "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)",
            (project_uuid, "plan_approval_sync", json.dumps(payload_data))
        )
        conn.commit()
        print(f"[Remora] 探测到项目 {project_uuid} 用户审批信号，已向事件队列抛入 plan_approval_sync。")
