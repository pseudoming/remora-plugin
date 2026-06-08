import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

import json
import time
import re

from schema.schema_init import DB_PATH

from scan_sessions import is_subagent_session
from adapter.bridge.conversation import ConversationDataAccessLayer
from core.liveness import format_timestamp
from core.storage.messages import (
    get_watermark, get_max_line_number, insert_message, get_max_message_id,
    get_max_message_id_up_to_line, delete_messages_above_line,
    get_decisions_by_conversation, delete_topic_decision, get_message_timestamp,
    delete_decisions_by_conversation_after, delete_pending_events,
    update_watermark, ensure_watermark
)

MAX_PROMPT_LENGTH = 8000

def read_incremental_logs(conn, session):
    """利用 CDAL 进行增量读取，并将原日志叙写存入 messages 表"""
    is_sub = is_subagent_session(session['conversation_id'])
    conv_id = session['conversation_id']

    last_msg_id = get_watermark(conn, session['project_uuid'], conv_id)

    last_line = get_max_line_number(conn, conv_id)

    cdal = ConversationDataAccessLayer(conv_id)

    current_line = last_line
    new_snippets = []
    total_length = 0

    # 物理检测回滚：如果总最大步数小于记录的水位线，说明发生了物理裁剪 (Undo)
    db_max_idx = cdal.get_max_step_index()
    if db_max_idx < last_line:
        # 强制将 current_line 设为 0 以便触发下方的 Undo 回滚拦截线
        current_line = 0
        start_idx = 0
    else:
        start_idx = last_line + 1

    try:
        # 使用 CDAL 读取新数据，传入 start_idx 消除 O(N^2) 性能劣化
        for step in cdal.stream_steps_forward(start_idx=start_idx):
            step_index = step.get('step_index')
            if step_index is None:
                continue

            current_line = step_index
            if current_line > last_line:
                step_type = step.get('type', '')

                if is_sub and step_type not in ('USER_INPUT', 'PLANNER_RESPONSE'):
                    continue

                content = step.get('content', '')

                # 插入到 messages 表
                role = step.get('role')
                if not role:
                    role = step.get('source', '')
                if not role:
                    step_type = step.get('type', '')
                    if step_type == 'USER_INPUT':
                        role = 'user'
                    elif step_type == 'PLANNER_RESPONSE':
                        role = 'model'
                    else:
                        role = 'unknown'

                msg_id = insert_message(conn, conv_id, current_line,
                                        format_timestamp(step.get('timestamp', '')), role,
                                        content)

                # 为 LLM 收集 snippet
                if content and step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                    snippet = f"[msg_{msg_id}] {content[:500]}"
                    if total_length < MAX_PROMPT_LENGTH:
                        new_snippets.append(snippet)
                        total_length += len(snippet)
    except Exception:
        pass

    # 逆缩（Undo）自愈拦截线
    if current_line < last_line:
        target_rollback_line = max(0, current_line - 1)

        target_msg_id = get_max_message_id_up_to_line(conn, conv_id, target_rollback_line)

        delete_messages_above_line(conn, conv_id, target_rollback_line)

        decisions = get_decisions_by_conversation(conn, conv_id)
        for dec_id, ev_ids_str in decisions:
            try:
                ev_ids = json.loads(ev_ids_str) if ev_ids_str else []
                if any(int(eid) > target_msg_id for eid in ev_ids):
                    delete_topic_decision(conn, dec_id)
            except Exception:
                pass

        target_timestamp = get_message_timestamp(conn, target_msg_id)
        if target_timestamp:
            delete_decisions_by_conversation_after(conn, conv_id, target_timestamp)

        delete_pending_events(conn, session['project_uuid'])

        update_watermark(conn, session['project_uuid'], conv_id, target_msg_id)

        print(f"[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至 msg_id: {target_msg_id}")
        last_line = target_rollback_line
        last_msg_id = target_msg_id

    # Recalculate current_msg_id
    current_msg_id = get_max_message_id(conn, conv_id)
    if not current_msg_id:
        current_msg_id = last_msg_id

    ensure_watermark(conn, session['project_uuid'], conv_id)

    key_content = "\\n".join(new_snippets)

    return key_content, current_msg_id, last_msg_id
