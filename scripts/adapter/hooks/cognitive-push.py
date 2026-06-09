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
from core.injection_formatting import format_relax_discipline_prompt, format_decisions_for_session_resume, format_conflict_injection_message, format_file_decisions_injection, format_write_gate_deny_prompt
from core.safety_policy import is_planning_artifact
from core.state_trim import trim_stale_hook_states


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
        inject_steps.append({"ephemeralMessage": format_relax_discipline_prompt(artifact_path="/artifacts/", write_tool_examples=("write_to_file", "replace_file_content", "run_command"))})

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
        debug(f"session resumed: {conv_id}, injecting {len(decisions)} decisions")
        inject_steps.append({"ephemeralMessage": format_decisions_for_session_resume(decisions, topic_id)})
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
        inject_steps.append({"ephemeralMessage": format_conflict_injection_message(d, c, is_repeat)})
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
    is_artifact = is_planning_artifact(target_file,
        artifact_path_fragment="/artifacts/",
        artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md"))
    
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
                    inject_steps.append({"ephemeralMessage": format_file_decisions_injection(file_name, decisions)})
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
            prompt = format_write_gate_deny_prompt(target_file)
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

    trim_stale_hook_states(conv_id, current_turn_idx)

        
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
