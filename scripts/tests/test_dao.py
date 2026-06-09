import os
import sqlite3
import pytest

from core.storage.connection import check_db_exists
from core.storage.decisions import confirm_decision, get_confirmed_decisions, get_topic_id_by_decision
from core.storage.file_changes import get_decisions_by_file, get_files_by_topic, insert_file_change
from core.storage.maintenance import prune_expired_watermarks, run_topic_garbage_collection
from core.storage.recall import recall_decisions_by_fts5_topic, recall_decisions_by_like, recall_fts5_logs, touch_topics_accessed_by_recall
from core.storage.runtime_state import delete_hook_state, delete_runtime_hook_value, get_hook_state, get_runtime_hook_value, set_hook_state, set_runtime_hook_value, trim_hook_states, trim_runtime_hook_states
from core.storage.sessions import force_cold_start_latest_session, get_latest_session, read_mode, update_cold_start, write_mode
from core.storage.topics import close_topic, create_or_update_topic, get_active_topic, get_topics_by_uuid, merge_physical_files_to_topic, switch_topic, touch_topic_source_manual
from core.storage.watermarks import get_project_uuid_by_conv
import core.gate as gate
import core.storage.connection as conn_module

TEST_DB_PATH = "/tmp/test_remora_dao.db"

@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    monkeypatch.setattr(conn_module, "get_db_path", lambda: TEST_DB_PATH)
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
        
    # Initialize the schema for testing
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
                    last_updated DATETIME
                );
                CREATE TABLE project_topics (
                    uuid TEXT,
                    topic_id TEXT,
                    status TEXT DEFAULT 'open',
                    summary TEXT,
                    source TEXT DEFAULT 'auto',
                    associated_files TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
                    evidence_msg_ids TEXT,
                    user_confirmed INTEGER DEFAULT 0,
                    decision_type TEXT DEFAULT 'approved',
                    injected_count INTEGER DEFAULT 0,
                    last_injected_at TEXT,
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
                CREATE VIRTUAL TABLE messages_fts USING fts5(content, content_rowid='id');
                CREATE TABLE runtime_hook_state (
                    session_id TEXT NOT NULL,
                    turn_idx INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT,
                    PRIMARY KEY(session_id, turn_idx, key)
                );
                CREATE TABLE IF NOT EXISTS file_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_uuid TEXT,
                    conversation_id TEXT,
                    file_name TEXT,
                    source TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(conversation_id, file_name)
                );
            """)
    
    yield
    
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)

def test_session_state_operations():
    # Test read/write mode
    assert read_mode("session_1") == "standard"
    write_mode("session_1", "relax")
    assert read_mode("session_1") == "relax"
    
    # Test cold start
    latest = get_latest_session()
    assert latest is not None
    assert latest[0] == "session_1"
    assert latest[1] == 1 # is_cold_start defaults to 1 when inserted
    
    update_cold_start("session_1", 0)
    latest = get_latest_session()
    assert latest[1] == 0

def test_watermark_operations():
    assert get_project_uuid_by_conv("conv_1") is None
    
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1')")
        
    assert get_project_uuid_by_conv("conv_1") == "proj_1"

def test_topic_operations():
    assert get_active_topic("proj_1") is None
    
    create_or_update_topic("proj_1", "topic_A", "My Topic A")
    assert get_active_topic("proj_1") == "topic_A"
    
    # Updating same topic
    create_or_update_topic("proj_1", "topic_A", "My Topic A updated")
    topics = get_topics_by_uuid("proj_1")
    assert len(topics) == 1
    assert topics[0][2] == "My Topic A updated"
    
    # Updating with empty summary should not overwrite
    create_or_update_topic("proj_1", "topic_A", "")
    topics = get_topics_by_uuid("proj_1")
    assert topics[0][2] == "My Topic A updated"
    
    # Closing topic
    close_topic("proj_1", "topic_A")
    assert get_active_topic("proj_1") is None
    topics = get_topics_by_uuid("proj_1")
    assert topics[0][1] == "closed"

def test_decision_operations():
    # Insert some test data
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO messages (id, conversation_id, content) VALUES (1, 'c1', 'Evidence for python');
                INSERT INTO messages (id, conversation_id, content) VALUES (2, 'c1', 'Evidence for rust');

                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids)
                VALUES ('proj_1', 'topic_A', 'Use python', 'It is fast to write', 1, '[1]');
            
                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids)
                VALUES ('proj_1', 'topic_A', 'Use rust', 'It is memory safe', 0, '[2]');
            """)
        
    decisions = get_confirmed_decisions("proj_1", "topic_A")
    assert len(decisions) == 1
    assert decisions[0]["text"] == "Use python (原因: It is fast to write)"
    assert decisions[0]["decision_type"] == "approved"
    assert decisions[0]["evidence"] == "Evidence for python"

