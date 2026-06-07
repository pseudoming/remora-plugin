import os
import io
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


# =====================================================================
# Tests for lib/context.py: hook_entrypoint decorator
# =====================================================================

import sys as _sys
import json as _json
import time as _time

from lib.context import hook_entrypoint, get_profiler, _active_profiler


def test_hook_entrypoint_default_fallback():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"decision": "allow"}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "test"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit") as mock_exit:
        dummy_hook()
        mock_exit.assert_called_once_with(0)
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"


def test_hook_entrypoint_none_fallback_uses_default():
    @hook_entrypoint(fallback_result=None)
    def dummy_hook(input_data):
        return {"decision": "deny", "reason": "test"}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "test"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "deny"


def test_hook_entrypoint_stdin_json_error():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"decision": "allow"}

    with patch.object(_sys, "stdin", io.StringIO("not valid json {{{")), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False):
        try:
            dummy_hook()
        except SystemExit:
            pass
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"


def test_hook_entrypoint_stdin_json_error_with_log_file():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"decision": "allow"}

    with patch.object(_sys, "stdin", io.StringIO("not valid json {{{")), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=True), \
         patch("builtins.open", create=True):
        try:
            dummy_hook()
        except SystemExit:
            pass
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"


def test_hook_entrypoint_status_completed():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"decision": "allow", "status": "completed", "details": "all done"}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"transcriptPath": "/tmp/t.jsonl"}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel") as mock_sentinel, \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        mock_sentinel.update.assert_any_call("/tmp/t.jsonl", "completed", details="all done")


def test_hook_entrypoint_invocation_non_dict_result():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return "not a dict"

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"invocationNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {}


def test_hook_entrypoint_invocation_with_inject_steps():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"injectSteps": [{"ephemeralMessage": "hello"}]}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"invocationNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {"injectSteps": [{"ephemeralMessage": "hello"}]}


def test_hook_entrypoint_system_exit_code_zero_tool_use():
    @hook_entrypoint()
    def dummy_hook(input_data):
        raise SystemExit(0)

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "test"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit") as mock_exit:
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"


def test_hook_entrypoint_system_exit_nonzero_non_tool():
    @hook_entrypoint()
    def dummy_hook(input_data):
        raise SystemExit(1)

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"invocationNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit") as mock_exit:
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {"injectSteps": []}


def test_hook_entrypoint_exception_with_decision_fallback():
    @hook_entrypoint(fallback_result={"decision": "allow"})
    def dummy_hook(input_data):
        raise ValueError("something broke")

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "test"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"
        assert "decision_reason" in result
        assert "Remora Fallback" in result["decision_reason"]


def test_hook_entrypoint_exception_no_decision_fallback():
    @hook_entrypoint(fallback_result={"injectSteps": []})
    def dummy_hook(input_data):
        raise ValueError("other error")

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "test"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["injectSteps"] == []


def test_hook_entrypoint_base_exception_non_tool():
    @hook_entrypoint()
    def dummy_hook(input_data):
        raise SystemError("critical")

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"invocationNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {}


def test_hook_entrypoint_stop_hook():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"decision": "allow"}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"executionNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit") as mock_exit:
        dummy_hook()
        mock_exit.assert_called_once_with(0)
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"


def test_hook_entrypoint_post_tool_use():
    @hook_entrypoint()
    def dummy_hook(input_data):
        return {"some": "value"}

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"postTool": True}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit") as mock_exit:
        dummy_hook()
        mock_exit.assert_called_once_with(0)
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {}


def test_hook_entrypoint_exception_with_tool_use():
    @hook_entrypoint()
    def dummy_hook(input_data):
        raise ValueError("test error")

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"toolCall": {"name": "write"}}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result["decision"] == "allow"
        assert "Remora Fallback" in result["decision_reason"]


def test_hook_entrypoint_system_exit_zero_non_tool():
    @hook_entrypoint()
    def dummy_hook(input_data):
        sys.exit(0)

    with patch.object(_sys, "stdin", io.StringIO(_json.dumps({"invocationNum": 1}))), \
         patch.object(_sys, "stdout", new=io.StringIO()) as mock_stdout, \
         patch("lib.progress.ProgressSentinel"), \
         patch("lib.context.HookProfiler"), \
         patch("os.path.exists", return_value=False), \
         patch.object(_sys, "exit"):
        dummy_hook()
        output = mock_stdout.getvalue().strip()
        result = _json.loads(output)
        assert result == {}
