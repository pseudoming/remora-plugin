import json
import re
import time
import sys

from extract_decisions import get_or_create_conversation, AgentApiError

def consume_event_queue(conn, start_time):
    """
    [P0] 核心打标消费管线 (带超限熔断保护)
    """
    cursor = conn.execute(
        "SELECT id, project_uuid, event_type, payload FROM remora_event_queue WHERE status = 'pending' ORDER BY id ASC"
    )
    events = cursor.fetchall()
    if not events:
        return

    for event_id, project_uuid, event_type, payload in events:
        # 提取待确认的老决策集 (引入 LIMIT 30 限制，防爆仓与超时熔断)
        cursor = conn.execute(
            "SELECT id, decision, rationale FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 0 ORDER BY id DESC LIMIT 30",
            (project_uuid,)
        )
        pending_decisions = [{"id": r[0], "decision": r[1], "rationale": r[2]} for r in cursor.fetchall()]
        
        if not pending_decisions:
            conn.execute("UPDATE remora_event_queue SET status = 'processed' WHERE id = ?", (event_id,))
            conn.commit()
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
                for d_id in confirmed_ids:
                    conn.execute(
                        "UPDATE topic_decisions SET user_confirmed = 1 WHERE id = ? AND project_uuid = ?",
                        (d_id, project_uuid)
                    )
                print(f"[Remora] 事件 {event_id} ({event_type}) 消费成功，已将决策集 {confirmed_ids} 打标锁定。")
        except AgentApiError:
            raise
        except Exception as e:
            print(f"[Remora] 消费事件 {event_id} 发生异常: {str(e)}", file=sys.stderr)
            conn.commit()
            continue
            
        conn.execute("UPDATE remora_event_queue SET status = 'processed' WHERE id = ?", (event_id,))
        conn.commit()
