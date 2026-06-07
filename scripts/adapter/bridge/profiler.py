import time
import os
import re
from datetime import datetime
from pathlib import Path
from core.logger import profile as log_profile

class HookProfiler:
    def __init__(self, hook_name: str, context: dict = None):
        self.hook_name = hook_name
        self.t_start = time.perf_counter()
        self.events = [("start", self.t_start)]
        self.context = context or {}
        
        # 尝试提取 conv_id
        self.conv_id = "unknown"
        transcript_path = self.context.get('transcriptPath', '')
        if transcript_path:
            match = re.search(r'/brain/([^/]+)/', transcript_path)
            if match:
                self.conv_id = match.group(1)
                
    def step(self, event_name: str):
        self.events.append((event_name, time.perf_counter()))
        
    def finish(self):
        t_end = time.perf_counter()
        self.events.append(("end", t_end))
        
        total_ms = (t_end - self.t_start) * 1000.0
        
        log_lines = []
        log_lines.append(f"=== [{self.hook_name}] Run at {datetime.now().isoformat()} (Conv: {self.conv_id}) ===")
        for i in range(1, len(self.events)):
            name, t_curr = self.events[i]
            prev_name, t_prev = self.events[i-1]
            elapsed_ms = (t_curr - t_prev) * 1000.0
            log_lines.append(f"  [{prev_name} -> {name}]: {elapsed_ms:.2f} ms")
        log_lines.append(f"Total: {total_ms:.2f} ms\n")
        
        log_content = "\n".join(log_lines) + "\n"
        
        # 1. 写入全局日志
        log_profile(log_content)
            
        # 2. 顺着 transcriptPath 解析并写入 scratch 目录，彻底避免对 HOME 环境变量的猜测与依赖
        transcript_path = self.context.get('transcriptPath', '')
        if transcript_path:
            try:
                scratch_dir = Path(transcript_path).parent.parent.parent / "scratch"
                scratch_dir.mkdir(parents=True, exist_ok=True)
                log_profile(log_content, str(scratch_dir / "hooks_profile.log"))
            except Exception:
                pass
