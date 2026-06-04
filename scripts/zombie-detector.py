import os
import sys

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

def main():
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

    try:
        pids = os.listdir('/proc')
    except Exception:
        return

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
                sys.stderr.write(f"\n[!] FATAL: UNMANAGED BACKGROUND PROCESS DETECTED.\n")
                sys.stderr.write(f"SUSPECT: {cmdline} (UPTIME: {int(elapsed_seconds)}s, PID: {pid})\n\n")
                sys.stderr.write("ACTION REQUIRED - YOU MUST EVALUATE THIS PROCESS:\n")
                sys.stderr.write("1. Use `manage_task(list)` to find its Task ID.\n")
                sys.stderr.write("2. Use `manage_task(status, TaskId=...)` to read its logs and check if it is actively working or stuck.\n")
                sys.stderr.write("3. If it is hanging/zombie, execute `manage_task(kill, TaskId=...)`.\n")
                sys.stderr.write(f"4. If it is working normally and intentional, execute `run_command(echo {pid} >> ~/.remora/zombie_whitelist)`.\n\n")
                sys.stderr.write("ALL NEW COMMANDS ARE BLOCKED UNTIL YOU EXPLICITLY KILL OR WHITELIST IT.\n\n")
                sys.exit(1)
                
        except (IOError, OSError, PermissionError, IndexError, ValueError):
            continue

if __name__ == '__main__':
    main()
