// DAO facade — re-exports all storage functions as a single entry point.
// Mirror of scripts/lib/dao.py.

// Sessions
export * from "./storage/sessions";

// Messages
export * from "./storage/messages";

// Topics
export * from "./storage/topics";

// Artifacts
export * from "./storage/artifacts";

// Decisions
export * from "./storage/decisions";

// Recall
export * from "./storage/recall";

// Maintenance
export * from "./storage/maintenance";

// File changes
export * from "./storage/file-changes";

// Watermarks — hand-written to avoid getActiveTopicCreatedAt conflict with topics
export {
  getProjectUuidByConv,
  watermarkExists,
} from "./storage/watermarks";

// Runtime state
export * from "./storage/runtime-state";

// Gate
export * from "./gate";

// Connection
export * from "./storage/connection";
