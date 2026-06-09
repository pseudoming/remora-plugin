#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from adapter.bridge.context import hook_entrypoint
from adapter.bridge.paths import extract_conv_id
from lib import dao
from core.gate import should_fire, mark_fired, is_duplicate
from core.storage.runtime_state import get_hook_state as _get
from core.logger import warn, error, debug


def _get_active_topic_and_decisions(uuid):
    topic_id = dao.get_active_topic(uuid)
    if not topic_id:
        return None, []
    # Use get_recent_decisions for read-only within-hook access (single-shot conn)
    from core.storage.connection import get_conn, closing
    from core.storage.decisions import get_recent_decisions
    with closing(get_conn()) as conn:
        decisions = get_recent_decisions(conn, uuid, topic_id, limit=5)
    return topic_id, decisions

def _handle_pre_invocation(context, conv_id, current_turn_idx):
    # 检查同回合内是否已经注入过会话重载提示
    if is_duplicate(conv_id, "resume_injected", str(current_turn_idx)):
        return {"injectSteps": []}

    inject_steps = []

    # In PreInvocation, when in discussion/planning phase, inject system discipline
    mode = dao.read_mode(conv_id, "strict")
    if mode == "relax":
        # 中文翻译：[行为纪律] 您当前处于需求研讨与规划阶段。
        # 除非用户明确指定了具体文件名，否则禁止修改核心代码文件。
        # /artifacts/ 下的规划制品可自由编辑。
        # 若在此期间发现任何未经用户明确要求的 Bug 或代码异味，严禁立即动手。先写入实施计划，获得用户批准！
        ephemeral_msg = (
            "<system-discipline>\n"
            "COORDINATOR BEHAVIORAL DISCIPLINE:\n"
            "1. YOU ARE CURRENTLY IN THE REQUIREMENT DISCUSSION AND PLANNING PHASE.\n"
            "2. UNLESS THE USER EXPLICITLY NAMES A SPECIFIC FILE TO MODIFY, DO NOT INVOKE ANY TOOLS (e.g., write_to_file, replace_file_content, run_command) THAT CHANGE CORE CODE FILES. YOU MAY FREELY EDIT PLANNING ARTIFACTS UNDER /artifacts/.\n"
            "3. IF YOU SPOT A BUG OR CODE SMELL NOT EXPLICITLY REQUESTED BY THE USER, DOCUMENT IT IN THE IMPLEMENTATION PLAN INSTEAD OF FIXING IT. SEEK USER APPROVAL BEFORE ANY WRITES.\n"
            "</system-discipline>"
        )
        inject_steps.append({"ephemeralMessage": ephemeral_msg})

    # Line C: semantic conflict detection (feature-gated)
    if _check_line_c_enabled():
        try:
            line_c_injections = _run_line_c(context, conv_id, current_turn_idx)
            if line_c_injections:
                inject_steps.extend(line_c_injections)
        except Exception:
            pass  # Line C failure must never block the conversation

    # 查找 session 判定冷启动
    session = dao.get_session(conv_id)
    if not session or session[2] == 0:  # session[2] = is_cold_start
        mark_fired(conv_id, "resume_injected", str(current_turn_idx))
        return {"injectSteps": inject_steps}


        
    uuid = dao.get_project_uuid_by_conv(conv_id)
    if not uuid:
        mark_fired(conv_id, "resume_injected", str(current_turn_idx))
        return {"injectSteps": inject_steps}
        
    topic_id, decisions = _get_active_topic_and_decisions(uuid)
    
    if decisions:
        lines = []
        for d in decisions:
            label = f"[{d['created_at'][:16]}"
            if d['user_confirmed']:
                label += ", 已确认"
            label += f"] {d['decision']}"
            if d.get('rationale'):
                label += f" (原因: {d['rationale'][:120]})"
            lines.append(label)
        decision_text = "\n".join(lines)
        debug(f"session resumed: {conv_id}, injecting {len(decisions)} decisions")
        decisions_from_memory = f"活跃话题: {topic_id}\n{decision_text}"
        prompt = (
            f"<system-reminder>\n"
            f"⚠️ SESSION RESUMED — 历史决策供参考:\n"
            f"============================================================\n"
            f"以下是本次话题下最近的历史决策（按时间排列）。\n"
            f"如果其中任何一条与当前上下文冲突，请与用户讨论后再继续。\n"
            f"{decisions_from_memory}\n"
            f"============================================================\n"
            f"</system-reminder>"
        )
        inject_steps.append({"ephemeralMessage": prompt})
        from core.storage.connection import get_conn, closing
        from core.storage.decisions import bump_injection
        with closing(get_conn()) as conn:
            for d in decisions:
                bump_injection(conn, d.get("id", 0))
        
    # 恢复物理消费，仅在消费成功且执行 Line A 后置 0
    dao.update_cold_start(conv_id, 0)
    mark_fired(conv_id, "resume_injected", str(current_turn_idx))
    
    return {"injectSteps": inject_steps}


