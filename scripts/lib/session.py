import json, os

SESSION_DIR = "/tmp/remora_session_modes"

def read_mode(conversation_id, default="strict"):
    path = os.path.join(SESSION_DIR, conversation_id)
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                return json.load(f).get("mode", default)
        except Exception:
            pass
    return default

def write_mode(conversation_id, mode):
    os.makedirs(SESSION_DIR, exist_ok=True)
    with open(os.path.join(SESSION_DIR, conversation_id), 'w') as f:
        json.dump({"mode": mode}, f)
