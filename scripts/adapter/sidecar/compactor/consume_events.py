import os
import json
import re
import time
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

from extract_decisions import get_or_create_conversation, AgentApiError
from core.storage.artifacts import get_pending_events, mark_event_processed
from core.storage.decisions import get_pending_decisions, confirm_decisions_by_ids

def consume_event_queue(conn, start_time):
    """
    [P0] 核心打标消费管线 (带超限熔断保护)
    """
    events = get_pending_events(conn)
    if not events:
        return

    for event_id, project_uuid, event_type, payload in events:
        # 提取待确认的老决策集 (引入 LIMIT 30 限制，防爆仓与超时熔断)
        pending_decisions = get_pending_decisions(conn, project_uuid)
        
        if not pending_decisions:
            mark_event_processed(conn, event_id)
            continue

        # AI 精准映射匹配
        prompt = f"""[SYSTEM CONSTRAINT]
You are a precise Architecture Decision Validator.
We have a list of pending decisions that need user confirmation.
Your task is to analyze the synchronization payload ({event_type}) provided below and determine which pending decisions have been successfully implemented or explicitly approved.

Pending Decisions to Validate:
{json.dumps(pending_decisions, ensure_ascii=False, indent=2)}

Sync Event Payload:
{payload}

You MUST output ONLY a valid JSON object listing the IDs of decisions that are confirmed:
{{"confirmed_ids": [12, 15]}}
If none match, return: {{"confirmed_ids": []}}
"""
        # [P1] 熔断保护升级：在发起耗时 LLM 调用前检查时间预算，预留 30s 缓冲防止击穿 300s
        if time.time() - start_time > 270:
            print("[Remora] 临界超时熔断，剩余事件留待下轮处理。", file=sys.stderr)
            break

        try:
            llm_output = get_or_create_conversation(prompt)
            json_match = re.search(r'({.*})', llm_output, re.DOTALL)
            if json_match:
                result_data = json.loads(json_match.group(1).strip())
                confirmed_ids = result_data.get("confirmed_ids", [])
                confirm_decisions_by_ids(conn, confirmed_ids, project_uuid)
                print(f"[Remora] 事件 {event_id} ({event_type}) 消费成功，已将决策集 {confirmed_ids} 打标锁定。")
        except AgentApiError:
            raise
        except Exception as e:
            print(f"[Remora] 消费事件 {event_id} 发生异常: {str(e)}", file=sys.stderr)
            conn.commit()
            continue
            
        mark_event_processed(conn, event_id)
