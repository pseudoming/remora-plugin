import os
import json
import sqlite3
from typing import Optional, List, Dict, Any, Generator

from .proto_decoder import extract_step_payload

class ConversationDataAccessLayer:
    """
    CDAL: Conversation Data Access Layer
    A centralized facade for accessing Antigravity conversation history and metadata.
    Currently implements a hybrid CQRS transition strategy:
    - 0-latency operations (like status=5 check) use SQLite directly.
    - All JSONL reads have been physically replaced by zero-latency SQLite blob decoding.
    """
    
    def __init__(self, conv_id: str):
        self.conv_id = conv_id
        home_dir = os.environ.get("HOME", os.path.expanduser("~"))
        self.brain_dir = os.path.join(home_dir, ".gemini", "antigravity", "brain")
        
        # [SSOT] Zero-latency synchronous database
        self.db_path = os.path.join(home_dir, ".gemini", "antigravity", "conversations", f"{conv_id}.db")

    # ---------------------------------------------------------
    # 1. Database Metadata
    # ---------------------------------------------------------
    
    def get_compaction_watermark(self) -> int:
        """
        [SSOT] Probe the latest compaction boundary.
        Returns the maximum idx of steps that have been compacted (status=5).
        Returns -1 if no DB exists or no compacted steps exist.
        """
        if not os.path.exists(self.db_path):
            return -1
        try:
            from contextlib import closing
            with closing(sqlite3.connect(self.db_path, timeout=15)) as conn:
                with conn:
                    cursor = conn.cursor()
                    cursor.execute("SELECT MAX(idx) FROM steps WHERE status = 5;")
                    row = cursor.fetchone()
                    return row[0] if row and row[0] is not None else -1
        except Exception:
            return -1

    def get_max_step_index(self) -> int:
        """
        Returns the max step index in the DB.
        """
        if not os.path.exists(self.db_path):
            return 0
        try:
            from contextlib import closing
            with closing(sqlite3.connect(self.db_path, timeout=15)) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT MAX(idx) FROM steps")
                row = cursor.fetchone()
                return row[0] if row and row[0] is not None else 0
        except Exception:
            return 0

    def get_db_mtime(self) -> float:
        """
        Returns the modification time of the SQLite database.
        Used for high-frequency zombie/idle detection without Ghost Delay.
        """
        if os.path.exists(self.db_path):
            return os.path.getmtime(self.db_path)
        return 0.0

    # ---------------------------------------------------------
    # 2. Native SQLite Payload Extraction
    # ---------------------------------------------------------
    
    def stream_steps_reverse(self, limit: int = 1000) -> Generator[Dict[str, Any], None, None]:
        """
        Yields parsed step dicts from the SQLite steps table in reverse order (DESC).
        Replaces legacy JSONL stream_transcript_reverse.
        """
        if not os.path.exists(self.db_path):
            return
            
        try:
            from contextlib import closing
            with closing(sqlite3.connect(self.db_path, timeout=15)) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT idx, step_payload FROM steps ORDER BY idx DESC LIMIT ?", (limit,))
                for row in cursor:
                    idx, blob = row
                    entry = extract_step_payload(blob)
                    entry['step_index'] = idx
                    # Some clients check 'step_type' from DB rather than parsed 'type'
                    yield entry
        except Exception:
            return

    def stream_steps_forward(self, start_idx: int = 0) -> Generator[Dict[str, Any], None, None]:
        """
        Yields parsed step dicts in chronological order.
        Replaces legacy JSONL stream_history.
        """
        if not os.path.exists(self.db_path):
            return
            
        try:
            from contextlib import closing
            with closing(sqlite3.connect(self.db_path, timeout=15)) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT idx, step_payload FROM steps WHERE idx >= ? ORDER BY idx ASC", (start_idx,))
                for row in cursor:
                    idx, blob = row
                    entry = extract_step_payload(blob)
                    entry['step_index'] = idx
                    yield entry
        except Exception:
            return

    def get_latest_user_message(self) -> Optional[str]:
        """
        Extracts the most recent USER_INPUT message content.
        """
        for step in self.stream_steps_reverse(limit=50):
            if step.get("type") == "USER_INPUT":
                return step.get("content", "")
        return None

    def get_latest_planner_response(self) -> Optional[str]:
        """
        Extracts the most recent PLANNER_RESPONSE text.
        """
        for step in self.stream_steps_reverse(limit=50):
            if step.get("type") == "PLANNER_RESPONSE":
                return step.get("content", "")
        return None

    def get_current_turn_idx(self) -> int:
        """
        [SSOT] Returns the idx of the latest USER_INPUT step, representing the current Turn ID.
        """
        for step in self.stream_steps_reverse(limit=1000):
            if step.get("type") == "USER_INPUT":
                return step.get("step_index", 0)
        return 0

    def get_user_input_count(self) -> int:
        """
        Returns the total number of USER_INPUT steps in the conversation.
        """
        count = 0
        for step in self.stream_steps_forward():
            if step.get("type") == "USER_INPUT":
                count += 1
        return count

