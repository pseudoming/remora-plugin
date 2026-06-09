#!/usr/bin/env python3
import sys
import os
import json
import time
from datetime import datetime, timezone
from pathlib import Path

# Inject scripts path to import libs
scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

from lib import dao
from core.logger import warn, debug
from core.liveness import parse_sqlite_timestamp, find_all_uuids, judge_zombie
from core.storage.messages import get_latest_non_user_messages

def run_audit(conv_id: str, parent_conv_id: str = None) -> dict:
    # 1. 物理读取 progress.json
    home_dir = os.environ.get("HOME", os.path.expanduser("~"))
    
    import glob
    short_id = conv_id[:8] if len(conv_id) >= 8 else conv_id
    search_pattern = os.path.join(home_dir, ".gemini", "antigravity", "brain", parent_conv_id or "*", ".system_generated", "worktrees", f"*{short_id}*", "scratch", "progress.json")
    matches = glob.glob(search_pattern)
    
    if matches:
        progress_path = matches[0]
    else:
        exact_new = os.path.join(home_dir, ".gemini", "antigravity", "brain", parent_conv_id or "*", ".system_generated", "worktrees", conv_id, "scratch", "progress.json")
        exact_matches = glob.glob(exact_new)
        if exact_matches:
            progress_path = exact_matches[0]
        else:
            progress_path = os.path.join(home_dir, ".gemini", "antigravity", "brain", conv_id, "scratch", "progress.json")
    
    progress_data = {}
    progress_exists = os.path.exists(progress_path)
    if progress_exists:
        try:
            with open(progress_path, "r", encoding="utf-8") as f:
                progress_data = json.load(f)
        except Exception as e:
            warn(f"{str(e)}")
            
    # 2. 读取 messages 表（通过 DAO）
    latest_msg_ts = 0.0
    latest_msg_role = None
    latest_msg_content = None
    db_blocked = False
    db_blocked_reason = ""

    try:
        rows = get_latest_non_user_messages(conv_id, limit=5)
        if rows:
            ts_val = rows[0].get('timestamp')
            role = rows[0].get('role')
            content = rows[0].get('content', '')
            latest_msg_ts = parse_sqlite_timestamp(ts_val)
            latest_msg_role = role
            latest_msg_content = content[:100] + "..." if len(content) > 100 else content

            for row in rows:
                content_str = row.get('content', '')
                content_lower = content_str.lower()
                if any(kw in content_lower for kw in ("permission_denied", "tool_missing", "permission denied", "remora safety intercept", "exit status", "unknown tool name")):
                    db_blocked = True
                    db_blocked_reason = f"Fatal block in messages: {content_str[:80]}"
                    break
    except Exception as e:
        warn(f"{str(e)}")
 
    # 3. 判定逻辑
    status = progress_data.get("status")
    
    now_utc = datetime.now(timezone.utc).timestamp()
    
    progress_ts = 0.0
    last_updated_at_val = progress_data.get("last_updated_at")
    if last_updated_at_val:
        try:
            progress_ts = float(last_updated_at_val)
        except ValueError:
            pass
            
    if status == "completed":
        return {
            "liveness": "alive",
            "reason": "Task is already completed."
        }
        
    if status == "blocked" or db_blocked:
        blocked_msg = progress_data.get('details', '') if status == "blocked" else db_blocked_reason
        return {
            "liveness": "dead",
            "reason": f"Status is blocked: {blocked_msg}"
        }
        
    progress_elapsed = -1.0
    if progress_ts > 0:
        progress_elapsed = time.time() - progress_ts
        
    msg_elapsed = -1.0
    if latest_msg_ts > 0:
        msg_elapsed = now_utc - latest_msg_ts
        
    active_elapseds = []
    if progress_elapsed >= 0:
        active_elapseds.append(progress_elapsed)
    if msg_elapsed >= 0:
        active_elapseds.append(msg_elapsed)
        
    if not active_elapseds:
        if not progress_exists:
            return {
                "liveness": "alive",
                "reason": "No liveness signals yet. Subagent might be initializing."
            }
        else:
            is_dead = True
            death_reason = "Progress file exists but contains no valid timestamp."
    else:
        idle_seconds = int(min(active_elapseds))
        is_zombie, limit = judge_zombie(idle_seconds, latest_msg_role or "unknown", heavy_tools={"run_command", "grep_search"})
        is_dead = is_zombie
        if is_dead:
            death_reason = f"Liveness timeout: last updated {idle_seconds}s ago (Threshold: {limit}s)."
    
    idle_seconds = msg_elapsed if msg_elapsed >= 0 else progress_elapsed
    last_tool_name = latest_msg_role or "unknown"
    debug(f"subagent {conv_id}: status={'zombie' if is_dead else 'active'}, idle={idle_seconds:.0f}s, tool={last_tool_name}")
    
    if is_dead:
        # 顺便写回 progress.json，将其标记为 blocked，加速下一次感知
        try:
            from adapter.bridge.progress import ProgressSentinel
            home_dir = os.environ.get("HOME", os.path.expanduser("~"))
            transcript_dummy = os.path.join(home_dir, ".gemini", "antigravity", "brain", conv_id, ".system_generated", "transcript.jsonl")
            ProgressSentinel.update(transcript_dummy, "blocked", details=death_reason)
        except Exception:
            pass
            
        return {
            "liveness": "dead",
            "reason": death_reason,
            "details": {
                "progress_status": status,
                "progress_elapsed_seconds": progress_elapsed,
                "db_message_elapsed_seconds": msg_elapsed,
                "latest_role": latest_msg_role,
                "latest_content": latest_msg_content
            }
        }
    else:
        return {
            "liveness": "alive",
            "reason": "Subagent is active.",
            "details": {
                "progress_status": status,
                "progress_elapsed_seconds": progress_elapsed,
                "db_message_elapsed_seconds": msg_elapsed
            }
        }

