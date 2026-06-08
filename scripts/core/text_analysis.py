import re

DEFAULT_APPROVAL_KEYWORDS = ["同意", "执行吧", "批准", "启动吧", "开始执行", "可以执行", "没问题", "approve", "confirm"]
DEFAULT_NEGATION_PREFIXES = ["不", "拒绝", "拒绝执行"]

def scan_approval_signals(messages, keywords=None, negation_prefixes=None):
    """Return True if any message contains an un-negated approval keyword."""
    keywords = keywords or DEFAULT_APPROVAL_KEYWORDS
    negation_prefixes = negation_prefixes or DEFAULT_NEGATION_PREFIXES
    for msg in messages:
        if any(kw in msg for kw in keywords):
            neg_pattern = r'(' + '|'.join(negation_prefixes) + r')\s*(' + '|'.join(keywords) + ')'
            if not re.search(neg_pattern, msg):
                return True
    return False
