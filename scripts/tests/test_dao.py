import os
import sqlite3
import pytest
import sys

# Ensure lib is importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import lib.dao as dao
import lib.paths as paths

TEST_DB_PATH = "/tmp/test_remora_dao.db"

@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    monkeypatch.setattr(dao, "get_db_path", lambda: TEST_DB_PATH)
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        
    # Initialize the schema for testing
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
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
                    last_updated DATETIME
                );
                CREATE TABLE project_topics (
                    uuid TEXT,
                    topic_id TEXT,
                    status TEXT DEFAULT 'open',
                    summary TEXT,
                    source TEXT DEFAULT 'auto',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY(uuid, topic_id)
                );
                CREATE TABLE topic_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_uuid TEXT,
                    topic_id TEXT,
                    conversation_id TEXT,
                    decision TEXT,
                    rationale TEXT,
                    associated_files TEXT,
                    evidence_msg_ids TEXT,
                    user_confirmed INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
                CREATE VIRTUAL TABLE messages_fts USING fts5(content, content_rowid='id');
            """)
    
    yield
    
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)

def test_session_state_operations():
    # Test read/write mode
    assert dao.read_mode("session_1") == "standard"
    dao.write_mode("session_1", "relax")
    assert dao.read_mode("session_1") == "relax"
    
    # Test cold start
    latest = dao.get_latest_session()
    assert latest is not None
    assert latest[0] == "session_1"
    assert latest[1] == 1 # is_cold_start defaults to 1 when inserted
    
    dao.update_cold_start("session_1", 0)
    latest = dao.get_latest_session()
    assert latest[1] == 0
    
    # Test delete
    dao.delete_session("session_1")
    assert dao.get_latest_session() is None

def test_watermark_operations():
    assert dao.get_project_uuid_by_conv("conv_1") is None
    
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.execute("INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1')")
        
    assert dao.get_project_uuid_by_conv("conv_1") == "proj_1"

def test_topic_operations():
    assert dao.get_active_topic("proj_1") is None
    
    dao.create_or_update_topic("proj_1", "topic_A", "My Topic A")
    assert dao.get_active_topic("proj_1") == "topic_A"
    
    # Updating same topic
    dao.create_or_update_topic("proj_1", "topic_A", "My Topic A updated")
    topics = dao.get_topics_by_uuid("proj_1")
    assert len(topics) == 1
    assert topics[0][2] == "My Topic A updated"
    
    # Updating with empty summary should not overwrite
    dao.create_or_update_topic("proj_1", "topic_A", "")
    topics = dao.get_topics_by_uuid("proj_1")
    assert topics[0][2] == "My Topic A updated"
    
    # Closing topic
    dao.close_topic("proj_1", "topic_A")
    assert dao.get_active_topic("proj_1") is None
    topics = dao.get_topics_by_uuid("proj_1")
    assert topics[0][1] == "closed"

def test_decision_operations():
    # Insert some test data
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO messages (id, conversation_id, content) VALUES (1, 'c1', 'Evidence for python');
                INSERT INTO messages (id, conversation_id, content) VALUES (2, 'c1', 'Evidence for rust');

                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, associated_files, evidence_msg_ids)
                VALUES ('proj_1', 'topic_A', 'Use python', 'It is fast to write', 1, '[{"file": "main.py"}]', '[1]');
            
                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, associated_files, evidence_msg_ids)
                VALUES ('proj_1', 'topic_A', 'Use rust', 'It is memory safe', 0, '[{"file": "main.rs"}]', '[2]');
            """)
        
    decisions = dao.get_confirmed_decisions("proj_1", "topic_A")
    assert len(decisions) == 1
    assert decisions[0]["text"] == "Use python (原因: It is fast to write)"
    assert decisions[0]["files"] == ["main.py"]
    # Evidence fetched natively through message.id
    assert decisions[0]["evidence"] == "Evidence for python"

