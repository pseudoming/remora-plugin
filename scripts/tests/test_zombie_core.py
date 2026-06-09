import pytest


class TestIsInfrastructureProcess:
    def test_matches_keyword(self):
        from core.zombie import is_infrastructure_process
        assert is_infrastructure_process("/usr/bin/python3 cognitive-push.py arg") is True

    def test_no_match(self):
        from core.zombie import is_infrastructure_process
        assert is_infrastructure_process("/usr/bin/python3 my_script.py") is False

    def test_custom_keywords(self):
        from core.zombie import is_infrastructure_process
        assert is_infrastructure_process("run my_tool.sh", keywords=frozenset({"my_tool.sh"})) is True
        assert is_infrastructure_process("run other.sh", keywords=frozenset({"my_tool.sh"})) is False


class TestIsProcessExpired:
    def test_expired(self):
        from core.zombie import is_process_expired
        assert is_process_expired(20.0) is True
        assert is_process_expired(20.0, threshold=10.0) is True

    def test_not_expired(self):
        from core.zombie import is_process_expired
        assert is_process_expired(5.0) is False
        assert is_process_expired(15.0) is False

    def test_custom_threshold(self):
        from core.zombie import is_process_expired
        assert is_process_expired(5.0, threshold=3.0) is True
        assert is_process_expired(5.0, threshold=10.0) is False


class TestInfrastructureKeywords:
    def test_contains_expected_entries(self):
        from core.zombie import INFRASTRUCTURE_KEYWORDS
        expected = {
            "compactor.py", "safety-check.py", "zombie-detector.py",
            "cognitive-push.py", "snapshot-git.py", "session-guardian.py",
            "tone-injector.py", "clean-session-stats.py", "action-gate.py",
            "shellIntegration-bash.sh"
        }
        assert INFRASTRUCTURE_KEYWORDS == frozenset(expected)

    def test_is_frozenset(self):
        from core.zombie import INFRASTRUCTURE_KEYWORDS
        assert isinstance(INFRASTRUCTURE_KEYWORDS, frozenset)
