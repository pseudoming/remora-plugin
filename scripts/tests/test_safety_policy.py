from unittest.mock import patch

from core.safety_policy import (
    enforce_prompt_length_limit,
    enforce_sandbox_workspace,
    is_rot_sensitive_file,
    is_rot_sensitive_path,
    estimate_read_bytes,
    is_accumulated_limit_exceeded,
    is_planning_artifact,
)


def test_enforce_prompt_length_limit_under():
    result = enforce_prompt_length_limit("short prompt", max_chars=1500)
    assert result == (False, None)


def test_enforce_prompt_length_limit_over():
    long_prompt = "x" * 2000
    is_over, reason = enforce_prompt_length_limit(long_prompt, max_chars=1500)
    assert is_over is True
    assert reason["prefix"] == "PAYLOAD ENFORCEMENT"
    assert "2000" in reason["message"]


def test_enforce_sandbox_workspace_remora_branch():
    result = enforce_sandbox_workspace("Remora_Deep_Diver", "branch", restricted_type="Remora_Deep_Diver", valid_workspaces={"branch", "share"})
    assert result == (False, None)


def test_enforce_sandbox_workspace_remora_share():
    result = enforce_sandbox_workspace("Remora_Deep_Diver", "share", restricted_type="Remora_Deep_Diver", valid_workspaces={"branch", "share"})
    assert result == (False, None)


def test_enforce_sandbox_workspace_remora_main():
    is_violation, reason = enforce_sandbox_workspace("Remora_Deep_Diver", "main", restricted_type="Remora_Deep_Diver", valid_workspaces={"branch", "share"})
    assert is_violation is True
    assert reason["prefix"] == "SANDBOX ENFORCEMENT"


def test_enforce_sandbox_workspace_other_type():
    result = enforce_sandbox_workspace("Some_Other_Type", "main", restricted_type="Remora_Deep_Diver", valid_workspaces={"branch", "share"})
    assert result == (False, None)


def test_enforce_sandbox_workspace_restricted_type_none():
    result = enforce_sandbox_workspace("Remora_Deep_Diver", "main")
    assert result == (False, None)


def test_enforce_sandbox_workspace_valid_workspaces_none():
    result = enforce_sandbox_workspace("Remora_Deep_Diver", "main", restricted_type="Remora_Deep_Diver")
    assert result == (False, None)


def test_is_rot_sensitive_file_jsonl():
    assert is_rot_sensitive_file("data/logs.jsonl") is True


def test_is_rot_sensitive_file_log():
    assert is_rot_sensitive_file("server.log") is True


def test_is_rot_sensitive_file_sqlite():
    assert is_rot_sensitive_file("mydb.sqlite") is True


def test_is_rot_sensitive_file_py():
    assert is_rot_sensitive_file("src/main.py") is False


def test_is_rot_sensitive_path_system_generated():
    assert is_rot_sensitive_path("/home/user/.system_generated/logs") is True


def test_is_rot_sensitive_path_logs():
    assert is_rot_sensitive_path("/var/logs/app") is True


def test_is_rot_sensitive_path_normal():
    assert is_rot_sensitive_path("/home/user/src") is False


def test_estimate_read_bytes_with_start_end():
    with patch("os.path.exists", return_value=True):
        args = {"StartLine": 10, "EndLine": 110}
        result = estimate_read_bytes(args, "dummy.py")
        assert result == (110 - 10 + 1) * 50


def test_estimate_read_bytes_without_lines():
    with patch("os.path.exists", return_value=True):
        with patch("os.path.getsize", return_value=4096):
            result = estimate_read_bytes({}, "dummy.py")
            assert result == 4096


def test_estimate_read_bytes_file_not_exists():
    with patch("os.path.exists", return_value=False):
        result = estimate_read_bytes({}, "nonexistent.py")
        assert result == 0


def test_is_accumulated_limit_exceeded_under():
    stats = {"accumulated_source_bytes": 100 * 1024, "accumulated_data_bytes": 50 * 1024}
    assert is_accumulated_limit_exceeded(stats) is False


def test_is_accumulated_limit_exceeded_source_over():
    stats = {"accumulated_source_bytes": 500 * 1024, "accumulated_data_bytes": 10 * 1024}
    assert is_accumulated_limit_exceeded(stats) is True


def test_is_accumulated_limit_exceeded_data_over():
    stats = {"accumulated_source_bytes": 10 * 1024, "accumulated_data_bytes": 200 * 1024}
    assert is_accumulated_limit_exceeded(stats) is True


def test_is_planning_artifact_artifacts_path():
    assert is_planning_artifact("/project/artifacts/plan.md", artifact_path_fragment="/artifacts/", artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md")) is True


def test_is_planning_artifact_task_md():
    assert is_planning_artifact("/project/task.md", artifact_path_fragment="/artifacts/", artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md")) is True


def test_is_planning_artifact_walkthrough_md():
    assert is_planning_artifact("walkthrough.md", artifact_path_fragment="/artifacts/", artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md")) is True


def test_is_planning_artifact_implementation_plan():
    assert is_planning_artifact("/home/user/implementation_plan.md", artifact_path_fragment="/artifacts/", artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md")) is True


def test_is_planning_artifact_py():
    assert is_planning_artifact("src/main.py", artifact_path_fragment="/artifacts/", artifact_suffixes=("task.md", "implementation_plan.md", "walkthrough.md")) is False


def test_is_planning_artifact_both_none():
    assert is_planning_artifact("task.md") is False
