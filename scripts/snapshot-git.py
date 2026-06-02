#!/usr/bin/env python3
import sys
import json
import os
import subprocess
from pathlib import Path

def get_active_files(cwd):
    """
    自适应获取当前目录下的活跃文件列表。
    Git 模式: git ls-files --cached --others --exclude-standard
    Fallback 模式: os.walk
    """
    try:
        # 检测是否在 git 仓库内
        subprocess.check_call(['git', 'rev-parse', '--is-inside-work-tree'], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        is_git = True
    except subprocess.CalledProcessError:
        is_git = False
    except FileNotFoundError:
        # Git 未安装
        is_git = False
        
    active_files = set()
    
    if is_git:
        try:
            output = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=cwd, text=True, stderr=subprocess.DEVNULL)
            for line in output.split('\n'):
                line = line.strip()
                if line:
                    # 统一使用相对路径以防不同子目录下的路径解析问题，这里使用 basename 的集合，
                    # 但为了精准，应该保存完整相对或绝对路径。这里选择绝对路径。
                    active_files.add(os.path.abspath(os.path.join(cwd, line)))
        except Exception:
            is_git = False
            
    if not is_git:
        blacklist_dirs = {'node_modules', '.venv', 'venv', '.gemini', '__pycache__', 'build', 'dist', 'target', 'vendor', 'pkg', '.gradle', '.git'}
        for root, dirs, files in os.walk(cwd):
            dirs[:] = [d for d in dirs if d not in blacklist_dirs]
            for f in files:
                active_files.add(os.path.abspath(os.path.join(root, f)))
                
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

def main():
    try:
        context = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"injectSteps": []}))
        return
        
    transcript_path = context.get('transcriptPath', '')
    cwd = context.get('cwd', os.getcwd())
    
    if not transcript_path:
        print(json.dumps({"injectSteps": []}))
        return
        
    try:
        conv_dir = Path(transcript_path).parent.parent.parent
        scratch_dir = conv_dir / 'scratch'
        scratch_dir.mkdir(parents=True, exist_ok=True)
        snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
        
        snapshot = get_snapshot(cwd)
        with open(snapshot_file, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f)
            
    except Exception:
        pass
        
    print(json.dumps({"injectSteps": []}))

if __name__ == "__main__":
    main()
