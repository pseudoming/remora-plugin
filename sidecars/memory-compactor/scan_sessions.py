import os
import sys
import json
import time
import random
import re
import subprocess

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DATA_DIR
from lib.conversation import ConversationDataAccessLayer

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
    import shutil
    if not shutil.which("agentapi"):
        return "unknown"
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

        cdal = ConversationDataAccessLayer(conv_id)
        if os.path.exists(cdal.db_path):
            mtime = cdal.get_db_mtime()
            if current_time - mtime <= 2 * 24 * 3600:
                project_uuid = get_project_id(conv_id)
                active_sessions.append({
                    "project_uuid": project_uuid,
                    "conversation_id": conv_id,
                    "db_path": cdal.db_path
                })

    # 随机打乱，避免同一批会话永远轮不到
    random.shuffle(active_sessions)
    return active_sessions

def is_subagent_session(conv_id):
    """快速流式判别是否为系统/子代理派发的会话"""
    try:
        cdal = ConversationDataAccessLayer(conv_id)
        for step in cdal.stream_steps_forward():
            if step.get('type') == 'USER_INPUT' and step.get('source') == 'SYSTEM':
                return True
            break
    except Exception:
        pass
    return False

def extract_subagent_report(conv_id):
    """
    扫描子代理会话日志，抓取结构化的 remora_subagent_report JSON 块
    """
    changed_files, referenced_files = [], []
    try:
        cdal = ConversationDataAccessLayer(conv_id)
        # Search backwards since reports are usually at the end
        for step in cdal.stream_steps_reverse(limit=100):
            content = step.get('content', '')
            if content and "remora_subagent_report" in content:
                match = re.search(r'\{.*?"remora_subagent_report".*\}', content, re.DOTALL)
                if match:
                    data = json.loads(match.group(0))
                    report = data.get("remora_subagent_report", {})
                    changed_files = report.get("changed_files", [])
                    referenced_files = report.get("referenced_files", [])
                    return changed_files, referenced_files
    except Exception:
        pass
    return changed_files, referenced_files
