import os
import sys
import json
import pytest
import io
from unittest.mock import patch, MagicMock, mock_open

# Ensure scripts directory is in PYTHONPATH
current_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.dirname(current_dir)
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

import importlib
action_gate = importlib.import_module("action-gate")

@pytest.fixture
def test_env(tmp_path):
    """
    Creates a temporary workspace structure.
    """
    brain_dir = tmp_path / "brain" / "conv123" / "artifacts"
    brain_dir.mkdir(parents=True)
    transcript = brain_dir / "transcript.jsonl"
    transcript.touch()
    
    # Also create the scratch folder
    scratch = tmp_path / "brain" / "conv123" / "scratch"
    scratch.mkdir(parents=True)
    
    # We will set HOME to tmp_path to avoid global state contamination
    return {
        "transcriptPath": str(transcript),
        "initialNumSteps": 0,
        "cwd": str(tmp_path)
    }

def test_normalize_filepath():
    assert action_gate.normalize_filepath(None) == ""
    assert action_gate.normalize_filepath("not a dict") == ""
    assert action_gate.normalize_filepath({"TargetFile": "/path/to/foo.py"}) == "foo.py"
    assert action_gate.normalize_filepath({"AbsolutePath": "'/path/to/bar.js'"}) == "bar.js"
    assert action_gate.normalize_filepath({"FilePath": '"/path/to/baz.ts"'}) == "baz.ts"
    assert action_gate.normalize_filepath({"Target": "/path/to/qux.sh"}) == "qux.sh"
    assert action_gate.normalize_filepath({"Other": "ignored"}) == ""

@patch("action-gate.get_snapshot")
def test_get_physical_modifications(mock_get_snapshot, test_env):
    # Mock pre_snapshot file contents
    pre_data = {
        "/path/to/a.py": {"mtime": 100.0, "size": 100},
        "/path/to/b.py": {"mtime": 100.0, "size": 100},
    }
    
    mock_get_snapshot.return_value = {
        "/path/to/a.py": {"mtime": 100.0, "size": 100},       # unchanged
        "/path/to/b.py": {"mtime": 101.0, "size": 100},       # mtime changed
        "/path/to/c.py": {"mtime": 200.0, "size": 200},       # new file
    }
    
    m_open = mock_open(read_data=json.dumps(pre_data))
    
    with patch("builtins.open", m_open), \
         patch("pathlib.Path.exists", return_value=True), \
         patch("os.remove") as mock_remove:
         
        mods = action_gate.get_physical_modifications(test_env["cwd"], test_env["transcriptPath"])
        assert mods == {"b.py", "c.py"}
        mock_remove.assert_called_once()

def test_get_latest_conversation_states():
    mock_cdal = MagicMock()
    mock_cdal.stream_steps_reverse.return_value = [
        # Step 3: Planner response
        {
            "type": "PLANNER_RESPONSE",
            "step_index": 3,
            "content": "I have modified standard.py",
            "tool_calls": [
                {
                    "name": "write_to_file",
                    "args": {"TargetFile": "standard.py"}
                }
            ]
        },
        # Step 2: Tool call with string arguments
        {
            "type": "TOOL_CALL",
            "step_index": 2,
            "tool_calls": [
                {
                    "name": "replace_file_content",
                    "args": '{"AbsolutePath": "helper.py"}'
                }
            ]
        },
        # Step 1: User Input (should stop backtracking here)
        {
            "type": "USER_INPUT",
            "step_index": 1,
            "content": "please do something"
        }
    ]
    
    text, actual_files, has_calls = action_gate.get_latest_conversation_states(mock_cdal, initial_num_steps=0)
    assert text == "I have modified standard.py"
    assert actual_files == {"standard.py", "helper.py"}
    assert has_calls is True

def test_get_latest_conversation_states_watermark():
    mock_cdal = MagicMock()
    mock_cdal.stream_steps_reverse.return_value = [
        {"type": "PLANNER_RESPONSE", "step_index": 5, "content": "hello"},
        {"type": "PLANNER_RESPONSE", "step_index": 4, "content": "world"}
    ]
    
    # Should stop at step_index <= 4
    text, _, _ = action_gate.get_latest_conversation_states(mock_cdal, initial_num_steps=4)
    assert text == "hello"

@patch("action-gate.ConversationDataAccessLayer")
@patch("action-gate.get_physical_modifications")
@patch("action-gate.read_mode")
def test_main_wrapped_relax_mode(mock_read_mode, mock_phys_mods, mock_cdal_class, test_env):
    mock_read_mode.return_value = "relax"
    mock_phys_mods.return_value = {"a.py"}
    
    mock_cdal = MagicMock()
    mock_cdal.stream_steps_reverse.return_value = [
        {"type": "PLANNER_RESPONSE", "content": "I have updated a.py and b.py", "step_index": 10}
    ]
    mock_cdal_class.return_value = mock_cdal
    
    res = action_gate.main.__wrapped__(test_env)
    assert res == {"injectSteps": [], "terminationBehavior": ""}

