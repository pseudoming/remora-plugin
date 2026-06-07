#!/usr/bin/env python3
import sys
import json
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from adapter.bridge.conversation import ConversationDataAccessLayer
from core.reader import filter_user_ai_rounds

def read_last_user_ai_rounds(conv_id, rounds=10):
    cdal = ConversationDataAccessLayer(conv_id)

    if not os.path.exists(cdal.db_path):
        print(f"Error: db path not found for ID: {conv_id}")
        sys.exit(1)
        
    try:
        limit = rounds * 50
        rounds_data = filter_user_ai_rounds(cdal.stream_steps_reverse(limit=limit), rounds=rounds)
    except Exception as e:
        print(f"Error reading db: {e}")
        sys.exit(1)
        
    for r in reversed(rounds_data):
        print(f"[{r['role'].upper()}]: {r['content']}")

if __name__ == "__main__":
    from core.logger import set_trace_id
    import uuid
    set_trace_id(f"c_{uuid.uuid4().hex[:8]}")
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
