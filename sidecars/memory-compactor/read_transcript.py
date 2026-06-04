import os
import sys
import json
import time
import sqlite3
import re

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DB_PATH

from scan_sessions import is_subagent_session
from lib.conversation import ConversationDataAccessLayer

MAX_PROMPT_LENGTH = 8000

def format_timestamp(ts_str):
    """
    统一时间戳为 SQLite 标准 'YYYY-MM-DD HH:MM:SS' 字符串，以消除类型与格式失配 bug
    """
    if not ts_str:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    ts_str = ts_str.replace('T', ' ').replace('Z', '')
    return ts_str[:19]

def read_incremental_logs(conn, session):
    """利用 CDAL 进行增量读取，并将原日志叙写存入 messages 表"""
    is_sub = is_subagent_session(session['conversation_id'])
    conv_id = session['conversation_id']
    
    cursor = conn.execute(
        "SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?",
        (session['project_uuid'], conv_id))
    watermark_row = cursor.fetchone()
    last_msg_id = watermark_row[0] if watermark_row else 0

    # Derive last physical line from messages table to avoid reading from start
    cursor = conn.execute("SELECT MAX(line_number) FROM messages WHERE conversation_id=?", (conv_id,))
    max_line_row = cursor.fetchone()
    last_line = max_line_row[0] if max_line_row and max_line_row[0] else 0

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
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)",
                    (conv_id, current_line,
                     format_timestamp(step.get('timestamp', '')), step.get('source', ''),
                     content))
                msg_id = cursor.lastrowid
                
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
        
        # Get target_msg_id safely by looking for the MAX(id) <= target_rollback_line
        cursor = conn.execute("SELECT MAX(id) FROM messages WHERE conversation_id=? AND line_number<=?", (conv_id, target_rollback_line))
        msg_row = cursor.fetchone()
        target_msg_id = msg_row[0] if msg_row and msg_row[0] is not None else 0
        
        conn.execute(
            "DELETE FROM messages WHERE conversation_id=? AND line_number > ?",
            (conv_id, target_rollback_line))
        try:
            cursor = conn.execute("SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?", (conv_id,))
            decisions = cursor.fetchall()
            for dec_id, ev_ids_str in decisions:
                try:
                    ev_ids = json.loads(ev_ids_str) if ev_ids_str else []
                    if any(int(eid) > target_msg_id for eid in ev_ids):
                        conn.execute("DELETE FROM topic_decisions WHERE id=?", (dec_id,))
                except Exception:
                    pass
        except sqlite3.OperationalError:
            pass

        # Deletion based on created_at timestamp
        cursor = conn.execute("SELECT timestamp FROM messages WHERE id=?", (target_msg_id,))
        row = cursor.fetchone()
        target_timestamp = row[0] if row else None
        if target_timestamp:
            try:
                conn.execute("DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?", (conv_id, target_timestamp))
            except sqlite3.OperationalError:
                pass
        conn.execute(
            "DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'",
            (session['project_uuid'],))
            
        conn.execute(
            "UPDATE watermarks SET last_msg_id=? WHERE project_uuid=? AND conversation_id=?",
            (target_msg_id, session['project_uuid'], conv_id))
            
        print(f"[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至 msg_id: {target_msg_id}")
        last_line = target_rollback_line
        last_msg_id = target_msg_id

    # Recalculate current_msg_id
    cursor = conn.execute("SELECT MAX(id) FROM messages WHERE conversation_id=?", (conv_id,))
    max_id_row = cursor.fetchone()
    current_msg_id = max_id_row[0] if max_id_row and max_id_row[0] else last_msg_id

    if not watermark_row:
        conn.execute(
            "INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)",
            (session['project_uuid'], conv_id))

    key_content = "\\n".join(new_snippets)

    return key_content, current_msg_id, last_msg_id
