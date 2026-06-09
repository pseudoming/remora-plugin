import { existsSync, statSync } from "node:fs";

const ROT_SENSITIVE_SUFFIXES: readonly string[] = [".jsonl", ".log", ".sqlite"];
const ROT_SENSITIVE_PATH_FRAGMENTS: readonly string[] = ["/.system_generated", "/logs"];
const ACCUMULATED_SOURCE_LIMIT = 400 * 1024;
const ACCUMULATED_DATA_LIMIT = 150 * 1024;
const LINE_ESTIMATE_BYTES = 50;

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
}

/**
 * Returns (isOverLimit, denyReason) tuple.
 * Checks whether the subagent prompt exceeds the maximum character limit.
 */
export function enforcePromptLengthLimit(
  prompt: string,
  maxChars: number = 1500
): [boolean, DenyReason | null] {
  if (prompt.length > maxChars) {
    return [
      true,
      {
        prefix: "PAYLOAD ENFORCEMENT",
        message: `Subagent Prompt length (${prompt.length} chars) exceeds ${maxChars} limit.`,
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
