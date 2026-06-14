import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_DB_PATH = path.join(os.tmpdir(), "test_warm_storage_sync.db");

const { mockStreamForward, mockStreamReverse } = vi.hoisted(() => {
  const mockStreamForward = vi.fn<(startIdx?: number) => Generator<Record<string, any>>>();
  const mockStreamReverse = vi.fn<(limit?: number) => Generator<Record<string, any>>>();
  return { mockStreamForward, mockStreamReverse };
});

vi.mock("../src/bridge/conversation", () => ({
  ConversationDataAccessLayer: class {
    convId: string;
    constructor(convId: string) {
      this.convId = convId;
    }
    exists() {
      return true;
    }
    getMaxStepIndex() {
      return 0;
    }
    streamStepsForward(startIdx?: number) {
      return mockStreamForward(startIdx);
    }
    streamStepsReverse(limit?: number) {
      return mockStreamReverse(limit);
    }
  },
}));

vi.mock("../src/sidecar/scan-sessions", () => ({
  isSubagentSession: vi.fn().mockReturnValue(false),
  loadExcludedIds: vi.fn().mockReturnValue(new Set()),
  saveExcludedIds: vi.fn(),
  getActiveConversations: vi.fn().mockReturnValue([]),
  extractSubagentReport: vi.fn().mockReturnValue({ changedFiles: [], referencedFiles: [] }),
}));

function _isConnLike(v: any): v is Database.Database {
  return v && typeof v === "object" && typeof v.prepare === "function";
}

vi.mock("@remora/core", () => {
  const Database = require("better-sqlite3");

  function _resolve(args: any[]): { db: Database.Database; closeAfter: boolean; a: any[] } {
    if (args.length > 0 && _isConnLike(args[args.length - 1])) {
      return { db: args[args.length - 1], closeAfter: false, a: args.slice(0, -1) };
    }
    return { db: new Database(TEST_DB_PATH, { timeout: 15000 }), closeAfter: true, a: args };
  }

  return {
    getDbPath: () => TEST_DB_PATH,
    checkDbExists: () => {
      try {
        return require("node:fs").statSync(TEST_DB_PATH).isFile();
      } catch {
        return false;
      }
    },
    getWatermark: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?").get(a[0], a[1]) as { last_msg_id: number } | undefined;
        return row ? row.last_msg_id : 0;
      } finally { if (closeAfter) db.close(); }
    },
    getMaxLineNumber: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT MAX(line_number) as max_ln FROM messages WHERE conversation_id=?").get(a[0]) as { max_ln: number | null } | undefined;
        return row && row.max_ln ? row.max_ln : 0;
      } finally { if (closeAfter) db.close(); }
    },
    insertMessage: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const result = db.prepare("INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)").run(a[0], a[1], a[2], a[3], a[4]);
        return Number(result.lastInsertRowid);
      } finally { if (closeAfter) db.close(); }
    },
    getMaxMessageId: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=?").get(a[0]) as { max_id: number | null } | undefined;
        return row && row.max_id ? row.max_id : 0;
      } finally { if (closeAfter) db.close(); }
    },
    getMaxMessageIdUpToLine: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=? AND line_number<=?").get(a[0], a[1]) as { max_id: number | null } | undefined;
        return row && row.max_id ? row.max_id : 0;
      } finally { if (closeAfter) db.close(); }
    },
    deleteMessagesAboveLine: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        db.prepare("DELETE FROM messages WHERE conversation_id=? AND line_number > ?").run(a[0], a[1]);
      } finally { if (closeAfter) db.close(); }
    },
    getDecisionsByConversation: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        return db.prepare("SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?").all(a[0]) as Array<{ id: number; evidence_msg_ids: string }>;
      } finally { if (closeAfter) db.close(); }
    },
    deleteTopicDecision: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        db.prepare("DELETE FROM topic_decisions WHERE id=?").run(a[0]);
      } finally { if (closeAfter) db.close(); }
    },
    getMessageTimestamp: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT timestamp FROM messages WHERE id=?").get(a[0]) as { timestamp: string } | undefined;
        return row ? row.timestamp : null;
      } finally { if (closeAfter) db.close(); }
    },
    deleteDecisionsByConversationAfter: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        db.prepare("DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?").run(a[0], a[1]);
      } finally { if (closeAfter) db.close(); }
    },
    deletePendingEvents: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        db.prepare("DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'").run(a[0]);
      } finally { if (closeAfter) db.close(); }
    },
    updateWatermark: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        db.prepare("INSERT OR REPLACE INTO watermarks (project_uuid, conversation_id, last_msg_id, last_updated) VALUES (?, ?, ?, datetime('now'))").run(a[0], a[1], a[2]);
      } finally { if (closeAfter) db.close(); }
    },
    ensureWatermark: (...args: any[]) => {
      const { db, closeAfter, a } = _resolve(args);
      try {
        const row = db.prepare("SELECT 1 FROM watermarks WHERE project_uuid=? AND conversation_id=?").get(a[0], a[1]);
        if (!row) {
          db.prepare("INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)").run(a[0], a[1]);
        }
      } finally { if (closeAfter) db.close(); }
    },
    formatTimestamp: (ts: string) => ts,
    insertDecision: () => {},
    decisionExists: () => false,
    supersedeUnconfirmed: () => {},
    getOpenTopic: () => null,
    getTopicFiles: () => ["[]", "[]"],
    updateTopicFiles: () => {},
    upsertTopic: () => {},
    backfillMessageTopicIds: () => {},
    calculateFactualConfidence: () => 1.0,
    validateIdInheritance: () => {},
    calculateMd5: () => "mock-hash",
    getArtifactHash: () => null,
    upsertArtifactHash: () => {},
    deleteArtifactMessages: () => {},
    insertArtifactMessage: () => {},
    upsertArtifactTopic: () => {},
    enqueueEvent: () => {},
    insertFileChange: () => {},
    getAllProjectUuids: () => [] as string[],
    getPlanChangeTime: () => null,
    getUserMessagesAfter: () => [],
    getPlanContent: () => "",
    scanApprovalSignals: () => [],
    getPendingEvents: () => [],
    markEventProcessed: () => {},
    getPendingDecisions: () => [],
    confirmDecisionsByIds: () => {},
    getConfirmedDecisions: () => [],
    confirmDecision: () => {},
    getTopicIdByDecision: () => null,
    getDecisionConfirmed: () => 0,
    getConfirmedDecisionIds: () => [],
    getRecentDecisions: () => [],
    getRejectedOrDeferredByRelevance: () => [],
    bumpInjection: () => {},
    getActiveTopic: () => null,
    createOrUpdateTopic: () => {},
    switchTopic: () => {},
    closeTopic: () => {},
    getTopicsByUuid: () => [],
    touchTopicSourceManual: () => {},
    mergePhysicalFilesToTopic: () => {},
    getActiveTopicCreatedAt: () => null,
    recallFts5Logs: () => [],
    recallDecisionsByFts5Topic: () => [],
    recallDecisionsByLike: () => [],
    touchTopicsAccessedByRecall: () => {},
    runTopicGarbageCollection: () => {},
    pruneExpiredWatermarks: () => {},
    cleanupGhostMessages: () => {},
    getDecisionsByFile: () => [],
    getProjectUuidByConv: () => null,
    watermarkExists: () => false,
    getRuntimeHookValue: () => null,
    setRuntimeHookValue: () => {},
    deleteRuntimeHookValue: () => {},
    trimRuntimeHookStates: () => {},
    getHookState: () => null,
    setHookState: () => {},
    trimHookStates: () => {},
    shouldFire: () => false,
    markFired: () => {},
    isDuplicate: () => false,
    clearStale: () => {},
    shouldInjectTone: () => false,
    readMode: () => "standard",
    writeMode: () => {},
    getLatestSession: () => null,
    updateColdStart: () => {},
    forceColdStartLatestSession: () => {},
    getSession: () => null,
    getLatestNonUserMessages: () => [],
  };
});

