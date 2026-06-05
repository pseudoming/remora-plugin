import os
import sys
import json
import pytest
import io
from unittest.mock import patch, MagicMock

# Ensure scripts directory is in PYTHONPATH
current_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.dirname(current_dir)
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

import importlib
safety_check = importlib.import_module("safety-check")

orig_exists = os.path.exists

def test_get_subagent_type_invalid_paths():
    assert safety_check.get_subagent_type("") is None
    assert safety_check.get_subagent_type("/no/brain/here") is None

@patch("subprocess.run")
@patch("os.path.exists")
def test_get_subagent_type_api_success(mock_exists, mock_run):
    # Ensure plugin.json exists so find_plugin_root succeeds
    mock_exists.side_effect = lambda p: True if "plugin.json" in str(p) else False
    
    # Mock subprocess.run returning successful metadata
    mock_res = MagicMock()
    mock_res.returncode = 0
    mock_res.stdout = json.dumps({
        "response": {
            "conversationMetadata": {
                "metadata": {
                    "parentConversationId": "parent123",
                    "subagentSpec": {
                        "typeName": "Remora_ReadOnly_Extractor"
                    }
                }
            }
        }
    })
    mock_run.return_value = mock_res
    
    res = safety_check.get_subagent_type("/brain/conv123/transcript.jsonl")
    assert res == "Remora_ReadOnly_Extractor"

@patch("subprocess.run")
@patch("os.path.exists")
@patch("builtins.open")
def test_get_subagent_type_fallback(mock_open, mock_exists, mock_run):
    # Mock subprocess run failing
    mock_res = MagicMock()
    mock_res.returncode = 1
    mock_res.stderr = "error"
    mock_run.return_value = mock_res
    
    # Mock exists for main conv ID file and plugin.json
    mock_exists.side_effect = lambda p: True if ("plugin.json" in str(p) or str(p).endswith("remora_main_conv_id.txt")) else False
    
    # Mock open returning main ID
    m_file = MagicMock()
    m_file.read.return_value = "main_conv_id"
    mock_open.return_value.__enter__.return_value = m_file
    
    res = safety_check.get_subagent_type("/brain/sub_conv_id/transcript.jsonl")
    assert res == "Remora_Subagent_Fallback"

@patch("safety-check.get_subagent_type")
def test_invoke_subagent_payload_limit(mock_get_subagent):
    mock_get_subagent.return_value = None
    
    # Prompt is > 1500 chars
    long_prompt = "x" * 1501
    context = {
        "toolCall": {
            "name": "invoke_subagent",
            "args": {
                "Subagents": [
                    {
                        "TypeName": "Remora_Deep_Diver",
                        "Prompt": long_prompt,
                        "Workspace": "branch"
                    }
                ]
            }
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "PAYLOAD ENFORCEMENT" in res["reason"]

@patch("safety-check.get_subagent_type")
def test_invoke_subagent_sandbox_enforcement(mock_get_subagent):
    mock_get_subagent.return_value = None
    
    # Workspace is not branch/share
    context = {
        "toolCall": {
            "name": "invoke_subagent",
            "args": {
                "Subagents": [
                    {
                        "TypeName": "Remora_Deep_Diver",
                        "Prompt": "short prompt",
                        "Workspace": "inherit" # invalid for Deep_Diver
                    }
                ]
            }
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "SANDBOX ENFORCEMENT" in res["reason"]

@patch("safety-check.get_subagent_type")
def test_invoke_subagent_allow(mock_get_subagent):
    mock_get_subagent.return_value = None
    context = {
        "toolCall": {
            "name": "invoke_subagent",
            "args": {
                "Subagents": [
                    {
                        "TypeName": "Remora_Deep_Diver",
                        "Prompt": "short prompt",
                        "Workspace": "branch"
                    }
                ]
            }
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"

@patch("safety-check.get_subagent_type")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_sensitive_suffixes(mock_getsize, mock_exists, mock_get_subagent):
    mock_exists.return_value = True
    mock_getsize.return_value = 100
    
    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/log.jsonl"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # 1. Main context (not subagent) -> Deny
    mock_get_subagent.return_value = None
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "prohibited to prevent context explosion" in res["reason"]
    
    # 2. ReadOnly subagent -> Allow
    mock_get_subagent.return_value = "Remora_ReadOnly_Extractor"
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"

@patch("safety-check.get_subagent_type")
@patch("safety-check.read_mode")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_single_size_limit(mock_getsize, mock_exists, mock_read_mode, mock_get_subagent):
    mock_get_subagent.return_value = None
    mock_exists.return_value = True
    
    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/source.py"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # 1. Strict mode (limit 50KB), file size 51KB -> Deny
    mock_read_mode.return_value = "strict"
    mock_getsize.return_value = 51 * 1024
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    
    # 2. Relax mode (limit 200KB), file size 51KB -> Allow
    mock_read_mode.return_value = "relax"
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"

@patch("safety-check.get_subagent_type")
@patch("safety-check.accumulate")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_cumulative_limits(mock_getsize, mock_exists, mock_accumulate, mock_get_subagent):
    mock_get_subagent.return_value = None
    mock_exists.return_value = True
    mock_getsize.return_value = 1000
    
    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/code.py"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # Mock accumulated stats exceeding limit
    mock_accumulate.return_value = {
        "accumulated_source_bytes": 401 * 1024,
        "accumulated_data_bytes": 0
    }
    
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "CUMULATIVE READ LIMIT EXCEEDED" in res["reason"]

@patch("safety-check.get_subagent_type")
def test_run_command_rot_feature(mock_get_subagent):
    # command accesses large logs using jq
    cmd_args = {"CommandLine": "jq . /path/to/data.jsonl"}
    context = {
        "toolCall": {
            "name": "run_command",
            "args": cmd_args
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # 1. Main context -> Deny
    mock_get_subagent.return_value = None
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    
    # 2. Subagent (readonly) -> Allow (assuming inspect_command allows)
    mock_get_subagent.return_value = "Remora_ReadOnly_Extractor"
    with patch("safety-check.inspect_command", return_value=("allow", None)):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"

@patch("safety-check.get_subagent_type")
@patch("safety-check.inspect_command")
def test_run_command_deep_diver_rules(mock_inspect, mock_get_subagent):
    # Deep diver executing build command (category build)
    mock_get_subagent.return_value = "Remora_Deep_Diver"
    mock_inspect.return_value = ("deny", "build")
    
    context = {
        "toolCall": {
            "name": "run_command",
            "args": {"CommandLine": "make build"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # Allowed because Deep_Diver can execute build commands
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"

@patch("safety-check.get_subagent_type")
@patch("safety-check.inspect_command")
def test_run_command_normal_deny_categories(mock_inspect, mock_get_subagent):
    mock_get_subagent.return_value = None
    
    context = {
        "toolCall": {
            "name": "run_command",
            "args": {"CommandLine": "some command"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # Test "test" category -> Denied with test suggestion
    mock_inspect.return_value = ("deny", "test")
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "Diagnostic and test commands must be delegated" in res["reason"]
    
    # Test "build" category -> Denied with build suggestion
    mock_inspect.return_value = ("deny", "build")
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "Build commands must be delegated" in res["reason"]

@patch("safety-check.get_subagent_type")
def test_grep_search_sensitive(mock_get_subagent):
    mock_get_subagent.return_value = None
    context = {
        "toolCall": {
            "name": "grep_search",
            "args": {"SearchPath": "/path/to/logs"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }
    
    # Sensitive directory logs in main context -> Deny
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
