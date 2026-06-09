import re
from datetime import datetime, timezone
from typing import List, Optional, Set, Tuple, Union

RELAX_PATTERN = r'(草稿|想法|讨论|draft|brainstorm|discuss)'

def clean_system_reminders(text: str) -> str:
    return re.sub(r'<system-reminder>.*?</system-reminder>', '', text, flags=re.DOTALL)


def detect_mode(clean_msg: str, relax_keywords: Optional[List[str]] = None, alert_keywords: Optional[List[str]] = None) -> tuple:
    mode = "strict"
    matched_word = None

    if relax_keywords:
        for kw in relax_keywords:
            if kw.lower() in clean_msg.lower():
                mode = "relax"
                break
    elif re.search(RELAX_PATTERN, clean_msg, re.IGNORECASE):
        mode = "relax"

    if alert_keywords:
        for kw in alert_keywords:
            if kw.lower() in clean_msg.lower():
                mode = "alert"
                matched_word = kw
                break

    return mode, matched_word


def parse_sqlite_timestamp(ts_val) -> float:
    if ts_val is None:
        return 0.0
    if isinstance(ts_val, (int, float)):
        return float(ts_val)

    ts_str = str(ts_val).strip()
    try:
        return float(ts_str)
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            clean_str = ts_str.split('+')[0].split('Z')[0]
            dt = datetime.strptime(clean_str, fmt)
            return dt.replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue

    return 0.0


def find_all_uuids(val, parent_id):
    uuids = set()
    if isinstance(val, str):
        matches = re.findall(r'\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b', val)
        for m in matches:
            if m != parent_id:
                uuids.add(m)
    elif isinstance(val, dict):
        for k, v in val.items():
            if k in ("conversationId", "conversation_id") and isinstance(v, str):
                if v != parent_id:
                    uuids.add(v)
            else:
                uuids.update(find_all_uuids(v, parent_id))
    elif isinstance(val, (list, tuple)):
        for item in val:
            uuids.update(find_all_uuids(item, parent_id))
    return uuids


def judge_zombie(idle_seconds: int, tool_name: str, heavy_tools=None) -> Tuple[bool, int]:
    is_heavy = tool_name in (heavy_tools or frozenset())
    limit = 180 if is_heavy else 60
    is_zombie = idle_seconds > limit
    return (is_zombie, limit)


def suggest_zombie_action(retry_count: int) -> str:
    """Return action suggestion based on retry exhaustion threshold."""
    return "kill_and_retry" if retry_count < 2 else "escalate_to_human"


def format_timestamp(ts_str):
    if not ts_str:
        import time
        return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    ts_str = ts_str.replace('T', ' ').replace('Z', '')
    return ts_str[:19]

def is_timer_canceled(last_subagent_activity_index, latest_schedule_index):
    return (last_subagent_activity_index != -1 and
            (latest_schedule_index == -1 or last_subagent_activity_index < latest_schedule_index))
