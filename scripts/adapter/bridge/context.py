import sys
import json
import functools
import time
import os
from datetime import datetime
from adapter.bridge.profiler import HookProfiler

_active_profiler = None

def get_profiler():
    global _active_profiler
    return _active_profiler

def hook_entrypoint(fallback_result=None):
    if fallback_result is None:
        fallback_result = {"decision": "allow"}

    def decorator(func):
        @functools.wraps(func)
        def wrapper():
            global _active_profiler
            t0 = time.perf_counter()
            hook_name = func.__code__.co_filename
            hook_name = os.path.basename(hook_name) if hook_name else "unknown_hook"
            
            try:
                input_data = json.load(sys.stdin)
            except Exception as e:
                t1 = time.perf_counter()
                log_content = f"=== [{hook_name}] Stdin Read Failed at {datetime.now().isoformat()} (Elapsed: {(t1-t0)*1000.0:.2f} ms) (Error: {str(e)}) ===\n\n"
                try:
                    from adapter.bridge.paths import HOOKS_PROFILE_LOG
                    with open(HOOKS_PROFILE_LOG, "a", encoding="utf-8") as f:
                        f.write(log_content)
                except Exception:
                    pass
                print(json.dumps(fallback_result))
                sys.exit(0)
                
            try:
                _active_profiler = HookProfiler(hook_name, input_data)
                _active_profiler.step("stdin_read")
                
                transcript_path = input_data.get('transcriptPath', '')
                from adapter.bridge.progress import ProgressSentinel
                
                # 每次执行前，主动更新快照状态为 running
                ProgressSentinel.update(transcript_path, "running", details=f"Starting hook: {hook_name}")
                
                result = func(input_data)
                _active_profiler.step("func_execute")
                
                # 执行后更新进度快照
                if isinstance(result, dict) and result.get("decision") == "deny":
                    ProgressSentinel.update(transcript_path, "blocked", details=f"Blocked by hook {hook_name}: {result.get('reason', 'No reason provided')}")
                else:
                    status = "running"
                    details = f"Hook {hook_name} execution allowed"
                    if isinstance(result, dict) and result.get("status") == "completed":
                        status = "completed"
                        details = result.get("details", details)
                    ProgressSentinel.update(transcript_path, status, details=details)
                
                is_tool_use = (input_data and isinstance(input_data, dict) and input_data.get('toolCall') is not None)
                is_stop_hook = (input_data and isinstance(input_data, dict) and input_data.get('executionNum') is not None)
                is_invocation_hook = (input_data and isinstance(input_data, dict) and input_data.get('invocationNum') is not None)
                
                # 精细化出参整形：
                # 1. 只有 PreToolUse (is_tool_use) 和 Stop (is_stop_hook) 生命周期支持/必须 decision 字段。
                # 2. PreInvocation/PostInvocation (is_invocation_hook) 绝对不能返回 decision。
                # 3. PostToolUse (既不是 tool use 也不是 stop 也不是 invocation) 返回 {}。
                if is_invocation_hook:
                    if isinstance(result, dict):
                        inject_steps = result.get("injectSteps", [])
                        result = {"injectSteps": inject_steps} if inject_steps else {}
                    else:
                        result = {}
                elif not is_tool_use and not is_stop_hook:
                    # 例如 PostToolUse 等其它生命周期
                    result = {}
                    
                print(json.dumps(result))
            except SystemExit as se:
                is_tool_use = (input_data and isinstance(input_data, dict) and input_data.get('toolCall') is not None)
                is_stop_hook = (input_data and isinstance(input_data, dict) and input_data.get('executionNum') is not None)
                if se.code == 0 or se.code is None:
                    ProgressSentinel.update(transcript_path, "running", details=f"Hook {hook_name} exited with code 0")
                    if is_tool_use or is_stop_hook:
                        print(json.dumps({"decision": "allow"}))
                    else:
                        print(json.dumps({}))
                else:
                    _active_profiler.step(f"func_sys_exit: {se.code}")
                    import traceback
                    print(f"[Remora Hook SystemExit] {se.code}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                    ProgressSentinel.update(transcript_path, "blocked", details=f"Hook SystemExit {se.code}")
                    if is_tool_use or is_stop_hook:
                        print(json.dumps({"decision": "deny", "reason": f"SystemExit with code {se.code}"}))
                    else:
                        print(json.dumps({"injectSteps": []}))
            except Exception as e:
                is_tool_use = (input_data and isinstance(input_data, dict) and input_data.get('toolCall') is not None)
                is_stop_hook = (input_data and isinstance(input_data, dict) and input_data.get('executionNum') is not None)
                _active_profiler.step(f"func_error: {str(e)}")
                safe_fallback = {**fallback_result}
                if "decision" in safe_fallback:
                    safe_fallback["decision_reason"] = f"Remora Fallback (Error: {str(e)})"
                import traceback
                print(f"[Remora Hook Error] {str(e)}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                ProgressSentinel.update(transcript_path, "blocked", details=f"Hook Exception: {str(e)}")
                if is_tool_use or is_stop_hook:
                    print(json.dumps(safe_fallback))
                else:
                    print(json.dumps({}))
            except BaseException as e:
                is_tool_use = (input_data and isinstance(input_data, dict) and input_data.get('toolCall') is not None)
                is_stop_hook = (input_data and isinstance(input_data, dict) and input_data.get('executionNum') is not None)
                _active_profiler.step(f"func_fatal_error: {type(e).__name__}: {str(e)}")
                import traceback
                print(f"[Remora Hook Fatal Error] {type(e).__name__}: {str(e)}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                ProgressSentinel.update(transcript_path, "blocked", details=f"Hook Fatal BaseException: {type(e).__name__}")
                if is_tool_use or is_stop_hook:
                    print(json.dumps({"decision": "deny", "reason": f"Fatal Exception: {type(e).__name__}: {str(e)}"}))
                else:
                    print(json.dumps({}))
            finally:
                if _active_profiler:
                    _active_profiler.finish()
            sys.exit(0)
        return wrapper
    return decorator
