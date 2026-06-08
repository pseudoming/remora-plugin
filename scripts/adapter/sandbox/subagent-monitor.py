#!/usr/bin/env python3
import sys
import json
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from adapter.bridge.paths import get_data_dir
from core.liveness import HEAVY_TOOLS, judge_zombie, suggest_zombie_action
import subprocess
from datetime import datetime, timezone

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "message": "Missing conversation_id argument"}))
        sys.exit(1)
        
    conv_id = sys.argv[1]
    # 支持接收第二个参数 parent_conv_id 作为重试计数的唯一物理 key，解决子代理重试更改 ID 导致计数清零的隐患
    parent_conv_id = sys.argv[2] if len(sys.argv) > 2 else conv_id
    
    from adapter.bridge.conversation import ConversationDataAccessLayer
    cdal = ConversationDataAccessLayer(conv_id)
    
    if not os.path.exists(cdal.db_path):
        print(json.dumps({"status": "not_found", "message": f"Subagent DB path {cdal.db_path} not found"}))
        sys.exit(0)
        
    try:
        # 扩大回溯行数至 200 行，以防大流式输出（如 run_command 的大量输出）导致无法探测到 PLANNER_RESPONSE
        steps = list(cdal.stream_steps_reverse(limit=200))
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Failed to read db logs: {str(e)}"}))
        sys.exit(1)
            
    if not steps:
        print(json.dumps({"status": "empty", "message": "DB file is empty"}))
        sys.exit(0)
        
    # 分析最近的步骤与发生时间戳
    latest_time_str = None
    last_tool_name = None
    
    # 提取最近的有效时间戳与最近的工具调用 (stream 已经倒序)
    for step in steps:
        try:
            step_type = step.get("type")
            # 抓取最近的工具调用，包括独立物理工具执行及计划内工具
            if not last_tool_name:
                if step_type in ["RUN_COMMAND", "VIEW_FILE", "CODE_ACTION", "GREP_SEARCH", "FIND", "LIST_DIR", "LIST_DIRECTORY"]:
                    last_tool_name = step_type.lower()
                elif step_type == "PLANNER_RESPONSE" and step.get("tool_calls"):
                    t_calls = step.get("tool_calls", [])
                    for tc in t_calls:
                        if tc.get("name") in ["run_command"]:
                            last_tool_name = tc.get("name")
                            break
                    if not last_tool_name and t_calls:
                        last_tool_name = t_calls[-1].get("name")
            if last_tool_name:
                break
        except Exception:
            continue
            
    # 强制统一使用 DB 文件的物理修改时间 (mtime) 作为唯一的卡死计算基准，确保绝对鲁棒性。
    mtime = cdal.get_db_mtime()
    last_update = datetime.fromtimestamp(mtime, timezone.utc)
        
    now = datetime.now(timezone.utc)
    idle_seconds = int((now - last_update).total_seconds())
    
    is_zombie, limit = judge_zombie(idle_seconds, last_tool_name)
    status = "zombie" if is_zombie else "active"
    
    # 物理维护自愈重试计数 (绑定 parent_conv_id)
    retry_dir = os.path.join(get_data_dir(), ".runtime", "remora_subagent_retries")
    retry_file = f"{retry_dir}/{parent_conv_id}.json"
    retry_count = 0
    
    if status == "zombie":
        try:
            os.makedirs(retry_dir, exist_ok=True)
            if os.path.exists(retry_file):
                with open(retry_file, "r") as rf:
                    retry_data = json.load(rf)
                    retry_count = retry_data.get("retry_count", 0)
            
            retry_count += 1
            with open(retry_file, "w") as wf:
                json.dump({"retry_count": retry_count}, wf)
        except Exception:
            pass
    else:
        # 自清理：一旦探测处于活跃状态，立即物理删除旧的重试计数文件，实现计数归零重置
        try:
            if os.path.exists(retry_file):
                os.remove(retry_file)
        except Exception:
            pass
            
    # 行动建议判定：前两次判定卡死均尝试自动 Kill 强杀并 Retry 重试，第 2 次后依然失败则汇报人类
    if status == "zombie":
        action_suggestion = suggest_zombie_action(retry_count)
    else:
        action_suggestion = "continue_monitoring"
    
    print(json.dumps({
        "status": status,
        "conversation_id": conv_id,
        "parent_conversation_id": parent_conv_id,
        "last_tool": last_tool_name or "None",
        "idle_seconds": idle_seconds,
        "limit_threshold": limit,
        "last_active_time": last_update.isoformat(),
        "retry_count": retry_count,
        "action_suggestion": action_suggestion
    }))

if __name__ == "__main__":
    main()
