import os
import sys

# Ensure the parent scripts directory is in PYTHONPATH so we can import lib
current_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.dirname(current_dir)
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

from lib.conversation import ConversationDataAccessLayer

def run_tests():
    if len(sys.argv) < 2:
        print("Usage: python3 test_conversation.py <conversation_id>")
        sys.exit(1)
        
    conv_id = sys.argv[1]
    print(f"=== Testing ConversationDataAccessLayer for Conv ID: {conv_id} ===")
    
    cdal = ConversationDataAccessLayer(conv_id)
    
    print("\n[Test 1] get_compaction_watermark()")
    watermark = cdal.get_compaction_watermark()
    print(f"Watermark Result: {watermark}")
    assert isinstance(watermark, int), "Watermark must be an integer."
    
    print("\n[Test 2] stream_steps_reverse()")
    lines_count = 0
    first_few = []
    for step in cdal.stream_steps_reverse():
        line = str(step)
        lines_count += 1
        if lines_count <= 3:
            first_few.append(line.strip()[:100] + "...")
            
    print(f"Successfully streamed {lines_count} lines backwards.")
    for i, line in enumerate(first_few):
        print(f"  Line {i+1} preview: {line}")
        
    print("\n[Test 3] get_latest_user_message()")
    user_msg = cdal.get_latest_user_message()
    print(f"Latest User Msg Preview: {user_msg[:100] + '...' if user_msg else 'None'}")
    
    print("\n[Test 4] get_latest_planner_response()")
    planner_msg = cdal.get_latest_planner_response()
    print(f"Latest Planner Msg Preview: {planner_msg[:100] + '...' if planner_msg else 'None'}")
    
    print("\n[Test 5] stream_steps_forward()")
    history_count = 0
    for step in cdal.stream_steps_forward(start_idx=0):
        history_count += 1
    print(f"Successfully streamed {history_count} total steps chronologically.")
    
    print("\n✅ All basic CDAL tests passed.")

if __name__ == "__main__":
    run_tests()
