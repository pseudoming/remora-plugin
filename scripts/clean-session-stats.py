#!/usr/bin/env python3
import sys
import json
import os

sys.path.insert(0, os.path.dirname(__file__))
from lib.stats import cleanup

if __name__ == "__main__":
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        sys.exit(0)

    try:
        data = json.loads(raw_input)
        # 仅在系统判定当前会话处于 fullyIdle 状态时执行垃圾回收
        if data.get('fullyIdle', False):
            # 获取当前结束的会话 ID
            conv_id = data.get('conversationId')
            if conv_id:
                cleanup(conv_id)
    except Exception as e:
        pass
