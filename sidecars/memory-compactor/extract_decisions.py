import os
import sys
import json
import time
import re
import sqlite3
import subprocess

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DB_PATH, DATA_DIR

from scan_sessions import (
    get_active_conversations,
    is_subagent_session,
    extract_subagent_report,
    load_excluded_ids,
    save_excluded_ids
)
from read_transcript import read_incremental_logs

CONV_MARKER_FILE = os.path.join(DATA_DIR, "compactor_conversation_id.txt")
BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")
MAX_EXECUTION_TIME = 300

class AgentApiError(Exception):
    pass

def get_or_create_conversation(prompt):
    """复用已有会话，或在没有可复用会话时创建新的"""
    excluded_ids = load_excluded_ids()

    if os.path.exists(CONV_MARKER_FILE):
        with open(CONV_MARKER_FILE, 'r') as f:
            conv_id = f.read().strip()
            if conv_id:
                transcript_path = os.path.join(
                    BRAIN_DIR, conv_id, ".system_generated", "logs", "transcript.jsonl")
                should_rollover = False
                if os.path.exists(transcript_path):
                    try:
                        with open(transcript_path, 'rb') as tf:
                            line_count = sum(1 for _ in tf)
                        if line_count > 150:
                            should_rollover = True
                            print(f"[Remora] 会话 {conv_id} 步数已达 {line_count}，启动自动换代。")
                    except Exception:
                        pass
                
                if should_rollover:
                    try:
                        os.remove(CONV_MARKER_FILE)
                    except Exception:
                        pass
                else:
                    try:
                        result = subprocess.check_output(
                            ["agentapi", "send-message", conv_id, prompt],
                            stderr=subprocess.STDOUT, timeout=120)
                        return result.decode('utf-8').strip()
                    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                        raise AgentApiError(f"Fail-Fast: send-message failed. Abandoning execution. Error: {e}")

    try:
        current_date_str = time.strftime('%Y-%m-%d', time.localtime())
        init_prompt = f"# Remora Memory Compactor ({current_date_str})\n\n" + prompt
        result = subprocess.check_output(
            ["agentapi", "new-conversation", init_prompt],
            stderr=subprocess.STDOUT, timeout=120)
        output = result.decode('utf-8').strip()

        try:
            resp = json.loads(output)
            new_conv_id = (resp.get('response', {})
                .get('newConversation', {})
                .get('conversationId', ''))
            if new_conv_id:
                with open(CONV_MARKER_FILE, 'w') as f:
                    f.write(new_conv_id)
                excluded_ids.add(new_conv_id)
                save_excluded_ids(excluded_ids)
        except json.JSONDecodeError:
            pass

        return output
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        raise AgentApiError(f"Fail-Fast: new-conversation failed. Abandoning execution. Error: {e}")

def extract_factual_baseline(transcript_path, start_line):
    """
    用纯代码规则从增量对话中提取最小事实基准集 (Non-LLM Baseline)
    提取物理写文件工具调用中的目标文件名以及用户确认打标的动作 /confirm <id>
    """
    baseline_files = set()
    baseline_actions = set()
    current_line = 0
    if not os.path.exists(transcript_path):
        return [], []
        
    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            current_line += 1
            if current_line <= start_line:
                continue
            try:
                obj = json.loads(line)
                for tool in obj.get('tool_calls', []):
                    tool_name = tool.get('name', '')
                    args = tool.get('arguments', {})
                    if tool_name in ('write_to_file', 'replace_file_content', 'multi_replace_file_content'):
                        target_file = args.get('TargetFile') or args.get('AbsolutePath')
                        if target_file:
                            baseline_files.add(os.path.basename(target_file))
                content = obj.get('content', '')
                if content:
                    confirm_matches = re.findall(r'/confirm\s+(\d+)', content)
                    for m in confirm_matches:
                        baseline_actions.add(f"confirm:{m}")
            except Exception:
                continue
    return list(baseline_files), list(baseline_actions)

