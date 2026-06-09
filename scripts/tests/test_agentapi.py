import os
import sys
import json
import subprocess
import pytest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from adapter.bridge import agentapi


class TestGetBinary:
    def test_found_via_which(self):
        with patch('shutil.which', return_value='/bin/agentapi'):
            assert agentapi.get_binary() == '/bin/agentapi'

    def test_fallback_path_exists(self):
        with patch('shutil.which', return_value=None), \
             patch('os.path.exists', return_value=True):
            result = agentapi.get_binary()
            assert 'agentapi' in result

    def test_fallback_path_missing(self):
        with patch('shutil.which', return_value=None), \
             patch('os.path.exists', return_value=False):
            assert agentapi.get_binary() == 'agentapi'


class TestGetMetadata:
    def test_returns_metadata(self):
        with patch('adapter.bridge.agentapi._call') as mock_call:
            mock_call.return_value = json.dumps({
                "response": {"conversationMetadata": {"metadata": {"typeName": "Test"}}}
            }).encode()
            meta = agentapi.get_metadata("conv1")
            assert meta == {"typeName": "Test"}

    def test_missing_metadata_returns_empty(self):
        with patch('adapter.bridge.agentapi._call') as mock_call:
            mock_call.return_value = b'{"other": "stuff"}'
            meta = agentapi.get_metadata("conv2")
            assert meta == {}


class TestGetProjectId:
    def test_returns_project_id(self):
        with patch('adapter.bridge.agentapi.get_metadata', return_value={"projectId": "proj_abc"}):
            assert agentapi.get_project_id("conv1") == "proj_abc"

    def test_returns_default_when_missing(self):
        with patch('adapter.bridge.agentapi.get_metadata', return_value={}):
            assert agentapi.get_project_id("conv1") == "11111111-1111-1111-1111-111111111111"

    def test_returns_default_on_exception(self):
        with patch('adapter.bridge.agentapi.get_metadata', side_effect=Exception("down")):
            assert agentapi.get_project_id("conv1") == "11111111-1111-1111-1111-111111111111"


class TestSendMessage:
    def test_calls_send_message(self):
        with patch('adapter.bridge.agentapi._call') as mock_call:
            agentapi.send_message("conv1", "hello")
            mock_call.assert_called_once()
            call_args = mock_call.call_args[0]
            assert call_args[0] == "send-message"
            assert call_args[1] == "conv1"
            assert call_args[2] == "hello"


class TestCreateConversation:
    def test_returns_parsed_json(self):
        with patch('adapter.bridge.agentapi.subprocess.check_output') as mock_co:
            mock_co.return_value = b'{"response": {"newConversation": {"conversationId": "new_conv"}}}'
            result = agentapi.create_conversation("init prompt")
            assert result["response"]["newConversation"]["conversationId"] == "new_conv"

    def test_model_flag_injected(self):
        with patch('adapter.bridge.agentapi.subprocess.check_output') as mock_co:
            mock_co.return_value = b'{"ok": true}'
            agentapi.create_conversation("prompt", model="custom-model")
            cmd = mock_co.call_args[0][0]
            assert "--model=custom-model" in cmd

    def test_no_model_flag_when_none(self):
        with patch('adapter.bridge.agentapi.subprocess.check_output') as mock_co:
            mock_co.return_value = b'{"ok": true}'
            agentapi.create_conversation("prompt")
            cmd = mock_co.call_args[0][0]
            assert not any(arg.startswith("--model=") for arg in cmd)
