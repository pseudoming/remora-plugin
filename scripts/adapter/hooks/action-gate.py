#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import json
import re
import subprocess
from pathlib import Path

from adapter.bridge.context import hook_entrypoint, get_profiler
from lib.filesystem import get_snapshot, get_active_files
from adapter.bridge.paths import extract_conv_id
from adapter.bridge.session import read_mode
from core.logger import warn, error

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
# 1. 强水位线截断：在通过 CDAL 提取原生步骤时，以 `initialNumSteps` 为强水位线。
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

def profiler_step(event):
    try:
        p = get_profiler()
        if p:
            p.step(event)
    except Exception:
        pass

def get_physical_modifications(cwd, transcript_path):
    try:
        conv_dir = Path(transcript_path).parent.parent.parent
        scratch_dir = conv_dir / 'scratch'
        snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
        
        pre_snapshot = {}
        if snapshot_file.exists():
            with open(snapshot_file, 'r', encoding='utf-8') as f:
                pre_snapshot = json.load(f)
                
        profiler_step("phys_snapshot_pre_loaded")
        post_snapshot = get_snapshot(cwd)
        profiler_step("phys_snapshot_post_computed")
        
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
            val = val.strip('\'"')
            return os.path.basename(val)
    return ""

from adapter.bridge.conversation import ConversationDataAccessLayer

def get_latest_conversation_states(cdal: ConversationDataAccessLayer, initial_num_steps=0):
    """
    通过 CDAL 原生读取 SQLite，
    提取出最近一次大模型的 PLANNER_RESPONSE 陈述文本以及本次 Invocation 中的物理写入工具调用。
    """
    planner_text = None
    actual_modified_files = set()
    has_any_tool_calls = False

    try:
        # 使用 CDAL 的原生 SQLite 倒序查询接口，安全获取最后 1000 步
        for step in cdal.stream_steps_reverse(limit=1000):
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
        pass
        
    return planner_text or "", actual_modified_files, has_any_tool_calls

@hook_entrypoint(fallback_result={"injectSteps": [], "terminationBehavior": ""})
def main(context):
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

    conv_id = extract_conv_id(transcript_path) or "default"
            
    # 规则 7: Bypass gating if write tool returns error
    tool_call_result = context.get('toolCallResult', {})
    if tool_call_result and 'error' in tool_call_result and tool_call_result.get('error') is not None:
        return {"injectSteps": [], "terminationBehavior": ""}
            
    from lib.dao import get_hook_state, set_hook_state, trim_hook_states
    from lib.dao import insert_file_change, get_project_uuid_by_conv
    cdal = ConversationDataAccessLayer(conv_id)
    current_turn_idx = cdal.get_current_turn_idx()

    # 物理时序裁剪 (Timeline Trimming)
    last_seen = get_hook_state(conv_id, -1, 'last_seen_turn')
    should_trim = False
    if last_seen is None:
        should_trim = True
    else:
        try:
            should_trim = int(last_seen) != int(current_turn_idx)
        except (ValueError, TypeError):
            should_trim = False

    if should_trim:
        try:
            trim_turn = int(current_turn_idx)
        except (ValueError, TypeError):
            trim_turn = 0
        trim_hook_states(conv_id, trim_turn)
        set_hook_state(conv_id, -1, 'last_seen_turn', str(trim_turn))

    
    initial_num_steps = context.get('initialNumSteps', 0)
    
    profiler_step("start_conv_state_read")
    planner_text, actual_tool_files, has_any_tool_calls = get_latest_conversation_states(cdal, initial_num_steps)
    profiler_step("finish_conv_state_read")
    
    physical_files = get_physical_modifications(cwd, transcript_path)
    profiler_step("finish_physical_modifications")
    
    if physical_files:
        project_uuid = get_project_uuid_by_conv(conv_id)
        if project_uuid:
            for fname in physical_files:
                insert_file_change(project_uuid, conv_id, fname, "snapshot")
    
    # 事实基座 = (解析 transcript 得到的工具调用文件集) U (物理增量比对得出的文件集)
    actual_files = actual_tool_files.union(physical_files)
    
    # 若本回合无任何工具调用且无物理变更，或未发生任何文本生成，直接放行
    if not planner_text or (not has_any_tool_calls and not physical_files):
        return {"injectSteps": [], "terminationBehavior": ""}
    
    mode = read_mode(conv_id, "strict")

    # Relax 模式自适应直接放行，不执行虚报比对，提供最大发散性心流
    if mode == "relax":
        return {"injectSteps": [], "terminationBehavior": ""}

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
            if isinstance(path, tuple):
                path = [x for x in path if x][0]
            declared_files.add(os.path.basename(path))
            
    # 计算宣称已改但实际未发工具调用的文件差集
    phantom_modifications = declared_files - actual_files
    profiler_step("regex_matching_complete")
    
    if phantom_modifications:
        gating_cnt = get_hook_state(conv_id, current_turn_idx, "action_gating_cnt")
        if gating_cnt == "1":
            # 中文翻译：
            # 底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。你必须在你的回答开头以中文输出：“底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。”
            warning_prompt = (
                "Underlying detection module discovered abnormal states (physical files were not modified), "
                "but the model itself may lack capability to realize whether it actually modified them. "
                "You MUST prepend your response in Chinese with: "
                "\"底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。\""
            )
            return {
                "injectSteps": [{"ephemeralMessage": warning_prompt}],
                "terminationBehavior": ""
            }
        else:
            set_hook_state(conv_id, current_turn_idx, "action_gating_cnt", "1")
            # --------------------------------------------------------
            # ⛔ [安全限制 - 动作拦截] 信任但验证 - 你的总结描述了你意图做的事情，但不一定是实际所做的事情。
            # 我们检测到你声称编辑或写入了文件 ({', '.join(phantom_modifications)})，但未检测到任何物理修改或 git 状态差异。
            # 要继续执行，你必须遵循以下步骤：
            # 1. 验证工具执行：确保你实际调用了文件编辑工具（例如 `write_to_file`、`replace_file_content`），而不仅仅是输出声称完成的文本。
            # 2. 检查差异：检查实际文件或运行 `git status` 以验证工具调用是否成功。
            # 3. 物理重试：使用正确的参数重新调用正确的工具，以确保物理文件得到更新。
            # --------------------------------------------------------
            warning_msg = (
                "⛔ REMORA SAFETY LIMIT [ACTION-GATING]: Trust but verify - your summary describes what you intended to do, not necessarily what you did.\n"
                f"We detected that you claimed to edit or write to files ({', '.join(phantom_modifications)}), but no physical modifications or git status differences were detected.\n"
                "To proceed, you MUST follow these steps:\n"
                "1. VERIFY TOOL EXECUTION: Ensure you actually invoked file editing tools (e.g., `write_to_file`, `replace_file_content`) instead of just outputting text claiming completion.\n"
                "2. CHECK DIFF: Inspect the actual file or run `git status` to verify if the tool call succeeded.\n"
                "3. RETRY PHYSICALLY: Re-invoke the correct tool with the correct arguments to ensure the physical file is updated."
            )
            return {
                "injectSteps": [{"ephemeralMessage": warning_msg}],
                "terminationBehavior": "force_continue"
            }
    else:
        return {"injectSteps": [], "terminationBehavior": ""}

if __name__ == "__main__":
    main()
