import os
import re

def normalize_filepath(arguments_dict):
    """标准化提取同义路径键名，带类型防护"""
    if not isinstance(arguments_dict, dict):
        return ""
    aliases = ["TargetFile", "AbsolutePath", "FilePath", "Target"]
    for alias in aliases:
        val = arguments_dict.get(alias)
        if val and isinstance(val, str):
            val = val.strip('\'"')
            return os.path.basename(val)
    return ""

ACTION_PATTERNS = [
    re.compile(
        r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:已|成功)在\s*\[([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)\]\(file:///[^\)]+\)\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:已|成功)在\s*[`'"?]?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"?]?\s*中\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*[`'"?](([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+))[`'"?]?''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*[`'"?]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"?]?''',
        re.IGNORECASE,
    ),
    re.compile(
        r'''(?:updated|modified|written|created|overwritten|adjusted|rewritten)\s*(?:file)?\s*\b([a-zA-Z0-9_\-\.\/]+\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\b''',
        re.IGNORECASE,
    ),
]
