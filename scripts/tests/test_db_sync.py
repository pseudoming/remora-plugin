import os
import sys
import sqlite3
import pytest
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'sidecars', 'memory-compactor')))

import lib.dao as dao
import lib.paths as paths

TEST_DB_PATH = "/tmp/test_remora_db_sync.db"

@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    monkeypatch.setattr(paths, "get_db_path", lambda: TEST_DB_PATH)
    from schema import schema_init
    monkeypatch.setattr(schema_init, "DB_PATH", TEST_DB_PATH)
    monkeypatch.setattr(schema_init, "DATA_DIR", "/tmp")

    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        pass
        
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                CREATE TABLE session_state (
                    session_id TEXT PRIMARY KEY,
                    mode TEXT DEFAULT 'standard',
                    is_cold_start INTEGER DEFAULT 1,
                    updated_at DATETIME
                );
                CREATE TABLE watermarks (
                    conversation_id TEXT PRIMARY KEY,
                    project_uuid TEXT,
                    last_msg_id INTEGER DEFAULT 0,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE project_topics (
                    uuid TEXT,
                    topic_id TEXT,
                    status TEXT DEFAULT 'open',
                    summary TEXT,
                    source TEXT DEFAULT 'auto',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    compression_confidence REAL DEFAULT 1.0,
                    associated_files TEXT,
                    referenced_files TEXT,
                    PRIMARY KEY(uuid, topic_id)
                );
                CREATE TABLE topic_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_uuid TEXT,
                    topic_id TEXT,
                    conversation_id TEXT,
                    decision TEXT,
                    rationale TEXT,
                    evidence_msg_ids TEXT,
                    user_confirmed INTEGER DEFAULT 0,
                    decision_type TEXT DEFAULT 'approved',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
            """)

    yield
    
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        pass


def test_compactor_db_sync(monkeypatch):
    import lib.conversation
    def mock_stream(self, start_idx=0):
        yield {"step_index": 1, "type": "USER_INPUT", "source": "user", "content": "Hello", "timestamp": "2026-06-04T12:00:00Z"}
        yield {"step_index": 2, "type": "PLANNER_RESPONSE", "source": "agent", "content": "Hi", "timestamp": "2026-06-04T12:00:01Z"}
    monkeypatch.setattr(lib.conversation.ConversationDataAccessLayer, "stream_steps_forward", mock_stream)
    
    # Run warm_storage_sync
    import warm_storage_sync
    session = {
        'project_uuid': 'p1',
        'conversation_id': 'c1'
    }
    
    with sqlite3.connect(TEST_DB_PATH, timeout=15) as conn:
        key_content, current_msg_id, last_msg_id = warm_storage_sync.read_incremental_logs(conn, session)
        
        # Verify messages table populated
        messages = conn.execute("SELECT id, line_number FROM messages").fetchall()
        assert len(messages) == 2
        assert messages[0][1] == 1
        assert messages[1][1] == 2
        
        # Verify watermark table
        watermarks = conn.execute("SELECT last_msg_id FROM watermarks WHERE conversation_id='c1'").fetchall()
        assert watermarks[0] == (0,)
    
        # Mock LLM data mapping back
        # Let's mock a decision using line 1
        d = {
            'decision': 'd1',
            'rationale': 'r1',
            'evidence_msg_ids': [1]
        }
        t = {
            'topic_id': 't1',
            'summary': 's1',
            'decisions': [d]
        }
        
        # Run the single-track snippet directly since extract_decisions invokes LLM
        evidence_msg_ids = d.get('evidence_msg_ids', [])

        conn.execute(
            """INSERT INTO topic_decisions
               (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session['project_uuid'], t.get('topic_id', ''),
             session['conversation_id'], d.get('decision', ''),
             d.get('rationale', ''),
             json.dumps(evidence_msg_ids),
             0))
             
        # Also update watermark
        # Let's say current_msg_id is 2
        conn.execute(
            "UPDATE watermarks SET last_msg_id=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
            (current_msg_id, session['project_uuid'], session['conversation_id']))
            
        conn.commit()

        decisions = conn.execute("SELECT evidence_msg_ids FROM topic_decisions").fetchall()
        assert len(decisions) == 1
        assert decisions[0][0] == "[1]"

        watermarks = conn.execute("SELECT last_msg_id FROM watermarks WHERE conversation_id='c1'").fetchall()
        assert watermarks[0] == (2,)


def test_sync_artifacts_file_changes_artifact():
    from unittest.mock import patch, MagicMock
    import sync_artifacts

    conv_id = "aaa-bbb-ccc-ddd-eee"
    mock_conn = MagicMock()
    mock_conn.execute.return_value.fetchone.return_value = None
    mock_insert = MagicMock()

    with patch("sync_artifacts.insert_file_change", mock_insert, create=True), \
         patch("sync_artifacts.extract_conv_id", return_value=conv_id, create=True), \
         patch("sync_artifacts.calculate_md5", return_value="new_hash"), \
         patch("os.path.exists", return_value=True), \
         patch("builtins.open", create=True), \
         patch("sqlite3.connect", return_value=mock_conn):
        sync_artifacts.scan_and_ingest_artifacts({
            "artifactDirectoryPath": "/fake/artifacts",
            "transcriptPath": f"/home/agent/.gemini/antigravity/brain/{conv_id}/logs/transcript.jsonl"
        })

        call_filenames = {c.args[2] for c in mock_insert.call_args_list}
        assert "implementation_plan.md" in call_filenames
        assert "walkthrough.md" in call_filenames
        assert all(c.args[3] == "artifact" for c in mock_insert.call_args_list)


def test_sync_artifacts_file_changes_no_transcript():
    from unittest.mock import patch, MagicMock
    import sync_artifacts

    mock_conn = MagicMock()
    mock_conn.execute.return_value.fetchone.return_value = None
    mock_insert = MagicMock()

    with patch("sync_artifacts.insert_file_change", mock_insert, create=True), \
         patch("sync_artifacts.calculate_md5", return_value="new_hash"), \
         patch("os.path.exists", return_value=True), \
         patch("builtins.open", create=True), \
         patch("sqlite3.connect", return_value=mock_conn):
        sync_artifacts.scan_and_ingest_artifacts({
            "artifactDirectoryPath": "/fake/artifacts"
        })

        for c in mock_insert.call_args_list:
            assert c.args[3] != "artifact"
