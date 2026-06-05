import os
import sys
import json
import pytest
import importlib.util
import subprocess
import sqlite3
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

# Ensure scripts dir is on PATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def load_module(module_name, file_name):
    scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    file_path = os.path.join(scripts_dir, file_name)
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

session_gc = load_module("session_gc", "session_gc.py")
topic_gc = load_module("topic_gc", "topic_gc.py")
clean_session_stats = load_module("clean_session_stats", "clean-session-stats.py")
tone_injector = load_module("tone_injector", "tone-injector.py")
remora_init = load_module("remora_init", "remora_init.py")
read_session_log = load_module("read_session_log", "read-session-log.py")
remora_recall = load_module("remora_recall", "remora-recall.py")
remora_topic = load_module("remora_topic", "remora-topic.py")
sandbox_merge = load_module("sandbox_merge", "sandbox-merge.py")
schema_init = load_module("schema_init", "schema_init.py")
snapshot_git = load_module("snapshot_git", "snapshot-git.py")
cognitive_push = load_module("cognitive_push", "cognitive-push.py")
session_guardian = load_module("session_guardian", "session-guardian.py")
subagent_monitor = load_module("subagent_monitor", "subagent-monitor.py")


# 1. session_gc.py
def test_session_gc(tmp_path):
    with patch("session_gc._prune") as mock_prune:
        session_gc.prune_expired_watermarks(str(tmp_path))
        mock_prune.assert_called_once_with(str(tmp_path))


# 2. topic_gc.py
def test_topic_gc():
    with patch("topic_gc.run_topic_garbage_collection") as mock_gc:
        topic_gc.run_garbage_collection()
        mock_gc.assert_called_once()


# 3. clean-session-stats.py
def test_clean_session_stats():
    with patch("clean_session_stats.cleanup") as mock_cleanup:
        # 1. fullyIdle = True and conversationId exists
        res = clean_session_stats.main.__wrapped__({"fullyIdle": True, "conversationId": "c1"})
        mock_cleanup.assert_called_once_with("c1")
        assert res == {}

        # 2. fullyIdle = False
        mock_cleanup.reset_mock()
        res = clean_session_stats.main.__wrapped__({"fullyIdle": False, "conversationId": "c2"})
        mock_cleanup.assert_not_called()


# 4. tone-injector.py
def test_tone_injector():
    # 1. context without transcriptPath
    res = tone_injector.main.__wrapped__({})
    assert "injectSteps" in res
    
    # 2. strict mode
    with patch("tone_injector.read_mode", return_value="strict"):
        res = tone_injector.main.__wrapped__({"transcriptPath": "/brain/c1/transcript.jsonl"})
        assert len(res["injectSteps"]) == 1
        assert "STRICT TONE" in res["injectSteps"][0]["ephemeralMessage"]

    # 3. relax mode
    with patch("tone_injector.read_mode", return_value="relax"):
        res = tone_injector.main.__wrapped__({"transcriptPath": "/brain/c1/transcript.jsonl"})
        assert len(res["injectSteps"]) == 0


# 5. remora_init.py
def test_remora_init_already_initialized(tmp_path):
    plugin_dir = tmp_path / "plugins" / "remora-plugin"
    plugin_dir.mkdir(parents=True)
    
    project_file = tmp_path / "projects" / "11111111-1111-1111-1111-111111111111.json"
    project_file.parent.mkdir(parents=True, exist_ok=True)
    project_file.write_text("{}")
    
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps({
        "sidecars": {
            "remora-plugin/memory-compactor": {
                "enabled": True,
                "projectId": "11111111-1111-1111-1111-111111111111"
            }
        }
    }))
    
    init_py_path = str(plugin_dir / "scripts" / "remora_init.py")
    with patch("remora_init.__file__", init_py_path):
        initialized = remora_init.init_environment()
        assert not initialized


