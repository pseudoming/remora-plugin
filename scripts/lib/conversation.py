import os
import json
import sqlite3
from typing import Optional, List, Dict, Any, Generator

class ConversationDataAccessLayer:
    """
    CDAL: Conversation Data Access Layer
    A centralized facade for accessing Antigravity conversation history and metadata.
    Currently implements a hybrid CQRS transition strategy:
    - 0-latency operations (like status=5 check) use SQLite directly.
    - Legacy history parsing still uses transcript.jsonl (with Ghost Delay) until protobuf decoding is cracked.
    """
    
    def __init__(self, conv_id: str):
        self.conv_id = conv_id
        home_dir = os.environ.get("HOME", os.path.expanduser("~"))
        self.brain_dir = os.path.join(home_dir, ".gemini", "antigravity", "brain")
        
        # [SSOT] Zero-latency synchronous database
        self.db_path = os.path.join(home_dir, ".gemini", "antigravity", "conversations", f"{conv_id}.db")
        
        # [SINK] Asynchronous batched log (Ghost Delay prone)
        self.transcript_path = os.path.join(self.brain_dir, conv_id, ".system_generated", "logs", "transcript.jsonl")

    # ---------------------------------------------------------
    # 1. 0-Latency Native SQLite Queries (Strong Consistency)
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
            with closing(sqlite3.connect(self.db_path, timeout=15.0)) as conn:
                with conn:
                    cursor = conn.cursor()
                    cursor.execute("SELECT MAX(idx) FROM steps WHERE status = 5;")
                    row = cursor.fetchone()
                    return row[0] if row and row[0] is not None else -1
        except Exception:
            return -1

    # ---------------------------------------------------------
    # 2. Legacy JSONL Queries (Asynchronous, High Latency)
    # ---------------------------------------------------------
    
    def stream_transcript_reverse(self) -> Generator[str, None, None]:
        """
        Yields raw lines from the transcript.jsonl in reverse order (bottom to top).
        Used by action-gate and others to quickly find recent actions.
        """
        if not os.path.exists(self.transcript_path):
            return
            
        # Standard robust reverse file reading block
        with open(self.transcript_path, "rb") as f:
            f.seek(0, 2)
            position = f.tell()
            buffer = bytearray()
            while position >= 0:
                f.seek(position)
                char = f.read(1)
                if char == b'\n' and buffer:
                    line = buffer[::-1].decode("utf-8", errors="replace")
                    if line.strip():
                        yield line
                    buffer = bytearray()
                else:
                    if char != b'\n':
                        buffer.extend(char)
                position -= 1
                
            if buffer:
                line = buffer[::-1].decode("utf-8", errors="replace")
                if line.strip():
                    yield line

    def get_latest_user_message(self) -> Optional[str]:
        """
        Extracts the most recent USER_INPUT message content.
        Currently relies on transcript.jsonl.
        """
        for line in self.stream_transcript_reverse():
            try:
                step = json.loads(line)
                if step.get("type") == "USER_INPUT":
                    content = step.get("content", "")
                    # Optionally filter out system injected metadata tags here if needed
                    return content
            except json.JSONDecodeError:
                continue
        return None

    def get_latest_planner_response(self) -> Optional[str]:
        """
        Extracts the most recent PLANNER_RESPONSE text.
        """
        for line in self.stream_transcript_reverse():
            try:
                step = json.loads(line)
                if step.get("type") == "PLANNER_RESPONSE":
                    return step.get("content", "")
            except json.JSONDecodeError:
                continue
        return None
        
    def stream_history(self, start_idx: int = 0) -> Generator[Dict[str, Any], None, None]:
        """
        Yields parsed step dicts from the transcript in chronological order.
        Used by extract_decisions.py for full history sweeps.
        """
        if not os.path.exists(self.transcript_path):
            return
            
        with open(self.transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    step = json.loads(line)
                    if step.get("step_index", 0) >= start_idx:
                        yield step
                except json.JSONDecodeError:
                    continue
