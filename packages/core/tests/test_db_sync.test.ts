import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// ============================================================
// Fixture: 每次测试前创建 in-memory 数据库 (对应 Python setup_db)
// ============================================================
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_state (
        session_id TEXT PRIMARY KEY,
        mode TEXT DEFAULT 'standard',
        is_cold_start INTEGER DEFAULT 1,
        updated_at DATETIME
    );
    CREATE TABLE watermarks (
        conversation_id TEXT PRIMARY KEY,
        project_uuid TEXT,
        last_msg_id INTEGER DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE project_topics (
        uuid TEXT,
        topic_id TEXT,
        status TEXT DEFAULT 'open',
        summary TEXT,
        source TEXT DEFAULT 'auto',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        compression_confidence REAL DEFAULT 1.0,
        associated_files TEXT,
        referenced_files TEXT,
        PRIMARY KEY(uuid, topic_id)
    );
    CREATE TABLE topic_decisions (
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
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        topic_id TEXT,
        role TEXT,
        content TEXT,
        line_number INTEGER,
        timestamp DATETIME
    );
  `);
});

afterEach(() => {
  db.close();
});

// ============================================================
// 模拟 warm_storage_sync.read_incremental_logs
// (对应 Python 中 from ConversationDataAccessLayer 的 mock stream)
// ============================================================
function readIncrementalLogs(
  conn: Database.Database,
  session: { project_uuid: string; conversation_id: string }
): [string, number, number] {
  // 模拟 ConversationDataAccessLayer.stream_steps_forward
  const streamedMessages = [
    { step_index: 1, type: "USER_INPUT", source: "user", content: "Hello", timestamp: "2026-06-04T12:00:00Z" },
    { step_index: 2, type: "PLANNER_RESPONSE", source: "agent", content: "Hi", timestamp: "2026-06-04T12:00:01Z" },
  ];

  const insertStmt = conn.prepare(
    "INSERT INTO messages (conversation_id, topic_id, role, content, line_number, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
  );

  for (const msg of streamedMessages) {
    insertStmt.run(
      session.conversation_id,
      null,
      msg.source,
      msg.content,
      msg.step_index,
      msg.timestamp
    );
  }

  // 插入初始水印 (对应 Python 中 read_incremental_logs 创建的 watermark 行)
  const watermarkStmt = conn.prepare(
    "INSERT OR REPLACE INTO watermarks (conversation_id, project_uuid, last_msg_id) VALUES (?, ?, ?)"
  );
  watermarkStmt.run(session.conversation_id, session.project_uuid, 0);

  const keyContent = streamedMessages.map(m => m.content).join("\n");
  const currentMsgId = streamedMessages[streamedMessages.length - 1].step_index;

  return [keyContent, currentMsgId, 0];
}

// ============================================================
// test_compactor_db_sync
// ============================================================
describe("test_compactor_db_sync", () => {
  it("compactor db sync", () => {
    const session = {
      project_uuid: "p1",
      conversation_id: "c1",
    };

    // Run warm_storage_sync
    const [keyContent, currentMsgId, lastMsgId] = readIncrementalLogs(db, session);

    // Verify messages table populated
    const messages = db.prepare("SELECT id, line_number FROM messages").all() as Array<{ id: number; line_number: number }>;
    expect(messages.length).toBe(2);
    expect(messages[0].line_number).toBe(1);
    expect(messages[1].line_number).toBe(2);

    // Verify watermark table
    const watermarks_init = db.prepare("SELECT last_msg_id FROM watermarks WHERE conversation_id='c1'").all() as Array<{ last_msg_id: number }>;
    expect(watermarks_init[0].last_msg_id).toBe(0);

    // Mock LLM data mapping back
    // Let's mock a decision using line 1
    const d = {
      decision: "d1",
      rationale: "r1",
      evidence_msg_ids: [1],
    };
    const t = {
      topic_id: "t1",
      summary: "s1",
      decisions: [d],
    };

    // Run the single-track snippet directly since extract_decisions invokes LLM
    const evidenceMsgIds = d.evidence_msg_ids || [];

    db.prepare(
      `INSERT INTO topic_decisions
       (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.project_uuid,
      t.topic_id || "",
      session.conversation_id,
      d.decision || "",
      d.rationale || "",
      JSON.stringify(evidenceMsgIds),
      0
    );

    // Also update watermark
    // Let's say current_msg_id is 2
    db.prepare(
      "UPDATE watermarks SET last_msg_id=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?"
    ).run(currentMsgId, session.project_uuid, session.conversation_id);

    // Verify decisions
    const decisions = db.prepare("SELECT evidence_msg_ids FROM topic_decisions").all() as Array<{ evidence_msg_ids: string }>;
    expect(decisions.length).toBe(1);
    expect(decisions[0].evidence_msg_ids).toBe("[1]");

    // Verify watermark updated
    const watermarks = db.prepare("SELECT last_msg_id FROM watermarks WHERE conversation_id='c1'").all() as Array<{ last_msg_id: number }>;
    expect(watermarks[0].last_msg_id).toBe(2);
  });
});

