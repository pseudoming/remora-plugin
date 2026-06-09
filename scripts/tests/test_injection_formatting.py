from core.injection_formatting import (
    format_relax_discipline_prompt,
    format_decisions_for_session_resume,
    format_conflict_injection_message,
    format_file_decisions_injection,
    format_write_gate_deny_prompt,
    format_phantom_first_warning,
    format_phantom_repeat_warning,
    format_strict_recall_reminder,
    format_strict_tone_prompt,
    make_deny_reason,
)


def test_format_relax_discipline_prompt():
    result = format_relax_discipline_prompt(artifact_path="/artifacts/", write_tool_examples=("write_to_file", "replace_file_content", "run_command"))
    assert isinstance(result, str)
    assert len(result) > 0
    assert "<system-discipline>" in result
    assert "write_to_file" in result
    assert "run_command" in result
    assert "/artifacts/" in result


def test_format_relax_discipline_prompt_generic():
    result = format_relax_discipline_prompt()
    assert isinstance(result, str)
    assert "DO NOT INVOKE ANY TOOLS THAT CHANGE CORE CODE FILES." in result
    assert "YOU MAY FREELY EDIT PLANNING ARTIFACTS." in result
    assert "/artifacts/" not in result
    assert "write_to_file" not in result


def test_format_decisions_for_session_resume():
    decisions = [
        {
            "created_at": "2025-01-15T10:30:00Z",
            "user_confirmed": 1,
            "decision": "Use SQLite for all state storage",
            "rationale": "Better persistence and queryability vs JSONL",
        },
        {
            "created_at": "2025-01-16T14:00:00Z",
            "user_confirmed": 0,
            "decision": "Add retry logic to network calls",
        },
    ]
    topic_id = "topic-abc-123"
    result = format_decisions_for_session_resume(decisions, topic_id)
    assert isinstance(result, str)
    assert "topic-abc-123" in result
    assert "Use SQLite" in result
    assert "已确认" in result


def test_format_conflict_injection_message_not_repeat():
    d = {
        "decision_type": "architecture",
        "created_at": "2025-03-01T12:00:00Z",
        "decision": "All modules must use async IO",
    }
    c = {"reason": "User now wants synchronous calls for simplicity"}
    result = format_conflict_injection_message(d, c, is_repeat=False)
    assert isinstance(result, str)
    assert "SEMANTIC CONFLICT DETECTED" in result
    assert "REPEAT CONFLICT" not in result


def test_format_conflict_injection_message_repeat():
    d = {
        "decision_type": "architecture",
        "created_at": "2025-03-01T12:00:00Z",
        "decision": "All modules must use async IO",
    }
    c = {"reason": "Same conflict detected again"}
    result = format_conflict_injection_message(d, c, is_repeat=True)
    assert isinstance(result, str)
    assert "REPEAT CONFLICT" in result
    assert "SEMANTIC CONFLICT DETECTED" not in result


def test_format_file_decisions_injection():
    decisions = [
        {"decision": "Never use raw SQL outside DAO layer"},
        {"decision": "All imports must go through lib/dao.py"},
        {"decision": "Tests must mock external dependencies"},
        {"decision": "Fourth decision gets truncated in display"},
    ]
    result = format_file_decisions_injection("src/dao.py", decisions)
    assert isinstance(result, str)
    assert "src/dao.py" in result
    assert "4 条" in result


def test_format_write_gate_deny_prompt():
    result = format_write_gate_deny_prompt("src/main.py")
    assert isinstance(result, str)
    assert "src/main.py" in result
    assert "GLOBAL-WRITE-GATE" in result


def test_format_phantom_first_warning():
    phantom_files = ["src/module_a.py", "src/module_b.py"]
    result = format_phantom_first_warning(phantom_files, write_tool_examples=("write_to_file", "replace_file_content"))
    assert isinstance(result, str)
    assert "module_a.py" in result
    assert "module_b.py" in result
    assert "write_to_file" in result
    assert "replace_file_content" in result


def test_format_phantom_first_warning_generic():
    phantom_files = ["src/module_a.py"]
    result = format_phantom_first_warning(phantom_files)
    assert isinstance(result, str)
    assert "module_a.py" in result
    assert "write_to_file" not in result
    assert "replace_file_content" not in result
    assert "file editing tools instead" in result


def test_format_phantom_repeat_warning():
    phantom_files = ["test.py"]
    result = format_phantom_repeat_warning(phantom_files)
    assert isinstance(result, str)
    assert "底层检测模块发现了异常" in result


def test_format_strict_recall_reminder():
    result = format_strict_recall_reminder(recall_tool="remora-recall.py")
    assert isinstance(result, str)
    assert "cross-check" in result
    assert "remora-recall.py" in result


def test_format_strict_recall_reminder_generic():
    result = format_strict_recall_reminder()
    assert isinstance(result, str)
    assert "cross-check with the recall tool" in result
    assert "remora-recall.py" not in result


def test_format_strict_tone_prompt():
    result = format_strict_tone_prompt()
    assert isinstance(result, str)
    assert len(result) > 0
    assert "STRICT TONE" in result


def test_make_deny_reason_with_action_tip():
    result = make_deny_reason("PREFIX", "Something went wrong", "Please retry with correct args")
    assert "PREFIX" in result
    assert "Something went wrong" in result
    assert "ACTION REQUIRED: Please retry with correct args" in result


def test_make_deny_reason_without_action_tip():
    result = make_deny_reason("PREFIX", "Something went wrong")
    assert "PREFIX" in result
    assert "Something went wrong" in result
    assert "ACTION REQUIRED:" not in result
