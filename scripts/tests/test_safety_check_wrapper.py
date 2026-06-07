import os
import sys
import json
import pytest
import io
from unittest.mock import patch, MagicMock

# Ensure scripts directory is in PYTHONPATH
current_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.dirname(current_dir)

import importlib
# safety-check now lives in hooks/, add it to path for module import
_hooks_dir = os.path.join(scripts_dir, 'adapter', 'hooks')
if _hooks_dir not in sys.path:
    sys.path.insert(0, _hooks_dir)
safety_check = importlib.import_module("safety-check")

orig_exists = os.path.exists

def test_get_subagent_type_invalid_paths():
    assert safety_check.get_subagent_type("") is None
    assert safety_check.get_subagent_type("/no/brain/here") is None

@patch("adapter.bridge.subagent.get_metadata")
@patch("os.path.exists")
def test_get_subagent_type_api_success(mock_exists, mock_meta):
    # Ensure plugin.json exists so find_plugin_root succeeds
    mock_exists.side_effect = lambda p: True if "plugin.json" in str(p) else False
    
    mock_meta.return_value = {
        "parentConversationId": "parent123",
        "subagentSpec": {"typeName": "Remora_ReadOnly_Extractor"}
    }
    
    res = safety_check.get_subagent_type("/brain/conv123/transcript.jsonl")
    assert res == "Remora_ReadOnly_Extractor"

@patch("adapter.bridge.subagent.get_metadata")
@patch("os.path.exists")
@patch("builtins.open")
def test_get_subagent_type_fallback(mock_open, mock_exists, mock_meta):
    mock_meta.side_effect = Exception("api down")
    
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
    
    with patch("lib.dao.get_hook_state", return_value=None), \
         patch("lib.dao.set_hook_state"):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"
        assert "injectSteps" in res

    assert "REMORA COORDINATOR JIT INJECTION" in res["injectSteps"][0]["ephemeralMessage"]

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
    assert "DIRECT COMMAND RUNS BLOCKED!" in res["reason"]
    assert "UNTRUSTED CODE EXECUTION PREVENTED" in res["reason"]
    
    # Test "build" category -> Denied with build suggestion
    mock_inspect.return_value = ("deny", "build")
    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "DIRECT COMMAND RUNS BLOCKED!" in res["reason"]
    assert "UNTRUSTED CODE EXECUTION PREVENTED" in res["reason"]

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


# =====================================================================
# Additional branch coverage for safety-check.py
# =====================================================================

@patch("safety-check.get_subagent_type")
def test_invoke_subagent_jit_already_injected(mock_get_subagent):
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

    with patch("lib.dao.get_hook_state", return_value="injected"):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"
        assert "injectSteps" not in res


