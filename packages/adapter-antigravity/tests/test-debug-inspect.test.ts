import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================
// Schema (mirrors Python test)
// ============================================================
const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_topics (
    uuid TEXT,
    topic_id TEXT,
    status TEXT DEFAULT 'open',
    summary TEXT,
    source TEXT DEFAULT 'auto',
    associated_files TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(uuid, topic_id)
);
CREATE TABLE IF NOT EXISTS topic_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_uuid TEXT,
    topic_id TEXT,
    conversation_id TEXT,
    decision TEXT,
    rationale TEXT,
    evidence_msg_ids TEXT,
    user_confirmed INTEGER DEFAULT 0,
    decision_type TEXT DEFAULT 'approved',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    mode TEXT DEFAULT 'standard',
    is_cold_start INTEGER DEFAULT 1,
    updated_at DATETIME
);
CREATE TABLE IF NOT EXISTS watermarks (
    conversation_id TEXT PRIMARY KEY,
    project_uuid TEXT,
    last_msg_id INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_uuid TEXT,
    conversation_id TEXT,
    file_name TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, file_name)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    topic_id TEXT,
    role TEXT,
    content TEXT,
    line_number INTEGER,
    timestamp DATETIME
);
`;

// ============================================================
// hoisted mocks for paths
// ============================================================
const pathsMock = vi.hoisted(() => ({
  getDataDir: vi.fn<[], string>(),
}));

vi.mock("../src/bridge/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/paths")>();
  return {
    ...actual,
    getDataDir: pathsMock.getDataDir,
  };
});

// ============================================================
// mock @remora/core to use the dynamic REMORA_DB_PATH env var
// ============================================================
vi.mock("@remora/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@remora/core")>();
  const Database = require("better-sqlite3");
  function getTestConn() {
    return new Database(process.env.REMORA_DB_PATH || "", { timeout: 5000 });
  }
  return {
    ...actual,
    getDbPath: () => process.env.REMORA_DB_PATH || "",
    getConn: () => getTestConn(),
    getTopicsByUuid: (projectUuid: string) => {
      return (actual as any).getTopicsByUuid(projectUuid);
    },
    getConfirmedDecisions: (projectUuid: string, topicId: string) => {
      const conn = getTestConn();
      try {
        const decisionRows = conn
          .prepare(
            `SELECT decision, rationale, evidence_msg_ids, decision_type
             FROM topic_decisions
             WHERE project_uuid=? AND topic_id=? AND user_confirmed=1 AND decision_type='approved'
             ORDER BY created_at ASC`
          )
          .all(projectUuid, topicId) as Array<{
          decision: string;
          rationale: string;
          evidence_msg_ids: string | null;
          decision_type: string | null;
        }>;
        if (!decisionRows.length) return [];
        return decisionRows.map((d) => {
          let evidence = "";
          if (d.evidence_msg_ids) {
            try {
              const ids: number[] = JSON.parse(d.evidence_msg_ids);
              if (ids.length > 0) {
                const placeholders = ids.map(() => "?").join(",");
                const evidenceRows = conn
                  .prepare(
                    `SELECT content FROM messages WHERE id IN (${placeholders}) ORDER BY id`
                  )
                  .all(...ids) as Array<{ content: string }>;
                evidence = evidenceRows.map((r) => r.content).join(" ");
              }
            } catch { /* pass */ }
          }
          return {
            text: d.decision + (d.rationale ? " | " + d.rationale : ""),
            evidence: evidence,
            decision_type: d.decision_type || "approved",
          };
        });
      } finally {
        conn.close();
      }
    },
    getDecisionsByFile: (projectUuid: string, fileName: string) => {
      const conn = getTestConn();
      try {
        const rows = conn
          .prepare(
            `SELECT DISTINCT td.id, td.decision, td.rationale
             FROM topic_decisions td
             JOIN file_changes fc ON fc.conversation_id = td.conversation_id
             WHERE fc.project_uuid=? AND fc.file_name=?
             ORDER BY td.created_at DESC`
          )
          .all(projectUuid, fileName) as Array<{
          id: number;
          decision: string;
          rationale: string;
        }>;
        return rows;
      } finally {
        conn.close();
      }
    },
  };
});
let tmpDir: string;
let tempDbPath: string;
let db: Database.Database;

function setupTempDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-debug-inspect-test-"));
  tempDbPath = path.join(tmpDir, "remora_memory.db");
  db = new Database(tempDbPath);
  db.exec(SCHEMA);
  db.close();

  process.env.REMORA_DB_PATH = tempDbPath;
}

function teardownTempDb() {
  delete process.env.REMORA_DB_PATH;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // pass
  }
}

function captureOutput(fn: () => void): { out: string; err: string } {
  let out = "";
  let err = "";
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    fn();
  } catch (e) {
    // rethrow after restoring so SystemExit-like errors propagate
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    throw e;
  }
  stdoutWrite.mockRestore();
  stderrWrite.mockRestore();
  return { out, err };
}

// ============================================================
// import debug/inspect (must exist as TS module)
// NOTE: this import assumes packages/adapter-antigravity/src/debug/inspect.ts exists
// ============================================================
// Lazy import wrapper to avoid top-level errors when the module doesn't exist yet
let inspectMain: ((args?: string[]) => void) | undefined;
async function getInspectMain(): Promise<(args?: string[]) => void> {
  if (!inspectMain) {
    try {
      const mod = await import("../src/debug/inspect");
      inspectMain = mod.main as (args?: string[]) => void;
    } catch {
      throw new Error(
        "debug/inspect TS module not found at ../src/debug/inspect.ts. Create it before running these tests."
      );
    }
  }
  return inspectMain;
}

// ============================================================
// Tests
// ============================================================
describe("TestTopics", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("lists topics", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO project_topics (uuid, topic_id, status, summary) VALUES ('uuid-1', 'topic-a', 'open', 'Add auth module');
      INSERT INTO project_topics (uuid, topic_id, status, summary) VALUES ('uuid-1', 'topic-b', 'closed', 'Refactor db layer');
    `);
    conn.close();

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--topics"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("UUID");
      expect(out).toContain("TOPIC_ID");
      expect(out).toContain("STATUS");
      expect(out).toContain("uuid-1");
      expect(out).toContain("topic-a");
      expect(out).toContain("open");
      expect(out).toContain("Add auth module");
      expect(out).toContain("topic-b");
      expect(out).toContain("closed");
      expect(out).toContain("Refactor db layer");
    } finally {
      process.argv = origArgv;
    }
  });

  it("no topics", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--topics"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No project_topics found");
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestDecisions", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("decisions with project", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('p1', 't1', 'Use sqlite', 'It is embedded', 1);
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('p1', 't1', 'Use jsonl for logs', 'Human readable', 1);
    `);
    conn.close();

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t1", "--project", "p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      const data = JSON.parse(out.trim());
      expect(data.project_uuid).toBe("p1");
      expect(data.topic_id).toBe("t1");
      expect(data.decisions.length).toBe(2);
      const texts: string[] = data.decisions.map((d: { text: string }) => d.text);
      expect(texts.some((t) => t.includes("Use sqlite"))).toBe(true);
      expect(texts.some((t) => t.includes("Use jsonl for logs"))).toBe(true);
    } finally {
      process.argv = origArgv;
    }
  });

  it("decisions with evidence", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO messages (id, conversation_id, content) VALUES (1, 'c1', 'Evidence text here');
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids) VALUES ('p1', 't1', 'Structured logging', 'Better debugging', 1, '[1]');
    `);
    conn.close();

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t1", "--project", "p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      const data = JSON.parse(out.trim());
      expect(data.decisions[0].evidence).toBe("Evidence text here");
    } finally {
      process.argv = origArgv;
    }
  });

  it("decisions none found", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "nonexistent", "--project", "p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No confirmed decisions");
    } finally {
      process.argv = origArgv;
    }
  });

  it("decisions missing project", async () => {
    const prevEnv = process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.ANTIGRAVITY_PROJECT_ID;

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t1"];
    try {
      const mockExit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`EXIT_${code}`);
      });
      const { out, err } = captureOutput(() => {
        try {
          mainFn();
        } catch (e) {
          // expected
        }
      });
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(err).toContain("ANTIGRAVITY_PROJECT_ID");
      mockExit.mockRestore();
    } finally {
      process.argv = origArgv;
      if (prevEnv !== undefined) {
        process.env.ANTIGRAVITY_PROJECT_ID = prevEnv;
      }
    }
  });
});

