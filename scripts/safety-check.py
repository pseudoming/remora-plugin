#!/usr/bin/env python3
import sys
import json
import re
import shlex
import base64
import os
import subprocess
import fcntl

# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：本脚本是主干 Agent 拦截高危操作的物理防线。
#   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================================
# 设计原理一：命令语法分词与拆流逻辑
# ==========================================================
# 传统正则匹配不仅容易因多空格、子参数混杂被绕过，也无法处理 `cmd1 && cmd2` 等拼接链。
# 本模块采用 shlex 分词器拆分出独立的命令序列，并按 Shell 语法操作符（;, &&, ||, |）拆分。
# 保证链条中每个独立的子指令都会被独立审查，无法使用命令拼装、嵌套来规避检查。

# ==========================================================
# 设计原理二：环境变量追踪替换与嵌套解释器递归审计
# ==========================================================
# 1. 变量解析上下文跟踪：维护临时 `env_tracker` 键值对字典，解析并追踪 `VAR=VALUE` 并在后续的子命令中进行静态求值替换。
# 2. 嵌套解释器与 eval 穿透：识别嵌套调用特征。若执行器为 `sh` / `bash` / `zsh` / `dash` / `eval` 等，
#    主动提取其 `-c` 参数或后续合并参数并进行递归审计。对于 `python`/`node` 执行的代码串参数，
#    使用黑名单正则拦截其中隐藏的高危动作。

# ==========================================================
# 设计原理三：全局 Base64 穿透审计与白名单防护机制
# ==========================================================
# 1. 全局 Base64 扫描：对任意 Token 进行模式匹配。若发现 Token 长度大于 16，且仅包含 Base64 字符，则进行还原。
# 2. 穿透解码与递归审计：在内存中对该 Base64 串进行还原，并对解码后的文本进行递归安全审计。
# 3. Base64 白名单留空（BASE64_WHITELIST = []）：若明文或原串处于白名单中，或明文无任何高危测试/构建动作，
#    系统予以放行，保障开发流中正常 base64 文本编解码及跨平台工具运行通道的灵活性。

# ==========================================================
# 设计原理四：子代理类型判定与分流安全豁免
# ==========================================================
# 1. 元数据解析：通过从 `transcriptPath` 中切片提取出当前子会话的 ID，执行宿主官方 `agentapi get-conversation-metadata` 命令。
# 2. 只读特工 `Remora_ReadOnly_Extractor` 限制：特许豁免 view_file 大体积日志读取限制；但对其命令行写、构建与测试指令做绝对强拦截保护。
# 3. 沙盒特工 `Remora_Deep_Diver` 限制放行：特许豁免 view_file 日志体积熔断；且豁免其在分支沙盒内执行测试（test）或构建（build）命令的拦截。

# ==========================================================
# 设计原理五：View File 累加器与主干上下文防腐 (Anti-Context-Rot)
# ==========================================================
# 1. 回合级定宽累加器：在主干 (Main Context) 中追踪单一用户回合内对源码和日志的累积读取量，防止上下文因零散读取而慢速腐败。
# 2. 三级硬阻断机制：当累加量突破绝对阈值 (Source>400KB 或 Data>150KB) 时，实施硬熔断阻断。
# 3. O(1) 乘算估值策略：为防止 I/O 阻塞导致拦截器超时，采用行数 * 50 字节的快速常数估算，不进行磁盘全表扫描。
# 4. 进程级资源锁：使用 fcntl.flock 控制读写竞态，确保安全应对大模型高并发的读文件调用。

BASE64_WHITELIST = []

def decode_base64_token(token):
    if len(token) > 16 and re.match(r'^[A-Za-z0-9+/]+={0,2}$', token):
        try:
            return base64.b64decode(token).decode('utf-8')
        except Exception:
            return None
    return None