def test_fts5_recall_operations():
    # Setup test data
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1');
            
                INSERT INTO messages (id, conversation_id, topic_id, role, content) VALUES (1, 'conv_1', '["topic_A"]', 'user', 'hello world 202606606');
                INSERT INTO messages_fts (rowid, content) VALUES (1, 'hello world 202606606');
            
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) 
                VALUES ('proj_1', 'conv_1', 'topic_A', 'Log correctly', 'Need logs to debug 202606606', '[1]');
            """)

    # test recall_fts5_logs
    logs = recall_fts5_logs("proj_1", "conv_1", "202606606")
    assert len(logs) == 1
    assert logs[0] == "user: hello world 202606606"
    
    # test recall_decisions_by_fts5_topic
    decisions = recall_decisions_by_fts5_topic("proj_1", "conv_1", "202606606")
    assert len(decisions) == 1
    assert "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]" in decisions[0]
    
    # test recall_decisions_by_like
    like_decisions = recall_decisions_by_like("proj_1", "conv_1", "202606606")
    assert len(like_decisions) == 1
    assert "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]" in like_decisions[0]
    
    # test touch_topics
    # first fetch last_accessed
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO project_topics (uuid, topic_id, last_accessed_at) VALUES ('proj_1', 'topic_A', '2000-01-01 00:00:00')")
    
    touch_topics_accessed_by_recall("proj_1", "conv_1", "202606606")
    
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT last_accessed_at FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            assert row[0] != '2000-01-01 00:00:00'

def test_topic_garbage_collection():
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
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
    
    run_topic_garbage_collection()

    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
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
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
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
    
    prune_expired_watermarks(brain_dir)
    
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
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


def test_check_db_exists():
    assert check_db_exists() == True
    os.remove(TEST_DB_PATH)
    assert check_db_exists() == False


def test_switch_topic():
    create_or_update_topic("proj_1", "topic_A", "Topic A")
    assert get_active_topic("proj_1") == "topic_A"
    switch_topic("proj_1", "topic_B")
    assert get_active_topic("proj_1") == "topic_B"
    topics = get_topics_by_uuid("proj_1")
    topic_dict = {t[0]: t[1] for t in topics}
    assert topic_dict["topic_A"] == "closed"
    assert topic_dict["topic_B"] == "open"
    switch_topic("proj_1", "topic_A")
    assert get_active_topic("proj_1") == "topic_A"


def test_force_cold_start_latest_session():
    from contextlib import closing
    write_mode("session_1", "standard")
    write_mode("session_2", "standard")
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("UPDATE session_state SET updated_at = datetime('now', '-1 hours') WHERE session_id = 'session_1'")
    update_cold_start("session_1", 0)
    force_cold_start_latest_session("session_1")
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        row = conn.execute("SELECT is_cold_start FROM session_state WHERE session_id='session_1'").fetchone()
        assert row[0] == 1
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("UPDATE session_state SET updated_at = datetime('now', '-2 hours') WHERE session_id = 'session_1'")
    update_cold_start("session_2", 0)
    force_cold_start_latest_session()
    latest = get_latest_session()
    assert latest[1] == 1
    assert latest[0] == "session_2"


def test_confirm_decision():
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO topic_decisions (id, project_uuid, topic_id, decision) VALUES (1, 'proj_1', 'topic_A', 'test')")
    assert confirm_decision("proj_1", 1) == True
    assert confirm_decision("proj_1", 999) == False


def test_get_topic_id_by_decision():
    from contextlib import closing
    assert get_topic_id_by_decision(1) is None
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO topic_decisions (id, project_uuid, topic_id, decision) VALUES (1, 'proj_1', 'topic_A', 'test')")
    assert get_topic_id_by_decision(1) == "topic_A"


def test_touch_topic_source_manual():
    from contextlib import closing
    create_or_update_topic("proj_1", "topic_A")
    touch_topic_source_manual("proj_1", "topic_A")
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        row = conn.execute("SELECT source FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
        assert row[0] == 'manual'


def test_get_confirmed_decisions_edge_cases():
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO messages (id, conversation_id, content) VALUES (10, 'c1', 'Exists');
                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('proj_1', 'topic_A', 'No files/evidence', 'none', 1);
                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids) VALUES ('proj_1', 'topic_A', 'Bad evidence', 'Wrong format', 1, 'bad-json');
                INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids) VALUES ('proj_1', 'topic_A', 'Missing msg', 'No such msg', 1, '[999]');
            """)
    decisions = get_confirmed_decisions("proj_1", "topic_A")
    assert len(decisions) == 3
    assert decisions[0]["evidence"] == ""
    assert decisions[1]["evidence"] == ""
    assert decisions[2]["evidence"] == ""


