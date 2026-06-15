import { existsSync, statSync, readdirSync } from "node:fs";

const ROT_SENSITIVE_SUFFIXES: readonly string[] = [".jsonl", ".log", ".sqlite"];
const ROT_SENSITIVE_PATH_FRAGMENTS: readonly string[] = ["/.system_generated", "/logs"];
const ACCUMULATED_SOURCE_LIMIT = 400 * 1024;
const ACCUMULATED_DATA_LIMIT = 150 * 1024;
const LINE_ESTIMATE_BYTES = 50;

export const UNIFIED_READ_WARN_LIMIT = 80 * 1024;
export const UNIFIED_READ_DENY_LIMIT = 160 * 1024;
export const GREP_PRE_ALLOCATION_DIR_DEFAULT = 15 * 1024;
export const GREP_PRE_ALLOCATION_DIR_SMALL = 5 * 1024;
export const GREP_PRE_ALLOCATION_FILE_MAX = 10 * 1024;

export interface DenyReason {
  prefix: string;
  message: string;
  action_tip: string;
}

export interface ReadArgs {
  StartLine?: string | number;
  EndLine?: string | number;
  [key: string]: unknown;
}

export interface AccumulatedStats {
  accumulated_source_bytes: number;
  accumulated_data_bytes: number;
  unified_accumulated_read_bytes?: number;
}

export function estimateGrepReadBytes(searchPath: string, fileCount?: number): number {
  if (!existsSync(searchPath)) {
    return GREP_PRE_ALLOCATION_DIR_DEFAULT;
  }
  try {
    const stats = statSync(searchPath);
    if (stats.isFile()) {
      const estimated = Math.floor(stats.size * 0.5);
      return Math.min(estimated, GREP_PRE_ALLOCATION_FILE_MAX);
    } else if (stats.isDirectory()) {
      let count = fileCount;
      if (count === undefined) {
        try {
          const files = readdirSync(searchPath);
          count = files.length;
        } catch {
          // pass
        }
      }
      if (count !== undefined && count < 5) {
        return GREP_PRE_ALLOCATION_DIR_SMALL;
      }
      return GREP_PRE_ALLOCATION_DIR_DEFAULT;
    }
  } catch {
    // pass
  }
  return GREP_PRE_ALLOCATION_DIR_DEFAULT;
}

export function isUnifiedLimitExceeded(bytes: number): boolean {
  return bytes > UNIFIED_READ_DENY_LIMIT;
}

export function isUnifiedLimitApproaching(bytes: number): boolean {
  return bytes > UNIFIED_READ_WARN_LIMIT;
}


export function stripMarkdownCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/~~~[\s\S]*?(?:~~~|$)/g, "");
}

/**
 * Returns (isOverLimit, denyReason) tuple.
 * Checks whether the subagent prompt exceeds the maximum character limit.
 */
export function enforcePromptLengthLimit(
  prompt: string,
  maxChars: number = 1500
): [boolean, DenyReason | null] {
  const stripped = stripMarkdownCodeBlocks(prompt);
  if (stripped.length > maxChars) {
    return [
      true,
      {
        prefix: "PAYLOAD ENFORCEMENT",
        message: `Subagent Prompt stripped length (${stripped.length} chars) exceeds ${maxChars} limit. (Raw length: ${prompt.length} chars)`,
        action_tip: "Please partition the task and simplify the description.",
      },
    ];
  }
  return [false, null];
}

/**
 * Returns (isViolation, denyReason) tuple.
 * Enforces that a restricted subagent type can only run in approved workspaces.
 */
export function enforceSandboxWorkspace(
  typeName: string,
  workspace: string,
  restrictedType?: string | null,
  validWorkspaces?: string[] | null
): [boolean, DenyReason | null] {
  if (restrictedType == null || typeName !== restrictedType) {
    return [false, null];
  }
  const valid = new Set(validWorkspaces ?? []);
  if (valid.size === 0) {
    return [false, null];
  }
  if (!valid.has(workspace)) {
    return [
      true,
      {
        prefix: "SANDBOX ENFORCEMENT",
        message: `"${typeName}" MUST be invoked with valid workspaces. Direct execution is prohibited!`,
        action_tip: "Direct execution in the main tree is prohibited!",
      },
    ];
  }
  return [false, null];
}