def _inspect_tokens(tokens, depth=0):
    if depth > 10:
        return "deny", "syntax_error"
        
    sub_commands = []
    current_sub = []
    delimiters = {";", "&&", "||", "|"}
    for t in tokens:
        if t in delimiters:
            if current_sub:
                sub_commands.append(current_sub)
                current_sub = []
        else:
            current_sub.append(t)
    if current_sub:
        sub_commands.append(current_sub)

    env_tracker = {}
    
    for sub in sub_commands:
        if not sub: continue
        
        # 提取环境变量赋值
        while sub and '=' in sub[0] and not sub[0].startswith('-'):
            var_part = sub.pop(0)
            if '=' in var_part:
                k, v = var_part.split('=', 1)
                env_tracker[k] = v
        if not sub: continue
        
        # 替换变量
        processed_sub = []
        for token in sub:
            for k, v in env_tracker.items():
                token = token.replace(f'${k}', v).replace(f'${{{k}}}', v)
            processed_sub.append(token)
            
        exe = processed_sub[0]
        args = processed_sub[1:]
        
        # Base64 审计
        for token in processed_sub:
            if token in BASE64_WHITELIST:
                continue
            decoded = decode_base64_token(token)
            if decoded and decoded not in BASE64_WHITELIST:
                decision, cat = inspect_command(decoded, depth + 1)
                if decision == "deny":
                    return decision, cat

        # 嵌套解释器审计
        if exe in {"sh", "bash", "zsh", "dash"}:
            if "-c" in args:
                idx = args.index("-c")
                if idx + 1 < len(args):
                    inner_cmd = args[idx+1]
                    decision, cat = inspect_command(inner_cmd, depth + 1)
                    if decision == "deny":
                        return decision, cat
        elif exe == "eval":
            inner_cmd = " ".join(args)
            decision, cat = inspect_command(inner_cmd, depth + 1)
            if decision == "deny":
                return decision, cat
        elif exe in {"python", "python3"}:
            if "-c" in args:
                idx = args.index("-c")
                if idx + 1 < len(args):
                    code = args[idx+1]
                    if re.search(r'\b(pytest|unittest)\b', code):
                        return "deny", "test"
            if "-m" in args and "pytest" in args:
                return "deny", "test"
        elif exe == "node":
            if "-e" in args:
                idx = args.index("-e")
                if idx + 1 < len(args):
                    code = args[idx+1]
                    if re.search(r'\b(jest|vitest|mocha)\b', code):
                        return "deny", "test"
            
        # 标准规则审计
        if exe in {"pytest", "pytest3", "jest", "vitest"}:
            return "deny", "test"
        if exe == "gradlew" and "test" in args:
            return "deny", "test"
        if exe == "mvn" and "test" in args:
            return "deny", "test"
        if exe in {"npm", "yarn"}:
            if "test" in args or "t" in args:
                return "deny", "test"
            if "run" in args and ("test" in args or "t" in args):
                return "deny", "test"
                
        if exe == "tail" and "-f" in args:
            return "deny", "test"
        if exe == "journalctl":
            return "deny", "test"
        if exe == "find" and "-exec" in args:
            return "deny", "test"
        if exe == "grep":
            for flag in args:
                if flag.startswith("-") and ("r" in flag or "R" in flag):
                    return "deny", "test"
        if exe == "sed" and "-i" in args:
            return "deny", "test"
            
        if exe == "npm" and "run" in args and "build" in args:
            return "deny", "build"
        if exe == "gradlew" and "build" in args:
            return "deny", "build"
        if exe == "mvn" and ("package" in args or "install" in args):
            return "deny", "build"
            
    return "allow", ""

def inspect_command(cmd_str, depth=0):
    try:
        tokens = shlex.split(cmd_str)
    except Exception:
        fallback_test = r'\b(pytest|jest|vitest|gradlew\s+test|mvn\s+test|npm\s+test|npm\s+run\s+test)\b'
        fallback_build = r'\b(npm\s+run\s+build|gradlew\s+build|mvn\s+package|mvn\s+install)\b'
        
        if re.search(fallback_test, cmd_str):
            return "deny", "test"
        if re.search(fallback_build, cmd_str):
            return "deny", "build"
        return "deny", "syntax_error"
        
    if not tokens:
        return "allow", ""
        
    return _inspect_tokens(tokens, depth)

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
        if os.path.exists("/tmp/remora_agent_env.json"):
            try:
                with open("/tmp/remora_agent_env.json", "r", encoding="utf-8") as ef:
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
            with open("/tmp/remora_hook_debug.txt", "a", encoding="utf-8") as df:
                df.write(f"[remora] agentapi returncode={res.returncode}, stderr={res.stderr}\n")
    except Exception as e:
        with open("/tmp/remora_hook_debug.txt", "a", encoding="utf-8") as df:
            df.write(f"[remora] agentapi exception: {str(e)}\n")
    return None

