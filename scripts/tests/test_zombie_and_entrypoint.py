#!/usr/bin/env python3
import sys
import os
import json
import unittest
from unittest.mock import patch, MagicMock
import importlib.util

# Inject paths
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

# Dynamically import hyphenated script
spec = importlib.util.spec_from_file_location(
    "zombie_detector", 
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "zombie-detector.py"))
)
zombie_detector = importlib.util.module_from_spec(spec)
sys.modules["zombie_detector"] = zombie_detector
spec.loader.exec_module(zombie_detector)

from lib.context import hook_entrypoint

class TestHookEntrypointRefactor(unittest.TestCase):
    @patch("sys.stdin")
    @patch("sys.stdout")
    def test_system_exit_non_zero(self, mock_stdout, mock_stdin):
        mock_stdin.read.return_value = '{"test": "data"}'
        mock_stdin.isatty.return_value = False
        
        with patch("json.load", return_value={"toolCall": {"name": "test"}, "test": "data"}):
            @hook_entrypoint(fallback_result={"decision": "allow"})
            def dummy_hook(context):
                sys.exit(1)
                
            with self.assertRaises(SystemExit) as cm:
                dummy_hook()
            self.assertEqual(cm.exception.code, 0)
            
            printed = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data = json.loads(printed.strip())
            self.assertEqual(data.get("decision"), "deny")
            self.assertIn("SystemExit with code 1", data.get("reason", ""))

    @patch("sys.stdin")
    @patch("sys.stdout")
    def test_system_exit_zero(self, mock_stdout, mock_stdin):
        with patch("json.load", return_value={"test": "data"}):
            @hook_entrypoint(fallback_result={"decision": "allow"})
            def dummy_hook(context):
                sys.exit(0)
                
            with self.assertRaises(SystemExit) as cm:
                dummy_hook()
            self.assertEqual(cm.exception.code, 0)
            
            printed = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            self.assertNotIn("decision", printed)

    @patch("sys.stdin")
    @patch("sys.stdout")
    def test_base_exception_fatal(self, mock_stdout, mock_stdin):
        with patch("json.load", return_value={"toolCall": {"name": "test"}, "test": "data"}):
            @hook_entrypoint(fallback_result={"decision": "allow"})
            def dummy_hook(context):
                raise KeyboardInterrupt("interrupted")
                
            with self.assertRaises(SystemExit) as cm:
                dummy_hook()
            self.assertEqual(cm.exception.code, 0)
            
            printed = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data = json.loads(printed.strip())
            self.assertEqual(data.get("decision"), "deny")
            self.assertIn("Fatal Exception: KeyboardInterrupt: interrupted", data.get("reason", ""))

