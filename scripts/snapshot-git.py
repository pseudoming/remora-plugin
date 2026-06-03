#!/usr/bin/env python3
import sys
import json
import os
import subprocess
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from lib.filesystem import get_snapshot

def main():
    try:
        context = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"injectSteps": []}))
        return
        
    transcript_path = context.get('transcriptPath', '')
    cwd = context.get('cwd', os.getcwd())
    
    if not transcript_path:
        print(json.dumps({"injectSteps": []}))
        return
        
    try:
        conv_dir = Path(transcript_path).parent.parent.parent
        scratch_dir = conv_dir / 'scratch'
        scratch_dir.mkdir(parents=True, exist_ok=True)
        snapshot_file = scratch_dir / 'remora_pre_snapshot.json'
        
        snapshot = get_snapshot(cwd)
        with open(snapshot_file, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f)
            
    except Exception:
        pass
        
    print(json.dumps({"injectSteps": []}))

if __name__ == "__main__":
    main()
