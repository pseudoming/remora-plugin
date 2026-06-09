/**
 * Decision text truncation for memory injection.
 *
 * Extracted from scripts/core/injector.py.
 * Pure function — zero dependencies.
 */

const MAX_CHARS = 750;

/**
 * Truncate a list of decision objects to fit within the character budget.
 *
 * 将决策列表截断到指定字符预算内，超长文本以 "..." 结尾。
 *
 * @param decisions - Array of decision objects, each with a `text` string property.
 * @returns Truncated text joined with "\n- " prefix separators.
 */
export function truncateDecisions(
  decisions: Array<{ text: string }>
): string {
  const texts: string[] = [];
  let currentLen = 0;

  for (const d of decisions) {
    const text = d.text;
    if (currentLen + text.length > MAX_CHARS) {
      texts.push(text.slice(0, MAX_CHARS - currentLen) + "...");
      break;
    }
    texts.push(text);
    currentLen += text.length;
  }

  if (texts.length === 0) return "";
  return texts.join("\n- ");
}