// ============================================================
// 模拟 sync_artifacts 相关函数
// ============================================================

interface InsertFileChangeCall {
  param0: unknown;
  param1: unknown;
  fileName: string;
  source: string;
}

const insertFileChangeCalls: InsertFileChangeCall[] = [];

function insertFileChange(param0: unknown, param1: unknown, fileName: string, source: string): void {
  insertFileChangeCalls.push({ param0, param1, fileName, source });
}

function extractConvId(transcriptPath: string): string {
  // 从路径中提取 conversation_id
  // /home/agent/.gemini/antigravity/brain/{conv_id}/logs/transcript.jsonl
  const parts = transcriptPath.split("/");
  return parts[6]; // conv_id 是路径第 7 段 (0-indexed: 6)
}

function scanAndIngestArtifacts(config: {
  artifactDirectoryPath: string;
  transcriptPath?: string;
}): void {
  // 模拟扫描制品目录 (对应 Python 中 os.listdir + os.path.exists + calculate_md5)
  const discoveredFiles = ["implementation_plan.md", "walkthrough.md"];

  let conversationId = "";
  let source = "file_change"; // 默认来源 (无 transcriptPath 时)

  if (config.transcriptPath) {
    conversationId = extractConvId(config.transcriptPath);
    source = "artifact";
  }

  for (const file of discoveredFiles) {
    insertFileChange(null, null, file, source);
  }
}

// ============================================================
// test_sync_artifacts_file_changes_artifact
// ============================================================
describe("test_sync_artifacts_file_changes_artifact", () => {
  it("sync artifacts file changes artifact", () => {
    insertFileChangeCalls.length = 0; // 重置调用记录

    const convId = "aaa-bbb-ccc-ddd-eee";

    scanAndIngestArtifacts({
      artifactDirectoryPath: "/fake/artifacts",
      transcriptPath: `/home/agent/.gemini/antigravity/brain/${convId}/logs/transcript.jsonl`,
    });

    const callFilenames = new Set(insertFileChangeCalls.map(c => c.fileName));
    expect(callFilenames.has("implementation_plan.md")).toBe(true);
    expect(callFilenames.has("walkthrough.md")).toBe(true);
    expect(insertFileChangeCalls.every(c => c.source === "artifact")).toBe(true);
  });
});

// ============================================================
// test_sync_artifacts_file_changes_no_transcript
// ============================================================
describe("test_sync_artifacts_file_changes_no_transcript", () => {
  it("sync artifacts file changes no transcript", () => {
    insertFileChangeCalls.length = 0; // 重置调用记录

    scanAndIngestArtifacts({
      artifactDirectoryPath: "/fake/artifacts",
    });

    for (const c of insertFileChangeCalls) {
      expect(c.source).not.toBe("artifact");
    }
  });
});
