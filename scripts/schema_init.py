import sqlite3
import os
import sys

scripts_dir = os.path.abspath(os.path.dirname(__file__))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from lib.paths import get_data_dir

DATA_DIR = get_data_dir()
DB_PATH = os.path.join(DATA_DIR, "remora_memory.db")
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")

def init_db():
    from contextlib import closing
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(sqlite3.connect(DB_PATH, timeout=15)) as conn:
        with conn:
            with open(SCHEMA_PATH, 'r') as f:
                conn.executescript(f.read())


            # Schema 动态迁移升级防线二：如果 user_confirmed 字段不存在，自动 Alter Table 动态加入该列
            try:
                conn.execute("SELECT user_confirmed FROM topic_decisions LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("ALTER TABLE topic_decisions ADD COLUMN user_confirmed INTEGER DEFAULT 0")

            # Schema 动态迁移升级防线三：扩展 project_topics 列以支持 Phase 17 机制
            for col, col_def in [("source", "TEXT DEFAULT 'auto'"), 
                                 ("last_accessed_at", "TIMESTAMP DEFAULT '2026-06-05 00:00:00'"),
                                 ("associated_files", "TEXT DEFAULT '[]'"),
                                 ("referenced_files", "TEXT DEFAULT '[]'")]:
                try:
                    conn.execute(f"SELECT {col} FROM project_topics LIMIT 1")
                except sqlite3.OperationalError:
                    conn.execute(f"ALTER TABLE project_topics ADD COLUMN {col} {col_def}")

            # Schema 动态迁移升级防线四：新增 session_state 跨进程状态同步表
            conn.execute("""
                CREATE TABLE IF NOT EXISTS session_state (
                    session_id TEXT PRIMARY KEY,
                    mode TEXT DEFAULT 'relax',
                    is_cold_start INTEGER DEFAULT 1,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Schema 动态迁移升级防线五：扩展 topic_decisions 列以支持语义类型与实体映射
            for col, col_def in [("decision_type", "TEXT DEFAULT 'approved'"),
                                 ("associated_files", "TEXT DEFAULT '[]'"),
                                 ("updated_at", "TIMESTAMP DEFAULT '2026-06-05 00:00:00'")]:
                try:
                    conn.execute(f"SELECT {col} FROM topic_decisions LIMIT 1")
                except sqlite3.OperationalError:
                    conn.execute(f"ALTER TABLE topic_decisions ADD COLUMN {col} {col_def}")

            # Phase 34: Table Remodeling (Refactor to remove line number fields and transition columns)
            try:
                cursor = conn.execute("PRAGMA table_info(topic_decisions)")
                td_columns = [row[1] for row in cursor.fetchall()]
                if any(col in td_columns for col in ["created_at_line", "created_at_msg_id", "evidence_msg_db_ids"]):
                    # 1. Create temporary table
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS topic_decisions_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            project_uuid TEXT NOT NULL,
                            topic_id TEXT NOT NULL,
                            conversation_id TEXT NOT NULL,
                            decision TEXT NOT NULL,
                            rationale TEXT NOT NULL,
                            evidence_msg_ids TEXT,
                            user_confirmed INTEGER DEFAULT 0,
                            decision_type TEXT DEFAULT 'approved',
                            associated_files TEXT DEFAULT '[]',
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY(project_uuid, topic_id) REFERENCES project_topics(uuid, topic_id)
                        )
                    """)
                    
                    # 2. Data migration
                    if "evidence_msg_ids" in td_columns and "evidence_msg_db_ids" in td_columns:
                        source_evidence = "COALESCE(evidence_msg_db_ids, evidence_msg_ids)"
                    elif "evidence_msg_ids" in td_columns:
                        source_evidence = "evidence_msg_ids"
                    elif "evidence_msg_db_ids" in td_columns:
                        source_evidence = "evidence_msg_db_ids"
                    else:
                        source_evidence = "NULL"
                    
                    conn.execute(f"""
                        INSERT INTO topic_decisions_new (
                            id, project_uuid, topic_id, conversation_id, decision, rationale,
                            evidence_msg_ids, user_confirmed, decision_type, associated_files,
                            created_at, updated_at
                        )
                        SELECT 
                            id, project_uuid, topic_id, conversation_id, decision, rationale,
                            {source_evidence}, user_confirmed, decision_type, associated_files,
                            created_at, updated_at
                        FROM topic_decisions
                    """)
                    
                    # 3. Replace old table
                    conn.execute("DROP TABLE topic_decisions")
                    conn.execute("ALTER TABLE topic_decisions_new RENAME TO topic_decisions")
                    print("[Remora] Database migrated topic_decisions to Phase 34 successfully.")
            except Exception as me:
                print(f"Error during Phase 34 topic_decisions migration: {str(me)}", file=sys.stderr)

            try:
                conn.execute("SELECT created_at_msg_id FROM topic_decisions LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("ALTER TABLE topic_decisions ADD COLUMN created_at_msg_id INTEGER DEFAULT 0")

            try:
                conn.execute("SELECT last_msg_id FROM watermarks LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("ALTER TABLE watermarks ADD COLUMN last_msg_id INTEGER DEFAULT 0")

            try:
                cursor = conn.execute("PRAGMA table_info(topic_decisions)")
                columns = [row[1] for row in cursor.fetchall()]
                if "evidence_msg_db_ids" in columns:
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS topic_decisions_new (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            project_uuid TEXT NOT NULL,
                            topic_id TEXT NOT NULL,
                            conversation_id TEXT NOT NULL,
                            decision TEXT NOT NULL,
                            rationale TEXT NOT NULL,
                            evidence_msg_ids TEXT,
                            user_confirmed INTEGER DEFAULT 0,
                            created_at_line INTEGER DEFAULT 0,
                            created_at_msg_id INTEGER DEFAULT 0,
                            decision_type TEXT DEFAULT 'approved',
                            associated_files TEXT DEFAULT '[]',
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY(project_uuid, topic_id) REFERENCES project_topics(uuid, topic_id)
                        )
                    """)
                    conn.execute("""
                        INSERT INTO topic_decisions_new (
                            id, project_uuid, topic_id, conversation_id, decision, rationale,
                            evidence_msg_ids, user_confirmed, created_at_line, created_at_msg_id, decision_type,
                            associated_files, created_at, updated_at
                        )
                        SELECT 
                            id, project_uuid, topic_id, conversation_id, decision, rationale,
                            COALESCE(evidence_msg_db_ids, evidence_msg_ids), user_confirmed, created_at_line, COALESCE(created_at_msg_id, 0), decision_type,
                            associated_files, created_at, updated_at
                        FROM topic_decisions
                    """)
                    conn.execute("DROP TABLE topic_decisions")
                    conn.execute("ALTER TABLE topic_decisions_new RENAME TO topic_decisions")
                    print("[Remora] Database migrated to single-track ID (evidence_msg_ids) successfully.")
            except Exception as me:
                print(f"Error during single-track migration: {str(me)}", file=sys.stderr)

            try:
                cursor = conn.execute("PRAGMA table_info(watermarks)")
                w_columns = [row[1] for row in cursor.fetchall()]
                if "last_line_processed" in w_columns:
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS watermarks_new (
                            project_uuid TEXT NOT NULL,
                            conversation_id TEXT NOT NULL,
                            last_msg_id INTEGER DEFAULT 0,
                            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (project_uuid, conversation_id)
                        )
                    """)
                    select_last_msg_id = "last_msg_id" if "last_msg_id" in w_columns else "0"
                    conn.execute(f"""
                        INSERT INTO watermarks_new (
                            project_uuid, conversation_id, last_msg_id, last_updated
                        )
                        SELECT 
                            project_uuid, conversation_id, {select_last_msg_id}, last_updated
                        FROM watermarks
                    """)
                    conn.execute("DROP TABLE watermarks")
                    conn.execute("ALTER TABLE watermarks_new RENAME TO watermarks")
                    print("[Remora] Database migrated watermarks to Phase 34 successfully.")
            except Exception as me:
                print(f"Error during Phase 34 watermarks migration: {str(me)}", file=sys.stderr)
