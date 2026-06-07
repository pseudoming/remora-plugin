import os
import json
import shutil
import subprocess


def get_binary():
    cmd = shutil.which("agentapi")
    if cmd:
        return cmd
    fallback = os.path.expanduser("~/.gemini/antigravity/bin/agentapi")
    if os.path.exists(fallback):
        return fallback
    return "agentapi"


def _call(action, *args, timeout=30, env=None):
    cmd = [get_binary(), action] + list(args)
    if env is None:
        env = os.environ.copy()
    return subprocess.check_output(cmd, env=env, stderr=subprocess.STDOUT, timeout=timeout)


def get_metadata(conv_id, timeout=10):
    result = _call("get-conversation-metadata", conv_id, timeout=timeout)
    data = json.loads(result.decode("utf-8"))
    return data.get("response", {}).get("conversationMetadata", {}).get("metadata", {})


def get_project_id(conv_id, default="11111111-1111-1111-1111-111111111111", timeout=10):
    try:
        meta = get_metadata(conv_id, timeout=timeout)
        return meta.get("projectId") or default
    except Exception:
        return default


def send_message(conv_id, prompt, timeout=120):
    env = os.environ.copy()
    env["ANTIGRAVITY_PROJECT_ID"] = "11111111-1111-1111-1111-111111111111"
    _call("send-message", conv_id, prompt, timeout=timeout, env=env)


def create_conversation(prompt, timeout=120):
    env = os.environ.copy()
    env["ANTIGRAVITY_PROJECT_ID"] = "11111111-1111-1111-1111-111111111111"
    result = _call("new-conversation", prompt, timeout=timeout, env=env)
    return json.loads(result.decode("utf-8"))
