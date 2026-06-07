import os
import re
import json

from adapter.bridge.paths import extract_conv_id
from adapter.bridge.agentapi import get_metadata


def get_subagent_type(transcript_path):
    conv_id = extract_conv_id(transcript_path)
    if not conv_id:
        return None

    from adapter.bridge.paths import get_data_dir
    data_dir = get_data_dir()

    try:
        metadata = get_metadata(conv_id)
        parent_id = metadata.get("parentConversationId")
        if not parent_id:
            return None
        return metadata.get("subagentSpec", {}).get("typeName")
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
