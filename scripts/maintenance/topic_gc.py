import os
import sys

scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from lib.dao import run_topic_garbage_collection

def run_garbage_collection(conn=None):
    run_topic_garbage_collection()

if __name__ == "__main__":
    run_garbage_collection()