def test_recall_decisions_edge_cases():
    from contextlib import closing
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1');
                INSERT INTO messages (id, conversation_id, topic_id, role, content) VALUES (1, 'conv_1', '["topic_A"]', 'user', 'hello world');
                INSERT INTO messages_fts (rowid, content) VALUES (1, 'hello world');
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale) VALUES ('proj_1', 'conv_1', 'topic_A', 'Test decision', 'Test reason');
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Bad evidence', 'Broken', 'not json');
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Missing msg', 'No msg', '[999]');
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Like bad json', 'Test bad json', 'not-json-either');
                INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Like missing', 'Test no msg', '[111]');
            """)
    decisions = recall_decisions_by_fts5_topic("proj_1", "conv_1", "hello")
    assert len(decisions) == 5
    decisions = recall_decisions_by_like("proj_1", "conv_1", "Test")
    assert len(decisions) == 3


def test_merge_physical_files_to_topic():
    import json
    from contextlib import closing
    create_or_update_topic("proj_1", "topic_A")
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("UPDATE project_topics SET associated_files='not-valid-json' WHERE uuid='proj_1' AND topic_id='topic_A'")
    merge_physical_files_to_topic("proj_1", "topic_A", ["/path/to/fallback.py"])
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            data = json.loads(row[0])
    assert len(data) == 1
    assert data[0]["file"] == "/path/to/fallback.py"
    merge_physical_files_to_topic("proj_1", "topic_A", ["/path/to/file1.py", "/path/to/file2.py"])
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            data = json.loads(row[0])
    assert len(data) == 3
    merge_physical_files_to_topic("proj_1", "topic_A", ["/path/to/file1.py"])
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            data = json.loads(row[0])
    assert len(data) == 3
    merge_physical_files_to_topic("proj_1", "topic_A", ["/path/to/file3.py"])
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            data = json.loads(row[0])
    assert len(data) == 4
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("UPDATE project_topics SET associated_files=? WHERE uuid='proj_1' AND topic_id='topic_A'",
                        (json.dumps([{"file": "/path/to/file1.py", "source": "auto"}]),))
    merge_physical_files_to_topic("proj_1", "topic_A", ["/path/to/file1.py"])
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'").fetchone()
            data = json.loads(row[0])
    file1 = [item for item in data if item["file"] == "/path/to/file1.py"][0]
    assert "physical" in file1["source"]


def test_runtime_hook_operations():
    assert get_runtime_hook_value("s1", 0, "k1") is None
    set_runtime_hook_value("s1", 0, "k1", "v1")
    assert get_runtime_hook_value("s1", 0, "k1") == "v1"
    set_runtime_hook_value("s1", 0, "k1", "v2")
    assert get_runtime_hook_value("s1", 0, "k1") == "v2"
    delete_runtime_hook_value("s1", 0, "k1")
    assert get_runtime_hook_value("s1", 0, "k1") is None
    set_runtime_hook_value("s1", 0, "k", "v0")
    set_runtime_hook_value("s1", 1, "k", "v1")
    trim_runtime_hook_states("s1", 1)
    assert get_runtime_hook_value("s1", 0, "k") == "v0"
    assert get_runtime_hook_value("s1", 1, "k") is None
    assert get_hook_state("s1", 0, "k") == "v0"
    set_hook_state("s1", 0, "k", "alias")
    assert get_hook_state("s1", 0, "k") == "alias"
    delete_hook_state("s1", 0, "k")
    assert get_hook_state("s1", 0, "k") is None
    trim_hook_states("s1", 0)


def test_common_exceptions(monkeypatch):
    def broken_conn(*args, **kwargs):
        raise sqlite3.OperationalError("mock error")
    monkeypatch.setattr(sqlite3, "connect", broken_conn)
    assert read_mode("test") == "standard"
    assert get_latest_session() is None
    assert get_project_uuid_by_conv("test") is None
    assert get_active_topic("test") is None
    assert get_topics_by_uuid("test") == []
    assert get_confirmed_decisions("test", "test") == []
    assert get_topic_id_by_decision(999) is None
    assert recall_fts5_logs("test", "test", "test") == []
    assert recall_decisions_by_fts5_topic("test", "test", "test") == []
    assert recall_decisions_by_like("test", "test", "test") == []


def test_runtime_hook_exceptions(monkeypatch):
    def broken_conn(*args, **kwargs):
        raise sqlite3.OperationalError("mock error")
    monkeypatch.setattr(sqlite3, "connect", broken_conn)
    assert get_runtime_hook_value("test", 0, "key") is None
    set_runtime_hook_value("test", 0, "key", "val")
    delete_runtime_hook_value("test", 0, "key")
    trim_runtime_hook_states("test", 0)


def test_gc_exception(monkeypatch):
    def broken_conn(*args, **kwargs):
        raise sqlite3.OperationalError("mock error")
    monkeypatch.setattr(sqlite3, "connect", broken_conn)
    with pytest.raises(SystemExit):
        run_topic_garbage_collection()


def test_prune_exception(monkeypatch, tmp_path):
    def broken_conn(*args, **kwargs):
        raise sqlite3.OperationalError("mock error")
    monkeypatch.setattr(sqlite3, "connect", broken_conn)
    with pytest.raises(SystemExit):
        prune_expired_watermarks(str(tmp_path))


def test_prune_expired_watermarks_artifact_sync(tmp_path):
    from contextlib import closing
    brain_dir = str(tmp_path)
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('artifact_sync_foo', 1, datetime('now', '-40 days'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'artifact_sync_foo', datetime('now', '-40 days'));
            """)
    prune_expired_watermarks(brain_dir)
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        rows = conn.execute("SELECT conversation_id FROM watermarks WHERE conversation_id='artifact_sync_foo'").fetchall()
        assert len(rows) == 1


