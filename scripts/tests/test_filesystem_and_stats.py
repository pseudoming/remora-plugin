import os
import sys
import shutil
import json
import pytest
import subprocess
from unittest.mock import patch

# Ensure scripts dir is on PATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import lib.filesystem as filesystem
import adapter.bridge.stats as stats

@pytest.fixture
def temp_dir(tmp_path):
    # Create a clean directory structure
    d = tmp_path / "workspace"
    d.mkdir()
    yield d

def test_get_active_files_non_git(temp_dir):
    # Setup files and directories
    src_dir = temp_dir / "src"
    src_dir.mkdir()
    file1 = src_dir / "main.py"
    file1.write_text("print('hello')")
    
    # Blacklisted dirs
    node_modules = temp_dir / "node_modules"
    node_modules.mkdir()
    ignored_file = node_modules / "index.js"
    ignored_file.write_text("const a = 1;")
    
    # Regular nested dir
    lib_dir = temp_dir / "lib"
    lib_dir.mkdir()
    file2 = lib_dir / "utils.py"
    file2.write_text("def run(): pass")

    # Run get_active_files when there is no git repository
    active_files = filesystem.get_active_files(str(temp_dir))
    
    # Assertions
    expected_files = {
        os.path.abspath(file1),
        os.path.abspath(file2)
    }
    assert os.path.abspath(ignored_file) not in active_files
    # Check that our created files are present
    assert os.path.abspath(file1) in active_files
    assert os.path.abspath(file2) in active_files


def test_get_active_files_non_git_file_limit(temp_dir):
    # Test file limit constraint (2000 files)
    # Creating lots of small files
    for i in range(10):
        (temp_dir / f"file_{i}.txt").write_text("a")
    
    # Mocking os.walk limit to lower value (e.g. 5) to trigger the early break
    # Wait, we can just check if we limit to 5 files
    # Instead of creating 2001 files which takes time, let's patch the threshold or check limit
    # filesystem.py: file_count > 2000
    # Let's mock filesystem.get_active_files limit logic or create 2005 files.
    # To keep it quick, we can patch `file_count` limit if we want, but let's look at the logic:
    # We can patch os.walk or create files. Creating 2005 small files in memory temp_dir is quick on Linux,
    # but to be completely safe and fast we can mock `os.walk` or verify basic logic.
    # Actually, we don't have to trigger the limit of 2000 if we have reached high coverage anyway.
    # Let's check how many statements would be missed if we don't hit the `file_count > 2000` break:
    # 29: break; 31: break; (only 2 lines missed).
    # To cover it, we can temporarily monkeypatch the threshold or create 2005 empty files.
    # Let's write a quick loop to create 2005 empty files to be 100% genuine!
    # Creating 2005 empty files in Python takes < 0.2s.
    for i in range(2005):
        (temp_dir / f"f_{i}.txt").touch()
        
    active_files = filesystem.get_active_files(str(temp_dir))
    assert len(active_files) <= 2001 # 2000 plus break logic might include the one causing break


