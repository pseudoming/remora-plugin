MAX_CONTENT_CHARS = 1000


def filter_user_ai_rounds(steps_iter, rounds=10):
    results = []
    limit = rounds * 2
    try:
        for step in steps_iter:
            step_type = step.get('type')
            content = step.get('content', '')
            if not content:
                continue

            if step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                results.append({
                    "role": "user" if step_type == 'USER_INPUT' else "assistant",
                    "content": content[:MAX_CONTENT_CHARS]
                })
                if len(results) >= limit:
                    break
    except Exception:
        pass
    return results
