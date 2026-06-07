import os
import sys
import sqlite3
import pytest

# Ensure scripts dir is on PATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
# cleanup_ghost_records now lives in maintenance/, add it to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'maintenance')))

import cleanup_ghost_records

@pytest.fixture
def test_db(tmp_path):
    db_file = tmp_path / "test_remora_memory.db"
    db_path_str = str(db_file)
    
    # Save original DB_PATH
    orig_db_path = cleanup_ghost_records.DB_PATH
    cleanup_ghost_records.DB_PATH = db_path_str
    
    # Create tables
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
    
    # Restore original DB_PATH
    cleanup_ghost_records.DB_PATH = orig_db_path


def test_fix_db_no_ghost_records(test_db, capsys):
    # Insert normal records
    with sqlite3.connect(test_db) as conn:
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')")
        conn.commit()

    cleanup_ghost_records.fix_db()
    
    # Verify outputs
    captured = capsys.readouterr()
    assert "Found 0 ghost records." in captured.out
    assert "No ghost records to clean up." in captured.out
    
    # Verify data remains
    with sqlite3.connect(test_db) as conn:
        rows = conn.execute("SELECT * FROM messages").fetchall()
        assert len(rows) == 1
        assert rows[0][4] == 'user'
        assert rows[0][5] == 'hello'


def test_fix_db_with_ghost_records(test_db, capsys):
    # Insert both normal and ghost records
    with sqlite3.connect(test_db) as conn:
        # Normal
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')")
        # Ghost: role IS NULL
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 2, NULL, 'ghost role null')")
        # Ghost: role is empty
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 3, '', 'ghost role empty')")
        # Ghost: content IS NULL
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 4, 'assistant', NULL)")
        # Ghost: content is empty
        conn.execute("INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 5, 'assistant', '')")
        
        conn.commit()

    cleanup_ghost_records.fix_db()
    
    # Verify outputs
    captured = capsys.readouterr()
    assert "Found 4 ghost records." in captured.out
    assert "Deleting ghost records..." in captured.out
    assert "Deleted 4 records." in captured.out
    assert "Rebuilding FTS index..." in captured.out
    assert "FTS index rebuilt." in captured.out
    assert "Cleanup complete." in captured.out
    
    # Verify only normal data remains
    with sqlite3.connect(test_db) as conn:
        rows = conn.execute("SELECT id, conversation_id, line_number, role, content FROM messages").fetchall()
        assert len(rows) == 1
        assert rows[0][3] == 'user'
        assert rows[0][4] == 'hello'
        
        # Verify FTS rebuild was successful by checking query
        fts_rows = conn.execute("SELECT * FROM messages_fts WHERE messages_fts MATCH 'hello'").fetchall()
        assert len(fts_rows) == 1
