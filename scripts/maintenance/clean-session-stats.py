#!/usr/bin/env python3
import sys
import json
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from adapter.bridge.stats import cleanup
from adapter.bridge.context import hook_entrypoint

@hook_entrypoint(fallback_result={})
def main(context):
    if context.get('fullyIdle', False):
        conv_id = context.get('conversationId')
        if conv_id:
            cleanup(conv_id)
    return {}

if __name__ == "__main__":
    main()