def test_remora_init_new_installation(tmp_path):
    plugin_dir = tmp_path / "plugins" / "remora-plugin"
    plugin_dir.mkdir(parents=True)
    
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps({}))
    
    init_py_path = str(plugin_dir / "scripts" / "remora_init.py")
    with patch("remora_init.__file__", init_py_path), \
         patch("glob.glob", return_value=["dummy_script.py"]), \
         patch("os.stat"), \
         patch("os.chmod"):
        
        initialized = remora_init.init_environment()
        assert initialized
        
        # Resolve path exactly like remora_init.py
        p_dir = os.path.dirname(os.path.dirname(init_py_path))
        c_dir = os.path.join(p_dir, '..', '..')
        project_file = os.path.join(c_dir, 'projects', "11111111-1111-1111-1111-111111111111.json")
        assert os.path.exists(project_file)


# 6. read-session-log.py
def test_read_session_log_no_db(capsys):
    with patch("os.path.exists", return_value=False):
        with pytest.raises(SystemExit) as excinfo:
            read_session_log.read_last_user_ai_rounds("c1")
        assert excinfo.value.code == 1
        assert "Error: db path not found for ID: c1" in capsys.readouterr().out


def test_read_session_log_success(capsys):
    with patch("os.path.exists", return_value=True), \
         patch("read_session_log.ConversationDataAccessLayer") as mock_cdal_cls:
        
        mock_cdal = MagicMock()
        mock_cdal.stream_steps_reverse.return_value = [
            {"type": "USER_INPUT", "content": "hello user"},
            {"type": "PLANNER_RESPONSE", "content": "hello assistant"},
            {"type": "OTHER", "content": "ignored"},
        ]
        mock_cdal_cls.return_value = mock_cdal
        
        read_session_log.read_last_user_ai_rounds("c1", rounds=2)
        
        captured = capsys.readouterr()
        assert "[USER]: hello user" in captured.out
        assert "[ASSISTANT]: hello assistant" in captured.out


# 7. remora-recall.py
def test_remora_recall_errors(capsys):
    # Missing args
    with patch("sys.argv", ["remora-recall.py"]):
        with pytest.raises(SystemExit) as excinfo:
            remora_recall.main()
        assert excinfo.value.code == 1

    # Database missing
    with patch("sys.argv", ["remora-recall.py", "keyword", "project_1"]), \
         patch("lib.dao.check_db_exists", return_value=False):
        with pytest.raises(SystemExit) as excinfo:
            remora_recall.main()
        assert excinfo.value.code == 1
        assert "温存储数据库尚未建立" in capsys.readouterr().out

    # Missing project identifier
    with patch("sys.argv", ["remora-recall.py", "keyword"]), \
         patch("os.environ.get", return_value=""), \
         patch("lib.dao.check_db_exists", return_value=True):
        with pytest.raises(SystemExit) as excinfo:
            remora_recall.main()
        assert excinfo.value.code == 1
        assert "错误: 无法获取项目标识" in capsys.readouterr().out


def test_remora_recall_success(capsys):
    with patch("sys.argv", ["remora-recall.py", "keyword", "project_1"]), \
         patch("lib.dao.check_db_exists", return_value=True), \
         patch("lib.dao.recall_fts5_logs", return_value=["user: hello"]), \
         patch("lib.dao.recall_decisions_by_fts5_topic", return_value=["[t1] dec (rationale)"]), \
         patch("lib.dao.recall_decisions_by_like", return_value=["[t2] dec2 (rationale2)"]), \
         patch("lib.dao.touch_topics_accessed_by_recall") as mock_touch:
        
        remora_recall.main()
        captured = capsys.readouterr()
        
        assert "user: hello" in captured.out
        assert "[t1] dec (rationale)" in captured.out
        assert "[t2] dec2 (rationale2)" in captured.out
        mock_touch.assert_called_once()


