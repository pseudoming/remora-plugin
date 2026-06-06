#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
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

def _handle_pre_invocation(context):
    inject_steps = []
    # 查找最新的 session_id 判定冷启动
    latest = dao.get_latest_session()
    if not latest or latest[1] == 0:
        return {"injectSteps": []}
        
    session_id = latest[0]
    uuid = dao.get_project_uuid_by_conv(session_id)
    if not uuid:
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
    
    return {"injectSteps": inject_steps}

def _handle_pre_tool_use(context):
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
    
    hit_decisions = []
    for d in decisions:
        for f in d["files"]:
            # 改用包含/后缀匹配，防范同名跨目录文件误命中
            if f and (f in target_file or target_file.endswith(f)):
                hit_decisions.append(d)
                break
                
    if hit_decisions:
        decision_text = _truncate_decisions(hit_decisions)
        # 中文翻译：
        # ⛔ REMORA 安全限制 [实体防护]：禁止未经授权的自我修改！
        # ============================================================
        # !!! 关键策略违规 & 记忆防御触发 !!!
        # 你尝试修改或破坏性覆写受物理保护的系统配置或决策实体（目标：{target_file}）。
        #
        # 必须遵守的决策：
        # - {decision_text}
        #
        # 严禁未经授权更改核心代理行为规则或决策锚点，以防状态漂移！
        #
        # 如需继续，你必须：
        # 1. 解释意图：与用户讨论并确认修改此受保护配置的原因。
        # 2. 手动确认：在提出进一步编辑之前，确保用户在对话中显式允许该更改。
        # ============================================================
        prompt = (
            f"<system-reminder>\n"
            f"⛔ REMORA SAFETY LIMIT [ENTITY-PROTECTION]: UNSANCTIONED SELF-MODIFICATION BLOCKED!\n"
            f"============================================================\n"
            f"!!! CRITICAL POLICY VIOLATION & MEMORY DEFENSE TRIGGERED !!!\n"
            f"YOU ATTEMPTED TO MODIFY OR DESTRUCTIVELY OVERWRITE PHYSICALLY PROTECTED SYSTEM CONFIGURATIONS OR DECISION ENTITIES (Target: {target_file}).\n\n"
            f"THE DECISIONS YOU MUST COMPLY WITH:\n"
            f"- {decision_text}\n\n"
            f"UNAUTHORIZED ALTERATION OF CORE AGENT BEHAVIOR RULES OR DECISION ANCHORS IS STRICTLY PROHIBITED TO PREVENT STATE DRIFT!\n\n"
            f"TO PROCEED, YOU MUST:\n"
            f"1. EXPLAIN INTENT: DISCUSS WITH THE USER AND CONFIRM THE REASON FOR MODIFYING THIS PROTECTED CONFIGURATION.\n"
            f"2. MANUAL CONFIRM: ENSURE THE USER EXPLICITLY PERMITS THE CHANGE IN THE CONVERSATION BEFORE PROPOSING FURTHER EDITS.\n"
            f"============================================================\n"
            f"</system-reminder>"
        )
        return {"injectSteps": [{"ephemeralMessage": prompt}]}
        
    return {"injectSteps": []}

@hook_entrypoint(fallback_result={"injectSteps": []})
def main(context):
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["pre-invoke", "pre-tool"], required=True)
    
    try:
        args, _ = parser.parse_known_args()
    except:
        return {"injectSteps": []}
        
    try:
        if args.stage == "pre-invoke":
            return _handle_pre_invocation(context)
        elif args.stage == "pre-tool":
            return _handle_pre_tool_use(context)
    except Exception as e:
        import traceback
        print(f"[Remora Error] cognitive-push failed: {e}", file=sys.stderr)
        traceback.print_exc()
            
    return {"injectSteps": []}

if __name__ == "__main__":
    main()
