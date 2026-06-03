import os
import sys
import json
import time
import random
import re
import subprocess

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DATA_DIR

BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")
EXCLUDE_FILE = os.path.join(DATA_DIR, "compactor_managed_conversations.json")

def load_excluded_ids():
    if os.path.exists(EXCLUDE_FILE):
        with open(EXCLUDE_FILE, 'r') as f:
            return set(json.load(f))
    return set()

def save_excluded_ids(ids):
    with open(EXCLUDE_FILE, 'w') as f:
        json.dump(list(ids), f)

def get_project_id(conv_id):
    """通过 agentapi 获取这个会话的真实 projectId"""
    try:
        result = subprocess.check_output(
            ["agentapi", "get-conversation-metadata", conv_id],
            stderr=subprocess.STDOUT, timeout=10)
        data = json.loads(result.decode('utf-8'))
        project_id = (data.get("response", {})
            .get("conversationMetadata", {})
            .get("metadata", {})
            .get("projectId", ""))
        return project_id if project_id else "unknown"
    except Exception:
        return "unknown"

def get_active_conversations():
    """扫描 brain 目录，获取最近 48 小时内有活动的会话
    自动排除自己创建的会话，随机打乱避免饥饿"""
    active_sessions = []
    if not os.path.exists(BRAIN_DIR):
        return []

    excluded_ids = load_excluded_ids()
    current_time = time.time()

    for conv_id in os.listdir(BRAIN_DIR):
        if conv_id in excluded_ids:
            continue
        if len(conv_id) != 36 or conv_id.count('-') != 4:
            continue

        transcript_path = os.path.join(
            BRAIN_DIR, conv_id, ".system_generated", "logs", "transcript.jsonl")
        if os.path.exists(transcript_path):
            mtime = os.path.getmtime(transcript_path)
            if current_time - mtime <= 2 * 24 * 3600:
                project_uuid = get_project_id(conv_id)
                active_sessions.append({
                    "project_uuid": project_uuid,
                    "conversation_id": conv_id,
                    "transcript_path": transcript_path
                })

    # 随机打乱，避免同一批会话永远轮不到
    random.shuffle(active_sessions)
    return active_sessions

def is_subagent_session(transcript_path):
    """快速流式判别是否为系统/子代理派发的会话"""
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                obj = json.loads(line)
                if obj.get('type') == 'USER_INPUT' and obj.get('source') == 'SYSTEM':
                    return True
                break
    except Exception:
        pass
    return False

def extract_subagent_report(transcript_path):
    """
    扫描子代理会话日志，抓取结构化的 remora_subagent_report JSON 块
    """
    changed_files, referenced_files = [], []
    if not os.path.exists(transcript_path):
        return changed_files, referenced_files
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                obj = json.loads(line)
                content = obj.get('content', '')
                if content and "remora_subagent_report" in content:
                    match = re.search(r'\{.*?"remora_subagent_report".*\}', content, re.DOTALL)
                    if match:
                        data = json.loads(match.group(0))
                        report = data.get("remora_subagent_report", {})
                        changed_files = report.get("changed_files", [])
                        referenced_files = report.get("referenced_files", [])
                        break
    except Exception:
        pass
    return changed_files, referenced_files
