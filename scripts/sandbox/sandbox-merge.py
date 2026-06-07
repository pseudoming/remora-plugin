#!/usr/bin/env python3
import sys, os, subprocess, glob

def main():
    if len(sys.argv) < 2:
        print("Usage: sandbox-merge.py <subagent_conv_id> --target-cwd <dir>")
        sys.exit(1)
        
    subagent_id = sys.argv[1]

    target_cwd = None
    for i, arg in enumerate(sys.argv):
        if arg == "--target-cwd" and i + 1 < len(sys.argv):
            target_cwd = sys.argv[i + 1]
            break
    if not target_cwd:
        print("ERROR: --target-cwd is required.")
        sys.exit(1)
    
    # 模拟 bash: ls -d ~/.gemini/antigravity/brain/*/.system_generated/worktrees/*$SUBAGENT_CONV_ID* | head -n 1
    pattern = os.path.expanduser(f"~/.gemini/antigravity/brain/*/.system_generated/worktrees/*{subagent_id}*")
    matches = glob.glob(pattern)
    
    if not matches:
        print(f"ERROR: Could not find isolated worktree for {subagent_id}. Either it doesn't exist, or it wasn't invoked with 'Workspace: branch'.")
        sys.exit(1)
        
    wt_dir = matches[0]
    
    try:
        # 1. 抽取分支名: git -C "$WORKTREE_DIR" branch --show-current
        branch_name = subprocess.check_output(["git", "-C", wt_dir, "branch", "--show-current"], text=True).strip()
        
        if not branch_name:
            print("ERROR: Could not determine branch name in worktree.")
            sys.exit(1)
            
        print(f"Merging branch {branch_name} from worktree {wt_dir} ...")
        
        # 提取物理变更文件列表输出给调用者
        print("[Remora] Detecting physical changed files in sandbox...")
        try:
            diff_output = subprocess.check_output(["git", "-C", target_cwd, "diff", "--name-only", f"main...{branch_name}"], text=True)
            for line in diff_output.splitlines():
                if line.strip():
                    print(f"[PHYSICAL_CHANGES] {line.strip()}")
        except subprocess.CalledProcessError as e:
            print(f"Failed to detect physical changes: {e}")
        
        # 2. 合并: cd {target_cwd} && git merge "$BRANCH_NAME"
        subprocess.check_call(["git", "merge", branch_name, "-m", f"Merge sandbox changes from subagent {subagent_id}"], cwd=target_cwd)
        
        print("Sandbox merged successfully.")
    except subprocess.CalledProcessError as e:
        print(f"Git merge failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
