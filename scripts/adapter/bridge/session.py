from lib import dao

def read_mode(session_id: str, default: str = "standard") -> str:
    return dao.read_mode(session_id, default)