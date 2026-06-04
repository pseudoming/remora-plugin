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

sys.path.insert(0, os.path.dirname(__file__))
from lib.paths import get_db_path

DB_PATH = get_db_path()

def _force_cold_start(conn):
    # 强置 is_cold_start 信号位以实现冷启动与 Topic 切换同步
    main_conv_id = None
    if os.path.exists("/tmp/remora_main_conv_id.txt"):
        try:
            with open("/tmp/remora_main_conv_id.txt", "r") as mf:
                main_conv_id = mf.read().strip()
        except:
            pass
    if main_conv_id:
        conn.execute(
            "INSERT INTO session_state (session_id, is_cold_start, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) "
            "ON CONFLICT(session_id) DO UPDATE SET is_cold_start=1, updated_at=CURRENT_TIMESTAMP",
            (main_conv_id,)
        )
    else:
        # 仅对最近活跃的单一 session 进行置位，防止污染全表历史 session
        conn.execute("""
            UPDATE session_state 
            SET is_cold_start = 1, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = (SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1)
        """)

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
                "INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES (?, ?, 'open', 'manual', CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', source='manual', last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, args.name)
            )
            _force_cold_start(conn)
            conn.commit()
            print(f"Created active topic {args.name} in project {project_uuid}.")

        elif args.action == "switch":
            if not args.name:
                print("Error: Topic name (-n/--name) is required for switch action.", file=sys.stderr)
                sys.exit(1)
            # 切换当前项目下的活跃话题，将其他话题设为 closed，当前话题设为 open
            conn.execute("UPDATE project_topics SET status='closed' WHERE uuid=?", (project_uuid,))
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status, last_accessed_at) VALUES (?, ?, 'open', CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, args.name)
            )
            _force_cold_start(conn)
            conn.commit()
            print(f"Switched active topic to {args.name} in project {project_uuid}.")

        elif args.action == "close":
            if not args.name:
                print("Error: Topic name (-n/--name) is required for close action.", file=sys.stderr)
                sys.exit(1)
            # 关闭指定话题，物理晋升为 manual 防止 GC 清理
            conn.execute(
                "UPDATE project_topics SET status='closed', source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
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
                
                # 晋升关联话题为 manual 并更新访问时间
                topic_row = conn.execute(
                    "SELECT topic_id FROM topic_decisions WHERE id=?", (args.decision_id,)
                ).fetchone()
                if topic_row:
                    t_id = topic_row[0]
                    conn.execute(
                        "UPDATE project_topics SET source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                        (project_uuid, t_id)
                    )

                # 方案 B: 隐式沙箱自动合并并捕获物理文件列表
                print("Checking for isolated subagent sandboxes to merge...", file=sys.stderr)
                try:
                    import glob, subprocess, json
                    worktrees = glob.glob(os.path.expanduser("~/.gemini/antigravity/brain/*/.system_generated/worktrees/subagent-*"))
                    if worktrees:
                        # 启发式合并：取最近修改的那个工作树
                        worktrees.sort(key=os.path.getmtime, reverse=True)
                        latest_worktree = worktrees[0]
                        wt_name = os.path.basename(latest_worktree)
                        print(f"Found latest subagent sandbox: {wt_name}", file=sys.stderr)
                        
                        merge_script = os.path.join(os.path.dirname(__file__), "sandbox-merge.py")
                        res = subprocess.run(["python3", merge_script, wt_name], capture_output=True, text=True, check=True)
                        
                        # 解析 stdout 中的物理变更文件列表
                        physical_files = []
                        for line in res.stdout.splitlines():
                            if line.startswith("[PHYSICAL_CHANGES]"):
                                parts = line.split(" ", 1)
                                if len(parts) > 1:
                                    physical_files.append(os.path.basename(parts[1].strip()))
                                    
                        if physical_files and topic_row:
                            t_id = topic_row[0]
                            p_row = conn.execute(
                                "SELECT associated_files FROM project_topics WHERE uuid=? AND topic_id=?",
                                (project_uuid, t_id)
                            ).fetchone()
                            existing_assoc = json.loads(p_row[0]) if p_row and p_row[0] else []
                            assoc_dict = {item['file']: item for item in existing_assoc if 'file' in item}
                            
                            for pf in physical_files:
                                if pf not in assoc_dict:
                                    assoc_dict[pf] = {"file": pf, "source": "physical"}
                                elif "physical" not in assoc_dict[pf].get("source", ""):
                                    assoc_dict[pf]["source"] = assoc_dict[pf]["source"] + ", physical"
                                    
                            conn.execute(
                                "UPDATE project_topics SET associated_files=? WHERE uuid=? AND topic_id=?",
                                (json.dumps(list(assoc_dict.values())), project_uuid, t_id)
                            )
                            conn.commit()
                            print(f"[Remora] Integrated {len(physical_files)} physical changed files from sandbox.")
                    else:
                        print("No active sandbox worktree found. Nothing to merge.", file=sys.stderr)
                except Exception as e:
                    print(f"Sandbox automatic merge failed: {str(e)}", file=sys.stderr)

    except Exception as e:
        print(f"Execution Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