from adapter.bridge.context import hook_entrypoint

@hook_entrypoint(fallback_result={"decision": "allow"})
def run_as_hook(input_data):
    transcript_path = input_data.get('transcriptPath', '')
    if not transcript_path:
        return {"decision": "allow", "reason": "No transcriptPath in stdin"}
        
    import re
    match = re.search(r'/brain/([^/]+)/', transcript_path)
    if not match:
        return {"decision": "allow", "reason": "Could not extract parent conversation_id"}
        
    parent_conv_id = match.group(1)
    
    from lib.dao import get_hook_state, set_hook_state, trim_hook_states
    from adapter.bridge.conversation import ConversationDataAccessLayer
    
    cdal = ConversationDataAccessLayer(parent_conv_id)
    current_turn_idx = cdal.get_current_turn_idx()

    # 物理时序裁剪 (Timeline Trimming)
    last_seen = get_hook_state(parent_conv_id, -1, 'last_seen_turn')
    if last_seen is None or int(last_seen) != current_turn_idx:
        trim_hook_states(parent_conv_id, current_turn_idx)
        set_hook_state(parent_conv_id, -1, 'last_seen_turn', str(current_turn_idx))

    # O(1) 心跳特异过滤：只在特定心跳探活上下文才审计，防止普通对话时发生 O(N) 步骤扫描雪崩
    try:
        latest_msg = cdal.get_latest_user_message() or ""
        latest_planner = cdal.get_latest_planner_response() or ""
        full_text = latest_msg + " " + latest_planner
        if not re.search(r'(定时器|定时任务|schedule|heartbeat|心跳探活|等待子代理)', full_text, re.IGNORECASE):
            return {"decision": "allow", "reason": "Not a liveness audit phase."}
    except Exception:
        pass
    
    # 自动探测子特工 ID
    subagent_ids = []
    try:
        from adapter.bridge.conversation import ConversationDataAccessLayer
        cdal = ConversationDataAccessLayer(parent_conv_id)
        
        # 1. 检索 parent_conv_id 的 project_uuid 与活动话题时间范围
        # Retrieve parent_conv_id's project_uuid and active topic timeframe
        project_uuid = None
        active_topic_ts = 0.0
        try:
            project_uuid = dao.get_project_uuid_by_conv(parent_conv_id)
            if project_uuid:
                topic_ts = dao.get_active_topic_created_at(project_uuid)
                if topic_ts:
                    active_topic_ts = parse_sqlite_timestamp(topic_ts)
        except Exception as db_err:
            # 中文翻译：警告：获取 project_uuid 或活动话题信息失败
            # Warning: Failed to fetch project_uuid or active topic info
            warn(f"{str(db_err)}")
        
        # 2. 时序范围截断：提取最后 20 条日志范围或当前活动话题的步骤
        # Temporal range truncation: extract steps within the last 20 logs or active topic timeframe
        all_steps = list(cdal.stream_steps_forward())
        last_20_steps = all_steps[-20:] if len(all_steps) > 20 else all_steps
        last_20_indices = {s.get('step_index') for s in last_20_steps if s.get('step_index') is not None}
        
        filtered_steps = []
        for step in all_steps:
            is_in_last_20 = step.get('step_index') in last_20_indices
            is_in_active_topic = False
            if active_topic_ts > 0.0:
                step_ts_str = step.get('timestamp')
                if step_ts_str:
                    step_ts = parse_sqlite_timestamp(step_ts_str)
                    if step_ts >= active_topic_ts:
                        is_in_active_topic = True
            if is_in_last_20 or is_in_active_topic:
                filtered_steps.append(step)

        candidate_subagent_ids = set()
        for step in filtered_steps:
            candidate_subagent_ids.update(find_all_uuids(step, parent_conv_id))

        # 3. 会话关联过滤：不仅匹配 UUID，还要与 SQLite 中的 watermarks 进行关联，确保属于该项目
        # Session-association filtering: verify candidate UUIDs are registered under the parent conversation's project_uuid in the watermarks table
        if project_uuid:
            try:
                for sub_id in candidate_subagent_ids:
                    if dao.watermark_exists(project_uuid, sub_id):
                        subagent_ids.append(sub_id)
            except Exception as db_err:
                # 中文翻译：警告：在水印关联过滤期间失败
                # Warning: Failed during watermarks correlation filter
                warn(f"Failed during watermarks correlation filter: {str(db_err)}")
                subagent_ids = list(candidate_subagent_ids)
        else:
            subagent_ids = list(candidate_subagent_ids)
            
        subagent_ids = list(set(subagent_ids))
    except Exception as e:
        return {"decision": "allow", "reason": f"Failed to auto-detect subagents: {str(e)}"}
        
    if not subagent_ids:
        return {"decision": "allow", "reason": "No subagents detected"}
        
    dead_agents = []
    for sub_id in subagent_ids:
        res = run_audit(sub_id, parent_conv_id)
        if res.get("liveness") == "dead":
            dead_agents.append((sub_id, res.get("reason", "unknown reason")))
            
    if dead_agents:
        reason_msg = f"⚠️ 警告：检测到后台子特工已卡死：\n" + "\n".join([f"- 特工 {sid}: {reason}" for sid, reason in dead_agents])
        dead_ids_str = ", ".join([f"'{sid}'" for sid, _ in dead_agents])
        
        # 检查同回合内 SOP 提示是否已经注入过
        sop_injected = get_hook_state(parent_conv_id, current_turn_idx, "liveness_sop")
        if not sop_injected:
            set_hook_state(parent_conv_id, current_turn_idx, "liveness_sop", "injected")
            # 中文翻译：
            # ⛔ REMORA 存活警告：子特工 {dead_ids_str} 无响应。
            # 要解决此问题，您必须遵循以下自愈 SOP：
            # 1. 强制终止：调用 `manage_subagents(Action='kill', ConversationIds=[{dead_ids_str}])`。
            # 2. 清理僵尸进程：运行命令列出子代理路径下的进程（例如 `ps aux | grep -v grep | grep -E 'pytest|build'`）。若发现任何孤儿进程，使用 kill/pkill 清理。
            # 3. 验证锁：确保在重新派发或重试前，没有会阻碍下一个子代理实例的数据库日志锁（例如 SQLite .db-journal 或 .runtime/ 中）。
            ephemeral_msg = (
                f"⛔ REMORA LIVENESS WARNING: Subagents {dead_ids_str} are unresponsive.\n"
                f"To resolve this, you MUST follow this Self-Healing SOP:\n"
                f"1. FORCE TERMINATE: Invoke `manage_subagents(Action='kill', ConversationIds=[{dead_ids_str}]).\n"
                f"2. CLEAN ZOMBIE PROCESSES: Run a command to list processes under the subagent's path (e.g., `ps aux | grep -v grep | grep -E 'pytest|build'`). If any orphaned subprocesses are found, use kill/pkill to clean them up.\n"
                f"3. VERIFY LOCKS: Ensure there are no database journal locks (e.g., in SQLite .db-journal or .runtime/) that could block next subagent instances before you respawn or retry."
            )
        else:
            # 中文翻译：
            # ⛔ REMORA 存活警告：子特工 {dead_ids_str} 无响应。
            ephemeral_msg = f"⛔ REMORA LIVENESS WARNING: Subagents {dead_ids_str} are unresponsive."

        # 判断是 PreInvocation 还是 PreToolUse 还是 Stop 阶段
        if not input_data.get('toolCall'):
            return {
                "decision": "deny",
                "reason": reason_msg,
                "injectSteps": [
                    {
                        "ephemeralMessage": ephemeral_msg
                    }
                ]
            }
        else:
            return {
                "decision": "deny",
                "reason": reason_msg
            }
        
    return {"decision": "allow", "reason": "All subagents are active"}

def main():
    from core.logger import set_trace_id
    import uuid
    set_trace_id(f"s_{uuid.uuid4().hex[:8]}")
    if len(sys.argv) > 1:
        conv_id = sys.argv[1]
        res = run_audit(conv_id)
        print(json.dumps(res, ensure_ascii=False))
        if res.get("liveness") == "dead":
            sys.exit(1)
        else:
            sys.exit(0)
            
    # Hook mode (decorated with @hook_entrypoint, it handles stdin, wraps exits and outputs JSON)
    run_as_hook()

if __name__ == "__main__":
    main()