def calculate_factual_confidence(conn, baseline_files, baseline_actions, output_topics):
    """
    在 Python 侧计算 Decisions 对 Baseline 的覆盖率作为客观置信度
    """
    if not baseline_files and not baseline_actions:
        return 1.0
    covered_files = 0
    covered_actions = 0
    decisions_text = ""
    for t in output_topics:
        for d in t.get("decisions", []):
            decisions_text += " " + d.get("decision", "").lower() + " " + d.get("rationale", "").lower()
            
    for f in baseline_files:
        if f.lower() in decisions_text:
            covered_files += 1
            
    for action in baseline_actions:
        if action.startswith("confirm:"):
            dec_id = action.split(":")[1]
            try:
                cursor = conn.execute("SELECT user_confirmed FROM topic_decisions WHERE id=?", (dec_id,))
                row = cursor.fetchone()
                if row and row[0] == 1:
                    covered_actions += 1
            except Exception:
                pass
                
    total_items = len(baseline_files) + len(baseline_actions)
    covered_items = covered_files + covered_actions
    return min(1.0, covered_items / total_items) if total_items > 0 else 1.0

def validate_id_inheritance(conn, project_uuid, new_topics):
    """
    校验所有标记了 user_confirmed=1 的历史决策 ID，是否完全被合并后的新决策继承 (Method A)
    防止由于大模型误删、合并时流失已确认的核心决策。
    """
    cursor = conn.execute(
        "SELECT id FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 1",
        (project_uuid,)
    )
    confirmed_ids = {row[0] for row in cursor.fetchall()}
    if not confirmed_ids:
        return True
    inherited_ids = set()
    for t in new_topics:
        for d in t.get("decisions", []):
            for val in d.get("inherited_from", []):
                try:
                    inherited_ids.add(int(val))
                except (ValueError, TypeError):
                    pass
    missing_ids = confirmed_ids - inherited_ids
    if missing_ids:
        raise Exception(f"REMORA HARD ANCHOR VIOLATION: user_confirmed=1 IDs lost: {list(missing_ids)}.")
    return True

def _get_active_topic(conn, project_uuid):
    try:
        cursor = conn.execute(
            "SELECT topic_id FROM project_topics WHERE uuid = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1",
            (project_uuid,)
        )
        row = cursor.fetchone()
        return row[0] if row else None
    except Exception as te:
        print(f"Error querying active topic: {str(te)}", file=sys.stderr)
        return None

