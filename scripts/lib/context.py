import sys
import json
import functools

def hook_entrypoint(fallback_result=None):
    if fallback_result is None:
        fallback_result = {"decision": "allow"}

    def decorator(func):
        @functools.wraps(func)
        def wrapper():
            try:
                input_data = json.load(sys.stdin)
            except Exception:
                print(json.dumps(fallback_result))
                sys.exit(0)
            
            try:
                result = func(input_data)
                print(json.dumps(result))
            except Exception as e:
                safe_fallback = {**fallback_result}
                if "decision" in safe_fallback:
                    safe_fallback["decision_reason"] = f"Remora Fallback (Error: {str(e)})"
                import traceback
                print(f"[Remora Hook Error] {str(e)}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                print(json.dumps(safe_fallback))
            sys.exit(0)
        return wrapper
    return decorator
