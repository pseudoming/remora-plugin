#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.context import hook_entrypoint
from lib import dao

MAX_CHARS = 750  # 粗略控制 300 tokens 预算上限

def _get_active_topic_and_decisions(uuid):
    topic_id = dao.get_active_topic(uuid)
    if not topic_id:
        return None, []
    
    decisions = dao.get_confirmed_decisions(uuid, topic_id)
    return topic_id, decisions

def _truncate_decisions(decisions):
    # 控制 300 Tokens 内预算截断
    texts = []
    current_len = 0
    for d in decisions:
        text = d["text"]
        if current_len + len(text) > MAX_CHARS:
            texts.append(text[:(MAX_CHARS - current_len)] + "...")
            break
        texts.append(text)
        current_len += len(text)
    return "\n- ".join(texts)

def _handle_pre_invocation(context, conv_id, current_turn_idx):
    # 检查同回合内是否已经注入过会话重载提示
    resume_injected = dao.get_hook_state(conv_id, current_turn_idx, "resume_injected")
    if resume_injected:
        return {"injectSteps": []}

    inject_steps = []

    # In PreInvocation, when in discussion/planning phase, inject system discipline
    mode = dao.read_mode(conv_id, "strict")
    if mode == "relax":
        # 中文翻译：[行为纪律] 您当前处于需求研讨与规划阶段。
        # 禁止使用任何工具修改规划制品（/artifacts/）之外的物理代码文件。
        # 若在此期间发现任何明显 Bug，严禁立即动手修复。您必须先将其写入实施计划中，并显式获得用户批准！
        ephemeral_msg = (
            "<system-discipline>\n"
            "COORDINATOR BEHAVIORAL DISCIPLINE:\n"
            "1. YOU ARE CURRENTLY IN THE REQUIREMENT DISCUSSION AND PLANNING PHASE.\n"
            "2. DURING THIS PHASE, YOU ARE STRICTLY PROHIBITED FROM INVOKING ANY TOOLS (e.g., write_to_file, replace_file_content, run_command) THAT MODIFY CORE CODE FILES. YOU MAY ONLY MODIFY PLANNING ARTIFACTS IN THE `/artifacts/` SUBDIRECTORY.\n"
            "3. IF YOU SPOT ANY OBVIOUS BUG OR CODE SMELL, DO NOT FIX IT IMMEDIATELY. YOU MUST DOCUMENT IT IN THE IMPLEMENTATION PLAN AND SEEK EXPLICIT USER APPROVAL BEFORE RUNNING ANY WRITES.\n"
            "</system-discipline>"
        )
        inject_steps.append({"ephemeralMessage": ephemeral_msg})

    # 查找最新的 session_id 判定冷启动
    latest = dao.get_latest_session()
    if not latest or latest[1] == 0:
        dao.set_hook_state(conv_id, current_turn_idx, "resume_injected", "1")
        return {"injectSteps": inject_steps}


        
    session_id = latest[0]
    uuid = dao.get_project_uuid_by_conv(session_id)
    if not uuid:
        dao.set_hook_state(conv_id, current_turn_idx, "resume_injected", "1")
        return {"injectSteps": []}
        
    topic_id, decisions = _get_active_topic_and_decisions(uuid)
    
    if decisions:
        decision_text = _truncate_decisions(decisions)
        # 中文翻译：
        # ⚠️ REMORA 会话恢复警告：
        # ============================================================
        # 本次对话已被恢复或进行了上下文压缩！
        # 应用程序状态和目录内容可能已发生变化。
        # 为了保持逻辑一致性，你必须严格遵守以下从认知记忆中召回的物理锚定决策：
        # 活跃话题: {topic_id}
        # - {decision_text}
        #
        # 在任何情况下都不要忽略或覆写这些原则！
        # ============================================================
        decisions_from_memory = f"活跃话题: {topic_id}\n- {decision_text}"
        prompt = (
            f"<system-reminder>\n"
            f"⚠️ REMORA SESSION CONTINUATION WARNING:\n"
            f"============================================================\n"
            f"THIS CONVERSATION HAS BEEN RESUMED OR CONTEXT-COMPACTED!\n"
            f"APPLICATION STATE AND DIRECTORY CONTENTS MAY HAVE CHANGED.\n"
            f"TO PRESERVE LOGICAL CONSISTENCY, YOU MUST STRICTLY COMPLY WITH THE FOLLOWING PHYSICALLY ANCHORED DECISIONS RECALLED FROM COGNITIVE MEMORY:\n"
            f"{decisions_from_memory}\n\n"
            f"DO NOT IGNORE OR OVERWRITE THESE PRINCIPLES UNDER ANY CIRCUMSTANCES!\n"
            f"============================================================\n"
            f"</system-reminder>"
        )
        inject_steps.append({"ephemeralMessage": prompt})
        
    # 恢复物理消费，仅在消费成功且执行 Line A 后置 0
    dao.update_cold_start(session_id, 0)
    dao.set_hook_state(conv_id, current_turn_idx, "resume_injected", "1")
    
    return {"injectSteps": inject_steps}

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
            return {"decision": "allow", "injectSteps": []}
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
    except:
        return {"injectSteps": []}
        
    transcript_path = context.get('transcriptPath', '')
    conv_id = "default"
    if transcript_path:
        import re
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
    if conv_id == "default":
        latest = dao.get_latest_session()
        if latest:
            conv_id = latest[0]
            
    from lib.conversation import ConversationDataAccessLayer
    
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
        print(f"[Remora Error] cognitive-push failed: {e}", file=sys.stderr)
        traceback.print_exc()
            
    return {"injectSteps": []}

if __name__ == "__main__":
    main()
