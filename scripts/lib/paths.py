import os

def get_data_dir():
    env_path = os.environ.get("ANTIGRAVITY_EXECUTABLE_DATA_DIR")
    if env_path:
        return env_path
    current_dir = os.path.abspath(os.path.dirname(__file__))
    parts = current_dir.split(os.sep)
    if ".gemini" in parts:
        idx = parts.index(".gemini")
        gemini_root = os.sep.join(parts[:idx + 1])
        antigravity_path = os.path.join(gemini_root, "antigravity")
        if os.path.exists(antigravity_path):
            return os.path.join(antigravity_path, "sidecar_data/remora-plugin/memory-compactor/data")
        return os.path.join(gemini_root, "sidecar_data/remora-plugin/memory-compactor/data")
    return os.path.join(current_dir, "..", "..", "sidecars", "memory-compactor", "data")

def get_db_path():
    return os.path.join(get_data_dir(), "remora_memory.db")
