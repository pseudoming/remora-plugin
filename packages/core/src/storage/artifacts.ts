import Database from "better-sqlite3";
import { getConn } from "./connection";

/**
 * Returns last message timestamp of implementation_plan.md for this project, or null.
 */
export function getPlanChangeTime(
  projectUuid: string,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT MAX(timestamp) as max_ts FROM messages WHERE conversation_id=? AND role='implementation_plan.md'"
      )
      .get(`artifact_sync_${projectUuid}`) as
      | { max_ts: string | null }
      | undefined;
    return row && row.max_ts ? row.max_ts : null;
  } finally {
    if (ownConn) db.close();
  }
}

export function getUserMessagesAfter(
  timestamp: string,
  projectUuid: string,
  conn?: Database
): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        `SELECT m.content FROM messages m
         JOIN watermarks w ON m.conversation_id = w.conversation_id
         WHERE m.timestamp > ?
           AND m.role IN ('USER', 'USER_INPUT', 'USER_EXPLICIT', 'user')
           AND w.project_uuid = ?`
      )
      .all(timestamp, projectUuid) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } finally {
    if (ownConn) db.close();
  }
}

export function getPlanContent(
  projectUuid: string,
  conn?: Database
): string {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT content FROM messages WHERE conversation_id=? AND role='implementation_plan.md' LIMIT 1"
      )
      .get(`artifact_sync_${projectUuid}`) as
      | { content: string }
      | undefined;
    return row ? row.content : "";
  } finally {
    if (ownConn) db.close();
  }
}

export function enqueueEvent(
  projectUuid: string,
  eventType: string,
  payload: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)"
      )
      .run(projectUuid, eventType, payload);
  } finally {
    if (ownConn) db.close();
  }
}

export function getPendingEvents(
  conn?: Database
): Array<{
  id: number;
  project_uuid: string;
  event_type: string;
  payload: string;
}> {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    return db
      .prepare(
        "SELECT id, project_uuid, event_type, payload FROM remora_event_queue WHERE status='pending' ORDER BY id ASC"
      )
      .all() as Array<{
      id: number;
      project_uuid: string;
      event_type: string;
      payload: string;
    }>;
  } finally {
    if (ownConn) db.close();
  }
}

export function markEventProcessed(
  eventId: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare("UPDATE remora_event_queue SET status='processed' WHERE id=?")
      .run(eventId);
  } finally {
    if (ownConn) db.close();
  }
}

export function getArtifactHash(
  filePath: string,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare("SELECT hash FROM artifact_hashes WHERE file_path=?")
      .get(filePath) as { hash: string } | undefined;
    return row ? row.hash : null;
  } finally {
    if (ownConn) db.close();
  }
}

export function upsertArtifactHash(
  filePath: string,
  fileHash: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "INSERT OR REPLACE INTO artifact_hashes (file_path, hash, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)"
      )
      .run(filePath, fileHash);
  } finally {
    if (ownConn) db.close();
  }
}

export function deleteArtifactMessages(
  syncConvId: string,
  filename: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare("DELETE FROM messages WHERE conversation_id=? AND role=?")
      .run(syncConvId, filename);
  } finally {
    if (ownConn) db.close();
  }
}

export function insertArtifactMessage(
  syncConvId: string,
  lineNumber: number,
  role: string,
  content: string,
  topicId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        `INSERT INTO messages (conversation_id, line_number, timestamp, role, content, topic_id)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`
      )
      .run(syncConvId, lineNumber, role, content, topicId);
  } finally {
    if (ownConn) db.close();
  }
}

export function upsertArtifactTopic(
  projectUuid: string,
  topicId: string,
  summary: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        `INSERT INTO project_topics (uuid, topic_id, status, summary, source)
         VALUES (?, ?, 'closed', ?, 'auto')
         ON CONFLICT(uuid, topic_id) DO UPDATE SET
             status='closed',
             summary=excluded.summary,
             updated_at=CURRENT_TIMESTAMP`
      )
      .run(projectUuid, topicId, summary);
  } finally {
    if (ownConn) db.close();
  }
}
