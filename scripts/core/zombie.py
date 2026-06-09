INFRASTRUCTURE_KEYWORDS = frozenset({
    "compactor.py", "safety-check.py", "zombie-detector.py",
    "cognitive-push.py", "snapshot-git.py", "session-guardian.py",
    "tone-injector.py", "clean-session-stats.py", "action-gate.py",
    "shellIntegration-bash.sh"
})


def is_infrastructure_process(cmdline, keywords=INFRASTRUCTURE_KEYWORDS):
    for kw in keywords:
        if kw in cmdline:
            return True
    return False


def is_process_expired(elapsed_seconds, threshold=15.0):
    return elapsed_seconds > threshold
