#!/usr/bin/env python3
"""
Remora Memory Compactor V2.2 (Modular Split Version)
"""
import json
import time
import sqlite3
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))

import argparse

from schema.schema_init import DB_PATH, DATA_DIR, init_db
from adapter.maintenance.session_gc import prune_expired_watermarks
from adapter.maintenance.topic_gc import run_garbage_collection

from sidecar_lock import acquire_lock, release_lock
from extract_decisions import process_sessions, AgentApiError
from sync_artifacts import scan_and_ingest_artifacts
from check_approval import check_plan_approval
from consume_events import consume_event_queue
from core.storage.topics import get_all_project_uuids

def prune_sidecar_events():
    """清理 Antigravity 系统分发给 Sidecar 的过剩僵尸审计日志"""
    try:
        events_dir = os.path.join(DATA_DIR, "events")
        if os.path.exists(events_dir):
            import glob
            for f in glob.glob(os.path.join(events_dir, "*.json")):
                try:
                    os.remove(f)
                except Exception:
                    pass
    except Exception:
        pass

def main():
    parser = argparse.ArgumentParser(description="Remora Memory Compactor V2.2")
    parser.add_argument("--cron", action="store_true")
    parser.add_argument("--event-driven", action="store_true")
    args = parser.parse_args()

    init_db()

    if args.event_driven:
        # Stop 钩子同步扫描制品。它是单次极轻量的，无需文件锁保护，避免互斥冲突
        try:
            context = json.load(sys.stdin)
            scan_and_ingest_artifacts(context)
        except Exception:
            pass
    else:
        # 默认或 --cron 阶段的后台增量对话扫描，长耗时，必须文件锁保护
        acquire_lock()
        cycle_start = time.time()
        try:
            prune_expired_watermarks()
            process_sessions(cycle_start)
            
            # [P0] 串行保序：前置 decisions 提取 commit 之后，立即执行 Plan 审批拦截与事件队列 AI 精确匹配
            with sqlite3.connect(DB_PATH, timeout=15) as conn:
                active_projects = get_all_project_uuids(conn)
                for p_uuid in active_projects:
                    check_plan_approval(conn, p_uuid)
                consume_event_queue(conn, cycle_start)
                run_garbage_collection(conn)
        except AgentApiError as e:
            print(str(e), file=sys.stderr)
            release_lock()
            sys.exit(1)
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            prune_sidecar_events()
            release_lock()

if __name__ == "__main__":
    main()
