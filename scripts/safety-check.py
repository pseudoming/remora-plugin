#!/usr/bin/env python3
import sys
import json
import re
import shlex
import base64
import os

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

def main():
    try:
        context = json.load(sys.stdin)
    except json.JSONDecodeError:
        print(json.dumps({"decision": "allow"}))
        return
        
    tool_call = context.get('toolCall', {})
    tool_name = tool_call.get('name', '')
    args = tool_call.get('args', {})
    
    # --------------------------------------------------------
    # Anti-Context-Rot: 统一的返回模板
    # 中文注释：防上下文腐败拦截提示
    # --------------------------------------------------------
    rot_reason = "REMORA DELEGATION BLOCKED: ANTI-CONTEXT-ROT. Target data is too large or risky for main context. You MUST delegate this task to Remora_Deep_Diver using invoke_subagent with Workspace: 'branch'."

    # --------------------------------------------------------
    # 针对 view_file 的拦截
    # --------------------------------------------------------
    if tool_name == "view_file":
        target_file = args.get('AbsolutePath', '')
        if target_file:
            # 1. 敏感后缀拦截
            if target_file.endswith('.jsonl') or target_file.endswith('.log') or target_file.endswith('.sqlite'):
                print(json.dumps({"decision": "deny", "reason": rot_reason}))
                return
            # 2. 体积熔断 (50KB)
            try:
                if os.path.exists(target_file) and os.path.getsize(target_file) > 50 * 1024:
                    print(json.dumps({"decision": "deny", "reason": rot_reason}))
                    return
            except Exception:
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
        if re.search(rot_pattern, cmd, re.IGNORECASE):
            print(json.dumps({"decision": "deny", "reason": rot_reason}))
            return
            
        # 2. 原有的安全性拦截
        decision, category = inspect_command(cmd)
        
        if decision == "deny":
            if category == "test":
                print(json.dumps({
                    "decision": "deny",
                    "reason": "REMORA DELEGATION BLOCKED: Diagnostic and test commands must be delegated via invoke_subagent using (Workspace: 'branch')!"
                }))
            elif category == "build":
                print(json.dumps({
                    "decision": "deny",
                    "reason": "REMORA DELEGATION BLOCKED: Build commands must be delegated via invoke_subagent using (Workspace: 'share') to ensure artifacts are synced!"
                }))
            else:
                print(json.dumps({
                    "decision": "deny",
                    "reason": "REMORA DELEGATION BLOCKED: Command verification failed due to syntax parser error. Because this command may contain potential syntax evasion risks, please carefully re-evaluate if you should delegate it to a subagent under (Workspace: 'branch')!"
                }))
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
                print(json.dumps({"decision": "deny", "reason": rot_reason}))
                return
            # 2. 敏感目录拦截 (如 Orchestrator 的日志目录)
            if '/.system_generated' in search_path or '/logs' in search_path:
                print(json.dumps({"decision": "deny", "reason": rot_reason}))
                return
        
        print(json.dumps({"decision": "allow"}))
        return

    print(json.dumps({"decision": "allow"}))

if __name__ == "__main__":
    main()
