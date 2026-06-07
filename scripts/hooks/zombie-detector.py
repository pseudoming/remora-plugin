import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from adapter.bridge.paths import HOOKS_PROFILE_LOG
from adapter.bridge.context import hook_entrypoint

def log_duration(elapsed, exit_code=0):
    try:
        if os.path.exists(HOOKS_PROFILE_LOG) and os.path.getsize(HOOKS_PROFILE_LOG) > 1024 * 1024:
            with open(HOOKS_PROFILE_LOG, "w", encoding="utf-8") as f:
                f.write(f"=== Log Rotated at {datetime.now().isoformat()} ===\n")
        with open(HOOKS_PROFILE_LOG, "a", encoding="utf-8") as f:
            f.write(f"=== [zombie-detector.py] Run at {datetime.now().isoformat()} ===\n")
            f.write(f"  [total]: {elapsed:.2f} ms (Exit Code: {exit_code})\n\n")
    except Exception:
        pass

def get_sys_uptime():
    try:
        with open('/proc/uptime', 'r') as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0

def clean_whitelist(whitelist_path):
    if not os.path.exists(whitelist_path):
        return set()
        
    valid_pids = set()
    dirty = False
    
    try:
        with open(whitelist_path, 'r') as f:
            for line in f:
                pid = line.strip()
                if not pid: continue
                if os.path.exists(f"/proc/{pid}"):
                    valid_pids.add(pid)
                else:
                    dirty = True
                    
        if dirty:
            os.makedirs(os.path.dirname(whitelist_path), exist_ok=True)
            with open(whitelist_path, 'w') as f:
                for pid in valid_pids:
                    f.write(f"{pid}\n")
    except Exception:
        pass
        
    return valid_pids

@hook_entrypoint(fallback_result={"decision": "allow"})
def main(context):
    t0 = time.perf_counter()
    my_uid = os.getuid()
    my_pid = str(os.getpid())
    sys_uptime = get_sys_uptime()
    clk_tck = os.sysconf('SC_CLK_TCK')
    
    whitelist_path = os.path.expanduser("~/.remora/zombie_whitelist")
    whitelisted_pids = clean_whitelist(whitelist_path)
    
    infrastructure_keywords = {
        "compactor.py", "safety-check.py", "zombie-detector.py", 
        "cognitive-push.py", "snapshot-git.py", "session-guardian.py", 
        "tone-injector.py", "clean-session-stats.py", "action-gate.py",
        "shellIntegration-bash.sh"
    }

    is_tool_use = (context and isinstance(context, dict) and context.get('toolCall') is not None)

    try:
        pids = os.listdir('/proc')
    except Exception:
        log_duration((time.perf_counter() - t0) * 1000.0, 0)
        if is_tool_use:
            return {"decision": "allow"}
        else:
            return {"injectSteps": []}

    for pid in pids:
        if not pid.isdigit() or pid == my_pid:
            continue
            
        pid_dir = os.path.join('/proc', pid)
        try:
            if os.stat(pid_dir).st_uid != my_uid:
                continue
                
            with open(os.path.join(pid_dir, 'environ'), 'rb') as f:
                env_data = f.read().split(b'\0')
                
            is_antigravity = False
            for item in env_data:
                if item.startswith(b'ANTIGRAVITY_AGENT='):
                    is_antigravity = True
                    break
                    
            if not is_antigravity:
                continue
                
            # It's an Antigravity task. Check uptime.
            with open(os.path.join(pid_dir, 'stat'), 'r') as f:
                stat_data = f.read().split()
                # Skip if process is in D state (Uninterruptible sleep) to avoid hanging
                if len(stat_data) > 2 and stat_data[2] == 'D':
                    continue
                # Field 22 is starttime (1-indexed in docs, 21 in 0-indexed list)
                starttime = int(stat_data[21])
                
            elapsed_seconds = sys_uptime - (starttime / clk_tck)
            
            if elapsed_seconds > 15.0:
                if pid in whitelisted_pids:
                    continue
                    
                with open(os.path.join(pid_dir, 'cmdline'), 'rb') as f:
                    cmdline_raw = f.read().split(b'\0')
                    cmdline = " ".join([c.decode('utf-8', 'ignore') for c in cmdline_raw if c]).strip()
                    
                # Static infrastructure whitelist
                is_infra = False
                for kw in infrastructure_keywords:
                    if kw in cmdline:
                        is_infra = True
                        break
                        
                if is_infra:
                    continue
                
                # ZOMBIE DETECTED!
                sys.stderr.write(f"\n[!] WARNING: UNMANAGED BACKGROUND PROCESS DETECTED.\n")
                sys.stderr.write(f"SUSPECT: {cmdline} (UPTIME: {int(elapsed_seconds)}s, PID: {pid})\n\n")
                
                log_duration((time.perf_counter() - t0) * 1000.0, 0)
                
                
                if is_tool_use:
                    tool_name = context.get('toolCall', {}).get('name', '') if context else ''
                    if tool_name == 'manage_task':
                        continue
                    return {
                        "decision": "deny",
                        "reason": f"⚠️ 安全拦截：系统存在运行中的未托管衍生进程 {pid}，工具执行已被临时拒绝。"
                    }
                else:
                    return {
                        "injectSteps": [
                            {
                                "ephemeralMessage": f"⚠️ 警告：检测到未托管衍生后台进程 {pid} (UPTIME: {int(elapsed_seconds)}s)。当前命令已被安全网关限制，请使用 manage_task(list) 物理清理该进程。"
                            }
                        ]
                    }
                
        except (IOError, OSError, PermissionError, IndexError, ValueError):
            continue

    log_duration((time.perf_counter() - t0) * 1000.0, 0)
    if is_tool_use:
        return {"decision": "allow"}
    else:
        return {"injectSteps": []}

if __name__ == '__main__':
    main()
