import Database from "better-sqlite3";

/**
 * Returns last message timestamp of implementation_plan.md for this project, or null.
 */
export function getPlanChangeTime(
  conn: Database.Database,
  projectUuid: string
): string | null {
  const row = conn
    .prepare(
      "SELECT MAX(timestamp) as max_ts FROM messages WHERE conversation_id=? AND role='implementation_plan.md'"
    )
    .get(`artifact_sync_${projectUuid}`) as
    | { max_ts: string | null }
    | undefined;
  return row && row.max_ts ? row.max_ts : null;
}

export function getUserMessagesAfter(
  conn: Database.Database,
  timestamp: string,
  projectUuid: string
): string[] {
  const rows = conn
    .prepare(
      `SELECT m.content FROM messages m
       JOIN watermarks w ON m.conversation_id = w.conversation_id
       WHERE m.timestamp > ?
         AND m.role IN ('USER', 'USER_INPUT', 'USER_EXPLICIT', 'user')
         AND w.project_uuid = ?`
    )
    .all(timestamp, projectUuid) as Array<{ content: string }>;
  return rows.map((r) => r.content);
}

export function getPlanContent(
  conn: Database.Database,
  projectUuid: string
): string {
  const row = conn
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? AND role='implementation_plan.md' LIMIT 1"
    )
    .get(`artifact_sync_${projectUuid}`) as
    | { content: string }
    | undefined;
  return row ? row.content : "";
}

export function enqueueEvent(
  conn: Database.Database,
  projectUuid: string,
  eventType: string,
  payload: string
): void {
  conn
    .prepare(
      "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)"
    )
    .run(projectUuid, eventType, payload);
}

export function getPendingEvents(
  conn: Database.Database
): Array<{
  id: number;
  project_uuid: string;
  event_type: string;
  payload: string;
}> {
  return conn
    .prepare(
      "SELECT id, project_uuid, event_type, payload FROM remora_event_queue WHERE status='pending' ORDER BY id ASC"
    )
    .all() as Array<{
    id: number;
    project_uuid: string;
    event_type: string;
    payload: string;
  }>;
}

export function markEventProcessed(
  conn: Database.Database,
  eventId: number
): void {
  conn
    .prepare("UPDATE remora_event_queue SET status='processed' WHERE id=?")
    .run(eventId);
}

export function getArtifactHash(
  conn: Database.Database,
  filePath: string
): string | null {
  const row = conn
    .prepare("SELECT hash FROM artifact_hashes WHERE file_path=?")
    .get(filePath) as { hash: string } | undefined;
  return row ? row.hash : null;
}

export function upsertArtifactHash(
  conn: Database.Database,
  filePath: string,
  fileHash: string
): void {
  conn
    .prepare(
      "INSERT OR REPLACE INTO artifact_hashes (file_path, hash, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)"
    )
    .run(filePath, fileHash);
}

export function deleteArtifactMessages(
  conn: Database.Database,
  syncConvId: string,
  filename: string
): void {
  conn
    .prepare("DELETE FROM messages WHERE conversation_id=? AND role=?")
    .run(syncConvId, filename);
}

export function insertArtifactMessage(
  conn: Database.Database,
  syncConvId: string,
  lineNumber: number,
  role: string,
  content: string,
  topicId: string
): void {
  conn
    .prepare(
      `INSERT INTO messages (conversation_id, line_number, timestamp, role, content, topic_id)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`
    )
    .run(syncConvId, lineNumber, role, content, topicId);
}

export function upsertArtifactTopic(
  conn: Database.Database,
  projectUuid: string,
  topicId: string,
  summary: string
): void {
  conn
    .prepare(
      `INSERT INTO project_topics (uuid, topic_id, status, summary, source)
       VALUES (?, ?, 'closed', ?, 'auto')
       ON CONFLICT(uuid, topic_id) DO UPDATE SET
           status='closed',
           summary=excluded.summary,
           updated_at=CURRENT_TIMESTAMP`
    )
    .run(projectUuid, topicId, summary);
}
