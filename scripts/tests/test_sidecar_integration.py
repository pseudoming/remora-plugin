import os
import sys
import json
import time
import sqlite3
import subprocess
import argparse
import pytest
from unittest.mock import patch, MagicMock, mock_open

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'adapter', 'sidecar', 'compactor')))

import extract_decisions
import warm_storage_sync
import sync_artifacts
import scan_sessions
import compactor


def _create_remora_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("""CREATE TABLE IF NOT EXISTS project_topics (
        uuid TEXT NOT NULL, topic_id TEXT NOT NULL, status TEXT DEFAULT 'open',
        summary TEXT, compression_confidence REAL DEFAULT 1.0,
        source TEXT DEFAULT 'auto', last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        associated_files TEXT DEFAULT '[]', referenced_files TEXT DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (uuid, topic_id))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS topic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
        topic_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        decision TEXT NOT NULL, rationale TEXT NOT NULL,
        evidence_msg_ids TEXT, user_confirmed INTEGER DEFAULT 0,
        decision_type TEXT DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS watermarks (
        project_uuid TEXT NOT NULL, conversation_id TEXT NOT NULL,
        last_msg_id INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_uuid, conversation_id))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        line_number INTEGER NOT NULL, timestamp TIMESTAMP, role TEXT,
        content TEXT, topic_id TEXT,
        UNIQUE(conversation_id, line_number))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS remora_event_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
        event_type TEXT NOT NULL, payload TEXT, status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    return conn


# ============================================================
# get_or_create_conversation
# ============================================================

class TestGetOrCreateConversation:
    def test_creates_new_conversation_when_no_marker(self):
        mock_fopen = mock_open()
        with patch('builtins.open', mock_fopen), \
             patch.object(extract_decisions, 'CONV_MARKER_FILE', '/nonexistent/marker.txt'), \
             patch.object(extract_decisions, 'load_excluded_ids', return_value=set()), \
             patch.object(extract_decisions, 'save_excluded_ids') as mock_save, \
             patch.object(extract_decisions, 'create_conversation') as mock_create:
            mock_create.return_value = {
                'response': {
                    'newConversation': {
                        'reply': 'Hello from new conv',
                        'conversationId': 'new-conv-uuid'
                    }
                }
            }

            result = extract_decisions.get_or_create_conversation('test prompt')

            assert result == 'Hello from new conv'
            mock_create.assert_called_once()
            mock_save.assert_called_once()
            mock_fopen.assert_any_call('/nonexistent/marker.txt', 'w')
            handle = mock_fopen()
            handle.write.assert_called_with('new-conv-uuid')

    def test_reuses_existing_when_under_150_steps(self):
        m = mock_open(read_data='existing-conv-id')
        mock_cdal = MagicMock()
        mock_cdal.db_path = '/fake/test.db'
        mock_cdal.get_latest_planner_response.return_value = 'LLM reply text'

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (80,)
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__.return_value = mock_conn

        with patch('builtins.open', m), \
             patch.object(extract_decisions, 'CONV_MARKER_FILE', '/fake/marker.txt'), \
             patch('os.path.exists', return_value=True), \
             patch.object(extract_decisions, 'load_excluded_ids', return_value=set()), \
             patch('adapter.bridge.conversation.ConversationDataAccessLayer', return_value=mock_cdal), \
             patch('sqlite3.connect', return_value=mock_conn), \
             patch.object(extract_decisions, 'send_message') as mock_send:
            result = extract_decisions.get_or_create_conversation('test prompt')

            assert result == 'LLM reply text'
            mock_send.assert_called_once_with('existing-conv-id', 'test prompt')

    def test_rollover_when_above_150_steps(self):
        m = mock_open(read_data='existing-conv-id')
        mock_cdal = MagicMock()
        mock_cdal.db_path = '/fake/test.db'

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (200,)
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__.return_value = mock_conn

        with patch('builtins.open', m), \
             patch.object(extract_decisions, 'CONV_MARKER_FILE', '/fake/marker.txt'), \
             patch('os.path.exists', return_value=True), \
             patch.object(extract_decisions, 'load_excluded_ids', return_value=set()), \
             patch.object(extract_decisions, 'save_excluded_ids'), \
             patch('adapter.bridge.conversation.ConversationDataAccessLayer', return_value=mock_cdal), \
             patch('sqlite3.connect', return_value=mock_conn), \
             patch('os.remove') as mock_remove, \
             patch.object(extract_decisions, 'create_conversation') as mock_create:
            mock_create.return_value = {
                'response': {
                    'newConversation': {
                        'reply': 'New conv after rollover',
                        'conversationId': 'new-conv-rollover'
                    }
                }
            }

            result = extract_decisions.get_or_create_conversation('test prompt')

            assert result == 'New conv after rollover'
            mock_remove.assert_called_once_with('/fake/marker.txt')
            mock_create.assert_called_once()

    def test_agentapi_error_on_send_message(self):
        m = mock_open(read_data='existing-conv-id')
        mock_cdal = MagicMock()
        mock_cdal.db_path = '/fake/test.db'

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (80,)
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.__enter__.return_value = mock_conn

        with patch('builtins.open', m), \
             patch.object(extract_decisions, 'CONV_MARKER_FILE', '/fake/marker.txt'), \
             patch('os.path.exists', return_value=True), \
             patch.object(extract_decisions, 'load_excluded_ids', return_value=set()), \
             patch('adapter.bridge.conversation.ConversationDataAccessLayer', return_value=mock_cdal), \
             patch('sqlite3.connect', return_value=mock_conn), \
             patch.object(extract_decisions, 'send_message',
                          side_effect=subprocess.CalledProcessError(1, 'cmd')):
            with pytest.raises(extract_decisions.AgentApiError) as exc:
                extract_decisions.get_or_create_conversation('test prompt')

            assert 'send-message failed' in str(exc.value)

    def test_agentapi_error_on_create_conversation(self):
        with patch.object(extract_decisions, 'CONV_MARKER_FILE', '/nonexistent/marker.txt'), \
             patch.object(extract_decisions, 'load_excluded_ids', return_value=set()), \
             patch.object(extract_decisions, 'create_conversation',
                          side_effect=subprocess.CalledProcessError(1, 'cmd')):
            with pytest.raises(extract_decisions.AgentApiError) as exc:
                extract_decisions.get_or_create_conversation('test prompt')

            assert 'new-conversation failed' in str(exc.value)


# ============================================================
# process_sessions
# ============================================================

class TestProcessSessions:
    @pytest.fixture
    def test_db(self):
        return _create_remora_db()

    def test_processes_sessions_with_valid_llm_output(self, test_db):
        llm_output = "[Sync Finished: 2024-06-01 12:00:00]\n```json\n{\n  \"topics\": [\n    {\n      \"topic_id\": \"t_001\",\n      \"summary\": \"Test Architecture Decision\",\n      \"decisions\": [\n        {\n          \"decision\": \"Use Redis for caching\",\n          \"rationale\": \"Better performance\",\n          \"evidence_msg_ids\": [1],\n          \"decision_type\": \"approved\",\n          \"user_confirmed\": false,\n          \"inherited_from\": []\n        }\n      ]\n    }\n  ]\n}\n```"
        test_db.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) "
            "VALUES ('proj-uuid-1', 'conv-uuid-1', 0)")
        test_db.commit()

        with patch.object(extract_decisions, 'sqlite3') as mock_sql_module, \
             patch.object(extract_decisions, 'get_active_conversations') as mock_active, \
             patch.object(extract_decisions, 'read_incremental_logs') as mock_read, \
             patch.object(extract_decisions, 'is_subagent_session', return_value=False), \
             patch.object(extract_decisions, 'get_or_create_conversation', return_value=llm_output), \
             patch.object(extract_decisions, 'extract_factual_baseline', return_value=([], [])):
            mock_sql_module.connect.return_value = test_db
            mock_active.return_value = [{
                'project_uuid': 'proj-uuid-1',
                'conversation_id': 'conv-uuid-1'
            }]
            mock_read.return_value = ('Some conversation content', 10, 5)

            start_time = time.time() - 10
            extract_decisions.process_sessions(start_time)

            topics = test_db.execute("SELECT * FROM project_topics WHERE uuid='proj-uuid-1'").fetchall()
            assert len(topics) == 1
            assert topics[0][1] == 't_001'

            decisions = test_db.execute("SELECT * FROM topic_decisions WHERE project_uuid='proj-uuid-1'").fetchall()
            assert len(decisions) == 1
            assert decisions[0][4] == 'Use Redis for caching'

            watermarks = test_db.execute("SELECT * FROM watermarks WHERE project_uuid='proj-uuid-1'").fetchall()
            assert len(watermarks) == 1
            assert watermarks[0][2] == 10

    def test_skips_session_with_empty_key_content(self, test_db):
        test_db.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) "
            "VALUES ('proj-uuid-1', 'conv-uuid-1', 0)")
        test_db.commit()

        with patch.object(extract_decisions, 'sqlite3') as mock_sql_module, \
             patch.object(extract_decisions, 'get_active_conversations') as mock_active, \
             patch.object(extract_decisions, 'read_incremental_logs') as mock_read, \
             patch.object(extract_decisions, 'is_subagent_session', return_value=False):
            mock_sql_module.connect.return_value = test_db
            mock_active.return_value = [{
                'project_uuid': 'proj-uuid-1',
                'conversation_id': 'conv-uuid-1'
            }]
            mock_read.return_value = ('   ', 10, 5)

            extract_decisions.process_sessions(time.time())

            topics = test_db.execute("SELECT * FROM project_topics").fetchall()
            assert len(topics) == 0

            watermarks = test_db.execute("SELECT * FROM watermarks").fetchall()
            assert len(watermarks) == 1
            assert watermarks[0][2] == 10

    def test_max_execution_time_exceeded_stops_early(self, test_db):
        with patch.object(extract_decisions, 'sqlite3') as mock_sql_module, \
             patch.object(extract_decisions, 'MAX_EXECUTION_TIME', 0.001), \
             patch.object(extract_decisions, 'get_active_conversations') as mock_active, \
             patch.object(extract_decisions, 'read_incremental_logs') as mock_read:
            mock_sql_module.connect.return_value = test_db
            mock_active.return_value = [
                {'project_uuid': 'p1', 'conversation_id': 'c1'},
                {'project_uuid': 'p2', 'conversation_id': 'c2'},
            ]

            extract_decisions.process_sessions(0)

            assert not mock_read.called

    def test_handles_json_decode_error_gracefully(self, test_db):
        test_db.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) "
            "VALUES ('proj-uuid-1', 'conv-uuid-1', 0)")
        test_db.commit()

        with patch.object(extract_decisions, 'sqlite3') as mock_sql_module, \
             patch.object(extract_decisions, 'get_active_conversations') as mock_active, \
             patch.object(extract_decisions, 'read_incremental_logs') as mock_read, \
             patch.object(extract_decisions, 'is_subagent_session', return_value=False), \
             patch.object(extract_decisions, 'get_or_create_conversation', return_value='Not JSON at all'), \
             patch.object(extract_decisions, 'extract_factual_baseline', return_value=([], [])):
            mock_sql_module.connect.return_value = test_db
            mock_active.return_value = [{
                'project_uuid': 'proj-uuid-1',
                'conversation_id': 'conv-uuid-1'
            }]
            mock_read.return_value = ('some content', 10, 5)

            extract_decisions.process_sessions(time.time())

            topics = test_db.execute("SELECT * FROM project_topics").fetchall()
            assert len(topics) == 0

            watermarks = test_db.execute("SELECT * FROM watermarks").fetchall()
            assert len(watermarks) == 1

    def test_subagent_session_skips_llm_extraction(self, test_db):
        test_db.execute(
            "INSERT INTO project_topics (uuid, topic_id, status, summary, associated_files, referenced_files) "
            "VALUES ('proj-uuid-1', 't_active', 'open', 'test', '[]', '[]')")
        test_db.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) "
            "VALUES ('proj-uuid-1', 'conv-uuid-1', 0)")
        test_db.commit()

        with patch.object(extract_decisions, 'sqlite3') as mock_sql_module, \
             patch.object(extract_decisions, 'get_active_conversations') as mock_active, \
             patch.object(extract_decisions, 'read_incremental_logs') as mock_read, \
             patch.object(extract_decisions, 'is_subagent_session', return_value=True), \
             patch.object(extract_decisions, 'extract_subagent_report', return_value=([], [])), \
             patch.object(extract_decisions, 'get_or_create_conversation') as mock_get_conv:
            mock_sql_module.connect.return_value = test_db
            mock_active.return_value = [{
                'project_uuid': 'proj-uuid-1',
                'conversation_id': 'conv-uuid-1'
            }]
            mock_read.return_value = ('some content', 10, 5)

            extract_decisions.process_sessions(time.time())

            assert not mock_get_conv.called

            watermarks = test_db.execute("SELECT * FROM watermarks").fetchall()
            assert len(watermarks) == 1
            assert watermarks[0][2] == 10


# ============================================================
# read_incremental_logs
# ============================================================

class TestReadIncrementalLogs:
    @pytest.fixture
    def test_db(self):
        return _create_remora_db()

    def test_no_watermark_row_creates_one(self, test_db):
        mock_cdal = MagicMock()
        mock_cdal.get_max_step_index.return_value = 0
        mock_cdal.stream_steps_forward.return_value = []

        session = {'project_uuid': 'proj-1', 'conversation_id': 'conv-1'}

        with patch.object(warm_storage_sync, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(warm_storage_sync, 'is_subagent_session', return_value=False):
            key_content, current_msg_id, last_msg_id = (
                warm_storage_sync.read_incremental_logs(test_db, session))

            watermarks = test_db.execute(
                "SELECT * FROM watermarks WHERE project_uuid='proj-1' AND conversation_id='conv-1'").fetchall()
            assert len(watermarks) == 1
            assert watermarks[0][2] == 0
            assert key_content == ''
            assert current_msg_id == 0
            assert last_msg_id == 0

    def test_normal_incremental_read_inserts_messages(self, test_db):
        mock_cdal = MagicMock()
        mock_cdal.get_max_step_index.return_value = 10
        mock_cdal.stream_steps_forward.return_value = [
            {'step_index': 1, 'type': 'USER_INPUT', 'content': 'Hello world',
             'role': 'user', 'timestamp': '2024-01-01T00:00:00Z'},
            {'step_index': 2, 'type': 'PLANNER_RESPONSE', 'content': 'Hi there',
             'role': 'model', 'timestamp': '2024-01-01T00:00:01Z'},
            {'step_index': 3, 'type': 'TOOL_USE', 'content': '{}',
             'role': 'tool', 'timestamp': '2024-01-01T00:00:02Z'},
        ]

        session = {'project_uuid': 'proj-1', 'conversation_id': 'conv-1'}

        with patch.object(warm_storage_sync, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(warm_storage_sync, 'is_subagent_session', return_value=False):
            key_content, current_msg_id, last_msg_id = (
                warm_storage_sync.read_incremental_logs(test_db, session))

            messages = test_db.execute(
                "SELECT * FROM messages WHERE conversation_id='conv-1'").fetchall()
            assert len(messages) == 3

            assert 'Hello world' in key_content
            assert 'Hi there' in key_content
            assert '[msg_1]' in key_content
            assert '[msg_2]' in key_content
            assert current_msg_id > 0

    def test_max_prompt_length_exceeded_stops_collecting(self, test_db):
        mock_cdal = MagicMock()
        mock_cdal.get_max_step_index.return_value = 100
        steps = []
        for i in range(1, 20):
            steps.append({
                'step_index': i,
                'type': 'USER_INPUT',
                'content': 'X' * 200,
                'role': 'user',
                'timestamp': '2024-01-01T00:00:00Z'
            })
        mock_cdal.stream_steps_forward.return_value = steps

        session = {'project_uuid': 'proj-1', 'conversation_id': 'conv-1'}

        with patch.object(warm_storage_sync, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(warm_storage_sync, 'is_subagent_session', return_value=False), \
             patch.object(warm_storage_sync, 'MAX_PROMPT_LENGTH', 50):
            key_content, current_msg_id, last_msg_id = (
                warm_storage_sync.read_incremental_logs(test_db, session))

            messages = test_db.execute(
                "SELECT * FROM messages WHERE conversation_id='conv-1'").fetchall()
            assert len(messages) == 19

            assert len(key_content) < 300

    def test_undo_rollback_detected_triggers_cleanup(self, test_db):
        test_db.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) "
            "VALUES ('proj-1', 'conv-1', 100)")
        test_db.execute(
            "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) "
            "VALUES (1, 'conv-1', 1, '2024-01-01', 'user', 'msg 1')")
        test_db.execute(
            "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) "
            "VALUES (2, 'conv-1', 2, '2024-01-01', 'user', 'msg 2')")
        test_db.execute(
            "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) "
            "VALUES (3, 'conv-1', 5, '2024-01-01', 'user', 'msg 5')")
        test_db.commit()

        mock_cdal = MagicMock()
        mock_cdal.get_max_step_index.return_value = 2
        mock_cdal.stream_steps_forward.return_value = []

        session = {'project_uuid': 'proj-1', 'conversation_id': 'conv-1'}

        with patch.object(warm_storage_sync, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(warm_storage_sync, 'is_subagent_session', return_value=False):
            warm_storage_sync.read_incremental_logs(test_db, session)

        messages = test_db.execute(
            "SELECT * FROM messages WHERE conversation_id='conv-1'").fetchall()
        assert len(messages) == 0

    def test_subagent_filters_non_relevant_steps(self, test_db):
        mock_cdal = MagicMock()
        mock_cdal.get_max_step_index.return_value = 10
        mock_cdal.stream_steps_forward.return_value = [
            {'step_index': 1, 'type': 'USER_INPUT', 'content': 'user request',
             'role': 'user', 'timestamp': '2024-01-01T00:00:00Z'},
            {'step_index': 2, 'type': 'TOOL_USE', 'content': '{}',
             'role': 'tool', 'timestamp': '2024-01-01T00:00:01Z'},
            {'step_index': 3, 'type': 'PLANNER_RESPONSE', 'content': 'model answer',
             'role': 'model', 'timestamp': '2024-01-01T00:00:02Z'},
        ]

        session = {'project_uuid': 'proj-1', 'conversation_id': 'conv-1'}

        with patch.object(warm_storage_sync, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(warm_storage_sync, 'is_subagent_session', return_value=True):
            key_content, current_msg_id, last_msg_id = (
                warm_storage_sync.read_incremental_logs(test_db, session))

            messages = test_db.execute(
                "SELECT * FROM messages WHERE conversation_id='conv-1'").fetchall()
            assert len(messages) == 2

            assert 'user request' in key_content
            assert 'model answer' in key_content
            assert 'TOOL_USE' not in key_content


# ============================================================
# scan_and_ingest_artifacts
# ============================================================

class TestScanAndIngestArtifacts:
    @pytest.fixture
    def artifacts_db(self, tmp_path):
        db_file = str(tmp_path / 'test.db')
        conn = sqlite3.connect(db_file)
        conn.execute("""CREATE TABLE IF NOT EXISTS artifact_hashes (
            file_path TEXT PRIMARY KEY, hash TEXT NOT NULL,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
            line_number INTEGER NOT NULL, timestamp TIMESTAMP, role TEXT,
            content TEXT, topic_id TEXT,
            UNIQUE(conversation_id, line_number))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS remora_event_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
            event_type TEXT NOT NULL, payload TEXT, status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS project_topics (
            uuid TEXT NOT NULL, topic_id TEXT NOT NULL, status TEXT DEFAULT 'open',
            summary TEXT, compression_confidence REAL DEFAULT 1.0,
            source TEXT DEFAULT 'auto', last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            associated_files TEXT DEFAULT '[]', referenced_files TEXT DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uuid, topic_id))""")
        conn.close()
        return db_file

    def test_no_artifact_dir_returns_early(self, artifacts_db):
        context = {'artifactDirectoryPath': ''}
        with patch.object(sync_artifacts, 'DB_PATH', artifacts_db), \
             patch.dict('os.environ', {'ANTIGRAVITY_PROJECT_ID': 'proj-1'}):
            sync_artifacts.scan_and_ingest_artifacts(context)

    def test_unchanged_file_hash_match_skipped(self, artifacts_db, tmp_path):
        import hashlib
        artifact_dir = tmp_path / 'artifacts'
        artifact_dir.mkdir()
        plan_file = artifact_dir / 'implementation_plan.md'
        plan_file.write_text('# Test Plan Content')
        file_hash = hashlib.md5(plan_file.read_bytes()).hexdigest()

        conn = sqlite3.connect(artifacts_db)
        conn.execute("INSERT INTO artifact_hashes (file_path, hash) VALUES (?, ?)",
                     (str(plan_file), file_hash))
        conn.commit()
        conn.close()

        context = {'artifactDirectoryPath': str(artifact_dir)}

        with patch.object(sync_artifacts, 'DB_PATH', artifacts_db), \
             patch.dict('os.environ', {'ANTIGRAVITY_PROJECT_ID': 'proj-1'}):
            sync_artifacts.scan_and_ingest_artifacts(context)

        conn = sqlite3.connect(artifacts_db)
        messages = conn.execute("SELECT * FROM messages").fetchall()
        events = conn.execute("SELECT * FROM remora_event_queue").fetchall()
        conn.close()
        assert len(messages) == 0
        assert len(events) == 0

    def test_changed_file_deletes_old_inserts_new_queues_event(self, artifacts_db, tmp_path):
        artifact_dir = tmp_path / 'artifacts'
        artifact_dir.mkdir()
        walkthrough_file = artifact_dir / 'walkthrough.md'
        walkthrough_file.write_text('# New Walkthrough Content')

        conn = sqlite3.connect(artifacts_db)
        conn.execute("INSERT INTO artifact_hashes (file_path, hash) VALUES (?, ?)",
                     (str(walkthrough_file), 'old_different_hash'))
        conn.execute("INSERT INTO messages (conversation_id, line_number, timestamp, role, content) "
                     "VALUES ('artifact_sync_proj-1', 999901, datetime('now'), 'walkthrough.md', '# Old Content')")
        conn.commit()
        conn.close()

        context = {
            'artifactDirectoryPath': str(artifact_dir),
            'transcriptPath': '/some/path/brain/conv-uuid-test/something'
        }

        with patch.object(sync_artifacts, 'DB_PATH', artifacts_db), \
             patch.dict('os.environ', {'ANTIGRAVITY_PROJECT_ID': 'proj-1'}), \
             patch.object(sync_artifacts, 'extract_conv_id', return_value='conv-uuid-test'), \
             patch.object(sync_artifacts, 'insert_file_change') as mock_insert_fc:

            sync_artifacts.scan_and_ingest_artifacts(context)

        conn = sqlite3.connect(artifacts_db)
        messages = conn.execute(
            "SELECT * FROM messages WHERE conversation_id='artifact_sync_proj-1'").fetchall()
        assert len(messages) == 1
        assert '# New Walkthrough Content' in messages[0][5]

        events = conn.execute("SELECT * FROM remora_event_queue").fetchall()
        conn.close()
        assert len(events) == 1
        assert events[0][2] == 'walkthrough_sync'

        mock_insert_fc.assert_called_once_with(
            'proj-1', 'conv-uuid-test', 'walkthrough.md', 'artifact')

    def test_plan_file_no_event_queue(self, artifacts_db, tmp_path):
        artifact_dir = tmp_path / 'artifacts'
        artifact_dir.mkdir()
        plan_file = artifact_dir / 'implementation_plan.md'
        plan_file.write_text('# Plan Content Here')

        context = {
            'artifactDirectoryPath': str(artifact_dir),
            'transcriptPath': ''
        }

        with patch.object(sync_artifacts, 'DB_PATH', artifacts_db), \
             patch.dict('os.environ', {'ANTIGRAVITY_PROJECT_ID': 'proj-1'}), \
             patch.object(sync_artifacts, 'insert_file_change'):

            sync_artifacts.scan_and_ingest_artifacts(context)

        conn = sqlite3.connect(artifacts_db)
        events = conn.execute("SELECT * FROM remora_event_queue").fetchall()
        messages = conn.execute(
            "SELECT * FROM messages WHERE conversation_id='artifact_sync_proj-1' AND role='implementation_plan.md'").fetchall()
        conn.close()
        assert len(events) == 0
        assert len(messages) == 1


# ============================================================
# get_active_conversations
# ============================================================

UUID_1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1'
UUID_2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2'

class TestGetActiveConversations:
    def test_returns_shuffled_list(self, tmp_path):
        brain_dir = tmp_path / 'brain'
        brain_dir.mkdir()
        (brain_dir / UUID_1).mkdir()
        (brain_dir / UUID_2).mkdir()

        mock_cdal = MagicMock()
        mock_cdal.db_path = str(brain_dir / UUID_1 / 'test.db')
        mock_cdal.get_db_mtime.return_value = time.time() - 100

        with patch.object(scan_sessions, 'BRAIN_DIR', str(brain_dir)), \
             patch.object(scan_sessions, 'load_excluded_ids', return_value=set()), \
             patch.object(scan_sessions, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(scan_sessions, 'get_project_id', return_value='project-1'), \
             patch('os.path.exists', return_value=True):
            result = scan_sessions.get_active_conversations()

            assert len(result) == 2
            assert result[0]['project_uuid'] == 'project-1'

    def test_excludes_managed_ids(self, tmp_path):
        brain_dir = tmp_path / 'brain'
        brain_dir.mkdir()
        (brain_dir / UUID_1).mkdir()

        mock_cdal = MagicMock()
        mock_cdal.db_path = str(brain_dir / UUID_1 / 'test.db')
        mock_cdal.get_db_mtime.return_value = time.time() - 100

        with patch.object(scan_sessions, 'BRAIN_DIR', str(brain_dir)), \
             patch.object(scan_sessions, 'load_excluded_ids', return_value={UUID_1}), \
             patch.object(scan_sessions, 'ConversationDataAccessLayer', return_value=mock_cdal):
            result = scan_sessions.get_active_conversations()
            assert len(result) == 0

    def test_skips_non_uuid_directories(self, tmp_path):
        brain_dir = tmp_path / 'brain'
        brain_dir.mkdir()
        (brain_dir / 'not-a-uuid').mkdir()
        (brain_dir / UUID_1).mkdir()

        mock_cdal = MagicMock()
        mock_cdal.db_path = str(brain_dir / UUID_1 / 'test.db')
        mock_cdal.get_db_mtime.return_value = time.time() - 100

        with patch.object(scan_sessions, 'BRAIN_DIR', str(brain_dir)), \
             patch.object(scan_sessions, 'load_excluded_ids', return_value=set()), \
             patch.object(scan_sessions, 'ConversationDataAccessLayer', return_value=mock_cdal), \
             patch.object(scan_sessions, 'get_project_id', return_value='project-1'), \
             patch('os.path.exists', return_value=True):
            result = scan_sessions.get_active_conversations()
            assert len(result) == 1

    def test_no_brain_dir_returns_empty(self):
        with patch.object(scan_sessions, 'BRAIN_DIR', '/nonexistent/brain'), \
             patch('os.path.exists', return_value=False):
            result = scan_sessions.get_active_conversations()
            assert result == []


# ============================================================
# get_project_id
# ============================================================

class TestGetProjectId:
    def test_returns_default_on_failure(self):
        result = scan_sessions.get_project_id('any-conv-id')
        assert result == '11111111-1111-1111-1111-111111111111'


# ============================================================
# compactor.main()
# ============================================================

class TestCompactorMain:
    def test_event_driven_mode_reads_stdin_calls_scan_and_ingest(self):
        context = {'artifactDirectoryPath': '/test/artifacts'}

        with patch.object(compactor.argparse.ArgumentParser, 'parse_args') as mock_parse_args, \
             patch.object(compactor, 'init_db'), \
             patch.object(compactor, 'scan_and_ingest_artifacts') as mock_scan, \
             patch.object(compactor.json, 'load', return_value=context), \
             patch.object(compactor.sys, 'stdin'):
            mock_parse_args.return_value = argparse.Namespace(
                event_driven=True, cron=False)

            compactor.main()

            mock_scan.assert_called_once_with(context)

    def test_event_driven_mode_catches_exceptions(self):
        with patch.object(compactor.argparse.ArgumentParser, 'parse_args') as mock_parse_args, \
             patch.object(compactor, 'init_db'), \
             patch.object(compactor.json, 'load', side_effect=json.JSONDecodeError('bad', '{}', 0)), \
             patch.object(compactor.sys, 'stdin'):
            mock_parse_args.return_value = argparse.Namespace(
                event_driven=True, cron=False)

            compactor.main()

    def test_cron_mode_runs_full_pipeline(self):
        with patch.object(compactor.argparse.ArgumentParser, 'parse_args') as mock_parse_args, \
             patch.object(compactor, 'init_db'), \
             patch.object(compactor, 'acquire_lock') as mock_lock, \
             patch.object(compactor, 'prune_expired_watermarks') as mock_prune_watermarks, \
             patch.object(compactor, 'process_sessions') as mock_process, \
             patch.object(compactor, 'check_plan_approval') as mock_check_plan, \
             patch.object(compactor, 'consume_event_queue') as mock_consume, \
             patch.object(compactor, 'run_garbage_collection') as mock_gc, \
             patch.object(compactor, 'prune_sidecar_events'), \
             patch.object(compactor, 'release_lock') as mock_release:
            mock_parse_args.return_value = argparse.Namespace(
                event_driven=False, cron=True)

            mock_conn = MagicMock()
            mock_conn.execute.return_value.fetchall.return_value = [('proj-1',)]
            mock_conn.__enter__.return_value = mock_conn

            with patch.object(compactor.sqlite3, 'connect', return_value=mock_conn):
                compactor.main()

            mock_lock.assert_called_once()
            mock_prune_watermarks.assert_called_once()
            mock_process.assert_called_once()
            mock_check_plan.assert_called_once_with(mock_conn, 'proj-1')
            mock_consume.assert_called_once()
            mock_gc.assert_called_once_with(mock_conn)
            mock_release.assert_called_once()

    def test_cron_mode_handles_agentapi_error(self):
        with patch.object(compactor.argparse.ArgumentParser, 'parse_args') as mock_parse_args, \
             patch.object(compactor, 'init_db'), \
             patch.object(compactor, 'acquire_lock'), \
             patch.object(compactor, 'release_lock') as mock_release, \
             patch.object(compactor, 'prune_expired_watermarks'), \
             patch.object(compactor, 'prune_sidecar_events'), \
             patch.object(compactor, 'process_sessions',
                          side_effect=compactor.AgentApiError("API failure")):
            mock_parse_args.return_value = argparse.Namespace(
                event_driven=False, cron=True)

            with pytest.raises(SystemExit) as exc:
                compactor.main()

            assert exc.value.code == 1
            assert mock_release.call_count >= 1

    def test_cron_mode_handles_generic_exception(self):
        with patch.object(compactor.argparse.ArgumentParser, 'parse_args') as mock_parse_args, \
             patch.object(compactor, 'init_db'), \
             patch.object(compactor, 'acquire_lock'), \
             patch.object(compactor, 'release_lock') as mock_release, \
             patch.object(compactor, 'prune_sidecar_events'), \
             patch.object(compactor, 'prune_expired_watermarks'), \
             patch.object(compactor, 'process_sessions', side_effect=RuntimeError("unexpected")):

            mock_parse_args.return_value = argparse.Namespace(
                event_driven=False, cron=True)

            compactor.main()

            mock_release.assert_called_once()