@patch("safety-check.get_subagent_type")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_getsize_exception(mock_getsize, mock_exists, mock_get_subagent):
    mock_exists.return_value = True
    mock_getsize.side_effect = OSError("permission denied")
    mock_get_subagent.return_value = None

    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/file.py", "StartLine": "1", "EndLine": "10"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("safety-check.accumulate", return_value={"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_range_accumulation(mock_getsize, mock_exists, mock_get_subagent):
    mock_exists.return_value = True
    mock_getsize.return_value = 1000
    mock_get_subagent.return_value = None

    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/file.py", "StartLine": "10", "EndLine": "20"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("safety-check.accumulate") as mock_accumulate:
        mock_accumulate.return_value = {
            "accumulated_source_bytes": 0,
            "accumulated_data_bytes": 0
        }
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
@patch("os.path.exists")
@patch("os.path.getsize")
def test_view_file_accumulate_exception(mock_getsize, mock_exists, mock_get_subagent):
    mock_exists.return_value = True
    mock_getsize.return_value = 1000
    mock_get_subagent.return_value = None

    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/file.py"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("safety-check.accumulate", side_effect=Exception("db error")):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_run_command_readonly_deny(mock_get_subagent):
    mock_get_subagent.return_value = "Remora_ReadOnly_Extractor"

    context = {
        "toolCall": {
            "name": "run_command",
            "args": {"CommandLine": "cat /path/to/data.jsonl"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    # inspect_command returns deny (for something other than allow)
    with patch("safety-check.inspect_command", return_value=("deny", "unknown")):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "deny"
        assert "READONLY" in res["reason"]


@patch("safety-check.get_subagent_type")
@patch("safety-check.inspect_command")
def test_run_command_other_category_deny(mock_inspect, mock_get_subagent):
    mock_get_subagent.return_value = None
    mock_inspect.return_value = ("deny", "unknown_category")

    context = {
        "toolCall": {
            "name": "run_command",
            "args": {"CommandLine": "some_command"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "deny"
    assert "DELEGATION" in res["reason"]


@patch("safety-check.get_subagent_type")
def test_grep_search_sensitive_subagent_allows(mock_get_subagent):
    mock_get_subagent.return_value = "Remora_ReadOnly_Extractor"
    context = {
        "toolCall": {
            "name": "grep_search",
            "args": {"SearchPath": "/path/to/log.jsonl"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_grep_search_sensitive_dir_subagent_allows(mock_get_subagent):
    mock_get_subagent.return_value = "Remora_Deep_Diver"
    context = {
        "toolCall": {
            "name": "grep_search",
            "args": {"SearchPath": "/some/.system_generated/logs"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_grep_search_normal_allows(mock_get_subagent):
    mock_get_subagent.return_value = None
    context = {
        "toolCall": {
            "name": "grep_search",
            "args": {"SearchPath": "/path/to/normal_file.py"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_view_file_sensitive_suffix_without_subagent(mock_get_subagent):
    mock_get_subagent.return_value = None

    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/file.sqlite"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("os.path.exists", return_value=True), patch("os.path.getsize", return_value=100):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "deny"
        assert "prohibited to prevent context explosion" in res["reason"]


@patch("safety-check.get_subagent_type")
def test_view_file_sensitive_suffix_subagent_allow(mock_get_subagent):
    mock_get_subagent.return_value = "Remora_Deep_Diver"

    context = {
        "toolCall": {
            "name": "view_file",
            "args": {"AbsolutePath": "/path/to/file.log"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("os.path.exists", return_value=True), patch("os.path.getsize", return_value=100):
        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_trim_turn_type_error(mock_get_subagent):
    mock_get_subagent.return_value = None
    context = {
        "toolCall": {
            "name": "grep_search",
            "args": {"SearchPath": "/path/to/file.py"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    with patch("adapter.bridge.conversation.ConversationDataAccessLayer") as mock_cdal_cls, \
         patch("lib.dao.get_hook_state", return_value="not_a_number"), \
         patch("safety-check.read_mode", return_value="strict"):
        mock_cdal = MagicMock()
        mock_cdal.get_current_turn_idx.return_value = "not_a_number"
        mock_cdal_cls.return_value = mock_cdal

        res = safety_check.main.__wrapped__(context)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
def test_get_subagent_type_env_cache(mock_get_subagent, tmp_path):
    mock_get_subagent.return_value = None
    runtime_dir = tmp_path / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    env_file = runtime_dir / "remora_agent_env.json"
    env_file.write_text(json.dumps({"TEST_ENV": "test_value"}))

    context = {"toolCall": {"name": "invoke_subagent", "args": {"Subagents": []}}, "transcriptPath": "/brain/conv123/transcript.jsonl"}
    # Verify the env file was created
    assert env_file.exists()


@patch("safety-check.get_subagent_type")
def test_get_subagent_type_no_parent_id(mock_get_subagent):
    mock_get_subagent.return_value = None
    context_none = {
        "toolCall": {
            "name": "view_file",
            "args": {}
        },
        "transcriptPath": ""
    }

    with patch("safety-check.read_mode", return_value="strict"):
        res = safety_check.main.__wrapped__(context_none)
        assert res["decision"] == "allow"


@patch("safety-check.get_subagent_type")
@patch("safety-check.inspect_command")
def test_run_command_allow_no_rot_feature(mock_inspect, mock_get_subagent):
    mock_get_subagent.return_value = None
    mock_inspect.return_value = ("allow", "")

    context = {
        "toolCall": {
            "name": "run_command",
            "args": {"CommandLine": "echo hello"}
        },
        "transcriptPath": "/brain/conv123/transcript.jsonl"
    }

    res = safety_check.main.__wrapped__(context)
    assert res["decision"] == "allow"
