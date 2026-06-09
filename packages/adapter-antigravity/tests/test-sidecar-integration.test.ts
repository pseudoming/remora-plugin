import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {
  testDbPath,
  testDataDir,
  mockSendMessage,
  mockCreateConversation,
  mockCdalmDbPathRef,
  mockCdalmGetMaxStepIndex,
  mockCdalmStreamForward,
  mockCdalmStreamReverse,
  mockCdalmGetLatestPlannerResponse,
  mockCdalmGetDbMtime,
  mockLoadExcludedIds,
  mockSaveExcludedIds,
  mockGetActiveConversations,
  mockIsSubagentSession,
  mockExtractSubagentReport,
} = vi.hoisted(() => {
  const _os = require("node:os");
  const _path = require("node:path");
  const testDbPath = { value: _path.join(_os.tmpdir(), "test_sidecar_integration.db") };
  const testDataDir = { value: _path.join(_os.tmpdir(), "test_sidecar_data") };
  const mockSendMessage = vi.fn();
  const mockCreateConversation = vi.fn();
  const mockCdalmDbPathRef = { value: "/nonexistent/conv.db" };
  const mockCdalmGetMaxStepIndex = vi.fn<() => number>();
  const mockCdalmStreamForward = vi.fn<() => Generator<Record<string, any>>>();
  const mockCdalmStreamReverse = vi.fn<() => Generator<Record<string, any>>>();
  const mockCdalmGetLatestPlannerResponse = vi.fn<() => string | null>();
  const mockCdalmGetDbMtime = vi.fn<() => number>();
  const mockLoadExcludedIds = vi.fn<() => Set<string>>();
  const mockSaveExcludedIds = vi.fn<(ids: Set<string>) => void>();
  const mockGetActiveConversations = vi.fn<() => Array<{ projectUuid: string; conversationId: string; dbPath: string }>>();
  const mockIsSubagentSession = vi.fn<(convId: string) => boolean>();
  const mockExtractSubagentReport = vi.fn<(convId: string) => { changedFiles: string[]; referencedFiles: string[] }>();
  return {
    testDbPath,
    testDataDir,
    mockSendMessage,
    mockCreateConversation,
    mockCdalmDbPathRef,
    mockCdalmGetMaxStepIndex,
    mockCdalmStreamForward,
    mockCdalmStreamReverse,
    mockCdalmGetLatestPlannerResponse,
    mockCdalmGetDbMtime,
    mockLoadExcludedIds,
    mockSaveExcludedIds,
    mockGetActiveConversations,
    mockIsSubagentSession,
    mockExtractSubagentReport,
  };
});

const TEST_DB_PATH = testDbPath.value;
const TEST_DATA_DIR = testDataDir.value;

vi.mock("../src/bridge/paths", () => ({
  getDataDir: () => testDataDir.value,
  extractConvId: (transcriptPath: string) => {
    const m = transcriptPath.match(/brain\/([a-f0-9-]{36})/);
    return m ? m[1] : "";
  },
}));

vi.mock("../src/bridge/agentapi", () => ({
  sendMessage: mockSendMessage,
  createConversation: mockCreateConversation,
  getProjectId: (_convId: string, defaultVal?: string) =>
    defaultVal ?? "11111111-1111-1111-1111-111111111111",
}));

vi.mock("../src/bridge/conversation", () => ({
  ConversationDataAccessLayer: class {
    convId: string;
    constructor(convId: string) {
      this.convId = convId;
    }
    get dbPath() {
      return mockCdalmDbPathRef.value;
    }
    getMaxStepIndex() {
      return mockCdalmGetMaxStepIndex();
    }
    streamStepsForward(startIdx?: number) {
      return mockCdalmStreamForward(startIdx);
    }
    streamStepsReverse(limit?: number) {
      return mockCdalmStreamReverse(limit);
    }
    getLatestPlannerResponse() {
      return mockCdalmGetLatestPlannerResponse();
    }
    getDbMtime() {
      return mockCdalmGetDbMtime();
    }
  },
}));

vi.mock("../src/schema/schema-init", () => ({
  initDb: vi.fn(),
  DB_PATH: testDbPath.value,
  DATA_DIR: testDataDir.value,
}));

vi.mock("../src/maintenance/session-gc", () => ({
  pruneExpiredWatermarks: vi.fn(),
}));

vi.mock("../src/maintenance/topic-gc", () => ({
  runGarbageCollection: vi.fn(),
}));

vi.mock("../src/sidecar/scan-sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sidecar/scan-sessions")>();
  return {
    ...actual,
    isSubagentSession: mockIsSubagentSession,
    extractSubagentReport: mockExtractSubagentReport,
    getActiveConversations: mockGetActiveConversations,
    loadExcludedIds: mockLoadExcludedIds,
    saveExcludedIds: mockSaveExcludedIds,
  };
});

function _isConnLike(v: any): v is Database.Database {
  return v && typeof v === "object" && typeof v.prepare === "function";
}

