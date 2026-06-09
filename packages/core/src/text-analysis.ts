const DEFAULT_APPROVAL_KEYWORDS: string[] = [
  "同意", "执行吧", "批准", "启动吧", "开始执行", "可以执行", "没问题", "approve", "confirm",
];

const DEFAULT_NEGATION_PREFIXES: string[] = ["不", "拒绝", "拒绝执行"];

export interface ConflictCandidate {
  decision_type?: string;
  decision: string;
  rationale: string;
  [key: string]: unknown;
}

/**
 * Return True if any message contains an un-negated approval keyword.
 * Uses RegExp to detect negation patterns like "不同意" or "拒绝执行".
 */
export function scanApprovalSignals(
  messages: string[],
  keywords?: string[],
  negationPrefixes?: string[]
): boolean {
  const kw = keywords ?? DEFAULT_APPROVAL_KEYWORDS;
  const np = negationPrefixes ?? DEFAULT_NEGATION_PREFIXES;
  const negPattern = new RegExp(
    `(${np.join("|")})\\s*(${kw.join("|")})`
  );
  for (const msg of messages) {
    if (kw.some((keyword) => msg.includes(keyword))) {
      if (!negPattern.test(msg)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a semantic conflict detection prompt for comparing a user statement
 * against historical decisions.
 */
export function buildConflictDetectionPrompt(
  userMsg: string,
  candidates: ConflictCandidate[]
): string {
  const items: string[] = [];
  let i = 1;
  for (const c of candidates) {
    const label = c.decision_type === "rejected" ? "REJECTED" : "DEFERRED";
    items.push(
      `#${i} [${label}] ${c.decision} (rationale: ${c.rationale.slice(0, 150)})`
    );
    i++;
  }
  return `You are a semantic conflict detector.

USER STATEMENT:
"${userMsg}"

HISTORICAL DECISIONS:
${items.join("\n")}

Return ONLY a JSON object. If any decision conflicts with the user's statement:
{"conflicts": [{"decision_id": 42, "reason": "one sentence why"}]}
If none: {"conflicts": []}`;
}
