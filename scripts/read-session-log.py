#!/usr/bin/env python3
import sys
import json
import os

sys.path.insert(0, os.path.dirname(__file__))
from lib.conversation import ConversationDataAccessLayer

def read_last_user_ai_rounds(conv_id, rounds=10):
    cdal = ConversationDataAccessLayer(conv_id)

    if not os.path.exists(cdal.db_path):
        print(f"Error: db path not found for ID: {conv_id}")
        sys.exit(1)
        
    rounds_data = []
    try:
        limit = rounds * 50
        for step in cdal.stream_steps_reverse(limit=limit):
            step_type = step.get('type')
            content = step.get('content', '')
            if not content:
                continue
                
            if step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                rounds_data.append({
                    "role": "user" if step_type == 'USER_INPUT' else "assistant",
                    "content": content[:1000] # Limit output to avoid context explosion
                })
                if len(rounds_data) >= rounds * 2:
                    break
    except Exception as e:
        print(f"Error reading db: {e}")
        sys.exit(1)
        
    for r in reversed(rounds_data):
        print(f"[{r['role'].upper()}]: {r['content']}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 read-session-log.py <conversation_id> [rounds]")
        sys.exit(1)
    
    # Extract conv_id if path was passed for backwards compatibility
    arg = sys.argv[1]
    if '/' in arg:
        import re
        match = re.search(r'/brain/([^/]+)', arg)
        if match:
            arg = match.group(1)
            
    r = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    read_last_user_ai_rounds(arg, r)