describe("TestSessions", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("lists sessions", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO session_state (session_id, mode, is_cold_start, updated_at) VALUES ('sess-aaa', 'relax', 0, '2025-06-07 10:00:00');
      INSERT INTO session_state (session_id, mode, is_cold_start, updated_at) VALUES ('sess-bbb', 'standard', 1, '2025-06-07 09:00:00');
    `);
    conn.close();

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sessions"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("SESSION_ID");
      expect(out).toContain("MODE");
      expect(out).toContain("COLD_START");
      expect(out).toContain("sess-aaa");
      expect(out).toContain("relax");
      expect(out).toContain("sess-bbb");
      expect(out).toContain("standard");
    } finally {
      process.argv = origArgv;
    }
  });

  it("no sessions", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sessions"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No sessions found");
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestLiveness", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("liveness with retry files", async () => {
    const retriesDir = path.join(tmpDir, ".runtime", "remora_subagent_retries");
    fs.mkdirSync(retriesDir, { recursive: true });
    fs.writeFileSync(
      path.join(retriesDir, "sub_1.json"),
      JSON.stringify([{ entry: 1 }, { entry: 2 }, { entry: 3 }])
    );
    fs.writeFileSync(
      path.join(retriesDir, "sub_2.json"),
      JSON.stringify({ key1: "a", key2: "b" })
    );

    pathsMock.getDataDir.mockReturnValue(tmpDir);

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--liveness"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("Retry files (2)");
      expect(out).toContain("sub_1.json: 3 entries");
      expect(out).toContain("sub_2.json: 2 keys");
    } finally {
      process.argv = origArgv;
    }
  });

  it("liveness no directory", async () => {
    pathsMock.getDataDir.mockReturnValue("/nonexistent/path");

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--liveness"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No retries directory");
    } finally {
      process.argv = origArgv;
    }
  });

  it("liveness empty directory", async () => {
    const retriesDir = path.join(tmpDir, ".runtime", "remora_subagent_retries");
    fs.mkdirSync(retriesDir, { recursive: true });
    pathsMock.getDataDir.mockReturnValue(tmpDir);

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--liveness"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No subagent retry files found");
    } finally {
      process.argv = origArgv;
    }
  });

  it("liveness non json file", async () => {
    const retriesDir = path.join(tmpDir, ".runtime", "remora_subagent_retries");
    fs.mkdirSync(retriesDir, { recursive: true });
    fs.writeFileSync(path.join(retriesDir, "bad.json"), "not valid json {{{");
    pathsMock.getDataDir.mockReturnValue(tmpDir);

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--liveness"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("Retry files (1)");
      expect(out).toContain("error reading");
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestSql", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("select one", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sql", "SELECT 1"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("1");
    } finally {
      process.argv = origArgv;
    }
  });

  it("select multiple columns", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sql", "SELECT 2 AS a, 3 AS b"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("a | b");
      expect(out).toContain("2");
      expect(out).toContain("3");
    } finally {
      process.argv = origArgv;
    }
  });

  it("select no rows", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sql", "SELECT * FROM project_topics WHERE 1=0"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("(no rows)");
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestFile", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("file decisions link", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO file_changes (project_uuid, conversation_id, file_name, source) VALUES ('p1', 'c1', 'auth.py', 'snapshot');
      INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale) VALUES ('p1', 't1', 'c1', 'Add rate limiting', 'Prevent abuse');
      INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale) VALUES ('p1', 't2', 'c1', 'Use bcrypt', 'Industry standard');
    `);
    conn.close();

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--file", "auth.py", "--project", "p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      const data = JSON.parse(out.trim());
      expect(data.project_uuid).toBe("p1");
      expect(data.file).toBe("auth.py");
      expect(data.decisions.length).toBe(2);
      const decisionTexts: string[] = data.decisions.map((d: { decision: string }) => d.decision);
      expect(decisionTexts).toContain("Add rate limiting");
      expect(decisionTexts).toContain("Use bcrypt");
    } finally {
      process.argv = origArgv;
    }
  });

  it("file none found", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--file", "nonexistent.py", "--project", "p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      expect(out).toContain("No decisions found for file");
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestEmptyDatabase", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("topics empty", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--topics"];
    try {
      captureOutput(() => mainFn());
    } finally {
      process.argv = origArgv;
    }
  });

  it("sessions empty", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sessions"];
    try {
      captureOutput(() => mainFn());
    } finally {
      process.argv = origArgv;
    }
  });

  it("decisions empty", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t", "--project", "p1"];
    try {
      captureOutput(() => mainFn());
    } finally {
      process.argv = origArgv;
    }
  });

  it("file empty", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--file", "f.py", "--project", "p1"];
    try {
      captureOutput(() => mainFn());
    } finally {
      process.argv = origArgv;
    }
  });

  it("sql empty", async () => {
    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--sql", "SELECT 1"];
    try {
      captureOutput(() => mainFn());
    } finally {
      process.argv = origArgv;
    }
  });
});