def test_fts5_recall_operations():
    # Setup test data
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1');
            
                INSERT INTO messages (id, conversation_id, topic_id, role, content) VALUES (1, 'conv_1', 'topic_A', 'user', 'hello world 202606606');
                INSERT INTO messages_fts (rowid, content) VALUES (1, 'hello world 202606606');
            
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) 
                VALUES ('proj_1', 'conv_1', 'topic_A', 'Log correctly', 'Need logs to debug 202606606', '[1]');
            """)

    # test recall_fts5_logs
    logs = dao.recall_fts5_logs("proj_1", "conv_1", "202606606")
    assert len(logs) == 1
    assert logs[0] == "user: hello world 202606606"
    
    # test recall_decisions_by_fts5_topic
    decisions = dao.recall_decisions_by_fts5_topic("proj_1", "conv_1", "202606606")
    assert len(decisions) == 1
    assert "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]" in decisions[0]
    
    # test recall_decisions_by_like
    like_decisions = dao.recall_decisions_by_like("proj_1", "conv_1", "202606606")
    assert len(like_decisions) == 1
    assert "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]" in like_decisions[0]
    
    # test touch_topics
    # first fetch last_accessed
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.execute("INSERT INTO project_topics (uuid, topic_id, last_accessed_at) VALUES ('proj_1', 'topic_A', '2000-01-01 00:00:00')")
    
    dao.touch_topics_accessed_by_recall("proj_1", "conv_1", "202606606")
    
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            row = conn.execute("SELECT last_accessed_at FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            assert row[0] != '2000-01-01 00:00:00'

def test_topic_garbage_collection():
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.executescript("""
                -- Topic 1: Old last_accessed_at, but recent messages -> Should NOT be deleted
                INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't1', 'closed', 'auto', '2000-01-01 00:00:00');
                INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't1', 0, datetime('now', '-1 hours'));
                
                -- Topic 2: Old last_accessed_at, old messages -> Should be deleted
                INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't2', 'closed', 'auto', '2000-01-01 00:00:00');
                INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't2', 0, datetime('now', '-80 hours'));
                
                -- Topic 3: Old last_accessed_at, old messages, but has user_confirmed=1 -> Should NOT be deleted
                INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't3', 'closed', 'auto', '2000-01-01 00:00:00');
                INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't3', 1, datetime('now', '-80 hours'));
            """)
    
    dao.run_topic_garbage_collection()

    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        topics = conn.execute("SELECT topic_id FROM project_topics ORDER BY topic_id").fetchall()
        assert len(topics) == 2
        
        # Verify topic_decisions for deleted topic t2 is also deleted
        t2_decisions = conn.execute("SELECT 1 FROM topic_decisions WHERE topic_id='t2'").fetchall()
        assert len(t2_decisions) == 0
        
        # Verify other topic decisions still exist
        t1_decisions = conn.execute("SELECT 1 FROM topic_decisions WHERE topic_id='t1'").fetchall()
        assert len(t1_decisions) == 1
        assert topics[0][0] == 't1'
        assert topics[1][0] == 't3'

def test_prune_expired_watermarks(tmp_path):
    brain_dir = str(tmp_path)
    import os
    
    # Active folder
    os.makedirs(os.path.join(brain_dir, 'c1'))
    
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        with conn:
            conn.executescript("""
                -- c1: Folder exists, recent messages, active -> NO DELETE
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c1', 1, datetime('now', '-1 hours'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'c1', datetime('now', '-1 hours'));
                INSERT INTO session_state (session_id) VALUES ('c1');
                INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c1', 't1');
                
                -- c2: Folder missing -> DELETE
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c2', 2, datetime('now', '-1 hours'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (2, 'c2', datetime('now', '-1 hours'));
                INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c2', 't2');
                
                -- c3: Folder exists, old messages, inactive -> DELETE
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c3', 3, datetime('now', '-40 days'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (3, 'c3', datetime('now', '-40 days'));
                INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c3', 't3');
                
                -- c4: Folder exists, old messages, but active session -> NO DELETE
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c4', 4, datetime('now', '-40 days'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (4, 'c4', datetime('now', '-40 days'));
                INSERT INTO session_state (session_id) VALUES ('c4');
                INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c4', 't4');
            """)
            
    os.makedirs(os.path.join(brain_dir, 'c3'))
    os.makedirs(os.path.join(brain_dir, 'c4'))
    
    dao.prune_expired_watermarks(brain_dir)
    
    with closing(sqlite3.connect(TEST_DB_PATH)) as conn:
        watermarks = conn.execute("SELECT conversation_id FROM watermarks ORDER BY conversation_id").fetchall()
        assert len(watermarks) == 2
        assert watermarks[0][0] == 'c1'
        assert watermarks[1][0] == 'c4'
        
        # Verify messages for deleted watermarks are also deleted
        messages = conn.execute("SELECT conversation_id FROM messages ORDER BY conversation_id").fetchall()
        assert len(messages) == 2
        assert messages[0][0] == 'c1'
        assert messages[1][0] == 'c4'
        
        # Verify topic_decisions for deleted watermarks are also deleted
        decisions = conn.execute("SELECT conversation_id FROM topic_decisions ORDER BY conversation_id").fetchall()
        assert len(decisions) == 2
        assert decisions[0][0] == 'c1'
        assert decisions[1][0] == 'c4'
