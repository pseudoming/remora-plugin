/**
 * Step iterator filter for extracting user/assistant conversation rounds.
 *
 * Extracted from scripts/core/reader.py.
 * Pure function — zero dependencies.
 */

export const MAX_CONTENT_CHARS = 1000;

interface Step {
  type?: string;
  content?: string;
}

interface RoundEntry {
  role: "user" | "assistant";
  content: string;
}

export interface ReaderOptions {
  userType?: string;
  assistantType?: string;
}

/**
 * Filter a step iterator to extract the most recent user/assistant rounds.
 *
 * 从步骤迭代器中提取最近的用户/助手对话轮次（每轮 user + assistant 算一轮）。
 *
 * @param stepsIter - Iterable of step objects with `type` and `content` fields.
 * @param rounds    - Number of conversation rounds to extract (default 10).
 * @param options   - Platform-specific step type names.
 * @returns Array of { role, content } entries, max `rounds * 2` in length.
 */
export function filterUserAiRounds(
  stepsIter: Iterable<Step>,
  rounds: number = 10,
  options: ReaderOptions = {}
): RoundEntry[] {
  const userType = options.userType ?? "USER_INPUT";
  const assistantType = options.assistantType ?? "PLANNER_RESPONSE";
  const results: RoundEntry[] = [];
  const limit = rounds * 2;

  try {
    for (const step of stepsIter) {
      const stepType = step.type;
      const content = step.content ?? "";
      if (!content) continue;

      if (stepType === userType || stepType === assistantType) {
        results.push({
          role: stepType === userType ? "user" : "assistant",
          content: content.slice(0, MAX_CONTENT_CHARS),
        });
        if (results.length >= limit) {
          break;
        }
      }
    }
  } catch {
    // 静默处理迭代错误
  }

  return results;
}