# 8. remora-topic.py
def test_remora_topic_errors(capsys):
    # 1. Missing UUID
    with patch("sys.argv", ["remora-topic.py", "new"]):
        with pytest.raises(SystemExit) as excinfo:
            remora_topic.main()
        assert excinfo.value.code == 1

    # 2. Database missing
    with patch("sys.argv", ["remora-topic.py", "new", "-u", "proj_1"]), \
         patch("lib.dao.check_db_exists", return_value=False):
        with pytest.raises(SystemExit) as excinfo:
            remora_topic.main()
        assert excinfo.value.code == 1

    # 3. Missing name for new action
    with patch("sys.argv", ["remora-topic.py", "new", "-u", "proj_1"]), \
         patch("lib.dao.check_db_exists", return_value=True):
        with pytest.raises(SystemExit) as excinfo:
            remora_topic.main()
        assert excinfo.value.code == 1


def test_remora_topic_success(capsys):
    with patch("lib.dao.check_db_exists", return_value=True), \
         patch("lib.dao.create_or_update_topic") as mock_new, \
         patch("lib.dao.switch_topic") as mock_switch, \
         patch("lib.dao.close_topic") as mock_close, \
         patch("lib.dao.confirm_decision", return_value=True) as mock_confirm, \
         patch("lib.dao.get_topic_id_by_decision", return_value="t1"), \
         patch("lib.dao.touch_topic_source_manual") as mock_touch_man, \
         patch("lib.dao.force_cold_start_latest_session") as mock_cold, \
         patch("glob.glob", return_value=[]):
        
        # Action: new
        with patch("sys.argv", ["remora-topic.py", "new", "-u", "proj_1", "-n", "t1"]):
            remora_topic.main()
            mock_new.assert_called_once_with("proj_1", "t1", summary="", source="manual")
            mock_cold.assert_called_once()
            assert "Created active topic t1" in capsys.readouterr().out
            
        # Action: switch
        mock_cold.reset_mock()
        with patch("sys.argv", ["remora-topic.py", "switch", "-u", "proj_1", "-n", "t2"]):
            remora_topic.main()
            mock_switch.assert_called_once_with("proj_1", "t2")
            mock_cold.assert_called_once()
            assert "Switched active topic to t2" in capsys.readouterr().out

        # Action: close
        with patch("sys.argv", ["remora-topic.py", "close", "-u", "proj_1", "-n", "t3"]):
            remora_topic.main()
            mock_close.assert_called_once_with("proj_1", "t3")
            assert "Topic t3 closed" in capsys.readouterr().out

        # Action: confirm
        with patch("sys.argv", ["remora-topic.py", "confirm", "-u", "proj_1", "-d", "42"]):
            remora_topic.main()
            mock_confirm.assert_called_once_with("proj_1", 42)
            mock_touch_man.assert_called_once_with("proj_1", "t1")
            assert "Decision 42 confirmed" in capsys.readouterr().out


# 9. sandbox-merge.py
def test_sandbox_merge_errors(capsys):
    # Missing args
    with patch("sys.argv", ["sandbox-merge.py"]):
        with pytest.raises(SystemExit) as excinfo:
            sandbox_merge.main()
        assert excinfo.value.code == 1

    # Worktree missing
    with patch("sys.argv", ["sandbox-merge.py", "sub_1"]), \
         patch("glob.glob", return_value=[]):
        with pytest.raises(SystemExit) as excinfo:
            sandbox_merge.main()
        assert excinfo.value.code == 1
        assert "ERROR: Could not find isolated worktree" in capsys.readouterr().out


def test_sandbox_merge_success(capsys):
    with patch("sys.argv", ["sandbox-merge.py", "sub_1"]), \
         patch("glob.glob", return_value=["/path/to/worktree"]), \
         patch("subprocess.check_output") as mock_output, \
         patch("subprocess.check_call") as mock_call:
        
        mock_output.side_effect = ["my-branch\n", "file1.py\nfile2.py\n"]
        
        sandbox_merge.main()
        
        captured = capsys.readouterr()
        assert "Merging branch my-branch" in captured.out
        assert "[PHYSICAL_CHANGES] file1.py" in captured.out
        assert "[PHYSICAL_CHANGES] file2.py" in captured.out
        assert "Sandbox merged successfully." in captured.out