def _check_line_c_enabled():
    import json
    from adapter.bridge.paths import get_data_dir
    config_path = os.path.join(os.path.dirname(get_data_dir()), "conf", "features.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
        return config.get("semantic_conflict_detection", {}).get("enabled", False)
    except Exception:
        return False


def _run_line_c(context, conv_id, current_turn_idx):
    """Returns list of inject step dicts, or []."""
    from adapter.bridge.conversation import ConversationDataAccessLayer
    cdal = ConversationDataAccessLayer(conv_id)
    user_input_count = cdal.get_user_input_count()
    if user_input_count is None:
        return []
    turn_interval = int(user_input_count) // 10
    if turn_interval == 0:
        return []

    window_key = f"line_c_window:{turn_interval}"
    if not should_fire(conv_id, window_key, str(turn_interval)):
        return []

    last_msg = context.get("last_msg", "")
    if not last_msg:
        steps = list(cdal.stream_steps_reverse(limit=50))
        for step in steps:
            if step.get("type") == "USER_INPUT":
                last_msg = step.get("content", "")
                break
    if not last_msg:
        return []

    from core.liveness import clean_system_reminders
    clean_msg = clean_system_reminders(last_msg)
    if not clean_msg.strip():
        return []

    uuid = dao.get_project_uuid_by_conv(conv_id)
    if not uuid:
        return []

    from core.storage.connection import get_conn, closing
    from core.storage.decisions import get_rejected_or_deferred_by_relevance
    from core.text_analysis import build_conflict_detection_prompt

    with closing(get_conn()) as conn:
        candidates = get_rejected_or_deferred_by_relevance(conn, uuid, clean_msg)

    if not candidates:
        mark_fired(conv_id, window_key, str(turn_interval))
        return []

    prompt = build_conflict_detection_prompt(clean_msg, candidates)

    try:
        from adapter.sidecar.compactor.extract_decisions import get_or_create_conversation
        llm_output = get_or_create_conversation(prompt)
    except Exception:
        try:
            from adapter.bridge.agentapi import create_conversation
            import json as _json
            resp = create_conversation(prompt, timeout=15, model="flash_lite")
            llm_output = resp.get('response', {}).get('newConversation', {}).get('reply', '') or _json.dumps(resp)
        except Exception:
            mark_fired(conv_id, window_key, str(turn_interval))
            return []

    import re
    json_match = re.search(r'({.*})', llm_output, re.DOTALL)
    if not json_match:
        mark_fired(conv_id, window_key, str(turn_interval))
        return []

    try:
        import json
        result = json.loads(json_match.group(1).strip())
    except Exception:
        mark_fired(conv_id, window_key, str(turn_interval))
        return []

    conflicts = result.get("conflicts", [])
    if not conflicts:
        mark_fired(conv_id, window_key, str(turn_interval))
        return []

    candidate_map = {c["id"]: c for c in candidates}
    inject_steps = []
    has_any_conflict = False

    for c in conflicts:
        cid = c.get("decision_id")
        if cid is None or cid not in candidate_map:
            continue
        has_any_conflict = True

        d = candidate_map[cid]
        conflict_key = f"line_c_conflict:{cid}"
        if is_duplicate(conv_id, conflict_key, str(turn_interval)):
            continue

        is_repeat = _get(conv_id, -1, conflict_key) is not None
        label = "REPEAT CONFLICT" if is_repeat else "SEMANTIC CONFLICT DETECTED"
        type_label = d["decision_type"].upper()
        date = d["created_at"][:10] if d.get("created_at") else ""
        reason = c.get("reason", "")

        conflict_details = (
            f"  [{type_label}, {date}] {d['decision']}\n"
            f"  LLM analysis: {reason}"
        )

        msg = (
            f"<system-reminder>\n"
            f"⚠️ {label}. YOUR PROPOSED COURSE OF ACTION CONTRADICTS PRIOR DECISIONS.\n\n"
            f"BEFORE EXECUTING ANY TOOLS, YOU MUST:\n"
            f"1. EXPLICITLY POINT OUT THE CONFLICT TO THE USER\n"
            f"2. ASK THE USER WHETHER TO OVERRIDE THE PREVIOUS DECISION\n"
            f"3. WAIT FOR EXPLICIT USER CONFIRMATION BEFORE PROCEEDING\n\n"
            f"CONFLICT DETAILS:\n{conflict_details}\n\n"
            f"DO NOT PROCEED WITHOUT USER CONFIRMATION.\n"
            f"</system-reminder>"
        )
        inject_steps.append({"ephemeralMessage": msg})
        mark_fired(conv_id, conflict_key, str(turn_interval))

    if has_any_conflict:
        mark_fired(conv_id, window_key, str(turn_interval))
        from core.storage.connection import get_conn, closing
        from core.storage.decisions import bump_injection
        with closing(get_conn()) as conn:
            for c in conflicts:
                cid = c.get("decision_id")
                if cid:
                    bump_injection(conn, cid)

    return inject_steps


def _handle_pre_tool_use(context, conv_id, current_turn_idx):
    tool_name = context.get("toolName", "")
    if tool_name not in ["write_to_file", "multi_replace_file_content", "replace_file_content"]:
        return {"injectSteps": []}
        
    tool_args = context.get("toolArgs", {})
    target_file = tool_args.get("TargetFile") or tool_args.get("AbsolutePath") or ""
    if not target_file:
        return {"injectSteps": []}
    
    # 撤销 strict 模式门控：只要动了关键实体文件，全天候强制物理拦截
    latest = dao.get_latest_session()
    if not latest:
        return {"injectSteps": []}
        
    session_id = latest[0]
    uuid = dao.get_project_uuid_by_conv(session_id)
    if not uuid:
        return {"injectSteps": []}
        
    topic_id, decisions = _get_active_topic_and_decisions(uuid)

    # 方案 2：全局核心代码"首写拦截 + 自适应二次放行"
    # 检查目标文件是否是规划制品
    is_artifact = "/artifacts/" in target_file or target_file.endswith("task.md") or target_file.endswith("implementation_plan.md") or target_file.endswith("walkthrough.md")
    
    if not is_artifact:
        # 如果不是规划制品且没有命中特定的保护决策（是普通的业务代码文件）
        state_key = "first_write_deny:" + target_file
        retry_status = dao.get_hook_state(conv_id, current_turn_idx, state_key)
        if retry_status == "1":
            # 第二次尝试，清除状态直接放行 (allow)
            dao.set_hook_state(conv_id, current_turn_idx, state_key, "0")
            dao.insert_file_change(uuid, conv_id, os.path.basename(target_file), "write_tool")
            inject_steps = []
            file_name = os.path.basename(target_file)
            decisions = dao.get_decisions_by_file(uuid, file_name)
            if decisions:
                dedup_key = f"file_decisions_injected:{file_name}"
                if should_fire(conv_id, dedup_key, str(current_turn_idx)):
                    lines = []
                    for i, d in enumerate(decisions[:3], 1):
                        lines.append(f"  {i}. {d['decision'][:150]}")
                    msg = (
                        f"<system-reminder>\n"
                        f"⚠️ {file_name} 关联 {len(decisions)} 条历史决策:\n"
                        f"{chr(10).join(lines)}\n"
                        f"写入前请确认不与上述决策冲突。\n"
                        f"</system-reminder>"
                    )
                    inject_steps.append({"ephemeralMessage": msg})
                    mark_fired(conv_id, dedup_key, str(current_turn_idx))
                    from core.storage.connection import get_conn, closing
                    from core.storage.decisions import bump_injection
                    with closing(get_conn()) as conn:
                        for d in decisions:
                            bump_injection(conn, d.get("id", 0))
            return {"decision": "allow", "injectSteps": inject_steps}
        else:
            # 第一次尝试，记录状态为 "1"，并返回 deny 与 prompt 注入
            dao.set_hook_state(conv_id, current_turn_idx, state_key, "1")
            
            # 中文翻译：
            # ⛔ REMORA 安全限制 [全局写门禁]：未获授权的代码修改已拦截！
            # ============================================================
            # !!! 研讨防护与防冲动门禁触发 !!!
            # 你正在非 Coding 阶段或首次调用中修改核心代码文件（目标：{target_file}）。
            #
            # 如需继续，你必须：
            # 1. 解释意图：向用户说明你正在修改的核心代码文件及改动逻辑。
            # 2. 自适应重试：若此修改确有必要且用户已批准，你必须在当前回合立即再次调用此写工具以解锁释放。
            # ============================================================
            prompt = (
                f"<system-reminder>\n"
                f"⛔ REMORA SAFETY LIMIT [GLOBAL-WRITE-GATE]: UNSANCTIONED WRITE BLOCKED!\n"
                f"============================================================\n"
                f"!!! DISCUSSION PROTECTION & ANTI-IMPULSIVE GATE TRIGGERED !!!\n"
                f"YOU ARE ATTEMPTING TO MODIFY A CORE CODE FILE (Target: {target_file}) IN AN UNSANCTIONED DISCUSSION PHASE OR ON THE FIRST CALL.\n\n"
                f"TO PROCEED, YOU MUST:\n"
                f"1. EXPLAIN INTENT: EXPLAIN TO THE USER THE LOGIC AND PURPOSE OF MODIFYING THIS CORE FILE.\n"
                f"2. ADAPTIVE RETRY: IF THIS EDIT IS INDEED SANCTIONED AND CONFIRMED, RE-EXECUTE THE WRITE TOOL IMMEDIATELY IN THE CURRENT TURN TO UNLOCK AND RELEASE.\n"
                f"============================================================\n"
                f"</system-reminder>"
            )
            return {
                "decision": "deny",
                "reason": f"⛔ REMORA SAFETY LIMIT [GLOBAL-WRITE-GATE]: Unauthorized edit to {target_file} blocked. Explain intent and retry.",
                "injectSteps": [{"ephemeralMessage": prompt}]
            }

    return {"injectSteps": []}

@hook_entrypoint(fallback_result={"injectSteps": []})
def main(context):
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["pre-invoke", "pre-tool"], required=True)
    
    try:
        args, _ = parser.parse_known_args()
    except Exception:
        return {"injectSteps": []}
        
    transcript_path = context.get('transcriptPath', '')
    conv_id = extract_conv_id(transcript_path) or "default"
    if conv_id == "default":
        latest = dao.get_latest_session()
        if latest:
            conv_id = latest[0]
            
    from adapter.bridge.conversation import ConversationDataAccessLayer
    
    cdal = ConversationDataAccessLayer(conv_id)
    current_turn_idx = cdal.get_current_turn_idx()

    # 物理时序裁剪 (Timeline Trimming)
    last_seen = dao.get_hook_state(conv_id, -1, 'last_seen_turn')
    should_trim = False
    if last_seen is None:
        should_trim = True
    else:
        try:
            should_trim = int(last_seen) != int(current_turn_idx)
        except (ValueError, TypeError):
            should_trim = False

    if should_trim:
        try:
            trim_turn = int(current_turn_idx)
        except (ValueError, TypeError):
            trim_turn = 0
        dao.trim_hook_states(conv_id, trim_turn)
        dao.set_hook_state(conv_id, -1, 'last_seen_turn', str(trim_turn))

        
    try:
        if args.stage == "pre-invoke":
            return _handle_pre_invocation(context, conv_id, current_turn_idx)
        elif args.stage == "pre-tool":
            return _handle_pre_tool_use(context, conv_id, current_turn_idx)
    except Exception as e:
        import traceback
        error(f"cognitive-push failed: {e}")
        traceback.print_exc()
            
    return {"injectSteps": []}

if __name__ == "__main__":
    main()
