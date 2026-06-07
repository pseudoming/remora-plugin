import sqlite3
import os
import sys

scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
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

            # 新增 runtime_hook_state 跨进程 Hook 状态表
            conn.execute("""
                CREATE TABLE IF NOT EXISTS runtime_hook_state (
                    session_id TEXT NOT NULL,
                    turn_idx INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT,
                    PRIMARY KEY (session_id, turn_idx, key)
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

            try:
                conn.execute("SELECT last_msg_id FROM watermarks LIMIT 1")
            except sqlite3.OperationalError:
                conn.execute("ALTER TABLE watermarks ADD COLUMN last_msg_id INTEGER DEFAULT 0")

if __name__ == "__main__":
    init_db()

