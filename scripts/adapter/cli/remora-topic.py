#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from adapter.bridge.paths import get_data_dir
"""
Remora Topic Controller Script
用于手动控制话题状态修改 (new/switch/close) 以及手动打标确认决策 (confirm)
"""
from lib import dao
from core.logger import error, warn, info

def _force_cold_start():
    # 强置 is_cold_start 信号位以实现冷启动与 Topic 切换同步
    main_conv_id = None
    if os.path.exists(os.path.join(get_data_dir(), ".runtime", "remora_main_conv_id.txt")):
        try:
            with open(os.path.join(get_data_dir(), ".runtime", "remora_main_conv_id.txt"), "r") as mf:
                main_conv_id = mf.read().strip()
        except:
            pass
    dao.force_cold_start_latest_session(main_conv_id)

def main():
    parser = argparse.ArgumentParser(description="Remora Topic and Decision Controller")
    parser.add_argument("action", choices=["new", "switch", "close", "confirm"], help="Action to perform")
    parser.add_argument("-u", "--uuid", help="Project UUID (defaults to ANTIGRAVITY_PROJECT_ID env var)")
    parser.add_argument("-n", "--name", help="Topic ID / Name (for new, switch, close actions)")
    parser.add_argument("-d", "--decision-id", type=int, help="Decision ID to confirm (for confirm action)")

    args = parser.parse_args()

    project_uuid = args.uuid or os.environ.get("ANTIGRAVITY_PROJECT_ID")
    if not project_uuid:
        error("Project UUID is required. Please specify via -u/--uuid or ANTIGRAVITY_PROJECT_ID env var.")
        sys.exit(1)

    # dao operations encapsulate DB connection, so we don't need conn directly.
    # except for testing DB presence:
    if not dao.check_db_exists():
        error(f"Database file not found.")
        sys.exit(1)

    try:
        if args.action == "new":
            if not args.name:
                error("Topic name (-n/--name) is required for new action.")
                sys.exit(1)
            dao.create_or_update_topic(project_uuid, args.name, summary="", source="manual")
            _force_cold_start()
            print(f"Created active topic {args.name} in project {project_uuid}.")

        elif args.action == "switch":
            if not args.name:
                error("Topic name (-n/--name) is required for switch action.")
                sys.exit(1)
            # 切换当前项目下的活跃话题，将其他话题设为 closed，当前话题设为 open
            dao.switch_topic(project_uuid, args.name)
            _force_cold_start()
            print(f"Switched active topic to {args.name} in project {project_uuid}.")

        elif args.action == "close":
            if not args.name:
                error("Topic name (-n/--name) is required for close action.")
                sys.exit(1)
            # 关闭指定话题，物理晋升为 manual 防止 GC 清理
            dao.close_topic(project_uuid, args.name)
            print(f"Topic {args.name} closed in project {project_uuid}.")

        elif args.action == "confirm":
            if args.decision_id is None:
                error("Decision ID (-d/--decision-id) is required for confirm action.")
                sys.exit(1)
            # 手动打标确认决策
            success = dao.confirm_decision(project_uuid, args.decision_id)
            if not success:
                warn(f"No decision found with ID {args.decision_id} in project {project_uuid}.")
            else:
                print(f"Decision {args.decision_id} confirmed in project {project_uuid}.")
                
                # 晋升关联话题为 manual 并更新访问时间
                t_id = dao.get_topic_id_by_decision(args.decision_id)
                if t_id:
                    dao.touch_topic_source_manual(project_uuid, t_id)

                # 方案 B: 隐式沙箱自动合并并捕获物理文件列表
                info("Checking for isolated subagent sandboxes to merge...")
                try:
                    import glob, subprocess, json
                    worktrees = glob.glob(os.path.expanduser("~/.gemini/antigravity/brain/*/.system_generated/worktrees/subagent-*"))
                    if worktrees:
                        # 启发式合并：取最近修改的那个工作树
                        worktrees.sort(key=os.path.getmtime, reverse=True)
                        latest_worktree = worktrees[0]
                        wt_name = os.path.basename(latest_worktree)
                        info(f"Found latest subagent sandbox: {wt_name}")
                        
                        merge_script = os.path.join(os.path.dirname(os.path.dirname(__file__)), "sandbox", "sandbox-merge.py")
                        res = subprocess.run([sys.executable, merge_script, wt_name, "--target-cwd", os.getcwd()], capture_output=True, text=True, check=True)
                        
                        # 解析 stdout 中的物理变更文件列表
                        physical_files = []
                        for line in res.stdout.splitlines():
                            if line.startswith("[PHYSICAL_CHANGES]"):
                                parts = line.split(" ", 1)
                                if len(parts) > 1:
                                    physical_files.append(os.path.basename(parts[1].strip()))
                                    
                        if physical_files and t_id:
                            dao.merge_physical_files_to_topic(project_uuid, t_id, physical_files)
                            for pf in physical_files:
                                dao.insert_file_change(project_uuid, wt_name, pf, "sandbox")
                            print(f"[Remora] Integrated {len(physical_files)} physical changed files from sandbox.")
                    else:
                        info("No active sandbox worktree found. Nothing to merge.")
                except Exception as e:
                    error(f"Sandbox automatic merge failed: {str(e)}")

    except Exception as e:
        error(f"Execution Error: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
