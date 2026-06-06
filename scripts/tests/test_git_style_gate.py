import os
import sys
import pytest
from unittest.mock import patch, MagicMock

# Ensure scripts directory is in PYTHONPATH
current_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.dirname(current_dir)
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

import importlib
safety_check = importlib.import_module("safety-check")
from lib.dao import get_hook_state, set_hook_state, delete_hook_state, trim_hook_states

def test_analyze_commit_style_prefix():
    # History with prefix (conventional commits)
    history = [
        "task: add feature A",
        "fix: resolve issue B",
        "task: update doc C",
        "docs: document API",
    ]
    
    # 1. New message without prefix -> should deviate
    deviates, mismatches = safety_check.analyze_commit_style("added new feature", history)
    assert deviates is True
    assert any("Missing conventional prefix" in m for m in mismatches)
    
    # 2. New message with prefix -> should not deviate
    deviates, mismatches = safety_check.analyze_commit_style("feat: added new feature", history)
    assert deviates is False

def test_analyze_commit_style_casing():
    # History with capitalized body starts
    history = [
        "task: Add feature A",
        "fix: Resolve issue B",
        "task: Update doc C",
        "docs: Document API",
    ]
    
    # 1. New body starts with lowercase -> should deviate
    deviates, mismatches = safety_check.analyze_commit_style("feat: added new feature", history)
    assert deviates is True
    assert any("First letter of message body should be capitalized" in m for m in mismatches)
    
    # 2. New body starts with uppercase -> should not deviate
    deviates, mismatches = safety_check.analyze_commit_style("feat: Added new feature", history)
    assert deviates is False

def test_analyze_commit_style_period():
    # History without period at the end (100% no periods)
    history = [
        "task: Add feature A",
        "fix: Resolve issue B",
        "task: Update doc C",
    ]
    
    # 1. New message ends with period -> should deviate
    deviates, mismatches = safety_check.analyze_commit_style("feat: Add feature A.", history)
    assert deviates is True
    assert any("Commit message should not end with a period" in m for m in mismatches)
    
    # 2. New message doesn't end with period -> should not deviate
    deviates, mismatches = safety_check.analyze_commit_style("feat: Add feature A", history)
    assert deviates is False

@patch("safety-check.get_subagent_type")
@patch("lib.dao.get_hook_state")
@patch("lib.dao.set_hook_state")
@patch("lib.dao.delete_hook_state")
@patch("lib.dao.trim_hook_states")
@patch("subprocess.run")
def test_git_commit_gate_flow(mock_run, mock_trim, mock_delete, mock_set, mock_get, mock_subagent):
    mock_subagent.return_value = None
    
    # Mock Git Log returning prefix-heavy history
    mock_res_b = MagicMock()
    mock_res_b.returncode = 0
    mock_res_b.stdout = "task: Init\ntask: Work\ntask: Done"
    
    mock_res_s = MagicMock()
    mock_res_s.returncode = 0
    mock_res_s.stdout = "task: Init\ntask: Work\ntask: Done"
    
    mock_run.side_effect = [mock_res_b, mock_res_s]
    
    # First invocation: no hook state exists in DB yet (first attempt)
    # We call with a deviating message (no prefix)
    mock_get.side_effect = [
        None,  # 'trimmed' status check -> returns None (forces trim)
        None,  # 'git_commit_gate' status check -> returns None (first attempt)
    ]
    
    context = {
        "toolCall": {
            "name": "run_command",
            "args": {
                "CommandLine": "git commit -m \"deviating commit message\""
            }
        },
        "transcriptPath": "/brain/conv_id_123/transcript.jsonl"
    }
    
    res = safety_check.main.__wrapped__(context)
    
    assert res["decision"] == "deny"
    assert "GIT-COMMIT-STYLE" in res["reason"]
    # Verify we registered trim, trimmed flag, and commit gate denied state
    mock_trim.assert_called_once()
    mock_set.assert_any_call("conv_id_123", -1, "last_seen_turn", "0")
    mock_set.assert_any_call("conv_id_123", 0, "git_commit_gate", "denied")


@patch("safety-check.get_subagent_type")
@patch("lib.dao.get_hook_state")
@patch("lib.dao.delete_hook_state")
@patch("lib.dao.trim_hook_states")
def test_git_commit_gate_retry(mock_trim, mock_delete, mock_get, mock_subagent):
    mock_subagent.return_value = None
    
    # Second invocation: hook state is 'denied' (retry in the same turn)
    mock_get.side_effect = [
        "1",      # 'trimmed' status check -> trimmed is already done
        "denied", # 'git_commit_gate' status check -> returns denied
    ]

    
    context = {
        "toolCall": {
            "name": "run_command",
            "args": {
                "CommandLine": "git commit -m \"deviating commit message\""
            }
        },
        "transcriptPath": "/brain/conv_id_123/transcript.jsonl"
    }
    
    res = safety_check.main.__wrapped__(context)
    
    # Verify adaptive release: returns allow and deletes denied state
    assert res["decision"] == "allow"
    mock_delete.assert_called_once_with("conv_id_123", 0, "git_commit_gate")
