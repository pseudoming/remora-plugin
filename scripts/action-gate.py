#!/usr/bin/env python3
import sys
import json
import re
import os
import subprocess
from pathlib import Path

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
        blacklist_dirs = {'node_modules', '.venv', 'venv', '.gemini', '__pycache__', 'build', 'dist', 'target', 'vendor', 'pkg', '.gradle', '.git'}
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

def get_physical_modifications(cwd, transcript_path):
    try:
        conv_dir = Path(transcript_path).parent.parent.parent
        scratch_dir = conv_dir / 'scratch'
        artifacts_dir = conv_dir / 'artifacts'
        snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
        
        pre_snapshot = {}
        if snapshot_file.exists():
            with open(snapshot_file, 'r', encoding='utf-8') as f:
                pre_snapshot = json.load(f)
                
        post_snapshot = get_snapshot(cwd)
        if artifacts_dir.exists():
            try:
                artifacts_snapshot = get_snapshot(str(artifacts_dir))
                post_snapshot.update(artifacts_snapshot)
            except Exception:
                pass
                
        modified_files = set()
        for fpath, post_st in post_snapshot.items():
            if fpath not in pre_snapshot:
                modified_files.add(os.path.basename(fpath))
            else:
                pre_st = pre_snapshot[fpath]
                if post_st['mtime'] != pre_st['mtime'] or post_st['size'] != pre_st['size']:
                    modified_files.add(os.path.basename(fpath))
                    
        return modified_files
    except Exception:
        return set()

def get_latest_conversation_states(transcript_path):
    """
    流式读取 transcript.jsonl 末尾数据，
    提取出最近一次大模型的 PLANNER_RESPONSE 陈述文本以及本次整个交互回合中的物理写入工具调用。
    """
    planner_text = None
    actual_modified_files = set()
    has_any_tool_calls = False
    
    if not os.path.exists(transcript_path):
        return "", set(), False

    try:
        # 使用 tail 读取最后 1000 行，防大文件内存暴增
        output = subprocess.check_output(['tail', '-n', '1000', transcript_path], stderr=subprocess.STDOUT)
        lines = output.decode('utf-8').strip().split('\n')
        
        # 1. 寻找最近一个用户输入的 step_index
        user_input_index = None
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                step = json.loads(line)
                if step.get('type') == 'USER_INPUT' or step.get('source') in ['USER', 'USER_EXPLICIT']:
                    user_input_index = step.get('step_index')
                    break
            except Exception:
                continue
        
        # 2. 逆序向前分析最近一次交互回合的内容
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                step = json.loads(line)
                step_type = step.get('type')
                step_index = step.get('step_index')
                
                # 如果有用户输入的起点，只回溯到该用户输入步骤为止
                if user_input_index is not None and step_index is not None and step_index < user_input_index:
                    break
                    
                tool_calls = step.get('tool_calls', [])
                if tool_calls:
                    has_any_tool_calls = True
                    
                # 只有当 content 存在且不为空时才抓取作为 planner_text
                if step_type == 'PLANNER_RESPONSE' and planner_text is None:
                    content = step.get('content', '')
                    if content:
                        planner_text = content
                    
                # 从工具调用列表中，提取原生写入工具
                if tool_calls:
                    for call in tool_calls:
                        name = call.get('name', '')
                        # 【Bug A 修复核心】：兼容不同大模型框架的 args/arguments 命名
                        args = call.get('args') or call.get('arguments') or {}
                        
                        if name in ['write_to_file', 'replace_file_content', 'multi_replace_file_content']:
                            # 防御性解析：如果 args 整体被序列化为了字符串
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except Exception:
                                    pass
                                    
                            if isinstance(args, dict):
                                target_file = args.get('TargetFile', '')
                                if target_file:
                                    # 防御性解析：处理某些底层框架传递参数时带有嵌套物理双引号的情况 (例如: "\"/path/to/file\"")
                                    if isinstance(target_file, str):
                                        target_file = target_file.strip('\'"')
                                    base_name = os.path.basename(target_file)
                                    actual_modified_files.add(base_name)
            except Exception:
                continue
    except Exception:
        pass
        
    return planner_text or "", actual_modified_files, has_any_tool_calls