def main():
    try:
        context = json.load(sys.stdin)
    except json.JSONDecodeError:
        print(json.dumps({"decision": "allow"}))
        return
        
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
            cache_file = f"/tmp/remora_session_modes/{conv_id}.json"
            if os.path.exists(cache_file):
                try:
                    with open(cache_file, 'r', encoding='utf-8') as f:
                        mode = json.load(f).get("mode", "strict")
                except:
                    pass

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
    rot_reason = (
        "REMORA SAFETY INTERCEPT: Direct cat/grep or view_file on large logs (.jsonl/.log) in main context is prohibited to prevent context explosion.\n"
        "Please invoke a subagent for isolation:\n"
        "- For read-only log search or database queries: Typename 'Remora_ReadOnly_Extractor'\n"
        "- For sandbox debugging, tests, or code modifications: Typename 'Remora_Deep_Diver'"
    )

    # --------------------------------------------------------
    # 针对 invoke_subagent 的强制沙盒隔离拦截
    # --------------------------------------------------------
    if tool_name == "invoke_subagent":
        subagents = args.get('Subagents', [])
        for sub in subagents:
            t_name = sub.get('TypeName', '')
            ws = sub.get('Workspace', 'inherit')
            if t_name == "Remora_Deep_Diver" and ws not in ['branch', 'share']:
                # 中文翻译：[沙盒强制隔离] 'Remora_Deep_Diver' 必须通过 Workspace='branch' 或 'share' 在隔离环境中调用。禁止在主工作区直接执行以防污染！
                print(json.dumps({
                    "decision": "deny",
                    "reason": "REMORA SANDBOX ENFORCEMENT: 'Remora_Deep_Diver' MUST be invoked with Workspace='branch' or 'share'. Direct execution in the main tree is prohibited!"
                }))
                return
        print(json.dumps({"decision": "allow"}))
        return

    # --------------------------------------------------------
    # 针对 view_file 的拦截
    # --------------------------------------------------------
    if tool_name == "view_file":
        target_file = args.get('AbsolutePath', '')
        if target_file:
            # 1. 敏感后缀强力拦截 (大日志直接阻断)
            if target_file.endswith('.jsonl') or target_file.endswith('.log') or target_file.endswith('.sqlite'):
                if not is_sub:
                    print(json.dumps({"decision": "deny", "reason": rot_reason}))
                    return
                    
            # 2. 体积累加熔断机制 (针对单文件超大或碎片化堆叠)
            if not is_sub and transcript_path:
                match = re.search(r'/brain/([^/]+)/', transcript_path)
                if match:
                    # 单体文件突发超大拦截
                    size_limit = 200 * 1024 if mode == "relax" else 50 * 1024
                    try:
                        if os.path.exists(target_file) and os.path.getsize(target_file) > size_limit:
                            print(json.dumps({"decision": "deny", "reason": rot_reason}))
                            return
                    except Exception:
                        pass

                    conv_id = match.group(1)
                    stats_file = f"/tmp/remora_view_file_stats/{conv_id}.json"
                    
                    is_data_log = target_file.endswith(('.jsonl', '.log', '.sqlite', '.csv'))
                    inc_bytes = 0
                    if os.path.exists(target_file):
                        if 'StartLine' in args and 'EndLine' in args:
                            inc_bytes = (int(args['EndLine']) - int(args['StartLine']) + 1) * 50
                        else:
                            inc_bytes = os.path.getsize(target_file)
                    
                    if inc_bytes > 0:
                        try:
                            # 创建目录（若无）并以可读写模式操作
                            os.makedirs("/tmp/remora_view_file_stats", exist_ok=True)
                            if not os.path.exists(stats_file):
                                with open(stats_file, 'w') as f:
                                    json.dump({"accumulated_source_bytes": 0, "accumulated_data_bytes": 0}, f)
                                    
                            with open(stats_file, 'r+') as f:
                                fcntl.flock(f, fcntl.LOCK_EX)
                                stats = json.load(f)
                                if is_data_log:
                                    stats["accumulated_data_bytes"] += inc_bytes
                                else:
                                    stats["accumulated_source_bytes"] += inc_bytes
                                
                                # 三级硬性熔断
                                if stats["accumulated_source_bytes"] > 400 * 1024 or stats["accumulated_data_bytes"] > 150 * 1024:
                                    f.seek(0)
                                    f.truncate()
                                    json.dump(stats, f)
                                    fcntl.flock(f, fcntl.LOCK_UN)
                                    # 中文翻译：⛔ [安全拦截] 累积读取量触发严格阈值！主干上下文濒临腐败，当前操作已被强制阻断。请立即委派子代理！重要提示：调用子代理时，必须同时使用 schedule 工具创建 30s 定时监控（When invoking subagent, MUST also call schedule tool with DurationSeconds=30.）。
                                    print(json.dumps({
                                        "decision": "deny", 
                                        "reason": f"⛔ REMORA SAFETY INTERCEPT: CUMULATIVE READ LIMIT EXCEEDED (SOURCE: {stats['accumulated_source_bytes']//1024}KB, DATA: {stats['accumulated_data_bytes']//1024}KB). MAIN CONTEXT CORRUPTION IMMINENT. OPERATION BLOCKED. PLEASE DELEGATE TO A SUBAGENT! When invoking subagent, MUST also call schedule tool with DurationSeconds=30."
                                    }))
                                    return
                                    
                                f.seek(0)
                                f.truncate()
                                json.dump(stats, f)
                                fcntl.flock(f, fcntl.LOCK_UN)
                        except Exception as e:
                            pass
        
        print(json.dumps({"decision": "allow"}))
        return

    # --------------------------------------------------------
    # 针对 run_command 的拦截
    # --------------------------------------------------------
    if tool_name == "run_command":
        cmd = args.get('CommandLine', '')
        
        # 1. 高吞吐量特征拦截 (Anti-Context-Rot)
        rot_pattern = r'\b(cat|tail|grep|jq|awk|sed|sqlite3)\b.*?(?:\.jsonl|\.log|\.sqlite)\b|\bremora-recall\.sh\b'
        has_rot_feature = re.search(rot_pattern, cmd, re.IGNORECASE)
        
        # 2. 安全性拦截与审计分流
        decision, category = inspect_command(cmd)
        
        if has_rot_feature:
            # 子会话大日志查询特许放行
            if is_sub:
                # 若为只读特工，除日志外不可含有任何写或测试构建高危特征（必须为 allow）
                if is_readonly_sub and decision != "allow":
                    # 中文翻译：[安全防线拦截] 限制只读特工。Remora_ReadOnly_Extractor 仅被授权进行只读检索，严禁运行任何物理写操作、构建或测试命令！
                    print(json.dumps({
                        "decision": "deny",
                        "reason": "REMORA SAFETY INTERCEPT: Remora_ReadOnly_Extractor is strictly read-only and cannot run write/test/build commands!"
                    }))
                    return
                print(json.dumps({"decision": "allow"}))
                return
            else:
                # 普通主干会话一律拦截大日志读取
                print(json.dumps({"decision": "deny", "reason": rot_reason}))
                return
        else:
            # 不含大日志特征的常规命令审计
            if decision == "deny":
                # 沙盒调试特工允许在分支内执行测试和构建
                if is_deep_diver_sub and category in {"test", "build"}:
                    print(json.dumps({"decision": "allow"}))
                    return
                
                if category == "test":
                    # 中文翻译：[安全防线拦截] 诊断和测试命令已被拦截！您必须通过 invoke_subagent 委派给 Remora_Deep_Diver 并在分支沙盒中执行 (Workspace: 'branch')。
                    print(json.dumps({
                        "decision": "deny",
                        "reason": "REMORA DELEGATION BLOCKED: Diagnostic and test commands must be delegated via invoke_subagent using Remora_Deep_Diver (Workspace: 'branch')!"
                    }))
                elif category == "build":
                    # 中文翻译：[安全防线拦截] 构建命令已被拦截！您必须通过 invoke_subagent 委派给 Remora_Deep_Diver 并共享构建产物 (Workspace: 'share')。
                    print(json.dumps({
                        "decision": "deny",
                        "reason": "REMORA DELEGATION BLOCKED: Build commands must be delegated via invoke_subagent using Remora_Deep_Diver (Workspace: 'share')!"
                    }))
                else:
                    # 中文翻译：[安全防线拦截] 命令行语法解析校验未通过。可能包含潜在命令绕过风险。请将其委派给子代理在隔离沙盒内执行！
                    print(json.dumps({
                        "decision": "deny",
                        "reason": "REMORA DELEGATION BLOCKED: Command verification failed due to syntax parser error. Please delegate to a subagent under (Workspace: 'branch')!"
                    }))
                return
            else:
                print(json.dumps({"decision": "allow"}))
            return
        
    # --------------------------------------------------------
    # 针对 grep_search 的拦截 (Anti-Context-Rot)
    # --------------------------------------------------------
    if tool_name == "grep_search":
        search_path = args.get('SearchPath', '')
        if search_path:
            # 1. 敏感后缀拦截
            if search_path.endswith('.jsonl') or search_path.endswith('.log') or search_path.endswith('.sqlite'):
                if not is_sub:
                    print(json.dumps({"decision": "deny", "reason": rot_reason}))
                    return
            # 2. 敏感目录拦截 (如 Orchestrator 的日志目录)
            if '/.system_generated' in search_path or '/logs' in search_path:
                if not is_sub:
                    print(json.dumps({"decision": "deny", "reason": rot_reason}))
                    return
        
        print(json.dumps({"decision": "allow"}))
        return

    print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
