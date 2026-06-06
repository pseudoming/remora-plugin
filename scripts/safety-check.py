from lib.paths import get_data_dir
#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from lib.context import hook_entrypoint
from lib.session import read_mode
from lib.stats import accumulate

# 引入抽离出的核心算法模块
from safety_rules import inspect_command

import json
import re
import subprocess

# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：本脚本是主干 Agent 拦截高危操作的物理防线。
#   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================================
# 设计原理一：命令安全拦截分流与子代理判定（宿主系统层面）
# ==========================================================
# 1. 变量与上下文跟踪：命令的具体分词语法与正则黑名单已抽离到 safety_rules.py，保持本主控层简洁且无副作用。
# 2. 元数据解析：从 `transcriptPath` 中切片提取当前子会话 ID，调用 `agentapi get-conversation-metadata` 命令。
# 3. 只读特工 `Remora_ReadOnly_Extractor` 限制：特许豁免 view_file 大体积日志读取限制；但对其命令行写、构建与测试指令做绝对强拦截保护。
# 4. 沙盒特工 `Remora_Deep_Diver` 限制放行：特许豁免 view_file 日志体积熔断；且豁免其在分支沙盒内执行测试（test）或构建（build）命令的拦截。

# ==========================================================
# 设计原理二：View File 累加器与主干上下文防腐 (Anti-Context-Rot)
# ==========================================================
# 1. 回合级定宽累加器：在主干 (Main Context) 中追踪单一用户回合内对源码和日志的累积读取量，防止上下文因零散读取而慢速腐败。
# 2. 三级硬阻断机制：当累加量突破绝对阈值 (Source>400KB 或 Data>150KB) 时，实施硬熔断阻断。
# 3. O(1) 乘算估值策略：采用行数 * 50 字节的快速常数估算，防止磁盘全表扫描导致超时。
# 4. 进程级资源锁控制读写竞态，确保安全应对大模型高并发的读文件调用。

def make_deny_reason(prefix, message, action_tip=""):
    # 中文翻译：[安全拦截] 统一格式化 Remora 安全拦截的返回原因
    # 英文对照：⛔ REMORA SAFETY INTERCEPT [{prefix}]: {message}\nACTION REQUIRED: {action_tip}
    reason = f"⛔ REMORA SAFETY INTERCEPT [{prefix}]: {message}"
    if action_tip:
        reason += f"\nACTION REQUIRED: {action_tip}"
    return reason

def get_subagent_type(transcript_path):
    """通过系统官方 agentapi 查询当前子代理的 typeName，实现物理只读/读写属性提取"""
    if not transcript_path:
        return None
    match = re.search(r'/brain/([^/]+)/', transcript_path)
    if not match:
        return None
    conv_id = match.group(1)
    
    try:
        # 物理注入缓存的 LS 凭据，防止 Sandbox Hook 执行时由于缺少环境变量导致鉴权失败返回 1
        env = dict(os.environ)
        if os.path.exists(os.path.join(get_data_dir(), ".runtime", "remora_agent_env.json")):
            try:
                with open(os.path.join(get_data_dir(), ".runtime", "remora_agent_env.json"), "r", encoding="utf-8") as ef:
                    cached_env = json.load(ef)
                    env.update(cached_env)
            except:
                pass
                
        # 使用官方 agentapi get-conversation-metadata 获取会话元数据
        cmd = ["/home/agent/.gemini/antigravity/bin/agentapi", "get-conversation-metadata", conv_id]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, env=env)
        if res.returncode == 0:
            data = json.loads(res.stdout)
            metadata = data.get("response", {}).get("conversationMetadata", {}).get("metadata", {})
            parent_id = metadata.get("parentConversationId")
            if not parent_id:
                return None
            return metadata.get("subagentSpec", {}).get("typeName")
        else:
            with open(os.path.join(get_data_dir(), ".runtime", "remora_hook_debug.txt"), "a", encoding="utf-8") as df:
                df.write(f"[remora] agentapi returncode={res.returncode}, stderr={res.stderr}\n")
    except Exception as e:
        with open(os.path.join(get_data_dir(), ".runtime", "remora_hook_debug.txt"), "a", encoding="utf-8") as df:
            df.write(f"[remora] agentapi exception: {str(e)}\n")

    # ==========================================
    # 兜底死锁防护：如果进程查询失败/超时，但可确定该日志属于子会话，则特许升级为 is_sub = True
    # ==========================================
    try:
        if os.path.exists(os.path.join(get_data_dir(), ".runtime", "remora_main_conv_id.txt")):
            with open(os.path.join(get_data_dir(), ".runtime", "remora_main_conv_id.txt"), "r") as f:
                main_id = f.read().strip()
                if main_id and conv_id != main_id:
                    return "Remora_Subagent_Fallback"
    except:
        pass
    return None

