#!/usr/bin/env python3
import sys
import json
import os

def read_last_user_ai_rounds(path_or_id, rounds=10):
    transcript_path = path_or_id
    if not os.path.exists(transcript_path):
        brain_dir = os.path.expanduser("~/.gemini/antigravity/brain")
        transcript_path = os.path.join(brain_dir, path_or_id, ".system_generated", "logs", "transcript.jsonl")

    if not os.path.exists(transcript_path):
        print(f"Error: log path not found for ID or Path: {path_or_id}")
        sys.exit(1)
        
    rounds_data = []
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
                step_type = obj.get('type')
                content = obj.get('content', '')
                if not content:
                    continue
                    
                if step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                    rounds_data.append({
                        "role": "user" if step_type == 'USER_INPUT' else "assistant",
                        "content": content[:1000] # Limit output to avoid context explosion
                    })
                    if len(rounds_data) >= rounds * 2:
                        break
            except Exception:
                continue
    except Exception as e:
        print(f"Error reading log: {e}")
        sys.exit(1)
        
    for r in reversed(rounds_data):
        print(f"[{r['role'].upper()}]: {r['content']}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 read-session-log.py <conversation_id_or_path> [rounds]")
        sys.exit(1)
    path = sys.argv[1]
    r = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    read_last_user_ai_rounds(path, r)
