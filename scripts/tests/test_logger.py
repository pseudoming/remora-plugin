import os
import sys
import time
import importlib
from datetime import datetime, timedelta

import pytest

# Ensure scripts dir is on path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


@pytest.fixture(autouse=True)
def reset_logger():
    """Reset the logger module globals before each test."""
    from core import logger
    logger._init_done = False
    logger._log_file = None
    yield
    logger._init_done = False
    logger._log_file = None


@pytest.fixture
def log_dir(monkeypatch, tmp_path):
    """Monkeypatch LOG_DIR to a temporary directory."""
    from core import logger
    monkeypatch.setattr(logger, "LOG_DIR", str(tmp_path))
    return tmp_path


class TestInit:
    def test_first_init_creates_directory_and_state(self, log_dir):
        from core import logger
        # tmp_path is pre-created by pytest; remove it to test fresh creation
        os.rmdir(str(log_dir))
        assert not os.path.exists(str(log_dir))
        logger.init()
        assert os.path.isdir(str(log_dir))
        assert logger._init_done is True
        expected = os.path.join(str(log_dir), "system.log")
        assert logger._log_file == expected

    def test_second_init_is_idempotent(self, log_dir):
        from core import logger
        logger.init()
        logger.init()  # should not crash, not change state
        assert logger._init_done is True


class TestLogWriting:
    def test_info_writes_correct_format(self, log_dir):
        from core import logger
        logger.init()
        logger.info("hello world")
        log_path = os.path.join(str(log_dir), "system.log")
        with open(log_path) as f:
            content = f.read().strip()
        # Format: [YYYY-MM-DD HH:MM:SS] [INFO] [file.py:NN] hello world
        assert "[INFO]" in content
        assert "[test_logger.py:" in content
        assert content.endswith("hello world")

    def test_warn_writes_to_log_and_stderr(self, log_dir, capsys):
        from core import logger
        logger.init()
        logger.warn("danger zone")
        # Check log file
        log_path = os.path.join(str(log_dir), "system.log")
        with open(log_path) as f:
            log_content = f.read().strip()
        assert "[WARN]" in log_content
        assert "danger zone" in log_content
        # Check stderr
        captured = capsys.readouterr()
        assert "[WARN]" in captured.err
        assert "danger zone" in captured.err

    def test_error_writes_to_log_and_stderr(self, log_dir, capsys):
        from core import logger
        logger.init()
        logger.error("fatal failure")
        # Check log file
        log_path = os.path.join(str(log_dir), "system.log")
        with open(log_path) as f:
            log_content = f.read().strip()
        assert "[ERROR]" in log_content
        assert "fatal failure" in log_content
        # Check stderr
        captured = capsys.readouterr()
        assert "[ERROR]" in captured.err
        assert "fatal failure" in captured.err

    def test_profile_writes_prof_level(self, log_dir):
        from core import logger
        logger.init()
        logger.profile("benchmark data")
        log_path = os.path.join(str(log_dir), "system.log")
        with open(log_path) as f:
            content = f.read().strip()
        assert "[PROF]" in content
        assert "benchmark data" in content

    def test_file_content_is_written_and_readable(self, log_dir):
        from core import logger
        logger.init()
        logger.info("line one")
        logger.error("line two")
        log_path = os.path.join(str(log_dir), "system.log")
        with open(log_path) as f:
            lines = [line for line in f]
        assert len(lines) == 2
        assert "line one" in lines[0]
        assert "line two" in lines[1]


class TestRotation:
    def test_rotation_renames_yesterdays_log(self, log_dir):
        from core import logger
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        current = os.path.join(str(log_dir), "system.log")
        os.makedirs(str(log_dir), exist_ok=True)
        # Create yesterday's log file with yesterday's mtime
        with open(current, "w") as f:
            f.write("old log line\n")
        yesterday_ts = (datetime.now() - timedelta(days=1)).timestamp()
        os.utime(current, (yesterday_ts, yesterday_ts))

        logger.init()

        # today's system.log should not contain old content
        assert not os.path.exists(current) or os.path.getmtime(current) != yesterday_ts
        # archived file should exist
        archived = os.path.join(str(log_dir), f"system.{yesterday}.log")
        assert os.path.exists(archived)
        with open(archived) as f:
            assert "old log line" in f.read()

    def test_no_rotation_when_log_is_from_today(self, log_dir):
        from core import logger
        today_str = datetime.now().strftime("%Y-%m-%d")
        current = os.path.join(str(log_dir), "system.log")
        os.makedirs(str(log_dir), exist_ok=True)
        with open(current, "w") as f:
            f.write("today's log\n")
        logger.init()
        # file should still exist and not be renamed
        assert os.path.exists(current)
        with open(current) as f:
            assert "today's log" in f.read()


class TestCleanup:
    def test_cleanup_removes_files_older_than_3_days(self, log_dir):
        from core import logger
        os.makedirs(str(log_dir), exist_ok=True)
        now = datetime.now()

        # Create files 4, 5, 6 days old
        old_files = []
        for days_ago in (4, 5, 6):
            date_str = (now - timedelta(days=days_ago)).strftime("%Y-%m-%d")
            path = os.path.join(str(log_dir), f"system.{date_str}.log")
            with open(path, "w") as f:
                f.write(f"old log {days_ago}d\n")
            old_ts = (now - timedelta(days=days_ago)).timestamp()
            os.utime(path, (old_ts, old_ts))
            old_files.append(path)

        # Create a file that is 2 days old (should survive)
        keep_date = (now - timedelta(days=2)).strftime("%Y-%m-%d")
        keep_path = os.path.join(str(log_dir), f"system.{keep_date}.log")
        with open(keep_path, "w") as f:
            f.write("recent log\n")
        keep_ts = (now - timedelta(days=2)).timestamp()
        os.utime(keep_path, (keep_ts, keep_ts))

        logger.init()

        # Old files should be gone
        for path in old_files:
            assert not os.path.exists(path), f"{path} should have been cleaned up"

        # Recent file should survive
        assert os.path.exists(keep_path)

        # system.log (today's) path should be set
        assert logger._log_file == os.path.join(str(log_dir), "system.log")