import { readIncrementalLogs } from "../src/sidecar/warm-storage-sync";
import { isSubagentSession } from "../src/sidecar/scan-sessions";

const SCHEMA = `
  CREATE TABLE watermarks (
      conversation_id TEXT PRIMARY KEY,
      project_uuid TEXT,
      last_msg_id INTEGER DEFAULT 0,
      last_updated DATETIME
  );
  CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      topic_id TEXT,
      role TEXT,
      content TEXT,
      line_number INTEGER,
      timestamp DATETIME
  );
  CREATE TABLE topic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      evidence_msg_ids TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE remora_event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_uuid TEXT,
      status TEXT
  );
`;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

  const conn = new Database(TEST_DB_PATH, { timeout: 15000 });
  conn.exec(SCHEMA);
  conn.close();

  mockStreamForward.mockReturnValue((function* () {})());
  mockStreamReverse.mockReturnValue((function* () {})());
});

afterEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

it("cursor resume", () => {
  function* mockStream(startIdx?: number) {
    for (let i = 1; i <= 10; i++) {
      yield {
        step_index: i,
        type: "USER_INPUT",
        content: `msg ${i}`,
        source: "USER",
        timestamp: "2026-06-04T00:00:00Z",
      };
    }
  }
  mockStreamForward.mockReturnValue(mockStream());

  const conn = new Database(TEST_DB_PATH, { timeout: 15000 });
  conn.prepare("INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj1', 'conv1', 5)").run();
  for (let i = 1; i <= 5; i++) {
    conn.prepare("INSERT INTO messages (id, conversation_id, line_number, content) VALUES (?, 'conv1', ?, ?)").run(i, i, `msg ${i}`);
  }
  conn.close();

  const session = {
    projectUuid: "proj1",
    conversationId: "conv1",
  };

  const db = new Database(TEST_DB_PATH, { timeout: 15000 });
  try {
    const [keyContent, currentMsgId, lastMsgId] = readIncrementalLogs(db, session);

    expect(lastMsgId).toBe(5);
    expect(currentMsgId).toBe(10);
    expect(keyContent).toContain("[msg_6] msg 6");
    expect(keyContent).toContain("[msg_10] msg 10");
    expect(keyContent).not.toContain("[msg_1]");
    expect(keyContent).not.toContain("[msg_5]");

    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number };
    expect(row.cnt).toBe(10);
  } finally {
    db.close();
  }
});

it("proto role parsing", () => {
  function* mockStream(startIdx?: number) {
    yield {
      step_index: 1,
      type: "USER_INPUT",
      content: "user query",
      timestamp: "2026-06-04T00:00:00Z",
      role: "user",
    };
    yield {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      content: "model response",
      timestamp: "2026-06-04T00:00:01Z",
      role: "model",
    };
  }
  mockStreamForward.mockReturnValue(mockStream());

  const session = {
    projectUuid: "proj2",
    conversationId: "conv2",
  };

  const db = new Database(TEST_DB_PATH, { timeout: 15000 });
  try {
    const [keyContent, currentMsgId, lastMsgId] = readIncrementalLogs(db, session);

    const rows = db
      .prepare("SELECT role, content FROM messages WHERE conversation_id='conv2' ORDER BY line_number ASC")
      .all() as Array<{ role: string; content: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("user query");
    expect(rows[1].role).toBe("model");
    expect(rows[1].content).toBe("model response");
  } finally {
    db.close();
  }
});
