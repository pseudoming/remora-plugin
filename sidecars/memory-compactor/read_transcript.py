import os
import sys
import json
import time
import sqlite3
import re

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DB_PATH

from scan_sessions import is_subagent_session

MAX_PROMPT_LENGTH = 8000

def format_timestamp(ts_str):
    """
    统一时间戳为 SQLite 标准 'YYYY-MM-DD HH:MM:SS' 字符串，以消除类型与格式失配 bug
    """
    if not ts_str:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    ts_str = ts_str.replace('T', ' ').replace('Z', '')
    return ts_str[:19]

def extract_key_content(transcript_path, start_line):
    """按行解析 JSONL，只提取 USER_INPUT 和 PLANNER_RESPONSE 的核心内容并附带物理行号"""
    key_content = []
    current_line = 0
    total_length = 0

    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            current_line += 1
            if current_line <= start_line:
                continue
            try:
                obj = json.loads(line)
                step_type = obj.get('type', '')
                content = obj.get('content', '')
                if not content:
                    continue
                # 注入 [line_xxx] 前缀以向 LLM 物理透传行号，保障证据精准回链
                if step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                    snippet = f"[line_{current_line}] {content[:500]}"
                    key_content.append(snippet)
                    total_length += len(snippet)
                    if total_length >= MAX_PROMPT_LENGTH:
                        break
            except json.JSONDecodeError:
                continue

    return "\n".join(key_content), current_line

def read_incremental_logs(conn, session):
    """利用 SQLite 水位线进行增量读取，并将原日志叙写存入 messages 表"""
    is_sub = is_subagent_session(session['transcript_path'])
    
    cursor = conn.execute(
        "SELECT last_line_processed FROM watermarks WHERE project_uuid=? AND conversation_id=?",
        (session['project_uuid'], session['conversation_id']))
    row = cursor.fetchone()
    last_line = row[0] if row else 0

    # 持运行 JSONL 写入 messages 表（供FTS5全文检索用）
    current_line = 0
    with open(session['transcript_path'], 'r', encoding='utf-8') as f:
        for line in f:
            current_line += 1
            if current_line > last_line:
                try:
                    log_obj = json.loads(line)
                    step_type = log_obj.get('type', '')
                    
                    # 子代理会话仅录入交互与推理，彻底抛弃 TOOL_OUTPUT (历史副本)
                    if is_sub and step_type not in ('USER_INPUT', 'PLANNER_RESPONSE'):
                        continue
                        
                    conn.execute(
                        "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)",
                        (session['conversation_id'], current_line,
                         format_timestamp(log_obj.get('timestamp', '')), log_obj.get('source', ''),
                         log_obj.get('content', '')))
                except Exception:
                    pass

    # 逆缩（Undo）自愈拦截线
    if current_line < last_line:
        # 时序重合对齐边界：后退至 current_line - 1 行（即 t-1 轮）
        # 确保下一次增量扫描能够将回滚分界线边缘的最后一条用户输入（第 t 行）
        # 与重新生成的回答一同带入 LLM 提取上下文，避免因果关系断裂导致的漏提
        target_rollback_line = max(0, current_line - 1)
        conn.execute(
            "DELETE FROM messages WHERE conversation_id=? AND line_number > ?",
            (session['conversation_id'], target_rollback_line))
        conn.execute(
            "DELETE FROM topic_decisions WHERE conversation_id=? AND created_at_line > ?",
            (session['conversation_id'], target_rollback_line))
        # 撤销事件一致性大扫除：若发生 Undo 回滚，一并清空事件队列中该项目未消费的 pending 事件，防范跨 Undo 误打标
        conn.execute(
            "DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'",
            (session['project_uuid'],))
        # 物理水位线同步回滚更新：确保即使程序在后续阶段崩溃，自愈后的水位线也能在数据库中持久化
        conn.execute(
            "UPDATE watermarks SET last_line_processed=? WHERE project_uuid=? AND conversation_id=?",
            (target_rollback_line, session['project_uuid'], session['conversation_id']))
            
        print(f"[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至行号: {target_rollback_line}")
        last_line = target_rollback_line

    if not row:
        conn.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_line_processed) VALUES (?, ?, ?)",
            (session['project_uuid'], session['conversation_id'], 0))

    # 提取核心内容（只取 USER_INPUT + MODEL 产出）
    key_content, _ = extract_key_content(session['transcript_path'], last_line)

    return key_content, current_line, last_line
