import os
import sys
import inspect
from datetime import datetime, timedelta
from pathlib import Path

LOG_DIR = None
_init_done = False
_log_file = None


def _resolve_log_dir():
    global LOG_DIR
    if LOG_DIR is None:
        try:
            from adapter.bridge.paths import get_data_dir
            LOG_DIR = os.path.join(get_data_dir(), "logs")
        except Exception:
            LOG_DIR = os.path.join(os.path.expanduser("~"), ".remora", "logs")
    return LOG_DIR


def init():
    global _init_done, _log_file

    log_dir = _resolve_log_dir()
    os.makedirs(log_dir, exist_ok=True)

    today_str = datetime.now().strftime("%Y-%m-%d")
    log_path = os.path.join(log_dir, "system.log")

    if os.path.exists(log_path):
        mtime = datetime.fromtimestamp(os.path.getmtime(log_path))
        if mtime.strftime("%Y-%m-%d") != today_str:
            archive_path = os.path.join(log_dir, f"system.{mtime.strftime('%Y-%m-%d')}.log")
            os.rename(log_path, archive_path)

    _log_file = log_path
    _init_done = True

    # Cleanup old logs (>3 days)
    cutoff = datetime.now() - timedelta(days=3)
    try:
        for fname in os.listdir(log_dir):
            if fname.startswith("system.") and fname.endswith(".log") and fname != "system.log":
                fpath = os.path.join(log_dir, fname)
                try:
                    ftime = datetime.fromtimestamp(os.path.getmtime(fpath))
                    if ftime < cutoff:
                        os.remove(fpath)
                except Exception:
                    pass
    except Exception:
        pass


def _format_caller():
    frame = inspect.currentframe()
    try:
        caller = frame.f_back.f_back.f_back
        if caller is None:
            caller = frame.f_back.f_back
        filename = os.path.basename(caller.f_code.co_filename)
        lineno = caller.f_lineno
        return f"{filename}:{lineno}"
    finally:
        del frame


def _log(level, msg):
    global _init_done, _log_file
    if not _init_done:
        init()
    if _log_file is None:
        return

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    caller = _format_caller()
    line = f"[{timestamp}] [{level}] [{caller}] {msg}\n"

    try:
        with open(_log_file, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def _write_raw(log_path, content, max_bytes=1024*1024):
    try:
        path = Path(log_path)
        if path.exists() and path.stat().st_size > max_bytes:
            with open(path, "w", encoding="utf-8") as f:
                f.write(f"=== Log Rotated at {datetime.now().isoformat()} ===\n")
        with open(path, "a", encoding="utf-8") as f:
            f.write(content)
    except Exception:
        pass


def info(msg):
    _log("INFO", msg)


def warn(msg):
    _log("WARN", msg)
    print(f"[WARN] {msg}", file=sys.stderr)


def error(msg):
    _log("ERROR", msg)
    print(f"[ERROR] {msg}", file=sys.stderr)


def profile(msg, log_path=None):
    if log_path is not None:
        _write_raw(log_path, msg)
    elif isinstance(msg, str) and msg.strip().startswith("==="):
        try:
            from adapter.bridge.paths import HOOKS_PROFILE_LOG
            _write_raw(HOOKS_PROFILE_LOG, msg)
        except Exception:
            pass
    else:
        _log("PROF", msg)
