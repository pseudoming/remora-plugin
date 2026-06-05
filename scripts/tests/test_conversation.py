import os
import sqlite3
import pytest
from unittest.mock import patch, MagicMock
from lib.conversation import ConversationDataAccessLayer

@pytest.fixture
def temp_home(tmp_path, monkeypatch):
    """
    Creates a temporary home directory structure and mocks HOME env variable.
    """
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setenv("HOME", str(home_dir))
    
    # Create conversations directory
    conv_dir = home_dir / ".gemini" / "antigravity" / "conversations"
    conv_dir.mkdir(parents=True)
    return home_dir

def create_mock_db(db_path, steps_data=None):
    """
    Helper to create a SQLite DB at db_path with optional steps.
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS steps (
            idx INTEGER PRIMARY KEY,
            status INTEGER,
            step_payload BLOB
        )
    """)
    if steps_data:
        cursor.executemany("INSERT INTO steps (idx, status, step_payload) VALUES (?, ?, ?)", steps_data)
    conn.commit()
    conn.close()

def test_db_not_exist(temp_home):
    cdal = ConversationDataAccessLayer("non_existent")
    assert cdal.get_compaction_watermark() == -1
    assert cdal.get_max_step_index() == 0
    assert cdal.get_db_mtime() == 0.0
    assert list(cdal.stream_steps_reverse()) == []
    assert list(cdal.stream_steps_forward()) == []

def test_get_compaction_watermark(temp_home):
    conv_id = "test_conv_1"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    # 1. Empty DB
    create_mock_db(db_path)
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_compaction_watermark() == -1
    
    # 2. Populated DB
    steps = [
        (1, 1, b"payload1"),
        (2, 5, b"payload2"),
        (3, 5, b"payload3"),
        (4, 2, b"payload4")
    ]
    create_mock_db(db_path, steps)
    assert cdal.get_compaction_watermark() == 3

def test_get_compaction_watermark_exception(temp_home):
    conv_id = "test_conv_exception"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    # Create DB with wrong schema
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE steps (not_idx INTEGER)")
    conn.close()
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_compaction_watermark() == -1

def test_get_max_step_index(temp_home):
    conv_id = "test_conv_2"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    # 1. Empty DB
    create_mock_db(db_path)
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_max_step_index() == 0
    
    # 2. Populated DB
    steps = [
        (1, 1, b"payload1"),
        (5, 2, b"payload2")
    ]
    create_mock_db(db_path, steps)
    assert cdal.get_max_step_index() == 5

def test_get_max_step_index_exception(temp_home):
    conv_id = "test_conv_exception_max"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    # Create DB with wrong schema
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE steps (not_idx INTEGER)")
    conn.close()
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_max_step_index() == 0

def test_get_db_mtime(temp_home):
    conv_id = "test_conv_mtime"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    create_mock_db(db_path)
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_db_mtime() > 0.0

@patch("lib.conversation.extract_step_payload")
def test_stream_steps_reverse(mock_extract, temp_home):
    conv_id = "test_conv_reverse"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    steps = [
        (1, 1, b"p1"),
        (2, 1, b"p2"),
        (3, 1, b"p3"),
    ]
    create_mock_db(db_path, steps)
    
    mock_extract.side_effect = lambda blob: {"raw": blob.decode('utf-8')}
    
    cdal = ConversationDataAccessLayer(conv_id)
    results = list(cdal.stream_steps_reverse(limit=2))
    
    assert len(results) == 2
    # Should be DESC order
    assert results[0] == {"raw": "p3", "step_index": 3}
    assert results[1] == {"raw": "p2", "step_index": 2}

@patch("lib.conversation.extract_step_payload")
def test_stream_steps_reverse_exception(mock_extract, temp_home):
    conv_id = "test_conv_reverse_exc"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    # wrong schema triggers exception in query
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE steps (not_idx INTEGER)")
    conn.close()
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert list(cdal.stream_steps_reverse()) == []

@patch("lib.conversation.extract_step_payload")
def test_stream_steps_forward(mock_extract, temp_home):
    conv_id = "test_conv_forward"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    steps = [
        (10, 1, b"p10"),
        (11, 1, b"p11"),
        (12, 1, b"p12"),
    ]
    create_mock_db(db_path, steps)
    
    mock_extract.side_effect = lambda blob: {"raw": blob.decode('utf-8')}
    
    cdal = ConversationDataAccessLayer(conv_id)
    results = list(cdal.stream_steps_forward(start_idx=11))
    
    assert len(results) == 2
    # Should be ASC order starting from start_idx
    assert results[0] == {"raw": "p11", "step_index": 11}
    assert results[1] == {"raw": "p12", "step_index": 12}

@patch("lib.conversation.extract_step_payload")
def test_stream_steps_forward_exception(mock_extract, temp_home):
    conv_id = "test_conv_forward_exc"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE steps (not_idx INTEGER)")
    conn.close()
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert list(cdal.stream_steps_forward()) == []

@patch("lib.conversation.extract_step_payload")
def test_get_latest_user_message(mock_extract, temp_home):
    conv_id = "test_conv_user"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    steps = [
        (1, 1, b"p1"),
        (2, 1, b"p2"),
    ]
    create_mock_db(db_path, steps)
    
    # Mock return values for reversed order
    # idx 2 is NOT USER_INPUT, idx 1 IS USER_INPUT
    mock_extract.side_effect = [
        {"type": "PLANNER_RESPONSE", "content": "planner message"},
        {"type": "USER_INPUT", "content": "hello user"},
    ]
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_latest_user_message() == "hello user"

@patch("lib.conversation.extract_step_payload")
def test_get_latest_user_message_none(mock_extract, temp_home):
    conv_id = "test_conv_user_none"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    create_mock_db(db_path, [(1, 1, b"p1")])
    mock_extract.return_value = {"type": "OTHER"}
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_latest_user_message() is None

@patch("lib.conversation.extract_step_payload")
def test_get_latest_planner_response(mock_extract, temp_home):
    conv_id = "test_conv_planner"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    
    steps = [
        (1, 1, b"p1"),
        (2, 1, b"p2"),
    ]
    create_mock_db(db_path, steps)
    
    mock_extract.side_effect = [
        {"type": "PLANNER_RESPONSE", "content": "planner message"},
        {"type": "USER_INPUT", "content": "hello user"},
    ]
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_latest_planner_response() == "planner message"

@patch("lib.conversation.extract_step_payload")
def test_get_latest_planner_response_none(mock_extract, temp_home):
    conv_id = "test_conv_planner_none"
    db_path = temp_home / ".gemini" / "antigravity" / "conversations" / f"{conv_id}.db"
    create_mock_db(db_path, [(1, 1, b"p1")])
    mock_extract.return_value = {"type": "OTHER"}
    
    cdal = ConversationDataAccessLayer(conv_id)
    assert cdal.get_latest_planner_response() is None