class TestZombieDetectorInterception(unittest.TestCase):
    @patch("zombie_detector.os.getuid", return_value=1000)
    @patch("zombie_detector.os.listdir", return_value=["1234"])
    @patch("zombie_detector.os.stat")
    @patch("zombie_detector.get_sys_uptime", return_value=100.0)
    @patch("zombie_detector.os.sysconf", return_value=100)
    @patch("zombie_detector.clean_whitelist", return_value=set())
    @patch("sys.stdout")
    @patch("os.replace")
    def test_zombie_detected_pre_tool_use(self, mock_replace, mock_stdout, mock_clean, mock_sysconf, mock_uptime, mock_stat, mock_listdir, mock_getuid):
        mock_stat.return_value.st_uid = 1000
        
        def mock_open_file(filepath, mode="r", *args, **kwargs):
            m = MagicMock()
            m.__enter__.return_value = m
            m.fileno.return_value = 1
            filepath = str(filepath)
            if "environ" in filepath:
                m.read.return_value = b"ANTIGRAVITY_AGENT=true\x00"
            elif "stat" in filepath:
                stat_fields = ["0"] * 50
                stat_fields[21] = "5000"
                m.read.return_value = " ".join(stat_fields)
            elif "cmdline" in filepath:
                m.read.return_value = b"python3 custom-process.py\x00"
            return m

        with patch("builtins.open", side_effect=mock_open_file):
            # 1. PreToolUse stage (context has toolCall)
            context_tool = {"toolCall": {"name": "run_command", "args": {"CommandLine": "ls"}}}
            with patch("json.load", return_value=context_tool):
                with self.assertRaises(SystemExit) as cm:
                    zombie_detector.main()
                self.assertEqual(cm.exception.code, 0)
                
            printed_tool = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data_tool = json.loads(printed_tool.strip())
            self.assertEqual(data_tool.get("decision"), "deny")
            self.assertIn("安全拦截", data_tool.get("reason", ""))
            self.assertIn("1234", data_tool.get("reason", ""))
            
            # Reset mock
            mock_stdout.write.reset_mock()

            # 2. PreInvocation stage (context has no toolCall)
            context_invoke = {"transcriptPath": "/tmp/brain/mock-conv-id/transcript.jsonl", "invocationNum": 1}
            with patch("json.load", return_value=context_invoke):
                with self.assertRaises(SystemExit) as cm:
                    zombie_detector.main()
                self.assertEqual(cm.exception.code, 0)
                
            printed_invoke = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data_invoke = json.loads(printed_invoke.strip())
            self.assertIn("injectSteps", data_invoke)
            steps = data_invoke["injectSteps"]
            self.assertEqual(len(steps), 1)
            msg = steps[0]["ephemeralMessage"]
            self.assertIn("警告：检测到未托管衍生后台进程", msg)
            self.assertIn("1234", msg)

    @patch("zombie_detector.os.getuid", return_value=1000)
    @patch("zombie_detector.os.listdir", return_value=["1234"])
    @patch("zombie_detector.os.stat")
    @patch("zombie_detector.get_sys_uptime", return_value=100.0)
    @patch("zombie_detector.os.sysconf", return_value=100)
    @patch("zombie_detector.clean_whitelist", return_value=set())
    @patch("sys.stdout")
    @patch("os.replace")
    def test_manage_task_allowed_during_zombie_presence(self, mock_replace, mock_stdout, mock_clean, mock_sysconf, mock_uptime, mock_stat, mock_listdir, mock_getuid):
        mock_stat.return_value.st_uid = 1000
        
        def mock_open_file(filepath, mode="r", *args, **kwargs):
            m = MagicMock()
            m.__enter__.return_value = m
            m.fileno.return_value = 1
            filepath = str(filepath)
            if "environ" in filepath:
                m.read.return_value = b"ANTIGRAVITY_AGENT=true\x00"
            elif "stat" in filepath:
                stat_fields = ["0"] * 50
                stat_fields[21] = "5000"
                m.read.return_value = " ".join(stat_fields)
            elif "cmdline" in filepath:
                m.read.return_value = b"python3 custom-process.py\x00"
            return m

        with patch("builtins.open", side_effect=mock_open_file):
            context_tool = {"toolCall": {"name": "manage_task", "args": {"Action": "list"}}}
            with patch("json.load", return_value=context_tool):
                with self.assertRaises(SystemExit) as cm:
                    zombie_detector.main()
                self.assertEqual(cm.exception.code, 0)
                
            printed_tool = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data_tool = json.loads(printed_tool.strip())
            self.assertEqual(data_tool.get("decision"), "allow")

    @patch("builtins.open")
    def test_get_sys_uptime(self, mock_open):
        # 1. Success case
        mock_file = MagicMock()
        mock_file.read.return_value = "123.45 67.89\n"
        mock_open.return_value.__enter__.return_value = mock_file
        val = zombie_detector.get_sys_uptime()
        self.assertEqual(val, 123.45)

        # 2. Exception case
        mock_open.side_effect = IOError("failed to open")
        val = zombie_detector.get_sys_uptime()
        self.assertEqual(val, 0.0)

    @patch("zombie_detector.HOOKS_PROFILE_LOG", "/tmp/mock_hooks_profile.log")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("builtins.open")
    def test_log_duration(self, mock_open, mock_getsize, mock_exists):
        # 1. Rotated log (size > 1MB)
        mock_exists.return_value = True
        mock_getsize.return_value = 2 * 1024 * 1024
        mock_file = MagicMock()
        mock_open.return_value.__enter__.return_value = mock_file
        
        zombie_detector.log_duration(15.2, 0)
        
        # Verify both write calls happened (write for truncation, and write for append)
        self.assertTrue(mock_file.write.called)

    @patch("os.path.exists")
    @patch("builtins.open")
    @patch("os.makedirs")
    def test_clean_whitelist(self, mock_makedirs, mock_open, mock_exists):
        # 1. Not exists
        mock_exists.return_value = False
        res = zombie_detector.clean_whitelist("/tmp/whitelist")
        self.assertEqual(res, set())

        # 2. Exists with mixed pids
        # Mock paths:
        # whitelist path exists
        # /proc/123 exists, /proc/456 does not
        def mock_exists_side_effect(path):
            if path == "/tmp/whitelist":
                return True
            if "/proc/123" in str(path):
                return True
            if "/proc/456" in str(path):
                return False
            return False
        
        mock_exists.side_effect = mock_exists_side_effect
        
        mock_file = MagicMock()
        mock_file.__iter__.return_value = ["123\n", "456\n"]
        mock_open.return_value.__enter__.return_value = mock_file
        
        res = zombie_detector.clean_whitelist("/tmp/whitelist")
        self.assertEqual(res, {"123"})

    @patch("zombie_detector.os.listdir")
    @patch("zombie_detector.os.getuid", return_value=1000)
    @patch("zombie_detector.get_sys_uptime", return_value=100.0)
    @patch("zombie_detector.os.sysconf", return_value=100)
    @patch("sys.stdout")
    def test_zombie_detector_various_proc_conditions(self, mock_stdout, mock_sysconf, mock_uptime, mock_getuid, mock_listdir):
        # Test proc scan error
        mock_listdir.side_effect = OSError("Access denied")
        context_tool = {"toolCall": {"name": "run_command"}}
        with patch("json.load", return_value=context_tool):
            with self.assertRaises(SystemExit) as cm:
                zombie_detector.main()
            self.assertEqual(cm.exception.code, 0)
        
        # Test digit, state, and other branches
        mock_listdir.side_effect = None
        # PIDs: "not_digit" (ignored), "9999" (uid different), "8888" (D state), "7777" (recent uptime), "6666" (infra cmdline), "5555" (zombie)
        mock_listdir.return_value = ["not_digit", "9999", "8888", "7777", "6666", "5555"]
        
        # Mock os.stat
        mock_stat_1000 = MagicMock(st_uid=1000)
        mock_stat_2000 = MagicMock(st_uid=2000)
        
        def mock_stat(path):
            if "9999" in str(path):
                return mock_stat_2000
            return mock_stat_1000
        
        def mock_open_file(filepath, mode="r", *args, **kwargs):
            m = MagicMock()
            m.__enter__.return_value = m
            m.fileno.return_value = 1
            filepath = str(filepath)
            
            if "environ" in filepath:
                # 8888, 7777, 6666, 5555 are antigravity
                m.read.return_value = b"ANTIGRAVITY_AGENT=true\x00"
            elif "stat" in filepath:
                stat_fields = ["0"] * 50
                if "8888" in filepath:
                    stat_fields[2] = "D"  # uninterruptible state
                else:
                    stat_fields[2] = "R"
                
                if "7777" in filepath:
                    stat_fields[21] = "9500"  # uptime check: sys_uptime - (9500/100) = 100 - 95 = 5.0 <= 15
                else:
                    stat_fields[21] = "5000"  # uptime check: 100 - 50 = 50.0 > 15
                
                m.read.return_value = " ".join(stat_fields)
            elif "cmdline" in filepath:
                if "6666" in filepath:
                    m.read.return_value = b"python3 session-guardian.py\x00"  # infra whitelist
                elif "5555" in filepath:
                    m.read.return_value = b"python3 rogue-zombie.py\x00"
                else:
                    m.read.return_value = b"other\x00"
            return m

        with patch("zombie_detector.os.stat", side_effect=mock_stat), \
             patch("builtins.open", side_effect=mock_open_file), \
             patch("zombie_detector.clean_whitelist", return_value=set()):
            
            # Reset mock write from the first run
            mock_stdout.write.reset_mock()
            
            with patch("json.load", return_value={"toolCall": {"name": "test"}}):
                with self.assertRaises(SystemExit) as cm:
                    zombie_detector.main()
                self.assertEqual(cm.exception.code, 0)
                
            printed = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
            data = json.loads(printed.strip())
            self.assertEqual(data.get("decision"), "deny")
            self.assertIn("5555", data.get("reason", ""))

        # Test proc scan error without toolCall (PreInvocation stage)
        mock_listdir.side_effect = OSError("Access denied")
        mock_stdout.write.reset_mock()
        with patch("json.load", return_value={"transcriptPath": "foo.jsonl"}):
            with self.assertRaises(SystemExit) as cm:
                zombie_detector.main()
            self.assertEqual(cm.exception.code, 0)
        printed = "".join(call[0][0] for call in mock_stdout.write.call_args_list)
        data = json.loads(printed.strip())
        self.assertEqual(data, {})

if __name__ == "__main__":
    unittest.main()

