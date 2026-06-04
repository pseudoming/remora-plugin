#!/usr/bin/env python3
import re
import shlex
import base64

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
