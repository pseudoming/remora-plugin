#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Remora Topic Controller Script
用于手动控制话题状态修改 (new/switch/close) 以及手动打标确认决策 (confirm)
"""
import argparse
import os
import sqlite3
import sys

def _get_data_dir():
    env_path = os.environ.get("ANTIGRAVITY_EXECUTABLE_DATA_DIR")
    if env_path:
        return env_path
        
    current_dir = os.path.abspath(os.path.dirname(__file__))
    parts = current_dir.split(os.sep)
    if ".gemini" in parts:
        idx = parts.index(".gemini")
        gemini_root = os.sep.join(parts[:idx + 1])
        return os.path.join(gemini_root, "sidecar_data/remora-plugin/memory-compactor/data")
    else:
        return os.path.join(current_dir, "..", "sidecars", "memory-compactor", "data")

DATA_DIR = _get_data_dir()
DB_PATH = os.path.join(DATA_DIR, "remora_memory.db")

def main():
    parser = argparse.ArgumentParser(description="Remora Topic and Decision Controller")
    parser.add_argument("action", choices=["new", "switch", "close", "confirm"], help="Action to perform")
    parser.add_argument("-u", "--uuid", help="Project UUID (defaults to ANTIGRAVITY_PROJECT_ID env var)")
    parser.add_argument("-n", "--name", help="Topic ID / Name (for new, switch, close actions)")
    parser.add_argument("-d", "--decision-id", type=int, help="Decision ID to confirm (for confirm action)")

    args = parser.parse_args()

    project_uuid = args.uuid or os.environ.get("ANTIGRAVITY_PROJECT_ID")
    if not project_uuid:
        print("Error: Project UUID is required. Please specify via -u/--uuid or ANTIGRAVITY_PROJECT_ID env var.", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(DB_PATH):
        print(f"Error: Database file not found at {DB_PATH}.", file=sys.stderr)
        sys.exit(1)

    # 建立数据库连接，如果失败则快速失败 (Fail-Fast)
    try:
        conn = sqlite3.connect(DB_PATH)
    except Exception as e:
        print(f"Error: Failed to connect to database. {str(e)}", file=sys.stderr)
        sys.exit(1)

    try:
        if args.action == "new":
            if not args.name:
                print("Error: Topic name (-n/--name) is required for new action.", file=sys.stderr)
                sys.exit(1)
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status) VALUES (?, ?, 'open') "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open'",
                (project_uuid, args.name)
            )
            conn.commit()
            print(f"Created active topic {args.name} in project {project_uuid}.")

        elif args.action == "switch":
            if not args.name:
                print("Error: Topic name (-n/--name) is required for switch action.", file=sys.stderr)
                sys.exit(1)
            # 切换当前项目下的活跃话题，将其他话题设为 closed，当前话题设为 open
            conn.execute("UPDATE project_topics SET status='closed' WHERE uuid=?", (project_uuid,))
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status) VALUES (?, ?, 'open') "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open'",
                (project_uuid, args.name)
            )
            conn.commit()
            print(f"Switched active topic to {args.name} in project {project_uuid}.")

        elif args.action == "close":
            if not args.name:
                print("Error: Topic name (-n/--name) is required for close action.", file=sys.stderr)
                sys.exit(1)
            # 关闭指定话题
            conn.execute(
                "UPDATE project_topics SET status='closed' WHERE uuid=? AND topic_id=?",
                (project_uuid, args.name)
            )
            conn.commit()
            print(f"Topic {args.name} closed in project {project_uuid}.")

        elif args.action == "confirm":
            if args.decision_id is None:
                print("Error: Decision ID (-d/--decision-id) is required for confirm action.", file=sys.stderr)
                sys.exit(1)
            # 手动打标确认决策
            cursor = conn.execute(
                "UPDATE topic_decisions SET user_confirmed=1 WHERE id=? AND project_uuid=?",
                (args.decision_id, project_uuid)
            )
            conn.commit()
            if cursor.rowcount == 0:
                print(f"Warning: No decision found with ID {args.decision_id} in project {project_uuid}.", file=sys.stderr)
            else:
                print(f"Decision {args.decision_id} confirmed in project {project_uuid}.")

    except Exception as e:
        print(f"Execution Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
