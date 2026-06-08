from core.storage.sessions import (
    read_mode, write_mode, get_latest_session, update_cold_start,
    delete_session, force_cold_start_latest_session
)
from core.storage.messages import (
    get_watermark, get_max_line_number, insert_message, get_max_message_id,
    get_max_message_id_up_to_line, delete_messages_above_line,
    get_decisions_by_conversation, delete_topic_decision, get_message_timestamp,
    delete_decisions_by_conversation_after, delete_pending_events,
    update_watermark, ensure_watermark
)
from core.storage.topics import (
    get_active_topic, create_or_update_topic, switch_topic, close_topic,
    get_topics_by_uuid, get_topic_associated_files, update_topic_associated_files,
    touch_topic_source_manual, merge_physical_files_to_topic
)
from core.storage.artifacts import (
    get_plan_change_time, get_user_messages_after, get_plan_content,
    enqueue_event, get_pending_events, mark_event_processed,
    get_artifact_hash, upsert_artifact_hash, delete_artifact_messages,
    insert_artifact_message, upsert_artifact_topic
)
from core.storage.decisions import (
    get_confirmed_decisions, confirm_decision, get_topic_id_by_decision,
    decision_exists, supersede_unconfirmed,
    get_pending_decisions, confirm_decisions_by_ids, update_watermark
)
from core.storage.recall import (
    recall_fts5_logs, recall_decisions_by_fts5_topic,
    recall_decisions_by_like, touch_topics_accessed_by_recall
)
from core.storage.maintenance import (
    run_topic_garbage_collection, prune_expired_watermarks, cleanup_ghost_messages
)
from core.storage.file_changes import (
    insert_file_change, get_files_by_topic, get_decisions_by_file
)
from core.storage.watermarks import (
    get_project_uuid_by_conv, watermark_exists, get_active_topic_created_at
)
from core.storage.runtime_state import (
    get_runtime_hook_value, set_runtime_hook_value, delete_runtime_hook_value,
    trim_runtime_hook_states, get_hook_state, set_hook_state, delete_hook_state, trim_hook_states
)
from core.storage.connection import check_db_exists
