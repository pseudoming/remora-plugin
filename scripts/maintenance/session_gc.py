import os
import sys

scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from lib.dao import prune_expired_watermarks as _prune

BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")

def prune_expired_watermarks(brain_dir=BRAIN_DIR):
    _prune(brain_dir)

if __name__ == "__main__":
    prune_expired_watermarks(BRAIN_DIR)

