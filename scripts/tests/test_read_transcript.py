import os
import sys
import sqlite3
import pytest
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sidecars', 'memory-compactor')))
from read_transcript import read_incremental_logs

TEST_DB_PATH = "/tmp/test_read_transcript.db"

@pytest.fixture(autouse=True)
def setup_db():
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        
    # Initialize the schema
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.executescript("""
                CREATE TABLE watermarks (
                    conversation_id TEXT PRIMARY KEY,
                    project_uuid TEXT,
                    last_line_processed INTEGER DEFAULT 0,
                    last_msg_id INTEGER DEFAULT 0,
                    last_updated DATETIME
                );
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT,
                    topic_id TEXT,
                    role TEXT,
                    content TEXT,
                    line_number INTEGER,
                    timestamp DATETIME
                );
                CREATE TABLE topic_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT,
                    created_at_msg_id INTEGER
                );
                CREATE TABLE remora_event_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_uuid TEXT,
                    status TEXT
                );
            """)
    
    yield
    
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)

def test_cursor_resume(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts')))
    import lib.conversation
    def mock_stream(self, start_idx=0):
        for i in range(1, 11):
            yield {"step_index": i, "type": "USER_INPUT", "content": f"msg {i}", "source": "USER", "timestamp": "2026-06-04T00:00:00Z"}
    monkeypatch.setattr(lib.conversation.ConversationDataAccessLayer, "stream_steps_forward", mock_stream)
    
    # Mock initial DB state (processed up to 5)
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.execute("INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj1', 'conv1', 5)")
            for i in range(1, 6):
                conn.execute("INSERT INTO messages (id, conversation_id, line_number, content) VALUES (?, 'conv1', ?, ?)", (i, i, f"msg {i}"))
                
    session = {
        'project_uuid': 'proj1',
        'conversation_id': 'conv1'
    }
    
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        # execute
        key_content, current_msg_id, last_msg_id = read_incremental_logs(conn, session)
        
        # Assertions
        assert last_msg_id == 5
        assert current_msg_id == 10
        # verify only 6-10 are returned
        assert "[msg_6] msg 6" in key_content
        assert "[msg_10] msg 10" in key_content
        assert "[msg_1]" not in key_content
        assert "[msg_5]" not in key_content
        
        # Check messages table
        count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        assert count == 10