def test_prune_expired_watermarks_invalid_dir():
    prune_expired_watermarks("/nonexistent/path_xyz123")


def test_prune_expired_watermarks_no_delete(tmp_path):
    from contextlib import closing
    import os
    brain_dir = str(tmp_path)
    os.makedirs(os.path.join(brain_dir, 'c1'))
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.executescript("""
                INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c1', 1, datetime('now', '-1 hours'));
                INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'c1', datetime('now', '-1 hours'));
                INSERT INTO session_state (session_id) VALUES ('c1');
            """)
    prune_expired_watermarks(brain_dir)
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        rows = conn.execute("SELECT conversation_id FROM watermarks").fetchall()
        assert len(rows) == 1


def test_file_changes_insert_and_query():
    insert_file_change("proj_1", "conv_1", "auth.py", "snapshot")
    insert_file_change("proj_1", "conv_1", "auth.py", "snapshot")
    insert_file_change("proj_1", "conv_1", "middleware.py", "snapshot")
    insert_file_change("proj_1", "conv_2", "logger.py", "sandbox")

    with sqlite3.connect(TEST_DB_PATH, timeout=15) as conn:
        conn.execute("INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale) VALUES ('proj_1', 'topic_A', 'conv_1', 'Use python', 'fast')")
        conn.commit()

    files = get_files_by_topic("proj_1", "topic_A")
    assert "auth.py" in files
    assert "middleware.py" in files
    assert "logger.py" not in files

    decisions = get_decisions_by_file("proj_1", "auth.py")
    assert len(decisions) == 1
    assert decisions[0]["decision"] == "Use python"


def test_gate_should_fire_and_mark():
    """Gate fires when no prior state, then marks fired."""
    result = gate.should_fire("conv_1", "test_gate_key", "v1")
    assert result == True

    gate.mark_fired("conv_1", "test_gate_key", "v1")
    result2 = gate.should_fire("conv_1", "test_gate_key", "v1")
    assert result2 == False

    result3 = gate.should_fire("conv_1", "test_gate_key", "v2")
    assert result3 == True


def test_gate_dedup_and_clear():
    """Same value dedup, different value clears stale."""
    gate.mark_fired("conv_2", "test_dedup", "42")
    assert gate.is_duplicate("conv_2", "test_dedup", "42") == True
    assert gate.is_duplicate("conv_2", "test_dedup", "99") == False

    gate.mark_fired("conv_2", "test_dedup", "99")
    assert gate.is_duplicate("conv_2", "test_dedup", "42") == False

def test_bump_injection_once():
    from contextlib import closing
    import sqlite3
    from core.storage.decisions import bump_injection
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO topic_decisions (id, project_uuid, topic_id, decision, user_confirmed) VALUES (999, 'proj_1', 't1', 'test decision', 0)")
            bump_injection(conn, 999)
            row = conn.execute("SELECT injected_count, last_injected_at FROM topic_decisions WHERE id=999").fetchone()
            assert row[0] == 1
            assert row[1] is not None

def test_bump_injection_multiple():
    from contextlib import closing
    import sqlite3
    from core.storage.decisions import bump_injection
    with closing(sqlite3.connect(TEST_DB_PATH, timeout=15)) as conn:
        with conn:
            conn.execute("INSERT INTO topic_decisions (id, project_uuid, topic_id, decision, user_confirmed) VALUES (998, 'proj_1', 't1', 'multi bump', 0)")
            for _ in range(3):
                bump_injection(conn, 998)
            row = conn.execute("SELECT injected_count FROM topic_decisions WHERE id=998").fetchone()
            assert row[0] == 3
