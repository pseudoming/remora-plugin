import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let TEST_ROOT: string;
let TEST_DB_PATH: string;

vi.mock("@remora/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@remora/core")>();
  return {
    ...actual,
    getLatestNonUserMessages: (...args: any[]) => {
      // runAudit calls with (conn, convId, 5) but signature is (convId, limit)
      // args[0]=Database (if 3 args) or string (if 2 args). Remap accordingly.
      const convId: string = typeof args[0] === "string" ? args[0] : args[1];
      const limit: number = typeof args[1] === "number" ? args[1] : 5;

      const dbPath = process.env.REMORA_DB_PATH || "";
      if (!dbPath || !fs.existsSync(dbPath)) return [];

      try {
        const db = new Database(dbPath, { timeout: 5000 });
        try {
          return db
            .prepare(
              `SELECT timestamp, role, content FROM messages
               WHERE conversation_id = ?
               AND role NOT IN ('USER','USER_INPUT','USER_EXPLICIT','user')
               AND content IS NOT NULL AND content != ''
               ORDER BY line_number DESC, id DESC
               LIMIT ?`
            )
            .all(convId, limit) as Array<{
            timestamp: string;
            role: string;
            content: string;
          }>;
        } finally {
          db.close();
        }
      } catch (e) {
        console.error(`getLatestNonUserMessages failed: ${e}`);
        return [];
      }
    },
    getDbPath: () => process.env.REMORA_DB_PATH || "",
    getConn: () => new Database(process.env.REMORA_DB_PATH || "", { timeout: 5000 }),
  };
});

beforeEach(() => {
  TEST_ROOT = path.join(os.tmpdir(), `test_remora_liveness_${Date.now()}`);
  TEST_DB_PATH = path.join(TEST_ROOT, "test_remora_memory.db");
  process.env.REMORA_DB_PATH = TEST_DB_PATH;
});

import { parseSqliteTimestamp } from "@remora/core";
import { ProgressSentinel } from "../src/bridge/progress";
import { runAudit, main } from "../src/sandbox/check-subagents-liveness";
import { ConversationDataAccessLayer } from "../src/bridge/conversation";

const MESSAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    timestamp TIMESTAMP,
    role TEXT,
    content TEXT,
    topic_id TEXT,
    UNIQUE(conversation_id, line_number)
  )
`;

const WATERMARKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS watermarks (
    conversation_id TEXT PRIMARY KEY,
    project_uuid TEXT NOT NULL
  )
`;

const PROJECT_TOPICS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_topics (
    uuid TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    created_at TIMESTAMP,
    status TEXT,
    PRIMARY KEY (uuid, topic_id)
  )
`;

const RUNTIME_HOOK_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runtime_hook_state (
    session_id TEXT NOT NULL,
    turn_idx INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (session_id, turn_idx, key)
  )
`;

function insertMessage(
  convId: string,
  lineNumber: number,
  role: string,
  content: string | null,
  timestamp: string | null = null
): void {
  const db = new Database(TEST_DB_PATH, { timeout: 15000 });
  if (timestamp === null) {
    db.prepare(
      "INSERT INTO messages (conversation_id, line_number, role, content) VALUES (?, ?, ?, ?)"
    ).run(convId, lineNumber, role, content);
  } else {
    db.prepare(
      "INSERT INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)"
    ).run(convId, lineNumber, timestamp, role, content);
  }
  db.close();
}

function initDb(schemas: string[] = [MESSAGES_SCHEMA]): void {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  const db = new Database(TEST_DB_PATH, { timeout: 15000 });
  for (const s of schemas) {
    db.exec(s);
  }
  db.close();
}

function makeProgressDir(convId: string): string {
  const hd = process.env.HOME!;
  const progressDir = path.join(hd, ".gemini", "antigravity", "brain", convId, "scratch");
  fs.mkdirSync(progressDir, { recursive: true });
  return path.join(progressDir, "progress.json");
}

