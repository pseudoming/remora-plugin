import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

import json

from core.storage.artifacts import (
    get_plan_change_time, get_user_messages_after, get_plan_content, enqueue_event
)
from core.text_analysis import scan_approval_signals

from schema.schema_init import DATA_DIR

_CONF_PATH = os.path.join(os.path.dirname(DATA_DIR), "conf", "approval.json")
_approval_config = None

def _load_approval_config():
    global _approval_config
    if _approval_config is None:
        try:
            with open(_CONF_PATH, 'r') as f:
                _approval_config = json.load(f)
        except Exception:
            _approval_config = {}
    return _approval_config


def check_plan_approval(conn, project_uuid):
    """
    [P0] Plan 审批判定窗口扫描 (手术刀精准化改造)
    不再直接执行 blanket UPDATE 造成旧决策污染性锁定。
    改为：识别到审批信号后，极速向 remora_event_queue INSERT 对应 plan_approval_sync 事件，
    将其并入事件消费管线，通过 LLM 进行高精度的「审批消息 + Plan 原文 -> 待确认 Decisions」映射。
    """
    # 1. 查找 implementation_plan.md 最后哈希变更时间
    t_plan_change = get_plan_change_time(conn)
    if not t_plan_change:
        return

    # 2. 拉取此时间点之后的全部用户输入消息
    user_messages = get_user_messages_after(conn, t_plan_change)

    # 3. 加权关键词扫描
    config = _load_approval_config()
    has_approval = scan_approval_signals(
        user_messages,
        keywords=config.get("approval_keywords"),
        negation_prefixes=config.get("negation_prefixes")
    )

    # 4. 生成 plan_approval_sync 事件，交付事件消费管线统一精准匹配
    if has_approval:
        # 获取 Plan 的最新原文
        plan_content = get_plan_content(conn, project_uuid)
        
        payload_data = {
            "user_approval_context": "\n".join(user_messages),
            "plan_content": plan_content
        }
        
        enqueue_event(conn, project_uuid, "plan_approval_sync", json.dumps(payload_data))
        conn.commit()
        print(f"[Remora] 探测到项目 {project_uuid} 用户审批信号，已向事件队列抛入 plan_approval_sync。")
