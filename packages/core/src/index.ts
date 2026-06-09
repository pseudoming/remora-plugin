// @remora/core — barrel export
// 中文翻译：@remora/core 包入口，公开全部核心 API。

// Prompt formatting
export {
  formatRelaxDisciplinePrompt,
  formatDecisionsForSessionResume,
  formatConflictInjectionMessage,
  formatFileDecisionsInjection,
  formatWriteGateDenyPrompt,
  formatPhantomFirstWarning,
  formatPhantomRepeatWarning,
  formatStrictRecallReminder,
  formatStrictTonePrompt,
  formatAlertRecallPrompt,
  formatHeartbeatTimerInjection,
  formatCumulativeReadWarning,
  makeDenyReason,
} from "./injection-formatting";

// Safety policy
export {
  enforcePromptLengthLimit,
  enforceSandboxWorkspace,
  isRotSensitiveFile,
  isRotSensitivePath,
  estimateReadBytes,
  isAccumulatedLimitExceeded,
  isPlanningArtifact,
} from "./safety-policy";

// Text analysis
export {
  scanApprovalSignals,
  buildConflictDetectionPrompt,
} from "./text-analysis";

// Liveness
export {
  cleanSystemReminders,
  detectMode,
  parseSqliteTimestamp,
  findAllUuids,
  judgeZombie,
  suggestZombieAction,
  formatTimestamp,
  isTimerCanceled,
} from "./liveness";

// Phantom
export {
  ACTION_PATTERNS,
  normalizeFilepath,
  resolvePhantomModifications,
} from "./phantom";

// Injector / Reader
export { truncateDecisions } from "./injector";
export { filterUserAiRounds } from "./reader";

// Command inspector
export { inspectCommand, decodeBase64Token } from "./rules/inspector";

// Storage (via DAO)
export * from "./dao";

// Zombie (pure logic only — /proc scanning lives in adapter)
export {
  INFRASTRUCTURE_KEYWORDS,
  isInfrastructureProcess,
  isProcessExpired,
} from "./zombie";

// Filesystem
export { walkFiles, calculateMd5, diffSnapshots } from "./filesystem";

// Logger
export { setTraceId, init as initLogger, debug, info, warn, error, profile } from "./logger";
