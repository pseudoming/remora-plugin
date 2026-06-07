import os
import sys
import sqlite3
import pytest
from unittest.mock import patch

# Ensure scripts dir is on PATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from adapter.bridge.paths import get_db_path
from core.storage.maintenance import prune_expired_watermarks, run_topic_garbage_collection
import adapter.bridge.paths as paths

@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    db_file = tmp_path / "test_concurrency.db"
    db_path_str = str(db_file)
    
    # Patch get_db_path to return this temp db
    monkeypatch.setattr(paths, "get_db_path", lambda: db_path_str)
    
    # Initialize basic schema
    with sqlite3.connect(db_path_str) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS project_topics (
                uuid TEXT,
                topic_id TEXT,
                status TEXT DEFAULT 'open',
                summary TEXT,
                source TEXT DEFAULT 'auto',
                last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(uuid, topic_id)
            );
            CREATE TABLE IF NOT EXISTS topic_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_uuid TEXT,
                topic_id TEXT,
                conversation_id TEXT,
                decision TEXT,
                rationale TEXT,
                user_confirmed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS watermarks (
                conversation_id TEXT PRIMARY KEY,
                project_uuid TEXT,
                last_msg_id INTEGER DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT,
                timestamp TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS session_state (
                session_id TEXT PRIMARY KEY
            );
        """)
        
    yield db_path_str


def test_run_topic_garbage_collection_lock_contention(temp_db, monkeypatch):
    # Shorten connection timeout to trigger lock contention quickly
    original_connect = sqlite3.connect
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **kw: original_connect(*a, timeout=kw.pop('timeout', 0.1), **kw))
    
    # Establish a secondary connection and acquire an EXCLUSIVE lock
    conn_lock = sqlite3.connect(temp_db, timeout=0.2)
    conn_lock.execute("BEGIN EXCLUSIVE")
    # Run a write to hold the exclusive lock
    conn_lock.execute("INSERT INTO project_topics (uuid, topic_id) VALUES ('u1', 't1')")
    
    # Attempting to run GC should face contention, raise sqlite3.OperationalError and sys.exit(1)
    with pytest.raises(SystemExit) as excinfo:
        run_topic_garbage_collection()
        
    assert excinfo.value.code == 1
    
    # Release lock
    conn_lock.rollback()
    conn_lock.close()


def test_prune_expired_watermarks_lock_contention(temp_db, monkeypatch, tmp_path):
    # Setup folders to cause watermarks pruning
    brain_dir = tmp_path / "brain"
    brain_dir.mkdir()
    
    # Shorten connection timeout to trigger lock contention quickly
    original_connect = sqlite3.connect
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **kw: original_connect(*a, timeout=kw.pop('timeout', 0.1), **kw))
    
    # Seed db with expired data that requires pruning
    with sqlite3.connect(temp_db) as conn:
        conn.execute("INSERT INTO watermarks (conversation_id, project_uuid, last_updated) VALUES ('c_expired', 'p1', datetime('now', '-40 days'))")
        conn.commit()
    
    # Establish a secondary connection and acquire an EXCLUSIVE lock
    conn_lock = sqlite3.connect(temp_db)
    conn_lock.execute("BEGIN EXCLUSIVE")
    conn_lock.execute("INSERT INTO project_topics (uuid, topic_id) VALUES ('u2', 't2')")
    
    # Prune should run, attempt delete with exclusive transaction, fail, and exit(1)
    with pytest.raises(SystemExit) as excinfo:
        prune_expired_watermarks(str(brain_dir))
        
    assert excinfo.value.code == 1
    
    # Release lock
    conn_lock.rollback()
    conn_lock.close()