describe("TestProjectEnv", () => {
  beforeEach(() => {
    setupTempDb();
  });

  afterEach(() => {
    teardownTempDb();
    vi.restoreAllMocks();
  });

  it("env var fallback", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('env-p1', 't1', 'Env decision', 'From env', 1);
    `);
    conn.close();

    process.env.ANTIGRAVITY_PROJECT_ID = "env-p1";

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t1"];
    try {
      const { out } = captureOutput(() => mainFn());
      const data = JSON.parse(out.trim());
      expect(data.project_uuid).toBe("env-p1");
      expect(data.topic_id).toBe("t1");
      expect(data.decisions.length).toBe(1);
    } finally {
      process.argv = origArgv;
      delete process.env.ANTIGRAVITY_PROJECT_ID;
    }
  });

  it("project flag overrides env", async () => {
    const conn = new Database(tempDbPath);
    conn.exec(`
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('flag-p1', 't1', 'Flag decision', 'From flag', 1);
    `);
    conn.close();

    process.env.ANTIGRAVITY_PROJECT_ID = "env-p1";

    const mainFn = await getInspectMain();
    const origArgv = [...process.argv];
    process.argv = ["node", "inspect.js", "--decisions", "t1", "--project", "flag-p1"];
    try {
      const { out } = captureOutput(() => mainFn());
      const data = JSON.parse(out.trim());
      expect(data.project_uuid).toBe("flag-p1");
    } finally {
      process.argv = origArgv;
      delete process.env.ANTIGRAVITY_PROJECT_ID;
    }
  });
});