@hook_entrypoint(fallback_result={"decision": "allow"})
def main(context):
    tool_call = context.get('toolCall', {})
    tool_name = tool_call.get('name', '')
    args = tool_call.get('args', {})
    
    transcript_path = context.get('transcriptPath', '')
    
    # 提取会话 ID 并读取临时模式缓存
    mode = "strict"
    if transcript_path:
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
            mode = read_mode(conv_id, "strict")

    subagent_type = get_subagent_type(transcript_path)
    
    is_sub = subagent_type is not None
    is_readonly_sub = subagent_type == "Remora_ReadOnly_Extractor"
    is_deep_diver_sub = subagent_type == "Remora_Deep_Diver"
    
    # --------------------------------------------------------
    # Anti-Context-Rot: 统一的返回模板
    # 中文翻译：[防上下文腐败拦截] 禁止在主干上下文中直接对大日志文件（.jsonl/.log）使用 cat/grep 或 view_file，以防止上下文爆炸。请使用子代理进行隔离执行：
    # - 若为只读的日志搜索或数据库查询：使用 TypeName "Remora_ReadOnly_Extractor" 派发子代理
    # - 若为沙盒下的调试、测试或代码修改：使用 TypeName "Remora_Deep_Diver" 派发子代理
    # --------------------------------------------------------
    # 中文翻译：[防上下文腐败拦截] 禁止在主干上下文中直接对大日志文件（.jsonl/.log）使用 cat/grep 或 view_file，以防止上下文爆炸。请使用子代理进行隔离执行。
    # 英文对照：⛔ REMORA SAFETY INTERCEPT [ANTI-ROT]: Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.\nACTION REQUIRED: Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications.
    rot_reason = make_deny_reason(
        "ANTI-ROT",
        "Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.",
        "Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications."
    )

    # --------------------------------------------------------
    # 针对 invoke_subagent 的强制沙盒隔离拦截
    # --------------------------------------------------------
    if tool_name == "invoke_subagent":
        subagents = args.get('Subagents', [])
        for sub in subagents:
            t_name = sub.get('TypeName', '')
            ws = sub.get('Workspace', 'inherit')
            prompt_str = sub.get('Prompt', '')

            # 增加 1500 字符强限拦截（底线防崩拦截座）
            if len(prompt_str) > 1500:
                # 中文翻译：[子任务负载拦截] 指派给子代理的 Prompt 长度突破 1500 字符硬限。请做任务拆细与精炼描述！
                # 英文对照：⛔ REMORA SAFETY INTERCEPT [PAYLOAD ENFORCEMENT]: Subagent Prompt length ({len(prompt_str)} chars) exceeds 1500 limit.\nACTION REQUIRED: Please partition the task and simplify the description.
                return {
                    "decision": "deny",
                    "reason": make_deny_reason(
                        "PAYLOAD ENFORCEMENT",
                        f"Subagent Prompt length ({len(prompt_str)} chars) exceeds 1500 limit.",
                        "Please partition the task and simplify the description."
                    )
                }

            if t_name == "Remora_Deep_Diver" and ws not in ['branch', 'share']:
                # 中文翻译：[沙盒强制隔离] 'Remora_Deep_Diver' 必须通过 Workspace='branch' 或 'share' 在隔离环境中调用。禁止在主工作区直接执行以防污染！
                # 英文对照：⛔ REMORA SAFETY INTERCEPT [SANDBOX ENFORCEMENT]: 'Remora_Deep_Diver' MUST be invoked with Workspace='branch' or 'share'.\nACTION REQUIRED: Direct execution in the main tree is prohibited!
                return {
                    "decision": "deny",
                    "reason": make_deny_reason(
                        "SANDBOX ENFORCEMENT",
                        "'Remora_Deep_Diver' MUST be invoked with Workspace='branch' or 'share'.",
                        "Direct execution in the main tree is prohibited!"
                    )
                }
        # 中文翻译：
        # REMORA 协调器记忆注入：每当您调用子代理时，您必须同时调用 `schedule` 工具，设置 `DurationSeconds="60"` 以监控存活状态。在启动后立即退出当前回合。
        return {
            "decision": "allow",
            "injectSteps": [
                {
                    "ephemeralMessage": (
                        "REMORA COORDINATOR MEMORY INJECTION: Whenever you invoke a subagent, "
                        "you MUST simultaneously call the `schedule` tool with `DurationSeconds=\"60\"` "
                        "to monitor liveness. Exit the turn immediately after launching."
                    )
                }
            ]
        }

    # --------------------------------------------------------
    # 针对 view_file 的拦截
    # --------------------------------------------------------
    if tool_name == "view_file":
        target_file = args.get('AbsolutePath', '')
        if target_file:
            # 1. 敏感后缀强力拦截 (大日志直接阻断)
            if target_file.endswith('.jsonl') or target_file.endswith('.log') or target_file.endswith('.sqlite'):
                if is_readonly_sub:
                    pass  # 只读特工大日志读取显式放行
                elif not is_sub:
                    return {"decision": "deny", "reason": rot_reason}
                    
            # 2. 体积累加熔断机制 (针对单文件超大或碎片化堆叠)
            if not is_sub and transcript_path:
                match = re.search(r'/brain/([^/]+)/', transcript_path)
                if match:
                    # 单体文件突发超大拦截
                    size_limit = 200 * 1024 if mode == "relax" else 50 * 1024
                    try:
                        if os.path.exists(target_file) and os.path.getsize(target_file) > size_limit:
                            return {"decision": "deny", "reason": rot_reason}
                    except Exception:
                        pass

                    conv_id = match.group(1)
                    
                    is_data_log = target_file.endswith(('.jsonl', '.log', '.sqlite', '.csv'))
                    inc_bytes = 0
                    if os.path.exists(target_file):
                        if 'StartLine' in args and 'EndLine' in args:
                            inc_bytes = (int(args['EndLine']) - int(args['StartLine']) + 1) * 50
                        else:
                            inc_bytes = os.path.getsize(target_file)
                    
                    if inc_bytes > 0:
                        try:
                            if is_data_log:
                                stats = accumulate(conv_id, data_add=inc_bytes)
                            else:
                                stats = accumulate(conv_id, source_add=inc_bytes)
                                
                            # 三级硬性熔断
                            if stats["accumulated_source_bytes"] > 400 * 1024 or stats["accumulated_data_bytes"] > 150 * 1024:
                                # 中文翻译：
                                # ⛔ [安全拦截] 累积读取量已超限！
                                # ============================================================
                                # !!! 警告：主干上下文濒临腐败 !!!
                                # 源码读取：{stats['accumulated_source_bytes']//1024}KB (最大：400KB)
                                # 数据读取：{stats['accumulated_data_bytes']//1024}KB (最大：150KB)
                                #
                                # 操作已被阻断！为了保持认知稳定性，您必须立即委派至子代理。
                                #
                                # 在您结束当前回合前，您必须：
                                # 1. 归档进度：在 `/artifacts/task.md` 或当前决策日志中写入简短的进度报告与技术假设。
                                # 2. 委派执行：调用 `Remora_ReadOnly_Extractor` 进行读取/查询，或调用 `Remora_Deep_Diver` 进行修改。
                                # 3. 计划监控：在启动子代理时，您必须同时调用 `schedule` 工具，设置 `DurationSeconds="30"`。
                                #
                                # 切勿尝试在当前上下文中重新运行被拦截的读取命令！
                                # ============================================================
                                return {
                                    "decision": "deny", 
                                    "reason": (
                                        f"⛔ REMORA SAFETY INTERCEPT: CUMULATIVE READ LIMIT EXCEEDED!\n"
                                        f"============================================================\n"
                                        f"!!! WARNING: MAIN CONTEXT CORRUPTION IMMINENT !!!\n"
                                        f"SOURCE READ: {stats['accumulated_source_bytes']//1024}KB (MAX: 400KB)\n"
                                        f"DATA READ: {stats['accumulated_data_bytes']//1024}KB (MAX: 150KB)\n\n"
                                        f"OPERATION BLOCKED! TO PRESERVE COGNITIVE STABILITY, YOU MUST IMMEDIATELY DELEGATE TO A SUBAGENT.\n\n"
                                        f"BEFORE YOU EXIT THIS TURN, YOU MUST:\n"
                                        f"1. ARCHIVE PROGRESS: WRITE A CONCISE PROGRESS REPORT AND TECHNICAL HYPOTHESES TO `/artifacts/task.md` OR THE ACTIVE DECISION LOG.\n"
                                        f"2. DELEGATE EXECUTION: INVOKE `Remora_ReadOnly_Extractor` FOR READS/QUERIES, OR `Remora_Deep_Diver` FOR MODIFICATIONS.\n"
                                        f"3. SCHEDULE MONITOR: YOU MUST SIMULTANEOUSLY CALL THE `schedule` TOOL WITH `DurationSeconds=\"30\"` WHEN LAUNCHING THE SUBAGENT.\n\n"
                                        f"DO NOT ATTEMPT TO RE-RUN THE BLOCKED READ COMMAND IN THIS CONTEXT!\n"
                                        f"============================================================"
                                    )
                                }
                        except Exception as e:
                            pass
        
        return {"decision": "allow"}

    # --------------------------------------------------------
    # 针对 run_command 的拦截
    # --------------------------------------------------------
    if tool_name == "run_command":
        cmd = args.get('CommandLine', '')
        
        # 1. 高吞吐量特征拦截 (Anti-Context-Rot)
        rot_pattern = r'\b(cat|tail|grep|jq|awk|sed|sqlite3)\b.*?(?:\.jsonl|\.log|\.sqlite)\b|\bremora-recall\.py\b'
        has_rot_feature = re.search(rot_pattern, cmd, re.IGNORECASE)
        
        # 2. 安全性拦截与审计分流 (调用抽离出的 safety_rules)
        decision, category = inspect_command(cmd)
        
        if has_rot_feature:
            # 子会话大日志查询特许放行
            if is_sub:
                # 若为只读特工，除日志外不可含有任何写或测试构建高危特征（必须为 allow）
                if is_readonly_sub and decision != "allow":
                    # 中文翻译：[只读安全拦截] 限制只读特工。Remora_ReadOnly_Extractor 仅被授权进行只读检索，严禁运行任何物理写操作、构建或测试命令！
                    # 英文对照：⛔ REMORA SAFETY INTERCEPT [READONLY]: Remora_ReadOnly_Extractor is strictly read-only.\nACTION REQUIRED: Do not run write/test/build commands!
                    return {
                        "decision": "deny",
                        "reason": make_deny_reason(
                            "READONLY",
                            "Remora_ReadOnly_Extractor is strictly read-only.",
                            "Do not run write/test/build commands!"
                        )
                    }
                return {"decision": "allow"}
            else:
                # 普通主干会话一律拦截大日志读取
                return {"decision": "deny", "reason": rot_reason}
        else:
            # 不含大日志特征的常规命令审计
            if decision == "deny":
                # 沙盒调试特工允许在分支内执行测试和构建
                if is_deep_diver_sub and category in {"test", "build"}:
                    return {"decision": "allow"}
                
                if category in ("test", "build"):
                    # 中文翻译：
                    # ⛔ [安全限制 - 阻断委派] 命令行直接运行已被拦截！
                    # ============================================================
                    # !!! 警告：未受信任的代码执行已被阻止 !!!
                    # 为了保护当前活跃的工作树并在构建/测试阶段防止未审查代码执行或不安全的状态改变以维护 master 分支完整性，禁止直接执行 pytest/build。
                    #
                    # 您必须在隔离的工作空间中运行这些命令：
                    # - 测试/诊断：通过 `invoke_subagent` 委派给 `Remora_Deep_Diver` 且 `Workspace: "branch"`。
                    # - 编译/构建：通过 `invoke_subagent` 委派给 `Remora_Deep_Diver` 且 `Workspace: "share"`。
                    #
                    # 请勿尝试通过别名、Shell 脚本包装或替代路径运行来绕过此防线！所有绕过尝试将被记录并拦截。
                    # ============================================================
                    return {
                        "decision": "deny",
                        "reason": (
                            "⛔ REMORA SAFETY LIMIT [DELEGATION-BLOCKED]: DIRECT COMMAND RUNS BLOCKED!\n"
                            "============================================================\n"
                            "!!! WARNING: UNTRUSTED CODE EXECUTION PREVENTED !!!\n"
                            "TO PROTECT THE ACTIVE WORKING TREE AND PRESERVE MASTER BRANCH INTEGRITY FROM UNSAFE STATE CHANGES OR UNREVIEWED CODE EXECUTION DURING BUILD/TEST PHASES, DIRECT EXECUTION OF pytest/build IS PROHIBITED.\n\n"
                            "YOU MUST RUN THESE COMMANDS IN AN ISOLATED WORKSPACE:\n"
                            "- FOR TESTING/DIAGNOSTICS: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: \"branch\"`.\n"
                            "- FOR COMPILING/BUILDING: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: \"share\"`.\n\n"
                            "DO NOT ATTEMPT TO BYPASS THIS DEFENSE BY ALIASING, SHELL SCRIPT WRAPPING, OR ALTERNATIVE PATH RUNS! ALL BYPASS ATTEMPTS WILL BE LOGGED AND BLOCKED.\n"
                            "============================================================"
                        )
                    }
                else:
                    # 中文翻译：[命令验证拦截] 命令行语法解析校验未通过。可能包含潜在命令绕过风险。请将其委派给子代理在隔离沙盒内执行！
                    # 英文对照：⛔ REMORA SAFETY INTERCEPT [DELEGATION]: Command verification failed due to syntax parser error.\nACTION REQUIRED: Please delegate to a subagent under (Workspace: 'branch')!
                    return {
                        "decision": "deny",
                        "reason": make_deny_reason(
                            "DELEGATION",
                            "Command verification failed due to syntax parser error.",
                            "Please delegate to a subagent under (Workspace: 'branch')!"
                        )
                    }
            else:
                return {"decision": "allow"}
        
    # --------------------------------------------------------
    # 针对 grep_search 的拦截 (Anti-Context-Rot)
    # --------------------------------------------------------
    if tool_name == "grep_search":
        search_path = args.get('SearchPath', '')
        if search_path:
            # 1. 敏感后缀拦截
            if search_path.endswith('.jsonl') or search_path.endswith('.log') or search_path.endswith('.sqlite'):
                if not is_sub:
                    return {"decision": "deny", "reason": rot_reason}
            # 2. 敏感目录拦截 (如 Orchestrator 的日志目录)
            if '/.system_generated' in search_path or '/logs' in search_path:
                if not is_sub:
                    return {"decision": "deny", "reason": rot_reason}
        
        return {"decision": "allow"}

    return {"decision": "allow"}

if __name__ == "__main__":
    main()
