import subprocess, os, hashlib

def get_active_files(cwd):
    try:
        subprocess.check_call(['git', 'rev-parse', '--is-inside-work-tree'], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        is_git = True
    except Exception:
        is_git = False
        
    active_files = set()
    if is_git:
        try:
            output = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=cwd, text=True, stderr=subprocess.DEVNULL)
            for line in output.split('\n'):
                line = line.strip()
                if line:
                    active_files.add(os.path.abspath(os.path.join(cwd, line)))
        except Exception:
            is_git = False
            
    if not is_git:
        blacklist_dirs = {'node_modules', '.venv', 'venv', '__pycache__', 'build', 'dist', 'target', 'vendor', 'pkg', '.gradle', '.git'}
        file_count = 0
        for root, dirs, files in os.walk(cwd):
            dirs[:] = [d for d in dirs if d not in blacklist_dirs]
            for f in files:
                active_files.add(os.path.abspath(os.path.join(root, f)))
                file_count += 1
                if file_count > 2000:
                    break
            if file_count > 2000:
                break
                
    return active_files

def get_snapshot(cwd):
    files = get_active_files(cwd)
    snapshot = {}
    for f in files:
        try:
            st = os.stat(f)
            snapshot[f] = {
                "mtime": st.st_mtime,
                "size": st.st_size
            }
        except Exception:
            pass
    return snapshot

def calculate_md5(file_path):
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

def diff_snapshots(pre_snapshot, post_snapshot):
    modified_files = set()
    for fpath, post_st in post_snapshot.items():
        if fpath not in pre_snapshot:
            modified_files.add(os.path.basename(fpath))
        else:
            pre_st = pre_snapshot[fpath]
            if post_st['mtime'] != pre_st['mtime'] or post_st['size'] != pre_st['size']:
                modified_files.add(os.path.basename(fpath))
    return modified_files
