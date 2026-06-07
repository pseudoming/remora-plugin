import os


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


INFRASTRUCTURE_KEYWORDS = frozenset({
    "compactor.py", "safety-check.py", "zombie-detector.py",
    "cognitive-push.py", "snapshot-git.py", "session-guardian.py",
    "tone-injector.py", "clean-session-stats.py", "action-gate.py",
    "shellIntegration-bash.sh"
})
