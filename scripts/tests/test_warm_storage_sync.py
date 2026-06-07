import os
import sys
import sqlite3
import pytest
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sidecars', 'memory-compactor')))
from warm_storage_sync import read_incremental_logs

TEST_DB_PATH = "/tmp/test_warm_storage_sync.db"

@pytest.fixture(autouse=True)
def setup_db():
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        
    # Initialize the schema
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                CREATE TABLE watermarks (
                    conversation_id TEXT PRIMARY KEY,
                    project_uuid TEXT,
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
                    evidence_msg_ids TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    from adapter.bridge.conversation import ConversationDataAccessLayer
    def mock_stream(self, start_idx=0):
        for i in range(1, 11):
            yield {"step_index": i, "type": "USER_INPUT", "content": f"msg {i}", "source": "USER", "timestamp": "2026-06-04T00:00:00Z"}
    monkeypatch.setattr(ConversationDataAccessLayer, "stream_steps_forward", mock_stream)
    
    # Mock initial DB state (processed up to 5)
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj1', 'conv1', 5)")
            for i in range(1, 6):
                conn.execute("INSERT INTO messages (id, conversation_id, line_number, content) VALUES (?, 'conv1', ?, ?)", (i, i, f"msg {i}"))
                
    session = {
        'project_uuid': 'proj1',
        'conversation_id': 'conv1'
    }
    
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
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


def test_proto_role_parsing(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts')))
    from adapter.bridge.conversation import ConversationDataAccessLayer
    from lib.proto_decoder import extract_step_payload

    # Test raw decoding function directly first
    # 1. User role: tag 5 -> tag 3 -> 4
    blob_user = b'\x2a\x02\x18\x04'
    entry_user = extract_step_payload(blob_user)
    assert entry_user.get('role') == 'user'

    # 2. Model role: tag 5 -> tag 3 -> 2
    blob_model = b'\x2a\x02\x18\x02'
    entry_model = extract_step_payload(blob_model)
    assert entry_model.get('role') == 'model'

    # 3. System role: tag 5 -> tag 3 -> 5
    blob_system = b'\x2a\x02\x18\x05'
    entry_system = extract_step_payload(blob_system)
    assert entry_system.get('role') == 'system'

    # 4. Unknown role: tag 5 -> tag 3 -> 9
    blob_unknown = b'\x2a\x02\x18\x09'
    entry_unknown = extract_step_payload(blob_unknown)
    assert entry_unknown.get('role') == 'unknown_9'

    # Now verify end-to-end integration with read_incremental_logs
    def mock_stream(self, start_idx=0):
        # Yield one user step and one model step using the serialized blobs
        yield {"step_index": 1, "type": "USER_INPUT", "content": "user query", "timestamp": "2026-06-04T00:00:00Z", "role": "user"}
        yield {"step_index": 2, "type": "PLANNER_RESPONSE", "content": "model response", "timestamp": "2026-06-04T00:00:01Z", "role": "model"}
    monkeypatch.setattr(ConversationDataAccessLayer, "stream_steps_forward", mock_stream)

    session = {
        'project_uuid': 'proj2',
        'conversation_id': 'conv2'
    }

    with sqlite3.connect(TEST_DB_PATH, timeout=15) as conn:
        key_content, current_msg_id, last_msg_id = read_incremental_logs(conn, session)
        
        # Verify both messages are in the DB and roles are preserved
        rows = conn.execute("SELECT role, content FROM messages WHERE conversation_id='conv2' ORDER BY line_number ASC").fetchall()
        assert len(rows) == 2
        assert rows[0][0] == 'user'
        assert rows[0][1] == 'user query'
        assert rows[1][0] == 'model'
        assert rows[1][1] == 'model response'
