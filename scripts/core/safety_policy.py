import os

ROT_SENSITIVE_SUFFIXES = ('.jsonl', '.log', '.sqlite')
ROT_SENSITIVE_PATH_FRAGMENTS = ('/.system_generated', '/logs')
ACCUMULATED_SOURCE_LIMIT = 400 * 1024
ACCUMULATED_DATA_LIMIT = 150 * 1024
LINE_ESTIMATE_BYTES = 50


def enforce_prompt_length_limit(prompt, max_chars=1500):
    """Returns (is_over_limit: bool, deny_reason: dict_or_None)."""
    if len(prompt) > max_chars:
        return True, {
            "prefix": "PAYLOAD ENFORCEMENT",
            "message": f"Subagent Prompt length ({len(prompt)} chars) exceeds {max_chars} limit.",
            "action_tip": "Please partition the task and simplify the description."
        }
    return False, None


def enforce_sandbox_workspace(type_name, workspace, restricted_type=None, valid_workspaces=None):
    """Returns (is_violation: bool, deny_reason: dict_or_None)."""
    if restricted_type is None or type_name != restricted_type:
        return False, None
    _valid = frozenset(valid_workspaces or ())
    if not _valid:
        return False, None
    if workspace not in _valid:
        return True, {
            "prefix": "SANDBOX ENFORCEMENT",
            "message": f'"{type_name}" MUST be invoked with valid workspaces. Direct execution is prohibited!',
            "action_tip": "Direct execution in the main tree is prohibited!"
        }
    return False, None


def is_rot_sensitive_file(target_file):
    """Returns True if target_file has a context-rot sensitive suffix (.jsonl/.log/.sqlite)."""
    return target_file.endswith(ROT_SENSITIVE_SUFFIXES)


def is_rot_sensitive_path(search_path):
    """Returns True if search_path contains /.system_generated or /logs."""
    return any(fragment in search_path for fragment in ROT_SENSITIVE_PATH_FRAGMENTS)


def estimate_read_bytes(args, target_file):
    """Estimate bytes to read. Uses (lines * 50) if StartLine/EndLine present, else os.path.getsize."""
    if os.path.exists(target_file):
        if 'StartLine' in args and 'EndLine' in args:
            return (int(args['EndLine']) - int(args['StartLine']) + 1) * LINE_ESTIMATE_BYTES
        else:
            return os.path.getsize(target_file)
    return 0


def is_accumulated_limit_exceeded(stats):
    """Returns True if accumulated_source > 400KB or accumulated_data > 150KB."""
    return stats["accumulated_source_bytes"] > ACCUMULATED_SOURCE_LIMIT or stats["accumulated_data_bytes"] > ACCUMULATED_DATA_LIMIT


def is_planning_artifact(target_file, artifact_path_fragment=None, artifact_suffixes=None):
    """Returns True if target_file is a planning artifact (path fragment match or suffix match)."""
    if artifact_path_fragment is None and artifact_suffixes is None:
        return False
    if artifact_path_fragment and artifact_path_fragment in target_file:
        return True
    if artifact_suffixes and target_file.endswith(artifact_suffixes):
        return True
    return False