def test_get_active_files_git(temp_dir):
    # Initialize git repository
    subprocess.check_call(['git', 'init'], cwd=str(temp_dir), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Configure dummy user info so git commands work
    subprocess.check_call(['git', 'config', 'user.name', 'test'], cwd=str(temp_dir))
    subprocess.check_call(['git', 'config', 'user.email', 'test@example.com'], cwd=str(temp_dir))
    
    # Create tracked file
    file1 = temp_dir / "tracked.py"
    file1.write_text("print('tracked')")
    subprocess.check_call(['git', 'add', 'tracked.py'], cwd=str(temp_dir))
    
    # Create untracked file
    file2 = temp_dir / "untracked.py"
    file2.write_text("print('untracked')")
    
    # Create ignored file
    gitignore = temp_dir / ".gitignore"
    gitignore.write_text("ignored.py\n")
    subprocess.check_call(['git', 'add', '.gitignore'], cwd=str(temp_dir))
    
    file3 = temp_dir / "ignored.py"
    file3.write_text("print('ignored')")
    
    # Run
    active_files = filesystem.get_active_files(str(temp_dir))
    
    # Assertions
    assert os.path.abspath(file1) in active_files
    assert os.path.abspath(file2) in active_files  # git ls-files --others should include it
    assert os.path.abspath(file3) not in active_files  # excluded by .gitignore


def test_get_active_files_git_exception(temp_dir):
    # Test when git command fails or raises subprocess error, it falls back to non-git os.walk
    # Mock subprocess.check_output to raise subprocess.CalledProcessError
    with patch('subprocess.check_output', side_effect=subprocess.CalledProcessError(1, 'cmd')):
        # Let's ensure git command fails
        file1 = temp_dir / "fallback.py"
        file1.write_text("print('fallback')")
        
        active_files = filesystem.get_active_files(str(temp_dir))
        assert os.path.abspath(file1) in active_files


def test_get_snapshot(temp_dir):
    file1 = temp_dir / "snap.txt"
    file1.write_text("hello")
    
    snapshot = filesystem.get_snapshot(str(temp_dir))
    assert os.path.abspath(file1) in snapshot
    assert snapshot[os.path.abspath(file1)]["size"] == 5
    assert "mtime" in snapshot[os.path.abspath(file1)]


def test_get_snapshot_os_stat_exception(temp_dir):
    # Test that get_snapshot handles stat failure gracefully
    file1 = temp_dir / "snap_error.txt"
    file1.write_text("hello")
    
    with patch('os.stat', side_effect=OSError("permission denied")):
        snapshot = filesystem.get_snapshot(str(temp_dir))
        # The file should not be in snapshot since stat failed
        assert os.path.abspath(file1) not in snapshot


# Stats Tests
@pytest.fixture
def mock_stats_dir(tmp_path, monkeypatch):
    run_dir = tmp_path / "runtime"
    monkeypatch.setattr(stats, "STATS_DIR", str(run_dir))
    return run_dir


def test_get_stats_path(mock_stats_dir):
    path = stats.get_stats_path("my_conv")
    assert path.endswith("my_conv.json")
    assert os.path.exists(mock_stats_dir)


def test_get_stats_file_not_exist(mock_stats_dir):
    # Non-existent conv stats should return default dict
    res = stats.get_stats("missing_conv")
    assert res == {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}


def test_get_stats_corrupted_json(mock_stats_dir):
    path = stats.get_stats_path("corrupt_conv")
    with open(path, 'w') as f:
        f.write("invalid json {")
    
    # Should catch exception and return default dict
    res = stats.get_stats("corrupt_conv")
    assert res == {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}


def test_accumulate_operations(mock_stats_dir):
    conv_id = "test_conv_acc"
    
    # First accumulation
    res1 = stats.accumulate(conv_id, source_add=100, data_add=200)
    assert res1 == {"accumulated_source_bytes": 100, "accumulated_data_bytes": 200}
    
    # Second accumulation
    res2 = stats.accumulate(conv_id, source_add=50, data_add=50)
    assert res2 == {"accumulated_source_bytes": 150, "accumulated_data_bytes": 250}
    
    # Verify we can read it back via get_stats
    assert stats.get_stats(conv_id) == {"accumulated_source_bytes": 150, "accumulated_data_bytes": 250}


def test_accumulate_exception(mock_stats_dir):
    conv_id = "test_conv_err"
    # Make stats directory read-only or mock open to raise exception
    with patch('builtins.open', side_effect=PermissionError("permission denied")):
        res = stats.accumulate(conv_id, 10, 10)
        assert res == {"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}


def test_cleanup_stats(mock_stats_dir):
    conv_id = "test_conv_cleanup"
    stats.accumulate(conv_id, 10, 20)
    
    path = stats.get_stats_path(conv_id)
    assert os.path.exists(path)
    
    stats.cleanup(conv_id)
    assert not os.path.exists(path)
    
    # Cleanup again (should not raise exception when file is missing)
    stats.cleanup(conv_id)
