import os
import json
import time
import re
import sys
from pathlib import Path
from typing import Optional

class ProgressSentinel:
    @staticmethod
    def get_progress_path(transcript_path: str) -> Optional[Path]:
        if not transcript_path:
            return None
        path = Path(transcript_path)
        # 兼容多种 transcript_path 物理位置
        # 例如: .../brain/<conversation-id>/.system_generated/transcript.jsonl
        if path.parent.name == '.system_generated':
            return path.parent.parent / "scratch" / "progress.json"
        else:
            # 兜底：如果是直接处于 conversation 目录，或是其他自定义结构
            return path.parent / "scratch" / "progress.json"

    @classmethod
    def update(cls, transcript_path: str, status: str, step_index: Optional[int] = None, details: str = "") -> bool:
        if not transcript_path:
            return False
        
        progress_path = cls.get_progress_path(transcript_path)
        if not progress_path:
            return False
            
        # 保证父目录 scratch 存在
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 读取旧快照，用以提取 step_index 或者合并其他内容
        old_data = {}
        if progress_path.exists():
            with open(progress_path, "r", encoding="utf-8") as f:
                old_data = json.load(f)
        
        # 确定 step_index
        final_step_index = step_index
        if final_step_index is None:
            # 尝试从旧快照中读取
            if "step_index" in old_data:
                final_step_index = old_data["step_index"]
            else:
                # 尝试从 conversations db 里面查
                match = re.search(r'/brain/([^/]+)/', transcript_path)
                if match:
                    conv_id = match.group(1)
                    from adapter.bridge.conversation import ConversationDataAccessLayer
                    final_step_index = ConversationDataAccessLayer(conv_id).get_max_step_index()
        
        if final_step_index is None:
            final_step_index = 0
            
        snapshot = {
            "status": status,
            "last_updated_at": int(time.time()),
            "step_index": final_step_index,
            "details": details
        }
        
        # 原子性写入 progress.json
        tmp_path = progress_path.with_suffix(f".{os.getpid()}.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, progress_path)
        return True
