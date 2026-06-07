from lib import dao

def read_mode(session_id: str, default: str = "standard") -> str:
    return dao.read_mode(session_id, default)

def write_mode(session_id: str, mode: str):
    dao.write_mode(session_id, mode)