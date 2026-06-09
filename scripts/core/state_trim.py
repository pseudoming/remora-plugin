from core.storage.runtime_state import get_hook_state, set_hook_state, trim_hook_states


def trim_stale_hook_states(conv_id, current_turn_idx):
    last_seen = get_hook_state(conv_id, -1, 'last_seen_turn')
    should_trim = False
    if last_seen is None:
        should_trim = True
    else:
        try:
            should_trim = int(last_seen) != int(current_turn_idx)
        except (ValueError, TypeError):
            should_trim = False

    if should_trim:
        try:
            trim_turn = int(current_turn_idx)
        except (ValueError, TypeError):
            trim_turn = 0
        trim_hook_states(conv_id, trim_turn)
        set_hook_state(conv_id, -1, 'last_seen_turn', str(trim_turn))