def process_sessions(start_time):
    with sqlite3.connect(DB_PATH) as conn:
        active_sessions = get_active_conversations()
        for session in active_sessions:
            if time.time() - start_time > MAX_EXECUTION_TIME:
                print("Max execution time reached, stopping.", file=sys.stderr)
                break

            key_content, current_line, watermark_line = read_incremental_logs(conn, session)

            is_sub = is_subagent_session(session['transcript_path'])
            if is_sub:
                changed, referenced = extract_subagent_report(session['transcript_path'])
                if changed or referenced:
                    active_topic = _get_active_topic(conn, session['project_uuid'])
                    if active_topic:
                        cursor = conn.execute("SELECT associated_files, referenced_files FROM project_topics WHERE uuid=? AND topic_id=?", (session['project_uuid'], active_topic))
                        row = cursor.fetchone()
                        existing_assoc = json.loads(row[0]) if row and row[0] else []
                        existing_ref = json.loads(row[1]) if row and row[1] else []
                        assoc_dict = {item['file']: item for item in existing_assoc if 'file' in item}
                        ref_dict = {item['file']: item for item in existing_ref if 'file' in item}
                        for f in changed:
                            fb = os.path.basename(f)
                            assoc_dict[fb] = {"file": fb, "source": "agent"}
                        for f in referenced:
                            fb = os.path.basename(f)
                            ref_dict[fb] = {"file": fb, "source": "agent"}
                        conn.execute("UPDATE project_topics SET associated_files=?, referenced_files=?, last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                                     (json.dumps(list(assoc_dict.values())), json.dumps(list(ref_dict.values())), session['project_uuid'], active_topic))
                conn.execute(
                    "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                    (current_line, session['project_uuid'], session['conversation_id']))
                conn.commit()
                continue

            if not key_content.strip():
                conn.execute(
                    "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                    (current_line, session['project_uuid'], session['conversation_id']))
                conn.commit()
                continue

            current_time_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())

            active_topic_id = _get_active_topic(conn, session['project_uuid'])
            topic_constraint_desc = ""
            topic_constraint_prompt = ""

            if active_topic_id:
                topic_constraint_desc = f"\n[MANUAL TOPIC CONSTRAINT]\nThe current session is inside an active manual topic \"{active_topic_id}\".\nYou MUST group all extracted decisions under this specific topic_id: \"{active_topic_id}\".\nDo NOT generate a new topic_id or topic summary. Just reuse \"{active_topic_id}\" as the topic_id in your output."
                topic_constraint_prompt = f"\nNote: You MUST reuse \"{active_topic_id}\" as the topic_id in your output, do NOT create any other topic_id."

            baseline_files, baseline_actions = extract_factual_baseline(session['transcript_path'], watermark_line)

            prompt = f"""[SYSTEM CONSTRAINT]
This is a stateless extraction task. The conversation logs provided below are completely independent of any previous messages in this session.
You MUST ignore all previous contexts, topics, and decisions in this conversation history. Extract ADRs ONLY based on the new logs provided below.
Each line of the log is prefixed with its physical line number, e.g. [line_123]. You MUST reference these numbers.
{topic_constraint_desc}

You MUST output this exact timestamp on the first line before your JSON markdown block (do NOT put it inside the markdown code block):
[Sync Finished: {current_time_str}]

You are an expert Architecture Decision Record (ADR) extractor.
Analyze the following conversation snippets and extract all key topics.

You MUST output ONLY a valid JSON object matching this schema:
{{
  "topics": [
    {{
      "topic_id": "t_001",
      "summary": "...",
      "decisions": [
        {{"decision": "...", "rationale": "...", "evidence_msg_ids": [123, 125], "user_confirmed": false, "inherited_from": []}}
      ]
    }}
  ]
}}
Note: If this call compresses or merges old decisions with known IDs (e.g. 12, 15), you MUST list those original IDs in the "inherited_from" array. Otherwise, set "inherited_from": [].{topic_constraint_prompt}
Note: evidence_msg_ids MUST NOT be empty. Fill it with the actual line numbers from [line_XXXX] prefixes.
Note: If the MODEL output shows clear self-correction, agreement, or adoption of user's proposal, set "user_confirmed": true.
If no significant topics, output: {{"topics": []}}

[CONVERSATION]
""" + key_content

            llm_output = get_or_create_conversation(prompt)
            if not llm_output:
                conn.execute(
                    "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                    (current_line, session['project_uuid'], session['conversation_id']))
                conn.commit()
                continue

            json_match = re.search(r'```json\s*(.*?)\s*```', llm_output, re.DOTALL)
            if not json_match:
                json_match = re.search(r'({.*})', llm_output, re.DOTALL)

            if json_match:
                json_str = json_match.group(1).strip()
            else:
                json_str = llm_output.strip()

            try:
                data = json.loads(json_str)

                confidence = calculate_factual_confidence(conn, baseline_files, baseline_actions, data.get("topics", []))

                validate_id_inheritance(conn, session['project_uuid'], data.get("topics", []))

                for t in data.get("topics", []):
                    conn.execute(
                        """INSERT INTO project_topics (uuid, topic_id, summary, compression_confidence, source)
                           VALUES (?, ?, ?, ?, 'auto')
                           ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?, compression_confidence=?""",
                        (session['project_uuid'], t.get('topic_id', ''),
                         t.get('summary', ''), confidence, t.get('summary', ''), confidence))

                    for d in t.get("decisions", []):
                        user_confirmed_val = 1 if d.get("user_confirmed", False) else 0
                        conn.execute(
                            """INSERT INTO topic_decisions
                               (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, created_at_line)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            (session['project_uuid'], t.get('topic_id', ''),
                             session['conversation_id'], d.get('decision', ''),
                             d.get('rationale', ''),
                             json.dumps(d.get('evidence_msg_ids', [])),
                             user_confirmed_val,
                             current_line))
            except json.JSONDecodeError:
                pass

            conn.execute(
                "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                (current_line, session['project_uuid'], session['conversation_id']))
            conn.commit()
