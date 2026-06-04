#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
import sqlite3

sys.path.insert(0, os.path.dirname(__file__))
from lib.context import hook_entrypoint
from lib.paths import get_db_path

DB_PATH = get_db_path()
MAX_CHARS = 750  # 粗略控制 300 tokens 预算上限

def _get_active_topic_and_decisions(conn, uuid):
    topic_row = conn.execute("SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' LIMIT 1", (uuid,)).fetchone()
    if not topic_row:
        return None, []
    topic_id = topic_row[0]
    
    # 精准限制当前话题，且直接读取 topic_decisions 表内的精确实体文件映射
    decisions_rows = conn.execute(
        "SELECT decision, associated_files FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND user_confirmed=1 ORDER BY created_at ASC", 
        (uuid, topic_id)
    ).fetchall()
    
    decisions = []
    for d_text, files_json in decisions_rows:
        files = []
        if files_json:
            try:
                files = [item.get('file', '') for item in json.loads(files_json) if 'file' in item]
            except:
                pass
        decisions.append({"text": d_text, "files": files})
        
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

def _handle_pre_invocation(context, conn):
    inject_steps = []
    # 查找最新的 session_id 判定冷启动
    session_row = conn.execute("SELECT session_id, is_cold_start FROM session_state ORDER BY updated_at DESC LIMIT 1").fetchone()
    if not session_row or session_row[1] == 0:
        return {"injectSteps": []}
        
    session_id = session_row[0]
    uuid_row = conn.execute("SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1", (session_id,)).fetchone()
    if not uuid_row:
        return {"injectSteps": []}
        
    uuid = uuid_row[0]
    topic_id, decisions = _get_active_topic_and_decisions(conn, uuid)
    
    if decisions:
        decision_text = _truncate_decisions(decisions)
        # 追加自然语言软化指令
        prompt = f"<system-reminder>\n【Remora Line A: 会话恢复】\n检测到冷启动或话题切换。当前活跃话题: {topic_id}。\n已确立的核心约束：\n- {decision_text}\n⚠️ 请在后续回答中遵守上述约束。你在回复时自然提及约束原因即可，坚决不要复读本条系统提示，维持沟通心流。\n</system-reminder>"
        inject_steps.append({"ephemeralMessage": prompt})
        
    # 恢复物理消费，仅在消费成功且执行 Line A 后置 0
    conn.execute("UPDATE session_state SET is_cold_start = 0 WHERE session_id=?", (session_id,))
    conn.commit()
    
    return {"injectSteps": inject_steps}

def _handle_pre_tool_use(context, conn):
    tool_name = context.get("toolName", "")
    if tool_name not in ["write_to_file", "multi_replace_file_content", "replace_file_content"]:
        return {"injectSteps": []}
        
    tool_args = context.get("toolArgs", {})
    target_file = tool_args.get("TargetFile") or tool_args.get("AbsolutePath") or ""
    if not target_file:
        return {"injectSteps": []}
    
    # 撤销 strict 模式门控：只要动了关键实体文件，全天候强制物理拦截
    session_row = conn.execute("SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1").fetchone()
    if not session_row:
        return {"injectSteps": []}
        
    session_id = session_row[0]
    uuid_row = conn.execute("SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1", (session_id,)).fetchone()
    if not uuid_row:
        return {"injectSteps": []}
        
    uuid = uuid_row[0]
    topic_id, decisions = _get_active_topic_and_decisions(conn, uuid)
    
    hit_decisions = []
    for d in decisions:
        for f in d["files"]:
            # 改用包含/后缀匹配，防范同名跨目录文件误命中
            if f and (f in target_file or target_file.endswith(f)):
                hit_decisions.append(d)
                break
                
    if hit_decisions:
        decision_text = _truncate_decisions(hit_decisions)
        prompt = f"<system-reminder>\n【Remora Line B: 实体防护】\n🚨 MEMORY DEFENSE TRIGGERED:\n你正在修改受历史决策保护的文件 `{target_file}`。\n必须确保不违背以下已确认决策：\n- {decision_text}\n⚠️ 在回复中请自然提及你已充分考虑上述约束，维持顺畅心流。\n</system-reminder>"
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
        with sqlite3.connect(DB_PATH) as conn:
            if args.stage == "pre-invoke":
                return _handle_pre_invocation(context, conn)
            elif args.stage == "pre-tool":
                return _handle_pre_tool_use(context, conn)
    except Exception as e:
        import traceback
        print(f"[Remora Error] cognitive-push failed: {e}", file=sys.stderr)
        traceback.print_exc()
            
    return {"injectSteps": []}

if __name__ == "__main__":
    main()