/**
 * Returns True if targetFile has a context-rot sensitive suffix (.jsonl/.log/.sqlite).
 */
export function isRotSensitiveFile(targetFile: string): boolean {
  return ROT_SENSITIVE_SUFFIXES.some((suffix) => targetFile.endsWith(suffix));
}

/**
 * Returns True if searchPath contains /.system_generated or /logs.
 */
export function isRotSensitivePath(searchPath: string): boolean {
  return ROT_SENSITIVE_PATH_FRAGMENTS.some((fragment) =>
    searchPath.includes(fragment)
  );
}

/**
 * Estimate bytes to read. Uses (lines * 50) if StartLine/EndLine present,
 * otherwise calls getFileSize (defaults to fs.statSync size).
 */
export function estimateReadBytes(
  args: ReadArgs,
  targetFile: string,
  getFileSize?: (path: string) => number
): number {
  if (existsSync(targetFile)) {
    if ("StartLine" in args && "EndLine" in args) {
      return (
        (Number(args["EndLine"]) - Number(args["StartLine"]) + 1) *
        LINE_ESTIMATE_BYTES
      );
    } else {
      if (getFileSize) {
        return getFileSize(targetFile);
      }
      return statSync(targetFile).size;
    }
  }
  return 0;
}

/**
 * Returns True if accumulated_source > 400KB or accumulated_data > 150KB.
 */
export function isAccumulatedLimitExceeded(stats: AccumulatedStats): boolean {
  return (
    stats.accumulated_source_bytes > ACCUMULATED_SOURCE_LIMIT ||
    stats.accumulated_data_bytes > ACCUMULATED_DATA_LIMIT
  );
}

/**
 * Returns True if targetFile is a planning artifact (path fragment match or suffix match).
 */
export function isPlanningArtifact(
  targetFile: string,
  artifactPathFragment?: string | null,
  artifactSuffixes?: readonly string[] | null
): boolean {
  if (artifactPathFragment == null && artifactSuffixes == null) {
    return false;
  }
  if (artifactPathFragment && targetFile.includes(artifactPathFragment)) {
    return true;
  }
  if (artifactSuffixes && artifactSuffixes.some((s) => targetFile.endsWith(s))) {
    return true;
  }
  return false;
}

export function validatePromptSyntax(prompt: string): { isValid: boolean; errorReason?: string } {
  const stripped = stripMarkdownCodeBlocks(prompt);

  const tagsToCheck = ["system-reminder", "system-discipline"];
  for (const tag of tagsToCheck) {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    
    const openCount = (stripped.match(new RegExp(openTag, "g")) || []).length;
    const closeCount = (stripped.match(new RegExp(closeTag, "g")) || []).length;
    
    if (openCount !== closeCount) {
      return {
        isValid: false,
        errorReason: `XML tag '<${tag}>' is not properly closed (open count: ${openCount}, close count: ${closeCount})`
      };
    }
  }

  const stack: string[] = [];
  const matchingBrackets: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{",
  };
  const openBrackets = new Set(Object.values(matchingBrackets));
  const closeBrackets = new Set(Object.keys(matchingBrackets));

  const processedText = stripped.replace(/[a-zA-Z]'(?=[a-zA-Z])/g, "");

  let singleQuoteCount = 0;
  let doubleQuoteCount = 0;

  for (let i = 0; i < processedText.length; i++) {
    const char = processedText[i];
    if (char === "'") {
      singleQuoteCount++;
    } else if (char === '"') {
      doubleQuoteCount++;
    } else if (openBrackets.has(char)) {
      stack.push(char);
    } else if (closeBrackets.has(char)) {
      const top = stack.pop();
      if (top !== matchingBrackets[char]) {
        return {
          isValid: false,
          errorReason: `Unbalanced bracket detected. Expected matching bracket for '${char}' but got '${top || "none"}'`
        };
      }
    }
  }

  if (stack.length > 0) {
    return {
      isValid: false,
      errorReason: `Unclosed bracket '${stack[stack.length - 1]}' detected at the end of prompt`
    };
  }

  if (singleQuoteCount % 2 !== 0) {
    return {
      isValid: false,
      errorReason: "Unclosed single quote (') detected"
    };
  }

  if (doubleQuoteCount % 2 !== 0) {
    return {
      isValid: false,
      errorReason: "Unclosed double quote (\") detected"
    };
  }

  return { isValid: true };
}
