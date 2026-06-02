#!/usr/bin/env python3
import sys
import json
import re
import os
import subprocess
from pathlib import Path

# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：本脚本是判定大模型动作幻觉（Phantom Modification）的物理防线。
#   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================================
# 设计原理一：Markdown 链接与陈述意图正则匹配
# ==========================================================
# 解析大模型 PLANNER_RESPONSE 中声称已修改/更新/创建的文件名。
# 采用 7 组多时态中英文动词正则模式，过滤并提取出大模型声称发生修改的文件名 Basename。

# ==========================================================
# 设计原理二：时序净化与强水位线截断
# ==========================================================
# 1. 强水位线截断：在回溯解析 `transcript.jsonl` 时，以 `initialNumSteps` 为强水位线。
#    凡是 step_index 小于等于该水位线的步骤，说明是本轮交互启动之前发生的历史步骤，必须停止回溯，防历史交互干扰。
# 2. 回合截断：逆序回溯时，一旦遇到用户的 `USER_INPUT` 输入，表示上一个交互回合结束，停止回溯。
# 3. 锁定最近 PLANNER_RESPONSE：只抓取本回合内最近一次的模型输出，杜绝跨回合时序污染。

# ==========================================================
# 设计原理三：同义路径别名归一化对齐
# ==========================================================
# 模型在调用原生写文件工具或自定义工具时，参数名称可能在 TargetFile / AbsolutePath / FilePath / Target 之间摆动。
# 引入 `normalize_filepath` 自动过滤并提取统一的 Basename，消除假阳性误报。

# ==========================================================
# 设计原理四：零误伤降级保护 (Zero-Fault Fallback)
# ==========================================================
# 用全局 `try-except Exception` 包裹 main()。若发生任何解析崩溃，默认无条件放行（返回空 injectSteps），确保正常交互绝对可用。

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
        snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
        
        pre_snapshot = {}
        if snapshot_file.exists():
            with open(snapshot_file, 'r', encoding='utf-8') as f:
                pre_snapshot = json.load(f)
                
        post_snapshot = get_snapshot(cwd)
        
        modified_files = set()
        for fpath, post_st in post_snapshot.items():
            if fpath not in pre_snapshot:
                modified_files.add(os.path.basename(fpath))
            else:
                pre_st = pre_snapshot[fpath]
                if post_st['mtime'] != pre_st['mtime'] or post_st['size'] != pre_st['size']:
                    modified_files.add(os.path.basename(fpath))
                    
        if snapshot_file.exists():
            try:
                os.remove(snapshot_file)
            except Exception:
                pass
                
        return modified_files
    except Exception:
        return set()

def normalize_filepath(arguments_dict):
    """标准化提取同义路径键名，带类型防护"""
    if not isinstance(arguments_dict, dict):
        return ""
    aliases = ["TargetFile", "AbsolutePath", "FilePath", "Target"]
    for alias in aliases:
        val = arguments_dict.get(alias)
        if val and isinstance(val, str):
            # 去除可能的外围物理引号
            val = val.strip('\'"')
            return os.path.basename(val)
    return ""

def get_latest_conversation_states(transcript_path, initial_num_steps=0):
    """
    流式读取 transcript.jsonl 末尾数据，
    提取出最近一次大模型的 PLANNER_RESPONSE 陈述文本以及本次 Invocation 中的物理写入工具调用。
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
        
        # 逆序向前分析最近一次 Invocation 的内容
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                step = json.loads(line)
                step_type = step.get('type')
                source = step.get('source')
                step_index = step.get('step_index')
                
                # 水位线强截断，防止时序污染
                if initial_num_steps > 0 and step_index is not None and step_index <= initial_num_steps:
                    break
                
                # 遇到真实用户的输入，代表交互回合结束，停止回溯
                if step_type == 'USER_INPUT' or source in ['USER', 'USER_EXPLICIT']:
                    break
                    
                tool_calls = step.get('tool_calls', [])
                if tool_calls:
                    has_any_tool_calls = True
                    
                # 锁定最近的一次 PLANNER_RESPONSE
                if step_type == 'PLANNER_RESPONSE' and planner_text is None:
                    planner_text = step.get('content', '')
                    
                # 分析并提取写入工具调用的目标文件，应用别名归一化
                if tool_calls:
                    for call in tool_calls:
                        name = call.get('name', '')
                        args = call.get('args') or call.get('arguments') or {}
                        
                        if name in ['write_to_file', 'replace_file_content', 'multi_replace_file_content']:
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except Exception:
                                    pass
                                    
                            if isinstance(args, dict):
                                base_name = normalize_filepath(args)
                                if base_name:
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

        initial_num_steps = context.get('initialNumSteps', 0)
        planner_text, actual_tool_files, has_any_tool_calls = get_latest_conversation_states(transcript_path, initial_num_steps)
        physical_files = get_physical_modifications(cwd, transcript_path)
        
        # 事实基座 = (解析 transcript 得到的工具调用文件集) U (物理增量比对得出的文件集)
        actual_files = actual_tool_files.union(physical_files)
        
        # 若本回合无任何工具调用且无物理变更，或未发生任何文本生成，直接放行
        if not planner_text or (not has_any_tool_calls and not physical_files):
            print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))
            return

        action_patterns = [
            # 1. 匹配 Markdown 链接中被声明修改的文件名
            r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)''',
            
            # 2. 匹配已在...中 [修改/更新/...] 的模式
            r'''(?:已|成功)在\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?''',
            
            # 3. 匹配中文已在 <file> 中 [修改/更新/...] 的模式
            r'''(?:已|成功)在\s*[`'"?]?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"?]?\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?''',
            
            # 4. 匹配中文动词 + 有引号的文件名 (要求完成时态)
            r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*[`'"?](([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+))[`'"?]?''',
            
            # 5. 匹配中文动词 + 无引号的文件名 (要求完成时态)
            r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b''',
            
            # 6. 匹配英文动词 + 有引号的文件名
            r'''(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*[`'"?]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"?]?''',
            
            # 7. 匹配英文动词 + 无引号的文件名
            r'''(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b'''
        ]
        
        declared_files = set()
        for pattern in action_patterns:
            matches = re.findall(pattern, planner_text, re.IGNORECASE)
            for path in matches:
                # 如果 matches 是元组列表（例如带有多捕获组），则提取第一个非空项
                if isinstance(path, tuple):
                    path = [x for x in path if x][0]
                declared_files.add(os.path.basename(path))
                
        # 计算宣称已改但实际未发工具调用的文件差集
        phantom_modifications = declared_files - actual_files
        
        if phantom_modifications:
            # --------------------------------------------------------
            # 🚨 警告拦截提示：大模型陈述了修改但并没有发起对应的工具调用 (Phantom Modification)
            # 中文翻译：[安全断言拦截] 你在陈述中声称已经更新/创建了以下文件，但在本次执行中并未发送任何相匹配的写入工具调用。请必须首先发送 write_to_file / replace_file_content 工具调用，方可向用户汇报修改！
            # --------------------------------------------------------
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
            # 无虚报，默认放行终止
            print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))

    except Exception as e:
        # ==========================================================
        # 核心防误伤降级机制：
        # 如果拦截器内部发生任何意外错误，无条件放行，确保主干不卡死
        # ==========================================================
        print(json.dumps({"injectSteps": [], "terminationBehavior": ""}))

if __name__ == "__main__":
    main()
