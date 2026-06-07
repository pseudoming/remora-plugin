import os, json, fcntl

from adapter.bridge.paths import get_data_dir
STATS_DIR = os.path.join(get_data_dir(), ".runtime", "remora_view_file_stats")

def get_stats_path(conv_id):
    os.makedirs(STATS_DIR, exist_ok=True)
    return os.path.join(STATS_DIR, f"{conv_id}.json")

def get_stats(conv_id):
    path = get_stats_path(conv_id)
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}

def accumulate(conv_id, source_add=0, data_add=0):
    path = get_stats_path(conv_id)
    try:
        if not os.path.exists(path):
            with open(path, 'w') as f:
                json.dump({"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}, f)
                
        with open(path, 'r+') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            content = f.read()
            data = json.loads(content) if content else {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}
            
            data["accumulated_source_bytes"] += source_add
            data["accumulated_data_bytes"] += data_add
            
            f.seek(0)
            f.truncate()
            json.dump(data, f)
            fcntl.flock(f, fcntl.LOCK_UN)
            return data
    except Exception:
        return {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}

def cleanup(conv_id):
    path = get_stats_path(conv_id)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass
