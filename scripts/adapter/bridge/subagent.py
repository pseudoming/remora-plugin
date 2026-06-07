import os
import re
import json
import subprocess

AGENTAPI_BIN = os.path.expanduser("~/.gemini/antigravity/bin/agentapi")

from adapter.bridge.paths import extract_conv_id


def get_subagent_type(transcript_path):
    conv_id = extract_conv_id(transcript_path)
    if not conv_id:
        return None

    from adapter.bridge.paths import get_data_dir
    data_dir = get_data_dir()

    try:
        env = dict(os.environ)
        env_file = os.path.join(data_dir, ".runtime", "remora_agent_env.json")
        if os.path.exists(env_file):
            try:
                with open(env_file, "r", encoding="utf-8") as ef:
                    cached_env = json.load(ef)
                    env.update(cached_env)
            except Exception:
                pass

        cmd = [AGENTAPI_BIN, "get-conversation-metadata", conv_id]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, env=env)
        if res.returncode == 0:
            data = json.loads(res.stdout)
            metadata = data.get("response", {}).get("conversationMetadata", {}).get("metadata", {})
            parent_id = metadata.get("parentConversationId")
            if not parent_id:
                return None
            return metadata.get("subagentSpec", {}).get("typeName")
        else:
            debug_file = os.path.join(data_dir, ".runtime", "remora_hook_debug.txt")
            with open(debug_file, "a", encoding="utf-8") as df:
                df.write(f"[remora] agentapi returncode={res.returncode}, stderr={res.stderr}\n")
    except Exception as e:
        debug_file = os.path.join(data_dir, ".runtime", "remora_hook_debug.txt")
        try:
            with open(debug_file, "a", encoding="utf-8") as df:
                df.write(f"[remora] agentapi exception: {str(e)}\n")
        except Exception:
            pass

    try:
        main_id_file = os.path.join(data_dir, ".runtime", "remora_main_conv_id.txt")
        if os.path.exists(main_id_file):
            with open(main_id_file, "r") as f:
                main_id = f.read().strip()
                if main_id and conv_id != main_id:
                    return "Remora_Subagent_Fallback"
    except Exception:
        pass
    return None