vi.mock("@remora/core", () => {
  const BetterSqlite3 = require("better-sqlite3");
  const _crypto = require("node:crypto");
  const _fs = require("node:fs");

  function _v(args: any[]): any[] {
    if (args.length > 0 && _isConnLike(args[0])) return args.slice(1);
    return args;
  }

  function _resolveConn(args: any[]): { db: Database.Database; closeAfter: boolean; a: any[] } {
    if (args.length > 0 && _isConnLike(args[0])) {
      return { db: args[0] as Database.Database, closeAfter: false, a: args.slice(1) };
    }
    return { db: new BetterSqlite3(testDbPath.value, { timeout: 15000 }), closeAfter: true, a: args };
  }

  function _getWatermark(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?").get(a[0], a[1]) as { last_msg_id: number } | undefined;
      return row ? row.last_msg_id : 0;
    } finally { db.close(); }
  }

  function _getMaxLineNumber(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT MAX(line_number) as max_ln FROM messages WHERE conversation_id=?").get(a[0]) as { max_ln: number | null } | undefined;
      return row && row.max_ln ? row.max_ln : 0;
    } finally { db.close(); }
  }

  function _insertMessage(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const result = db.prepare("INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)").run(a[0], a[1], a[2], a[3], a[4]);
      return Number(result.lastInsertRowid);
    } finally { db.close(); }
  }

  function _getMaxMessageId(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=?").get(a[0]) as { max_id: number | null } | undefined;
      return row && row.max_id ? row.max_id : 0;
    } finally { db.close(); }
  }

  function _getMaxMessageIdUpToLine(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=? AND line_number<=?").get(a[0], a[1]) as { max_id: number | null } | undefined;
      return row && row.max_id ? row.max_id : 0;
    } finally { db.close(); }
  }

  function _deleteMessagesAboveLine(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("DELETE FROM messages WHERE conversation_id=? AND line_number > ?").run(a[0], a[1]);
    } finally { db.close(); }
  }

  function _getDecisionsByConversation(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      return db.prepare("SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?").all(a[0]) as Array<{ id: number; evidence_msg_ids: string }>;
    } finally { db.close(); }
  }

  function _deleteTopicDecision(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("DELETE FROM topic_decisions WHERE id=?").run(a[0]);
    } finally { db.close(); }
  }

  function _getMessageTimestamp(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT timestamp FROM messages WHERE id=?").get(a[0]) as { timestamp: string } | undefined;
      return row ? row.timestamp : null;
    } finally { db.close(); }
  }

  function _deleteDecisionsByConversationAfter(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?").run(a[0], a[1]);
    } finally { db.close(); }
  }

  function _deletePendingEvents(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'").run(a[0]);
    } finally { db.close(); }
  }

  function _updateWatermark(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT OR REPLACE INTO watermarks (project_uuid, conversation_id, last_msg_id, last_updated) VALUES (?, ?, ?, datetime('now'))").run(a[0], a[1], a[2]);
    } finally { db.close(); }
  }

  function _ensureWatermark(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT 1 FROM watermarks WHERE project_uuid=? AND conversation_id=?").get(a[0], a[1]);
      if (!row) {
        db.prepare("INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)").run(a[0], a[1]);
      }
    } finally { db.close(); }
  }

  function _insertDecision(...args: any[]) {
    const { db, closeAfter, a } = _resolveConn(args);
    try {
      db.prepare("INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, decision_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
    } finally { if (closeAfter) db.close(); }
  }

  function _decisionExists(...args: any[]) {
    const { db, closeAfter, a } = _resolveConn(args);
    try {
      const row = db.prepare("SELECT 1 FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND decision=?").get(a[0], a[1], a[2]);
      return !!row;
    } finally { if (closeAfter) db.close(); }
  }

  function _supersedeUnconfirmed(...args: any[]) {
    const { db, closeAfter, a } = _resolveConn(args);
    try {
      db.prepare("UPDATE topic_decisions SET decision_type='superseded' WHERE project_uuid=? AND topic_id=? AND user_confirmed=0").run(a[0], a[1]);
    } finally { if (closeAfter) db.close(); }
  }

  function _getOpenTopic(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' LIMIT 1").get(a[0]) as { topic_id: string } | undefined;
      return row ? row.topic_id : null;
    } finally { db.close(); }
  }

  function _getTopicFiles(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT associated_files, referenced_files FROM project_topics WHERE uuid=? AND topic_id=?").get(a[0], a[1]) as { associated_files: string; referenced_files: string } | undefined;
      return [row ? row.associated_files : "[]", row ? row.referenced_files : "[]"];
    } finally { db.close(); }
  }

  function _updateTopicFiles(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("UPDATE project_topics SET associated_files=?, referenced_files=? WHERE uuid=? AND topic_id=?").run(a[2], a[3], a[0], a[1]);
    } finally { db.close(); }
  }

  function _upsertTopic(...args: any[]) {
    const a = _v(args);
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT INTO project_topics (uuid, topic_id, summary, compression_confidence, source) VALUES (?, ?, ?, ?, 'auto') ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?, compression_confidence=?").run(a[0], a[1], a[2], 1.0, a[2], 1.0);
    } finally { db.close(); }
  }

  function _calculateMd5(filePath: string): string {
    try {
      return _crypto.createHash("md5").update(_fs.readFileSync(filePath)).digest("hex");
    } catch {
      return "mock-hash";
    }
  }

  function _getArtifactHash(filePath: string): string | null {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      const row = db.prepare("SELECT hash FROM artifact_hashes WHERE file_path=?").get(filePath) as { hash: string } | undefined;
      return row ? row.hash : null;
    } finally { db.close(); }
  }

  function _upsertArtifactHash(filePath: string, hash: string): void {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT INTO artifact_hashes (file_path, hash) VALUES (?, ?) ON CONFLICT(file_path) DO UPDATE SET hash=?")
        .run(filePath, hash, hash);
    } finally { db.close(); }
  }

  function _deleteArtifactMessages(convId: string, role: string): void {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("DELETE FROM messages WHERE conversation_id=? AND role=?").run(convId, role);
    } finally { db.close(); }
  }

  function _insertArtifactMessage(convId: string, lineNum: number, role: string, content: string, topicIds: string): void {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT INTO messages (conversation_id, line_number, role, content, topic_id) VALUES (?, ?, ?, ?, ?)")
        .run(convId, lineNum, role, content, topicIds);
    } finally { db.close(); }
  }

  function _upsertArtifactTopic(projectUuid: string, topicId: string, summary: string): void {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT INTO project_topics (uuid, topic_id, summary, source) VALUES (?, ?, ?, 'artifact') ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?")
        .run(projectUuid, topicId, summary, summary);
    } finally { db.close(); }
  }

  function _enqueueEvent(projectUuid: string, eventType: string, payload: string): void {
    const db = new BetterSqlite3(testDbPath.value, { timeout: 15000 });
    try {
      db.prepare("INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)")
        .run(projectUuid, eventType, payload);
    } finally { db.close(); }
  }

  function _insertFileChange(projectUuid: string, convId: string, filename: string, source: string): void {
  }

  return {
    getDbPath: () => testDbPath.value,
    checkDbExists: () => {
      try { return require("node:fs").statSync(testDbPath.value).isFile(); } catch { return false; }
    },
    getConn: () => new BetterSqlite3(testDbPath.value, { timeout: 15000 }),
    getWatermark: _getWatermark,
    getMaxLineNumber: _getMaxLineNumber,
    insertMessage: _insertMessage,
    getMaxMessageId: _getMaxMessageId,
    getMaxMessageIdUpToLine: _getMaxMessageIdUpToLine,
    deleteMessagesAboveLine: _deleteMessagesAboveLine,
    getDecisionsByConversation: _getDecisionsByConversation,
    deleteTopicDecision: _deleteTopicDecision,
    getMessageTimestamp: _getMessageTimestamp,
    deleteDecisionsByConversationAfter: _deleteDecisionsByConversationAfter,
    deletePendingEvents: _deletePendingEvents,
    updateWatermark: _updateWatermark,
    ensureWatermark: _ensureWatermark,
    formatTimestamp: (ts: string) => ts,
    insertDecision: _insertDecision,
    decisionExists: _decisionExists,
    supersedeUnconfirmed: _supersedeUnconfirmed,
    getOpenTopic: _getOpenTopic,
    getTopicFiles: _getTopicFiles,
    updateTopicFiles: _updateTopicFiles,
    upsertTopic: _upsertTopic,
    backfillMessageTopicIds: () => {},
    calculateFactualConfidence: () => 1.0,
    validateIdInheritance: () => {},
    calculateMd5: _calculateMd5,
    getArtifactHash: _getArtifactHash,
    upsertArtifactHash: _upsertArtifactHash,
    deleteArtifactMessages: _deleteArtifactMessages,
    insertArtifactMessage: _insertArtifactMessage,
    upsertArtifactTopic: _upsertArtifactTopic,
    enqueueEvent: _enqueueEvent,
    insertFileChange: _insertFileChange,
    getAllProjectUuids: (_conn?: Database) => ["proj-1"] as string[],
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
    getFilesByTopic: () => [],
    getDecisionsByFile: () => [],
    getProjectUuidByConv: () => null,
    watermarkExists: () => false,
    getRuntimeHookValue: () => null,
    setRuntimeHookValue: () => {},
    deleteRuntimeHookValue: () => {},
    trimRuntimeHookStates: () => {},
    getHookState: () => null,
    setHookState: () => {},
    deleteHookState: () => {},
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

import * as extractDecisions from "../src/sidecar/extract-decisions";
import * as warmStorageSync from "../src/sidecar/warm-storage-sync";
import * as syncArtifacts from "../src/sidecar/sync-artifacts";
import * as compactorMod from "../src/sidecar/compactor";
import * as scanSessions from "../src/sidecar/scan-sessions";
import * as sidecarLock from "../src/sidecar/sidecar-lock";
import * as checkApproval from "../src/sidecar/check-approval";
import * as consumeEvents from "../src/sidecar/consume-events";
import * as sessionGc from "../src/maintenance/session-gc";
import * as topicGc from "../src/maintenance/topic-gc";
import * as agentapi from "../src/bridge/agentapi";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_topics (
      uuid TEXT NOT NULL, topic_id TEXT NOT NULL, status TEXT DEFAULT 'open',
      summary TEXT, compression_confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'auto', last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      associated_files TEXT DEFAULT '[]', referenced_files TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (uuid, topic_id));
  CREATE TABLE IF NOT EXISTS topic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
      topic_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      decision TEXT NOT NULL, rationale TEXT NOT NULL,
      evidence_msg_ids TEXT, user_confirmed INTEGER DEFAULT 0,
      decision_type TEXT DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS watermarks (
      project_uuid TEXT NOT NULL, conversation_id TEXT NOT NULL,
      last_msg_id INTEGER DEFAULT 0,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_uuid, conversation_id));
  CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
      line_number INTEGER NOT NULL, timestamp TIMESTAMP, role TEXT,
      content TEXT, topic_id TEXT,
      UNIQUE(conversation_id, line_number));
  CREATE TABLE IF NOT EXISTS remora_event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT, status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS artifact_hashes (
      file_path TEXT PRIMARY KEY, hash TEXT NOT NULL,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
`;

function createRemoraFileDb(dbPath: string): Database.Database {
  const conn = new Database(dbPath, { timeout: 15000 });
  conn.exec(SCHEMA);
  return conn;
}

function createConvDbWithSteps(dbPath: string, stepCount: number): void {
  const conn = new Database(dbPath, { timeout: 15000 });
  conn.exec("CREATE TABLE steps (idx INTEGER)");
  for (let i = 0; i < stepCount; i++) {
    conn.prepare("INSERT INTO steps (idx) VALUES (?)").run(i);
  }
  conn.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  mockCdalmDbPathRef.value = "/nonexistent/conv.db";
  mockSendMessage.mockReset();
  mockCreateConversation.mockReset();
  mockCdalmGetMaxStepIndex.mockReset();
  mockCdalmStreamForward.mockReset();
  mockCdalmStreamReverse.mockReset();
  mockCdalmGetLatestPlannerResponse.mockReset();
  mockCdalmGetDbMtime.mockReset();
  mockIsSubagentSession.mockReset();
  mockExtractSubagentReport.mockReset();
  mockGetActiveConversations.mockReset();
  mockLoadExcludedIds.mockReset();
  mockSaveExcludedIds.mockReset();

  mockCdalmGetMaxStepIndex.mockReturnValue(0);
  mockCdalmGetLatestPlannerResponse.mockReturnValue(null);
  mockCdalmGetDbMtime.mockReturnValue(0);
  mockCdalmStreamForward.mockReturnValue((function* () {})());
  mockCdalmStreamReverse.mockReturnValue((function* () {})());
  mockIsSubagentSession.mockReturnValue(false);
  mockExtractSubagentReport.mockReturnValue({ changedFiles: [], referencedFiles: [] });
  mockGetActiveConversations.mockReturnValue([]);
  mockLoadExcludedIds.mockReturnValue(new Set());
});

afterEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  }
  if (fs.existsSync(TEST_DATA_DIR)) {
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  }
  vi.clearAllMocks();
});

// ============================================================
// getOrCreateConversation
// ============================================================

describe("getOrCreateConversation", () => {
  const MARKER_FILE = path.join(TEST_DATA_DIR, "compactor_conversation_id.txt");

  it("creates new conversation when no marker", () => {
    mockCreateConversation.mockReturnValue({
      response: {
        newConversation: {
          reply: "Hello from new conv",
          conversationId: "new-conv-uuid",
        },
      },
    });

    const result = extractDecisions.getOrCreateConversation("test prompt");

    expect(result).toBe("Hello from new conv");
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(MARKER_FILE)).toBe(true);
    expect(fs.readFileSync(MARKER_FILE, "utf-8").trim()).toBe("new-conv-uuid");
  });

  it("reuses existing when under 150 steps", () => {
    fs.writeFileSync(MARKER_FILE, "existing-conv-id");

    const convDbPath = path.join(TEST_DATA_DIR, "existing-conv.db");
    createConvDbWithSteps(convDbPath, 80);
    mockCdalmDbPathRef.value = convDbPath;
    mockCdalmGetLatestPlannerResponse.mockReturnValue("LLM reply text");

    const result = extractDecisions.getOrCreateConversation("test prompt");

    expect(result).toBe("LLM reply text");
    expect(mockSendMessage).toHaveBeenCalledWith("existing-conv-id", "test prompt");
  });

  it("rollover when above 150 steps", () => {
    fs.writeFileSync(MARKER_FILE, "existing-conv-id");

    const convDbPath = path.join(TEST_DATA_DIR, "existing-conv.db");
    createConvDbWithSteps(convDbPath, 200);
    mockCdalmDbPathRef.value = convDbPath;

    mockCreateConversation.mockReturnValue({
      response: {
        newConversation: {
          reply: "New conv after rollover",
          conversationId: "new-conv-rollover",
        },
      },
    });

    const result = extractDecisions.getOrCreateConversation("test prompt");

    expect(result).toBe("New conv after rollover");
    expect(fs.existsSync(MARKER_FILE)).toBe(true);
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
  });

  it("agentapi error on send message", () => {
    fs.writeFileSync(MARKER_FILE, "existing-conv-id");

    const convDbPath = path.join(TEST_DATA_DIR, "existing-conv.db");
    createConvDbWithSteps(convDbPath, 80);
    mockCdalmDbPathRef.value = convDbPath;

    class CalledProcessError extends Error {
      stderr: string;
      constructor(stderr: string) {
        super("Command failed");
        this.stderr = stderr;
        this.name = "CalledProcessError";
      }
    }
    mockSendMessage.mockImplementation(() => {
      throw new CalledProcessError("send-message failed");
    });

    expect(() => extractDecisions.getOrCreateConversation("test prompt")).toThrow(extractDecisions.AgentApiError);
    expect(() => extractDecisions.getOrCreateConversation("test prompt")).toThrow("send-message failed");
  });

  it("agentapi error on create conversation", () => {
    class CalledProcessError extends Error {
      stderr: string;
      constructor(stderr: string) {
        super("Command failed");
        this.stderr = stderr;
        this.name = "CalledProcessError";
      }
    }
    mockCreateConversation.mockImplementation(() => {
      throw new CalledProcessError("new-conversation failed");
    });

    expect(() => extractDecisions.getOrCreateConversation("test prompt")).toThrow(extractDecisions.AgentApiError);
    expect(() => extractDecisions.getOrCreateConversation("test prompt")).toThrow("new-conversation failed");
  });
});

// ============================================================
// processSessions
// ============================================================

describe("processSessions", () => {
  let testDb: Database.Database;

  beforeEach(() => {
    createRemoraFileDb(TEST_DB_PATH).close();
    testDb = new Database(TEST_DB_PATH, { timeout: 15000 });
  });

  afterEach(() => {
    testDb.close();
  });

  it("processes sessions with valid llm output", () => {
    const llmOutput =
      '[Sync Finished: 2024-06-01 12:00:00]\n```json\n{\n  "topics": [\n    {\n      "topic_id": "t_001",\n      "summary": "Test Architecture Decision",\n      "decisions": [\n        {\n          "decision": "Use Redis for caching",\n          "rationale": "Better performance",\n          "evidence_msg_ids": [1],\n          "decision_type": "approved",\n          "user_confirmed": false,\n          "inherited_from": []\n        }\n      ]\n    }\n  ]\n}\n```';
    testDb.exec(
      "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj-uuid-1', 'conv-uuid-1', 0)"
    );

    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "proj-uuid-1", conversationId: "conv-uuid-1", dbPath: "/fake/path" },
    ]);
    vi.spyOn(warmStorageSync, "readIncrementalLogs").mockReturnValue(["Some conversation content", 10, 5]);
    mockCreateConversation.mockReturnValue({
      response: {
        newConversation: {
          reply: llmOutput,
          conversationId: "new-conv-for-test",
        },
      },
    });

    const startTime = Date.now() / 1000 - 10;
    extractDecisions.processSessions(startTime);

    const topics = testDb.prepare("SELECT * FROM project_topics WHERE uuid='proj-uuid-1'").all() as any[];
    expect(topics.length).toBe(1);
    expect(topics[0].topic_id).toBe("t_001");

    const decisions = testDb.prepare("SELECT * FROM topic_decisions WHERE project_uuid='proj-uuid-1'").all() as any[];
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision).toBe("Use Redis for caching");

    const watermarks = testDb.prepare("SELECT * FROM watermarks WHERE project_uuid='proj-uuid-1'").all() as any[];
    expect(watermarks.length).toBe(1);
    expect(watermarks[0].last_msg_id).toBe(10);
  });

  it("skips session with empty key content", () => {
    testDb.exec(
      "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj-uuid-1', 'conv-uuid-1', 0)"
    );

    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "proj-uuid-1", conversationId: "conv-uuid-1", dbPath: "/fake/path" },
    ]);
    vi.spyOn(warmStorageSync, "readIncrementalLogs").mockReturnValue(["   ", 10, 5]);

    extractDecisions.processSessions(Date.now() / 1000);

    const topics = testDb.prepare("SELECT * FROM project_topics").all() as any[];
    expect(topics.length).toBe(0);

    const watermarks = testDb.prepare("SELECT * FROM watermarks").all() as any[];
    expect(watermarks.length).toBe(1);
    expect(watermarks[0].last_msg_id).toBe(10);
  });

  it("max execution time exceeded stops early", () => {
    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "p1", conversationId: "c1", dbPath: "/fake" },
      { projectUuid: "p2", conversationId: "c2", dbPath: "/fake" },
    ]);
    const spyRead = vi.spyOn(warmStorageSync, "readIncrementalLogs");

    extractDecisions.processSessions(0);

    expect(spyRead).not.toHaveBeenCalled();
  });

  it("handles json decode error gracefully", () => {
    testDb.exec(
      "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj-uuid-1', 'conv-uuid-1', 0)"
    );

    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "proj-uuid-1", conversationId: "conv-uuid-1", dbPath: "/fake/path" },
    ]);
    vi.spyOn(warmStorageSync, "readIncrementalLogs").mockReturnValue(["some content", 10, 5]);
    mockCreateConversation.mockReturnValue({
      response: {
        newConversation: {
          reply: "Not JSON at all",
          conversationId: "new-conv-not-json",
        },
      },
    });

    extractDecisions.processSessions(Date.now() / 1000);

    const topics = testDb.prepare("SELECT * FROM project_topics").all() as any[];
    expect(topics.length).toBe(0);

    const watermarks = testDb.prepare("SELECT * FROM watermarks").all() as any[];
    expect(watermarks.length).toBe(1);
  });

  it("subagent session skips llm extraction", () => {
    testDb.exec(
      "INSERT INTO project_topics (uuid, topic_id, status, summary, associated_files, referenced_files) VALUES ('proj-uuid-1', 't_active', 'open', 'test', '[]', '[]')"
    );
    testDb.exec(
      "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj-uuid-1', 'conv-uuid-1', 0)"
    );

    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "proj-uuid-1", conversationId: "conv-uuid-1", dbPath: "/fake/path" },
    ]);
    vi.spyOn(warmStorageSync, "readIncrementalLogs").mockReturnValue(["some content", 10, 5]);
    mockIsSubagentSession.mockReturnValue(true);
    mockExtractSubagentReport.mockReturnValue({ changedFiles: [], referencedFiles: [] });

    extractDecisions.processSessions(Date.now() / 1000);

    // getOrCreateConversation is never called because subagent branch continues early
    expect(mockCreateConversation).not.toHaveBeenCalled();

    const watermarks = testDb.prepare("SELECT * FROM watermarks").all() as any[];
    expect(watermarks.length).toBe(1);
    expect(watermarks[0].last_msg_id).toBe(10);
  });
});

// ============================================================
// readIncrementalLogs (direct tests)
// ============================================================

describe("readIncrementalLogs", () => {
  let testDb: Database.Database;

  beforeEach(() => {
    createRemoraFileDb(TEST_DB_PATH).close();
    testDb = new Database(TEST_DB_PATH, { timeout: 15000 });
    // Restore if spied on by processSessions tests
    if (vi.isMockFunction(warmStorageSync.readIncrementalLogs)) {
      vi.mocked(warmStorageSync.readIncrementalLogs).mockRestore();
    }
    mockIsSubagentSession.mockReturnValue(false);
    mockCdalmGetMaxStepIndex.mockReturnValue(0);
    mockCdalmStreamForward.mockReturnValue((function* () {})());
    mockCdalmStreamReverse.mockReturnValue((function* () {})());
  });

  afterEach(() => {
    testDb.close();
  });

  it("no watermark row creates one", () => {
    const session = { projectUuid: "proj-1", conversationId: "conv-1" };

    const [keyContent, currentMsgId, lastMsgId] = warmStorageSync.readIncrementalLogs(testDb, session);

    const watermarks = testDb.prepare(
      "SELECT * FROM watermarks WHERE project_uuid='proj-1' AND conversation_id='conv-1'"
    ).all() as any[];
    expect(watermarks.length).toBe(1);
    expect(watermarks[0].last_msg_id).toBe(0);
    expect(keyContent).toBe("");
    expect(currentMsgId).toBe(0);
    expect(lastMsgId).toBe(0);
  });

  it("normal incremental read inserts messages", () => {
    const steps = [
      { step_index: 1, type: "USER_INPUT", content: "Hello world", role: "user", timestamp: "2024-01-01T00:00:00Z" },
      { step_index: 2, type: "PLANNER_RESPONSE", content: "Hi there", role: "model", timestamp: "2024-01-01T00:00:01Z" },
      { step_index: 3, type: "TOOL_USE", content: "{}", role: "tool", timestamp: "2024-01-01T00:00:02Z" },
    ];

    mockCdalmGetMaxStepIndex.mockReturnValue(10);
    mockCdalmStreamForward.mockImplementation(() => (function* () { for (const s of steps) yield s; })());

    const session = { projectUuid: "proj-1", conversationId: "conv-1" };

    const [keyContent, currentMsgId] = warmStorageSync.readIncrementalLogs(testDb, session);

    const messages = testDb.prepare("SELECT * FROM messages WHERE conversation_id='conv-1'").all() as any[];
    expect(messages.length).toBe(3);

    expect(keyContent).toContain("Hello world");
    expect(keyContent).toContain("Hi there");
    expect(keyContent).toContain("[msg_1]");
    expect(keyContent).toContain("[msg_2]");
    expect(currentMsgId).toBeGreaterThan(0);
  });

  it("max prompt length exceeded stops collecting", () => {
    const steps: Array<Record<string, any>> = [];
    for (let i = 1; i < 20; i++) {
      steps.push({
        step_index: i, type: "USER_INPUT", content: "X".repeat(200),
        role: "user", timestamp: "2024-01-01T00:00:00Z",
      });
    }

    mockCdalmGetMaxStepIndex.mockReturnValue(100);
    mockCdalmStreamForward.mockImplementation(() => (function* () { for (const s of steps) yield s; })());

    const session = { projectUuid: "proj-1", conversationId: "conv-1" };

    const [keyContent] = warmStorageSync.readIncrementalLogs(testDb, session);

    const messages = testDb.prepare("SELECT * FROM messages WHERE conversation_id='conv-1'").all() as any[];
    expect(messages.length).toBe(19);
    expect(keyContent.length).toBeGreaterThan(0);
  });

  it("undo rollback detected triggers cleanup", () => {
    testDb.exec(
      "INSERT INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES ('proj-1', 'conv-1', 100)"
    );
    testDb.exec(
      "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) VALUES (1, 'conv-1', 1, '2024-01-01', 'user', 'msg 1')"
    );
    testDb.exec(
      "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) VALUES (2, 'conv-1', 2, '2024-01-01', 'user', 'msg 2')"
    );
    testDb.exec(
      "INSERT INTO messages (id, conversation_id, line_number, timestamp, role, content) VALUES (3, 'conv-1', 5, '2024-01-01', 'user', 'msg 5')"
    );

    mockCdalmGetMaxStepIndex.mockReturnValue(2);
    mockCdalmStreamForward.mockReturnValue((function* () {})());

    const session = { projectUuid: "proj-1", conversationId: "conv-1" };

    warmStorageSync.readIncrementalLogs(testDb, session);

    const messages = testDb.prepare("SELECT * FROM messages WHERE conversation_id='conv-1'").all() as any[];
    expect(messages.length).toBe(0);
  });

  it("subagent filters non relevant steps", () => {
    mockIsSubagentSession.mockReturnValue(true);

    const steps = [
      { step_index: 1, type: "USER_INPUT", content: "user request", role: "user", timestamp: "2024-01-01T00:00:00Z" },
      { step_index: 2, type: "TOOL_USE", content: "{}", role: "tool", timestamp: "2024-01-01T00:00:01Z" },
      { step_index: 3, type: "PLANNER_RESPONSE", content: "model answer", role: "model", timestamp: "2024-01-01T00:00:02Z" },
    ];

    mockCdalmGetMaxStepIndex.mockReturnValue(10);
    mockCdalmStreamForward.mockImplementation(() => (function* () { for (const s of steps) yield s; })());

    const session = { projectUuid: "proj-1", conversationId: "conv-1" };

    const [keyContent] = warmStorageSync.readIncrementalLogs(testDb, session);

    const messages = testDb.prepare("SELECT * FROM messages WHERE conversation_id='conv-1'").all() as any[];
    expect(messages.length).toBe(2);

    expect(keyContent).toContain("user request");
    expect(keyContent).toContain("model answer");

    expect(keyContent).toContain("[msg_1]");
    expect(keyContent).toContain("[msg_2]");
  });
});

// ============================================================
// scanAndIngestArtifacts
// ============================================================

describe("scanAndIngestArtifacts", () => {
  let artifactsDbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts_test_"));
    artifactsDbPath = path.join(tmpDir, "test.db");
    const conn = new Database(artifactsDbPath, { timeout: 15000 });
    conn.exec(`
      CREATE TABLE IF NOT EXISTS artifact_hashes (
          file_path TEXT PRIMARY KEY, hash TEXT NOT NULL,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
          line_number INTEGER NOT NULL, timestamp TIMESTAMP, role TEXT,
          content TEXT, topic_id TEXT,
          UNIQUE(conversation_id, line_number));
      CREATE TABLE IF NOT EXISTS remora_event_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_uuid TEXT NOT NULL,
          event_type TEXT NOT NULL, payload TEXT, status TEXT DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS project_topics (
          uuid TEXT NOT NULL, topic_id TEXT NOT NULL, status TEXT DEFAULT 'open',
          summary TEXT, compression_confidence REAL DEFAULT 1.0,
          source TEXT DEFAULT 'auto', last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          associated_files TEXT DEFAULT '[]', referenced_files TEXT DEFAULT '[]',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (uuid, topic_id));
    `);
    conn.close();
    testDbPath.value = artifactsDbPath;
  });

  afterEach(() => {
    testDbPath.value = TEST_DB_PATH;
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no artifact dir returns early", () => {
    const context: Record<string, unknown> = { artifactDirectoryPath: "" };
    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "proj-1");
    syncArtifacts.scanAndIngestArtifacts(context);
    vi.unstubAllEnvs();
  });

  it("unchanged file hash match skipped", () => {
    const artifactDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactDir);
    const planFile = path.join(artifactDir, "implementation_plan.md");
    fs.writeFileSync(planFile, "# Test Plan Content");
    const crypto = require("node:crypto");
    const fileHash = crypto.createHash("md5").update(fs.readFileSync(planFile)).digest("hex");

    const conn = new Database(artifactsDbPath, { timeout: 15000 });
    conn.prepare("INSERT INTO artifact_hashes (file_path, hash) VALUES (?, ?)").run(planFile, fileHash);
    conn.close();

    const context: Record<string, unknown> = { artifactDirectoryPath: artifactDir };

    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "proj-1");
    syncArtifacts.scanAndIngestArtifacts(context);
    vi.unstubAllEnvs();

    const conn2 = new Database(artifactsDbPath, { timeout: 15000 });
    const messages = conn2.prepare("SELECT * FROM messages").all() as any[];
    const events = conn2.prepare("SELECT * FROM remora_event_queue").all() as any[];
    conn2.close();
    expect(messages.length).toBe(0);
    expect(events.length).toBe(0);
  });

  it("changed file deletes old inserts new queues event", () => {
    const artifactDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactDir);
    const walkthroughFile = path.join(artifactDir, "walkthrough.md");
    fs.writeFileSync(walkthroughFile, "# New Walkthrough Content");

    const conn = new Database(artifactsDbPath, { timeout: 15000 });
    conn.prepare("INSERT INTO artifact_hashes (file_path, hash) VALUES (?, ?)").run(walkthroughFile, "old_different_hash");
    conn.prepare(
      "INSERT INTO messages (conversation_id, line_number, timestamp, role, content) VALUES ('artifact_sync_proj-1', 999901, datetime('now'), 'walkthrough.md', '# Old Content')"
    ).run();
    conn.close();

    const context: Record<string, unknown> = {
      artifactDirectoryPath: artifactDir,
      transcriptPath: "/some/path/brain/conv-uuid-test/something",
    };

    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "proj-1");
    syncArtifacts.scanAndIngestArtifacts(context);
    vi.unstubAllEnvs();

    const conn2 = new Database(artifactsDbPath, { timeout: 15000 });
    const messages = conn2.prepare("SELECT * FROM messages WHERE conversation_id='artifact_sync_proj-1'").all() as any[];
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain("# New Walkthrough Content");

    const events = conn2.prepare("SELECT * FROM remora_event_queue").all() as any[];
    conn2.close();
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("walkthrough_sync");
  });

  it("plan file no event queue", () => {
    const artifactDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactDir);
    const planFile = path.join(artifactDir, "implementation_plan.md");
    fs.writeFileSync(planFile, "# Plan Content Here");

    const context: Record<string, unknown> = {
      artifactDirectoryPath: artifactDir,
      transcriptPath: "",
    };

    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "proj-1");
    syncArtifacts.scanAndIngestArtifacts(context);
    vi.unstubAllEnvs();

    const conn = new Database(artifactsDbPath, { timeout: 15000 });
    const events = conn.prepare("SELECT * FROM remora_event_queue").all() as any[];
    const messages = conn.prepare(
      "SELECT * FROM messages WHERE conversation_id='artifact_sync_proj-1' AND role='implementation_plan.md'"
    ).all() as any[];
    conn.close();
    expect(events.length).toBe(0);
    expect(messages.length).toBe(1);
  });
});

// ============================================================
// getActiveConversations
// ============================================================

const UUID_1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1";
const UUID_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2";

describe("getActiveConversations", () => {
  it("returns shuffled list", () => {
    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "project-1", conversationId: UUID_1, dbPath: "/fake/test.db" },
      { projectUuid: "project-1", conversationId: UUID_2, dbPath: "/fake/test.db" },
    ]);

    const result = mockGetActiveConversations();
    expect(result.length).toBe(2);
    expect(result[0].projectUuid).toBe("project-1");
  });

  it("excludes managed ids", () => {
    mockGetActiveConversations.mockReturnValue([]);

    const result = mockGetActiveConversations();
    expect(result.length).toBe(0);
  });

  it("skips non uuid directories", () => {
    mockGetActiveConversations.mockReturnValue([
      { projectUuid: "project-1", conversationId: UUID_1, dbPath: "/fake/test.db" },
    ]);

    const result = mockGetActiveConversations();
    expect(result.length).toBe(1);
  });

  it("no brain dir returns empty", () => {
    mockGetActiveConversations.mockReturnValue([]);

    const result = mockGetActiveConversations();
    expect(result).toEqual([]);
  });
});

// ============================================================
// getProjectId
// ============================================================

describe("getProjectId", () => {
  it("returns default on failure", () => {
    const result = agentapi.getProjectId("any-conv-id");
    expect(result).toBe("11111111-1111-1111-1111-111111111111");
  });
});

// ============================================================
// compactor main()
// ============================================================

describe("compactor main", () => {
  let originalExit: typeof process.exit;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalExit = process.exit;
    originalStderrWrite = process.stderr.write;
    process.exit = vi.fn() as any;
    process.stderr.write = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
  });

  it("event driven mode reads stdin calls scan and ingest", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "compactor", "--event-driven"]);

    const mockJson = JSON.stringify({ artifactDirectoryPath: "/test/artifacts" });
    const stdinFile = path.join(TEST_DATA_DIR, "stdin.json");
    fs.writeFileSync(stdinFile, mockJson);
    const fd = fs.openSync(stdinFile, "r");
    Object.defineProperty(process.stdin, "fd", { value: fd, configurable: true, writable: true });
    const spyScan = vi.spyOn(syncArtifacts, "scanAndIngestArtifacts");

    compactorMod.main();

    expect(spyScan).toHaveBeenCalledWith({ artifactDirectoryPath: "/test/artifacts" });
    try { fs.closeSync(fd); } catch {}
  });

  it("event driven mode catches exceptions", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "compactor", "--event-driven"]);

    Object.defineProperty(process.stdin, "fd", { value: -1, configurable: true, writable: true });

    compactorMod.main();
  });

  it("cron mode runs full pipeline", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "compactor", "--cron"]);

    const spyLock = vi.spyOn(sidecarLock, "acquireLock");
    const spyRelease = vi.spyOn(sidecarLock, "releaseLock");
    const spyPrune = vi.spyOn(sessionGc, "pruneExpiredWatermarks");
    const spyCheck = vi.spyOn(checkApproval, "checkPlanApproval");
    const spyConsume = vi.spyOn(consumeEvents, "consumeEventQueue");
    const spyGc = vi.spyOn(topicGc, "runGarbageCollection");

    compactorMod.main();

    expect(spyLock).toHaveBeenCalledTimes(1);
    expect(spyPrune).toHaveBeenCalledTimes(1);
    expect(spyCheck).toHaveBeenCalledWith("proj-1", expect.any(Object));
    expect(spyConsume).toHaveBeenCalledTimes(1);
    expect(spyGc).toHaveBeenCalledTimes(1);
    expect(spyRelease).toHaveBeenCalledTimes(1);
  });

  it("cron mode handles agentapi error", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "compactor", "--cron"]);

    const spyRelease = vi.spyOn(sidecarLock, "releaseLock");

    vi.spyOn(extractDecisions, "processSessions").mockImplementation(() => {
      throw new extractDecisions.AgentApiError("API failure");
    });

    compactorMod.main();

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(spyRelease).toHaveBeenCalled();
  });

  it("cron mode handles generic exception", () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "compactor", "--cron"]);

    const spyRelease = vi.spyOn(sidecarLock, "releaseLock");

    vi.spyOn(extractDecisions, "processSessions").mockImplementation(() => {
      throw new Error("unexpected");
    });

    compactorMod.main();

    expect(spyRelease).toHaveBeenCalledTimes(1);
  });
});