function writeProgress(convId: string, data: Record<string, unknown>): string {
  const progressPath = makeProgressDir(convId);
  fs.writeFileSync(progressPath, JSON.stringify(data), "utf-8");
  return progressPath;
}

describe("test_subagent_liveness_and_progress", () => {
  beforeEach(() => {
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    process.env.HOME = TEST_ROOT;
    process.env.REMORA_DB_PATH = TEST_DB_PATH;
    initDb([MESSAGES_SCHEMA]);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  });

  describe("ProgressSentinel.update", () => {
    it("test_progress_sentinel_update", () => {
      const convId = "test_conv_123";
      const transcriptPath = path.join(
        TEST_ROOT, ".gemini", "antigravity", "brain", convId,
        ".system_generated", "transcript.jsonl"
      );

      const success = ProgressSentinel.update(transcriptPath, "running", 5, "Initial test step");
      expect(success).toBe(true);

      const progressFile = path.join(
        TEST_ROOT, ".gemini", "antigravity", "brain", convId, "scratch", "progress.json"
      );
      expect(fs.existsSync(progressFile)).toBe(true);

      const data = JSON.parse(fs.readFileSync(progressFile, "utf-8"));
      expect(data["status"]).toBe("running");
      expect(data["step_index"]).toBe(5);
      expect(data["details"]).toBe("Initial test step");
      expect(data["last_updated_at"]).toBeDefined();

      const success2 = ProgressSentinel.update(transcriptPath, "blocked", undefined, "Encountered error");
      expect(success2).toBe(true);

      const data2 = JSON.parse(fs.readFileSync(progressFile, "utf-8"));
      expect(data2["status"]).toBe("blocked");
      expect(data2["step_index"]).toBe(5);
      expect(data2["details"]).toBe("Encountered error");
    });
  });

  describe("runAudit", () => {
    it("test_liveness_completed", () => {
      const convId = "conv_completed";
      writeProgress(convId, {
        status: "completed",
        last_updated_at: Math.floor(Date.now() / 1000) - 150,
        step_index: 10,
        details: "Done",
      });

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
      expect(res["reason"]).toContain("completed");
    });

    it("test_liveness_blocked", () => {
      const convId = "conv_blocked";
      writeProgress(convId, {
        status: "blocked",
        last_updated_at: Math.floor(Date.now() / 1000) - 10,
        step_index: 2,
        details: "Blocked by lock",
      });

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
      expect(res["reason"]).toContain("blocked");
    });

    it("test_liveness_timeout_progress", () => {
      const convId = "conv_timeout";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 150,
        step_index: 3,
        details: "Long step",
      });

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
      expect(res["reason"]).toContain("Liveness timeout");
    });

    it("test_liveness_active_progress", () => {
      const convId = "conv_active";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 30,
        step_index: 3,
        details: "Step normal",
      });

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });

    it("test_liveness_db_timeout", () => {
      const convId = "conv_db_timeout";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 150,
        step_index: 1,
        details: "Running test",
      });

      const expiredUtcStr = new Date(Date.now() - 150000).toISOString().replace("T", " ").replace("Z", "");
      insertMessage(convId, 1, "model", "Old subagent response", expiredUtcStr);

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
      expect(res["reason"]).toContain("Liveness timeout");
    });

    it("test_liveness_db_active", () => {
      const convId = "conv_db_active";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 150,
        step_index: 1,
        details: "Running test",
      });

      const freshUtcStr = new Date(Date.now() - 30000).toISOString().replace("T", " ").replace("Z", "");
      insertMessage(convId, 1, "model", "Fresh subagent response", freshUtcStr);

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });

    it("test_liveness_no_signals", () => {
      const convId = "conv_no_signals";

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
      expect(res["reason"]).toContain("No liveness signals yet");
    });

    it("test_progress_corrupted", () => {
      const convId = "conv_corrupted";
      const pp = makeProgressDir(convId);
      fs.writeFileSync(pp, "not valid json");

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
    });

    it("test_db_blocked_keyword", () => {
      const convId = "conv_db_blocked";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 10,
      });

      const nowStr = new Date().toISOString().replace("T", " ").replace("Z", "");
      insertMessage(convId, 1, "tool", "permission_denied: cannot execute", nowStr);

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
      expect(res["reason"]).toContain("Fatal block");
    });

    it("test_db_query_exception", () => {
      initDb([MESSAGES_SCHEMA]);
      const convId = "conv_db_exc";
      const db = new Database(TEST_DB_PATH, { timeout: 15000 });
      db.exec("DROP TABLE messages");
      db.close();

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });

    it("test_progress_invalid_timestamp", () => {
      const convId = "conv_invalid_ts";
      writeProgress(convId, {
        status: "running",
        last_updated_at: "invalid",
      });

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("dead");
      expect(res["reason"]).toContain("no valid timestamp");
    });

    it("test_heavy_task_threshold", () => {
      const convId = "conv_heavy";
      writeProgress(convId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 150,
        details: "run_command: building project",
      });

      initDb([MESSAGES_SCHEMA]);
      const expiredUtcStr = new Date(Date.now() - 150000).toISOString().replace("T", " ").replace("Z", "");
      insertMessage(convId, 1, "run_command", "building project", expiredUtcStr);

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });

    it("test_db_not_exists", () => {
      try { fs.unlinkSync(TEST_DB_PATH); } catch {}
      const convId = "conv_no_db";

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });

    it("test_glob_worktree_short_id_match", () => {
      const convId = "conv_glob_match_12345";
      const shortId = convId.slice(0, 8);

      const worktreeDir = path.join(
        TEST_ROOT, ".gemini", "antigravity", "brain", "some_parent",
        ".system_generated", "worktrees", `worktree_${shortId}`, "scratch"
      );
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, "progress.json"),
        JSON.stringify({ status: "completed", last_updated_at: Math.floor(Date.now() / 1000) - 10 })
      );

      const res = runAudit(convId);
      expect(res["liveness"]).toBe("alive");
    });
  });

  describe("main — hook mode", () => {
    it("test_liveness_hook_mode_auto_detect", () => {
      const parentConvId = "parent_conv_123";
      const subConvId = "eb6fe685-f656-4edd-83f9-1fe05d851143";

      initDb([MESSAGES_SCHEMA, RUNTIME_HOOK_STATE_SCHEMA]);

      writeProgress(subConvId, {
        status: "running",
        last_updated_at: Math.floor(Date.now() / 1000) - 30,
        step_index: 1,
        details: "Active step",
      });

      const mockStream = vi.fn(function*(this: any, _startIdx?: number) {
        yield {
          type: "SYSTEM",
          content: `Launched subagent with conversationId: ${subConvId}`,
          step_index: 0,
        } as Record<string, unknown>;
      });

      vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(mockStream);
      vi.spyOn(ConversationDataAccessLayer.prototype, "getCurrentTurnIdx").mockReturnValue(0);
      vi.spyOn(ConversationDataAccessLayer.prototype, "getLatestUserMessage").mockReturnValue("定时器 heartbeat");
      vi.spyOn(ConversationDataAccessLayer.prototype, "getLatestPlannerResponse").mockReturnValue("");

      const context = {
        transcriptPath: `/home/agent/.gemini/antigravity/brain/${parentConvId}/.system_generated/logs/transcript.jsonl`,
      };

      const res = main(context);
      expect(res).toBeDefined();
      expect(res["decision"]).toBeDefined();

      vi.restoreAllMocks();
    });

    it("test_liveness_with_watermarks_and_timeframe", () => {
      const parentConvId = "parent_conv_123";
      const projectUuid = "proj_xyz";
      const subActive = "11111111-1111-1111-1111-111111111111";
      const subStale = "22222222-2222-2222-2222-222222222222";
      const subWrongProject = "33333333-3333-3333-3333-333333333333";

      initDb([MESSAGES_SCHEMA, WATERMARKS_SCHEMA, PROJECT_TOPICS_SCHEMA, RUNTIME_HOOK_STATE_SCHEMA]);

      const db = new Database(TEST_DB_PATH, { timeout: 15000 });
      db.prepare("INSERT OR REPLACE INTO watermarks (conversation_id, project_uuid) VALUES (?, ?)").run(parentConvId, projectUuid);
      db.prepare("INSERT OR REPLACE INTO watermarks (conversation_id, project_uuid) VALUES (?, ?)").run(subActive, projectUuid);
      db.prepare("INSERT OR REPLACE INTO watermarks (conversation_id, project_uuid) VALUES (?, ?)").run(subStale, projectUuid);
      db.prepare("INSERT OR REPLACE INTO watermarks (conversation_id, project_uuid) VALUES (?, ?)").run(subWrongProject, "proj_other");

      const nowTs = Date.now();
      const activeTopicTsStr = new Date(nowTs - 50000).toISOString().replace("T", " ").replace("Z", "");
      db.prepare(
        "INSERT OR REPLACE INTO project_topics (uuid, topic_id, created_at, status) VALUES (?, ?, ?, ?)"
      ).run(projectUuid, "topic_1", activeTopicTsStr, "open");
      db.close();

      for (const [subId, offset] of [[subActive, 10], [subStale, 10], [subWrongProject, 10]] as Array<[string, number]>) {
        writeProgress(subId, {
          status: "running",
          last_updated_at: Math.floor(nowTs / 1000) - offset,
          step_index: 1,
          details: "Checking",
        });
      }

      const allMockSteps: Record<string, unknown>[] = [];
      for (let i = 0; i < 25; i++) {
        allMockSteps.push({
          step_index: i,
          timestamp: new Date(nowTs - 100000).toISOString().replace("T", " ").replace("Z", ""),
          content: i === 5 ? `Spawned stale subagent conversationId: ${subStale}` : `Normal step ${i}`,
        });
      }
      allMockSteps.push({
        step_index: 25,
        timestamp: new Date(nowTs - 30000).toISOString().replace("T", " ").replace("Z", ""),
        content: `Spawned active subagent conversationId: ${subActive}`,
      });
      allMockSteps.push({
        step_index: 26,
        timestamp: new Date(nowTs - 30000).toISOString().replace("T", " ").replace("Z", ""),
        content: `Spawned wrong project subagent conversationId: ${subWrongProject}`,
      });
      allMockSteps.push({
        step_index: 27,
        timestamp: new Date(nowTs - 5000).toISOString().replace("T", " ").replace("Z", ""),
        content: "Checking schedule heartbeat",
      });

      const mockStream = vi.fn(function*(this: any, _startIdx?: number) {
        for (const step of allMockSteps) {
          yield step;
        }
      });

      vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(mockStream);
      vi.spyOn(ConversationDataAccessLayer.prototype, "getCurrentTurnIdx").mockReturnValue(27);
      vi.spyOn(ConversationDataAccessLayer.prototype, "getLatestUserMessage").mockReturnValue("heartbeat check");
      vi.spyOn(ConversationDataAccessLayer.prototype, "getLatestPlannerResponse").mockReturnValue("");

      const context = {
        transcriptPath: `/home/agent/.gemini/antigravity/brain/${parentConvId}/.system_generated/logs/transcript.jsonl`,
      };

      const res = main(context);
      expect(res).toBeDefined();
      expect(res["decision"]).toBeDefined();

      vi.restoreAllMocks();
    });
  });

  describe("parseSqliteTimestamp edge cases", () => {
    it("test_parse_ts_none", () => {
      expect(parseSqliteTimestamp(null)).toBe(0.0);
      expect(parseSqliteTimestamp(undefined)).toBe(0.0);
    });

    it("test_parse_ts_numeric", () => {
      expect(parseSqliteTimestamp(12345)).toBe(12345.0);
      expect(parseSqliteTimestamp(12345.67)).toBe(12345.67);
    });

    it("test_parse_ts_unrecognized", () => {
      expect(parseSqliteTimestamp("garbage")).toBe(0.0);
    });
  });
});
