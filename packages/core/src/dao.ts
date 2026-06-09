// DAO facade — re-exports all storage functions as a single entry point.
// Mirror of scripts/lib/dao.py.

// Sessions
export {
  readMode,
  writeMode,
  getLatestSession,
  updateColdStart,
  forceColdStartLatestSession,
  getSession,
} from "./storage/sessions";

// Messages
export {
  getWatermark,
  getMaxLineNumber,
  insertMessage,
  getMaxMessageId,
  deleteMessagesAboveLine,
  getDecisionsByConversation,
  deleteTopicDecision,
  getMessageTimestamp,
  deleteDecisionsByConversationAfter,
  deletePendingEvents,
  updateWatermark,
  ensureWatermark,
  backfillMessageTopicIds,
} from "./storage/messages";

// Topics
export {
  getActiveTopic,
  createOrUpdateTopic,
  switchTopic,
  closeTopic,
  getTopicsByUuid,
  touchTopicSourceManual,
  mergePhysicalFilesToTopic,
  getOpenTopic,
  getTopicFiles,
  updateTopicFiles,
  upsertTopic,
  getAllProjectUuids,
  getActiveTopicCreatedAt,
} from "./storage/topics";

// Artifacts
export {
  getPlanChangeTime,
  getUserMessagesAfter,
  getPlanContent,
  enqueueEvent,
  getPendingEvents,
  markEventProcessed,
  getArtifactHash,
  upsertArtifactHash,
  deleteArtifactMessages,
  insertArtifactMessage,
  upsertArtifactTopic,
} from "./storage/artifacts";

// Decisions
export {
  getConfirmedDecisions,
  confirmDecision,
  getTopicIdByDecision,
  decisionExists,
  supersedeUnconfirmed,
  getPendingDecisions,
  confirmDecisionsByIds,
  insertDecision,
  getDecisionConfirmed,
  getConfirmedDecisionIds,
  getRecentDecisions,
  getRejectedOrDeferredByRelevance,
  bumpInjection,
} from "./storage/decisions";

// Recall
export {
  recallFts5Logs,
  recallDecisionsByFts5Topic,
  recallDecisionsByLike,
  touchTopicsAccessedByRecall,
} from "./storage/recall";

// Maintenance
export {
  runTopicGarbageCollection,
  pruneExpiredWatermarks,
  cleanupGhostMessages,
} from "./storage/maintenance";

// File changes
export {
  insertFileChange,
  getFilesByTopic,
  getDecisionsByFile,
} from "./storage/file-changes";

// Watermarks
export {
  getProjectUuidByConv,
  watermarkExists,
} from "./storage/watermarks";

// Runtime state
export {
  getRuntimeHookValue,
  setRuntimeHookValue,
  deleteRuntimeHookValue,
  trimRuntimeHookStates,
  getHookState,
  setHookState,
  deleteHookState,
  trimHookStates,
} from "./storage/runtime-state";

// Gate
export { shouldFire, markFired, isDuplicate, clearStale, shouldInjectTone } from "./gate";

// Connection
export { getDbPath, checkDbExists } from "./storage/connection";