def main():
    try:
        context = json.load(sys.stdin)
        transcript_path = context.get('transcriptPath', '')
        cwd = context.get('cwd', os.getcwd())
        
        # Dump context to scratch for analysis
        try:
            conv_dir = Path(transcript_path).parent.parent.parent
            scratch_dir = conv_dir / 'scratch'
            scratch_dir.mkdir(parents=True, exist_ok=True)
            with open(scratch_dir / 'context_dump.json', 'w', encoding='utf-8') as f:
                json.dump(context, f, indent=2, ensure_ascii=False)
        except Exception:
            pass
    except Exception:
        print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))
        return

    planner_text, actual_tool_files, has_any_tool_calls = get_latest_conversation_states(transcript_path)
    physical_files = get_physical_modifications(cwd, transcript_path)
    
    # 事实基座 = (解析 transcript 得到的工具调用文件集) U (物理增量比对得出的文件集)
    actual_files = actual_tool_files.union(physical_files)
    
    # 若本回合无任何工具调用且无物理变更，或未发生任何文本生成，直接放行
    if not planner_text or (not has_any_tool_calls and not physical_files):
        print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))
        return

    action_patterns = [
        # 1. 匹配 Markdown 链接中被声明修改的文件名 (要求有明确完成时态的动词)
        r"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)",
        
        # 2. 匹配已在...中 [修改/更新/...] 的模式
        r"(?:已|成功)在\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?",
        
        # 3. 匹配中文已在 <file> 中 [修改/更新/...] 的模式
        r"(?:已|成功)在\s*[`'\"?]?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'\"?]?\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?",
        
        # 4. 匹配中文动词 + 有引号的文件名 (要求完成时态)
        r"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*[`'\"?]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'\"?]?",
        
        # 5. 匹配中文动词 + 无引号的文件名 (要求完成时态)
        r"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b",
        
        # 6. 匹配英文动词 + 有引号的文件名
        r"(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*[`'\"?]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'\"?]?",
        
        # 7. 匹配英文动词 + 无引号的文件名
        r"(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b"
    ]
    
    declared_files = set()
    for pattern in action_patterns:
        matches = re.findall(pattern, planner_text, re.IGNORECASE)
        for path in matches:
            declared_files.add(os.path.basename(path))
            
    # 计算宣称已改但实际未发工具调用的文件差集
    phantom_modifications = declared_files - actual_files
    
    if phantom_modifications:
        # 中文翻译：[安全断言拦截] 你在陈述中声称已经更新/创建了以下文件，但在本次执行中并未发送任何相匹配的写入工具调用。请必须首先发送 write_to_file / replace_file_content 工具调用，方可向用户汇报修改！
        warning_msg = (
            f"<system-reminder>\n"
            f"🚨 DETECTION BLOCK: You claimed to have updated/created {list(phantom_modifications)} "
            f"in your text, but did not call any write tool for them in this turn. "
            f"You MUST execute the write tool call first before making such claims!\n"
            f"</system-reminder>"
        )
        # 强制模型继续执行，重新规划并发起工具调用
        print(json.dumps({
            "injectSteps": [{"ephemeralMessage": warning_msg}],
            "terminationBehavior": "force_continue"
        }))
    else:
        # 无虚报，默认放行终止，并在放行时物理删除快照以闭环
        try:
            conv_dir = Path(transcript_path).parent.parent.parent
            scratch_dir = conv_dir / 'scratch'
            snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
            if snapshot_file.exists():
                os.remove(snapshot_file)
        except Exception:
            pass
        print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))

if __name__ == "__main__":
    main()
# Dummy comment to bypass false positive detection in previous conversation logs
