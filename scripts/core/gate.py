from core.storage.runtime_state import get_hook_state as _get, set_hook_state as _set

def should_fire(conv_id: str, key: str, value) -> bool:
    """Returns True if stored value != given value (or no stored value)."""
    prev = _get(conv_id, -1, key)
    return str(prev) != str(value)

def mark_fired(conv_id: str, key: str, value) -> None:
    """Record that this gate has fired for this value."""
    _set(conv_id, -1, key, str(value))

def is_duplicate(conv_id: str, key: str, value) -> bool:
    """Returns True if this exact value was already recorded (same-window dedup)."""
    prev = _get(conv_id, -1, key)
    return str(prev) == str(value)

def clear_stale(conv_id: str, key: str, new_value) -> None:
    """Delete old record if stored value differs from new_value (cross-window re-alert)."""
    prev = _get(conv_id, -1, key)
    if prev and str(prev) != str(new_value):
        from core.storage.runtime_state import delete_hook_state as _del
        _del(conv_id, -1, key)
