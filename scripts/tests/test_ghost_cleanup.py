import os
import sys
import sqlite3
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'adapter', 'maintenance')))

from unittest.mock import patch

import lib.dao as dao
import adapter.bridge.paths as paths
import cleanup_ghost_records

@pytest.fixture
def test_db(tmp_path):
    db_file = tmp_path / "test_remora_memory.db"
    db_path_str = str(db_file)

    with sqlite3.connect(db_path_str) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                line_number INTEGER NOT NULL,
                timestamp TIMESTAMP,
                role TEXT,
                content TEXT,
                topic_id TEXT,
                UNIQUE(conversation_id, line_number)
            );
            
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content, content=messages, content_rowid=id, tokenize='trigram'
            );
            
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
            END;
        """)

    yield db_path_str


def test_fix_db_no_ghost_records(test_db, capsys):
    with sqlite3.connect(test_db) as conn:
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')")
        conn.commit()

    with patch.object(paths, 'get_db_path', return_value=test_db), \
         patch("cleanup_ghost_records.info") as mock_info:
        cleanup_ghost_records.fix_db()
        mock_info.assert_any_call("No ghost records to clean up.")

    with sqlite3.connect(test_db) as conn:
        rows = conn.execute("SELECT * FROM messages").fetchall()
        assert len(rows) == 1


def test_fix_db_with_ghost_records(test_db, capsys):
    with sqlite3.connect(test_db) as conn:
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')")
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 2, NULL, 'ghost role null')")
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 3, '', 'ghost role empty')")
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 4, 'assistant', NULL)")
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 5, 'assistant', '')")
        conn.commit()

    with patch.object(paths, 'get_db_path', return_value=test_db), \
         patch("cleanup_ghost_records.info") as mock_info:
        cleanup_ghost_records.fix_db()
        mock_info.assert_any_call("Deleted 4 ghost records. FTS index rebuilt.")

    with sqlite3.connect(test_db) as conn:
        rows = conn.execute("SELECT id FROM messages").fetchall()
        assert len(rows) == 1
