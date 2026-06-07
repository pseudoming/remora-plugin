import os
import sys
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from unittest.mock import patch, mock_open


class TestGetSysUptime:
    def test_normal(self):
        from core.zombie import get_sys_uptime
        mock_file = mock_open(read_data="123.45 67.89\n")
        with patch("core.zombie.open", mock_file):
            val = get_sys_uptime()
            assert val == 123.45

    def test_exception_returns_zero(self):
        from core.zombie import get_sys_uptime
        with patch("core.zombie.open", side_effect=IOError("fail")):
            val = get_sys_uptime()
            assert val == 0.0


class TestCleanWhitelist:
    def test_file_not_exists(self, tmp_path):
        from core.zombie import clean_whitelist
        nonexistent = str(tmp_path / "nonexistent")
        result = clean_whitelist(nonexistent)
        assert result == set()

    def test_stale_pids_cleaned(self, tmp_path):
        from core.zombie import clean_whitelist
        whitelist_path = tmp_path / "whitelist"
        whitelist_path.write_text("123\n456\n789\n")

        def mock_exists(path):
            path_str = str(path)
            if path_str == str(whitelist_path):
                return True
            if "/proc/456" in path_str:
                return True
            return False

        with patch("core.zombie.os.path.exists", side_effect=mock_exists), \
             patch("core.zombie.os.makedirs"):
            result = clean_whitelist(str(whitelist_path))
            assert result == {"456"}
            content = whitelist_path.read_text()
            assert "123" not in content
            assert "789" not in content
            assert "456" in content

    def test_valid_pids_kept(self, tmp_path):
        from core.zombie import clean_whitelist
        whitelist_path = tmp_path / "whitelist"
        whitelist_path.write_text("111\n222\n333\n")

        def mock_exists(path):
            path_str = str(path)
            if path_str == str(whitelist_path):
                return True
            if "/proc/" in path_str:
                return True
            return False

        with patch("core.zombie.os.path.exists", side_effect=mock_exists), \
             patch("core.zombie.os.makedirs"):
            result = clean_whitelist(str(whitelist_path))
            assert result == {"111", "222", "333"}
            content = whitelist_path.read_text()
            assert "111" in content
            assert "222" in content
            assert "333" in content

    def test_empty_lines_ignored(self, tmp_path):
        from core.zombie import clean_whitelist
        whitelist_path = tmp_path / "whitelist"
        whitelist_path.write_text("\n\n42\n\n\n")

        def mock_exists(path):
            path_str = str(path)
            if path_str == str(whitelist_path):
                return True
            if "/proc/42" in path_str:
                return True
            return False

        with patch("core.zombie.os.path.exists", side_effect=mock_exists), \
             patch("core.zombie.os.makedirs"):
            result = clean_whitelist(str(whitelist_path))
            assert result == {"42"}
            content = whitelist_path.read_text()
            assert content.strip() == "42"

    def test_read_exception_graceful(self, tmp_path):
        from core.zombie import clean_whitelist
        whitelist_path = tmp_path / "whitelist"
        whitelist_path.write_text("111\n")

        with patch("core.zombie.os.path.exists", return_value=True), \
             patch("core.zombie.open", side_effect=IOError("fail")):
            result = clean_whitelist(str(whitelist_path))
            assert result == set()


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