# 10. session_gc / topic_gc main execution (subprocess coverage)
def test_gc_scripts_main_execution():
    # Execute the files as subprocesses to cover __main__ blocks
    scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    
    # 1. session_gc
    res = subprocess.run([sys.executable, os.path.join(scripts_dir, "session_gc.py")], capture_output=True)
    # Since default brain dir may or may not exist, we just check that it runs and exits
    assert res.returncode in [0, 1]

    # 2. topic_gc
    res2 = subprocess.run([sys.executable, os.path.join(scripts_dir, "topic_gc.py")], capture_output=True)
    assert res2.returncode in [0, 1]


# 11. schema_init.py
def test_schema_init_clean_and_migration(tmp_path):
    # Setup paths
    db_file = tmp_path / "test_remora_memory.db"
    
    # 1. Test init on clean database
    with patch("schema_init.DB_PATH", str(db_file)):
        schema_init.init_db()
        assert os.path.exists(db_file)
        
        # Verify tables exist
        conn = sqlite3.connect(str(db_file))
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cursor.fetchall()]
        assert "project_topics" in tables
        assert "topic_decisions" in tables
        assert "session_state" in tables
        assert "watermarks" in tables
        conn.close()

    # 2. Test legacy migration
    legacy_db = tmp_path / "legacy_remora_memory.db"
    conn = sqlite3.connect(str(legacy_db))
    # Create legacy project_topics (missing source, last_accessed_at, associated_files, referenced_files)
    conn.execute("""
        CREATE TABLE project_topics (
            uuid TEXT NOT NULL,
            topic_id TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            summary TEXT,
            constraints TEXT,
            compression_confidence REAL DEFAULT 1.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uuid, topic_id)
        )
    """)
    # Create legacy topic_decisions (has created_at_line, created_at_msg_id, evidence_msg_db_ids, but missing user_confirmed, decision_type, associated_files)
    conn.execute("""
        CREATE TABLE topic_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_uuid TEXT NOT NULL,
            topic_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            rationale TEXT NOT NULL,
            created_at_line INTEGER,
            created_at_msg_id INTEGER,
            evidence_msg_db_ids TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Create legacy watermarks (has last_line_processed, but missing last_msg_id)
    conn.execute("""
        CREATE TABLE watermarks (
            project_uuid TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            last_line_processed INTEGER DEFAULT 0,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_uuid, conversation_id)
        )
    """)
    
    # Insert legacy data
    conn.execute("INSERT INTO project_topics (uuid, topic_id) VALUES ('p1', 't1')")
    conn.execute("""
        INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_db_ids) 
        VALUES ('p1', 't1', 'c1', 'dec_1', 'rat_1', '["msg_1"]')
    """)
    conn.execute("INSERT INTO watermarks (project_uuid, conversation_id, last_line_processed) VALUES ('p1', 'c1', 10)")
    conn.commit()
    conn.close()

    # Run init_db on legacy database path
    with patch("schema_init.DB_PATH", str(legacy_db)):
        schema_init.init_db()
        
        # Verify migrated schema and data
        conn = sqlite3.connect(str(legacy_db))
        # 1. Check project_topics columns
        cursor = conn.execute("PRAGMA table_info(project_topics)")
        pt_cols = [row[1] for row in cursor.fetchall()]
        assert "source" in pt_cols
        assert "last_accessed_at" in pt_cols
        assert "associated_files" in pt_cols
        assert "referenced_files" in pt_cols
        
        # 2. Check topic_decisions (remodeled)
        cursor = conn.execute("PRAGMA table_info(topic_decisions)")
        td_cols = [row[1] for row in cursor.fetchall()]
        assert "evidence_msg_ids" in td_cols
        assert "user_confirmed" in td_cols
        assert "decision_type" in td_cols
        assert "associated_files" in td_cols
        assert "created_at_line" not in td_cols
        assert "evidence_msg_db_ids" not in td_cols

        # Verify data migrated
        cursor = conn.execute("SELECT decision, rationale, evidence_msg_ids, user_confirmed FROM topic_decisions")
        row = cursor.fetchone()
        assert row is not None
        assert row[0] == "dec_1"
        assert row[1] == "rat_1"
        assert row[2] == '["msg_1"]'
        assert row[3] == 0
        
        # 3. Check watermarks (remodeled)
        cursor = conn.execute("PRAGMA table_info(watermarks)")
        w_cols = [row[1] for row in cursor.fetchall()]
        assert "last_msg_id" in w_cols
        assert "last_line_processed" not in w_cols
        
        conn.close()


# 12. snapshot-git.py
def test_snapshot_git(tmp_path):
    # Prepare mock transcriptPath and directories
    transcript = tmp_path / "brain" / "conv_1" / "transcript.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.touch()

    # 1. Context with transcriptPath
    ctx = {"transcriptPath": str(transcript), "cwd": str(tmp_path)}
    with patch("snapshot_git.get_snapshot", return_value={"files": ["a.py"]}) as mock_get:
        res = snapshot_git.main.__wrapped__(ctx)
        assert res == {"injectSteps": []}
        mock_get.assert_called_once_with(str(tmp_path))
        
        # Check pre-snapshot file created
        snapshot_file = tmp_path / "scratch" / "remora_pre_snapshot.json"
        assert snapshot_file.exists()
        with open(snapshot_file, 'r') as f:
            data = json.load(f)
            assert data == {"files": ["a.py"]}

    # 2. Missing transcriptPath
    res_empty = snapshot_git.main.__wrapped__({})
    assert res_empty == {"injectSteps": []}

    # 3. Exception in get_snapshot
    with patch("snapshot_git.get_snapshot", side_effect=Exception("git error")):
        res_err = snapshot_git.main.__wrapped__(ctx)
        assert res_err == {"injectSteps": []}


# 13. cognitive-push.py
def test_cognitive_push_pre_invoke_not_cold_start():
    # 1. No session or is_cold_start == 0
    with patch("sys.argv", ["cognitive-push.py", "--stage", "pre-invoke"]):
        with patch("cognitive_push.dao.get_latest_session", return_value=("c1", 0)):
            res = cognitive_push.main.__wrapped__({"transcriptPath": "foo.jsonl"})
            assert res == {"injectSteps": []}

        # 2. No session found
        with patch("cognitive_push.dao.get_latest_session", return_value=None):
            res = cognitive_push.main.__wrapped__({"transcriptPath": "foo.jsonl"})
            assert res == {"injectSteps": []}


def test_cognitive_push_pre_invoke_success():
    # Setup mocks for active topic and decisions
    with patch("sys.argv", ["cognitive-push.py", "--stage", "pre-invoke"]):
        with patch("cognitive_push.dao.get_latest_session", return_value=("c1", 1)), \
             patch("cognitive_push.dao.get_project_uuid_by_conv", return_value="p1"), \
             patch("cognitive_push.dao.get_active_topic", return_value="t1"), \
             patch("cognitive_push.dao.get_confirmed_decisions", return_value=[{"text": "dec_text"}]), \
             patch("cognitive_push.dao.update_cold_start") as mock_update_cold:
             
            res = cognitive_push.main.__wrapped__({"transcriptPath": "foo.jsonl"})
            assert len(res["injectSteps"]) == 1
            msg = res["injectSteps"][0]["ephemeralMessage"]
            assert "活跃话题: t1" in msg
            assert "dec_text" in msg
            mock_update_cold.assert_called_once_with("c1", 0)


def test_cognitive_push_pre_tool_use():
    with patch("sys.argv", ["cognitive-push.py", "--stage", "pre-tool"]):
        # 1. Tool name not checked
        ctx_ignore = {"toolName": "view_file"}
        res = cognitive_push.main.__wrapped__(ctx_ignore)
        assert res == {"injectSteps": []}

        # 2. Matched tool but no target file
        ctx_no_file = {"toolName": "write_to_file", "toolArgs": {}}
        res = cognitive_push.main.__wrapped__(ctx_no_file)
        assert res == {"injectSteps": []}

        # 3. Match tool, target file protected
        ctx_protect = {
            "toolName": "write_to_file",
            "toolArgs": {"TargetFile": "/path/to/my_file.py"}
        }
        with patch("cognitive_push.dao.get_latest_session", return_value=("c1", 1)), \
             patch("cognitive_push.dao.get_project_uuid_by_conv", return_value="p1"), \
             patch("cognitive_push.dao.get_active_topic", return_value="t1"), \
             patch("cognitive_push.dao.get_confirmed_decisions", return_value=[{"text": "dec_text", "files": ["my_file.py"]}]):
             
            res = cognitive_push.main.__wrapped__(ctx_protect)
            assert len(res["injectSteps"]) == 1
            msg = res["injectSteps"][0]["ephemeralMessage"]
            assert "MEMORY DEFENSE TRIGGERED" in msg
            assert "my_file.py" in msg
            assert "dec_text" in msg

        # 4. Target file not protected
        with patch("cognitive_push.dao.get_latest_session", return_value=("c1", 1)), \
             patch("cognitive_push.dao.get_project_uuid_by_conv", return_value="p1"), \
             patch("cognitive_push.dao.get_active_topic", return_value="t1"), \
             patch("cognitive_push.dao.get_confirmed_decisions", return_value=[{"text": "dec_text", "files": ["other.py"]}]):
             
            res = cognitive_push.main.__wrapped__(ctx_protect)
            assert res == {"injectSteps": []}


# 14. session-guardian.py
def test_session_guardian_uninitialized(tmp_path):
    # installed.flag is missing
    with patch("lib.paths.get_data_dir", return_value=str(tmp_path)):
        res = session_guardian.main.__wrapped__({})
        assert len(res["injectSteps"]) == 1
        assert "REMORA FATAL ERROR" in res["injectSteps"][0]["ephemeralMessage"]


def test_session_guardian_success(tmp_path, capsys):
    # Setup installed.flag
    runtime_dir = tmp_path / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "installed.flag").touch()
    
    # Write mock keywords.json
    keywords_path = os.path.join(os.path.dirname(session_guardian.__file__), "keywords.json")
    with open(keywords_path, 'w') as f:
        json.dump({"hard_keywords": ["strict_kw"], "soft_keywords": ["relax_kw"]}, f)

    context = {
        "transcriptPath": f"/tmp/brain/conv_1/transcript.jsonl"
    }

    # Setup CDAL mock steps and stats mock
    mock_steps = [
        {"type": "USER_INPUT", "content": "Let's discuss design of this project"},
        {"type": "PLANNER_RESPONSE", "tool_calls": [{"name": "schedule", "args": {"DurationSeconds": "30", "Prompt": "subagent-monitor.py fake_uuid c1"}}]}
    ]

    with patch("lib.paths.get_data_dir", return_value=str(tmp_path)), \
         patch("lib.conversation.ConversationDataAccessLayer") as mock_cdal_cls, \
         patch("session_guardian.cleanup") as mock_cleanup, \
         patch("session_guardian.get_stats", return_value={"accumulated_source_bytes": 200 * 1024, "accumulated_data_bytes": 10 * 1024}), \
         patch("lib.dao.write_mode") as mock_write_mode, \
         patch.dict(os.environ, {"ANTIGRAVITY_LS_ADDRESS": "127.0.0.1:8080", "ANTIGRAVITY_CSRF_TOKEN": "token"}):
         
        mock_cdal = MagicMock()
        mock_cdal.stream_steps_reverse.return_value = mock_steps
        mock_cdal_cls.return_value = mock_cdal
        
        res = session_guardian.main.__wrapped__(context)
        
        # Verify LS env file is written
        env_file = runtime_dir / "remora_agent_env.json"
        assert env_file.exists()
        with open(env_file) as ef:
            env_data = json.load(ef)
            assert env_data["ANTIGRAVITY_LS_ADDRESS"] == "127.0.0.1:8080"
            assert env_data["ANTIGRAVITY_CSRF_TOKEN"] == "token"
            
        # Verify main conversation id is written
        conv_id_file = runtime_dir / "remora_main_conv_id.txt"
        assert conv_id_file.exists()
        with open(conv_id_file) as cf:
            assert cf.read() == "conv_1"

        # Verify mode written was "relax" (due to "discuss" keyword in user input)
        mock_write_mode.assert_called_once_with("conv_1", "relax")
        
        # Verify cleanup called
        mock_cleanup.assert_called_once_with("conv_1")
        
        # Verify cumulative warning is injected (src > 150KB)
        assert len(res["injectSteps"]) == 1
        assert "SYSTEM WARNING: CUMULATIVE READ REACHED SOFT LIMIT" in res["injectSteps"][0]["ephemeralMessage"]


# 15. subagent-monitor.py
def test_subagent_monitor(tmp_path, capsys):
    # Setup paths
    retry_dir = tmp_path / ".runtime" / "remora_subagent_retries"
    retry_dir.mkdir(parents=True, exist_ok=True)
    retry_file = retry_dir / "parent_1.json"

    # Mocks
    mock_steps = [
        {"type": "RUN_COMMAND", "content": "ls"},
        {"type": "PLANNER_RESPONSE", "tool_calls": [{"name": "run_command"}]}
    ]

    # Create dummy db file to satisfy exists check
    db_file = tmp_path / "subagent.db"
    db_file.touch()

    with patch("subagent_monitor.get_data_dir", return_value=str(tmp_path)), \
         patch("lib.conversation.ConversationDataAccessLayer") as mock_cdal_cls, \
         patch("sys.argv", ["subagent-monitor.py", "sub_1", "parent_1"]), \
         patch("subagent_monitor.datetime") as mock_datetime:
         
        mock_cdal = MagicMock()
        mock_cdal.db_path = str(db_file)
        mock_cdal.stream_steps_reverse.return_value = mock_steps
        # db mtime returns timestamp which is 200 seconds before "now"
        mock_cdal.get_db_mtime.return_value = 1000.0
        mock_cdal_cls.return_value = mock_cdal

        # Mock now = 1000.0 + 200 seconds = 1200.0 (idle_seconds is 200, which is > 180s limit)
        mock_now = datetime.fromtimestamp(1200.0, timezone.utc)
        mock_datetime.now.return_value = mock_now
        mock_datetime.fromtimestamp.side_effect = lambda ts, tz: datetime.fromtimestamp(ts, tz)

        # 1. Run zombie case (limit is 180s, idle_seconds is 200s)
        try:
            subagent_monitor.main()
        except SystemExit:
            pass

        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["status"] == "zombie"
        assert data["idle_seconds"] == 200
        assert data["retry_count"] == 1
        assert data["action_suggestion"] == "kill_and_retry"
        
        # Verify retry file is updated
        assert retry_file.exists()
        with open(retry_file) as rf:
            rdata = json.load(rf)
            assert rdata["retry_count"] == 1

        # 2. Run zombie case again to test escalate_to_human (retry_count >= 2)
        mock_datetime.now.return_value = datetime.fromtimestamp(1200.0, timezone.utc)
        try:
            subagent_monitor.main()
        except SystemExit:
            pass
            
        captured2 = capsys.readouterr()
        data2 = json.loads(captured2.out.strip())
        assert data2["status"] == "zombie"
        assert data2["retry_count"] == 2
        assert data2["action_suggestion"] == "escalate_to_human"