@patch("action-gate.ConversationDataAccessLayer")
@patch("action-gate.get_physical_modifications")
@patch("action-gate.read_mode")
def test_main_wrapped_phantom_detection(mock_read_mode, mock_phys_mods, mock_cdal_class, test_env):
    mock_read_mode.return_value = "strict"
    mock_phys_mods.return_value = set()
    
    mock_cdal = MagicMock()
    mock_cdal.stream_steps_reverse.return_value = [
        {
            "type": "PLANNER_RESPONSE",
            # Verb must immediately precede test.py in one of the patterns:
            "content": "成功更新了 [test.py](file:///test.py) 和 `src/main.py`",
            "step_index": 10,
            "tool_calls": [
                {"name": "write_to_file", "args": {"TargetFile": "src/main.py"}}
            ]
        }
    ]
    mock_cdal_class.return_value = mock_cdal
    
    res = action_gate.main.__wrapped__(test_env)
    # It should detect that test.py is declared but not in actual files
    assert "injectSteps" in res
    assert len(res["injectSteps"]) == 1
    assert "test.py" in res["injectSteps"][0]["ephemeralMessage"]
    assert res["terminationBehavior"] == "force_continue"

@patch("action-gate.ConversationDataAccessLayer")
@patch("action-gate.get_physical_modifications")
@patch("action-gate.read_mode")
def test_main_wrapped_no_phantom(mock_read_mode, mock_phys_mods, mock_cdal_class, test_env):
    mock_read_mode.return_value = "strict"
    # test.py is physically modified
    mock_phys_mods.return_value = {"test.py"}
    
    mock_cdal = MagicMock()
    mock_cdal.stream_steps_reverse.return_value = [
        {
            "type": "PLANNER_RESPONSE",
            "content": "成功更新了 [test.py](file:///test.py) 和 `src/main.py`",
            "step_index": 10,
            "tool_calls": [
                {"name": "write_to_file", "args": {"TargetFile": "src/main.py"}}
            ]
        }
    ]
    mock_cdal_class.return_value = mock_cdal
    
    res = action_gate.main.__wrapped__(test_env)
    # Both main.py and test.py are actual_files, so no phantom modification
    assert res == {"injectSteps": [], "terminationBehavior": ""}

@patch("action-gate.ConversationDataAccessLayer")
@patch("action-gate.get_physical_modifications")
@patch("action-gate.read_mode")
def test_regex_patterns(mock_read_mode, mock_phys_mods, mock_cdal_class, test_env):
    mock_read_mode.return_value = "strict"
    mock_phys_mods.return_value = set()
    
    test_cases = [
        ("已修改文件 `abc.py`", "abc.py"),
        ("成功更新了 `dir/def.json`", "def.json"),
        ("覆写了 [xyz.py](file:///path/xyz.py)", "xyz.py"),
        ("已在 [hello.js](file:///hello.js) 中修改了", "hello.js"),
        ("已在 `world.ts` 中更新了", "world.ts"),
        ("updated `test.sh`", "test.sh"),
        ("modified file `data.xml`", "data.xml"),
        ("created file helper.py", "helper.py"),
    ]
    
    for text, expected in test_cases:
        mock_cdal = MagicMock()
        mock_cdal.stream_steps_reverse.return_value = [
            {
                "type": "PLANNER_RESPONSE",
                "content": text,
                "step_index": 10,
                # Simulate tool calls for a DIFFERENT file to trigger detection
                "tool_calls": [{"name": "write_to_file", "args": {"TargetFile": "other.py"}}]
            }
        ]
        mock_cdal_class.return_value = mock_cdal
        
        res = action_gate.main.__wrapped__(test_env)
        assert "injectSteps" in res
        assert len(res["injectSteps"]) == 1
        assert expected in res["injectSteps"][0]["ephemeralMessage"]

@patch("sys.stdin", new_callable=io.StringIO)
@patch("sys.stdout", new_callable=io.StringIO)
@patch("action-gate.get_latest_conversation_states")
def test_zero_fault_fallback(mock_get_states, mock_stdout, mock_stdin, test_env):
    # Setup stdin context
    mock_stdin.write(json.dumps(test_env))
    mock_stdin.seek(0)
    
    # Force an exception to trigger the decorator fallback
    mock_get_states.side_effect = Exception("Simulated CDAL failure")
    
    # Running main() will invoke the decorator which intercepts the exception and prints the fallback_result
    with pytest.raises(SystemExit) as exc:
        action_gate.main()
        
    assert exc.value.code == 0
    
    # Verify the output is the fallback result (which is empty dict for non-tool-use/non-stop hooks)
    output = json.loads(mock_stdout.getvalue().strip())
    assert output == {}
