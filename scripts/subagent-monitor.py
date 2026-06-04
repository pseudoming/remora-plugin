from lib.paths import get_data_dir
#!/usr/bin/env python3
import sys
import json
import os
import subprocess
from datetime import datetime, timezone

def parse_iso_time(time_str):
    """安全解析不同格式 of ISO 8601 和空格分隔的时间戳"""
    try:
        ts = time_str.replace('T', ' ').replace('Z', '').split('.')[0].strip()
        return datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    except Exception:
        # 异常兜底返回 None，由调用端自动回退使用文件的物理 mtime
        return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "message": "Missing conversation_id argument"}))
        sys.exit(1)
        
    conv_id = sys.argv[1]
    # 支持接收第二个参数 parent_conv_id 作为重试计数的唯一物理 key，解决子代理重试更改 ID 导致计数清零的隐患
    parent_conv_id = sys.argv[2] if len(sys.argv) > 2 else conv_id
    
    home_dir = os.environ.get("HOME", os.path.expanduser("~"))
    log_path = f"{home_dir}/.gemini/antigravity/brain/{conv_id}/.system_generated/logs/transcript.jsonl"
    
    if not os.path.exists(log_path):
        print(json.dumps({"status": "not_found", "message": f"Subagent log path {log_path} not found"}))
        sys.exit(0)
        
    try:
        # 扩大回溯行数至 200 行，以防大流式输出（如 run_command 的大量输出）导致无法探测到 PLANNER_RESPONSE
        output = subprocess.check_output(["tail", "-n", "200", log_path], stderr=subprocess.STDOUT)
        lines = [line.strip() for line in output.decode('utf-8').strip().split('\n') if line.strip()]
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Failed to read logs: {str(e)}"}))
        sys.exit(1)
            
    if not lines:
        print(json.dumps({"status": "empty", "message": "Log file is empty"}))
        sys.exit(0)
        
    # 分析最近的步骤与发生时间戳
    latest_time_str = None
    last_tool_name = None
    
    # 提取最近的有效时间戳与最近的工具调用
    for line in reversed(lines):
        try:
            step = json.loads(line)
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
            
    # 由于系统日志内不包含显式 timestamp，我们彻底摒弃 JSON 内联时间解析，
    # 强制统一使用日志文件的物理修改时间 (mtime) 作为唯一的卡死计算基准，确保绝对鲁棒性。
    mtime = os.path.getmtime(log_path)
    last_update = datetime.fromtimestamp(mtime, timezone.utc)
        
    now = datetime.now(timezone.utc)
    idle_seconds = int((now - last_update).total_seconds())
    
    # 重型耗时指令白名单，包含物理执行和大规模只读搜索，覆盖 ReadOnly 等子代理的需求
    heavy_tools = {"run_command", "grep_search"}
    is_heavy = last_tool_name in heavy_tools
    
    # 调整阈值：重型物理操作放宽至 180s。考虑到长上下文 Agent 推理思考耗时长，普通 API 查询/思考判定阈值提升至 60s
    limit = 180 if is_heavy else 60
    
    is_zombie = idle_seconds > limit
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
        action_suggestion = "kill_and_retry" if retry_count < 2 else "escalate_to_human"
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
