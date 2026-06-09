import Database from "better-sqlite3";
import { getConn } from "./connection";

const USER_ROLES = ["USER", "USER_INPUT", "USER_EXPLICIT", "user"];

export function getLatestNonUserMessages(
  convId: string,
  limit: number = 5,
  conn?: Database
): Array<{ timestamp: string; role: string; content: string }> {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        `SELECT timestamp, role, content FROM messages
         WHERE conversation_id = ?
         AND role NOT IN (?, ?, ?, ?)
         AND content IS NOT NULL AND content != ''
         ORDER BY line_number DESC, id DESC
         LIMIT ?`
      )
      .all(convId, ...USER_ROLES, limit) as Array<{
      timestamp: string;
      role: string;
      content: string;
    }>;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      role: r.role,
      content: r.content,
    }));
  } catch (e) {
    console.error(`getLatestNonUserMessages failed: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Returns last_msg_id from watermarks, or 0 if no row exists.
 */
export function getWatermark(
  projectUuid: string,
  conversationId: string,
  conn?: Database
): number {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?"
      )
      .get(projectUuid, conversationId) as
      | { last_msg_id: number }
      | undefined;
    return row ? row.last_msg_id : 0;
  } finally {
    if (ownConn) db.close();
  }
}

export function getMaxLineNumber(
  conversationId: string,
  conn?: Database
): number {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT MAX(line_number) as max_ln FROM messages WHERE conversation_id=?"
      )
      .get(conversationId) as { max_ln: number | null } | undefined;
    return row && row.max_ln ? row.max_ln : 0;
  } finally {
    if (ownConn) db.close();
  }
}

export function insertMessage(
  conversationId: string,
  lineNumber: number,
  timestamp: string,
  role: string,
  content: string,
  conn?: Database
): number | bigint {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)"
      )
      .run(conversationId, lineNumber, timestamp, role, content);
    return result.lastInsertRowid;
  } finally {
    if (ownConn) db.close();
  }
}

export function getMaxMessageId(
  conversationId: string,
  conn?: Database
): number {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=?")
      .get(conversationId) as { max_id: number | null } | undefined;
    return row && row.max_id ? row.max_id : 0;
  } finally {
    if (ownConn) db.close();
  }
}

export function getMaxMessageIdUpToLine(
  conversationId: string,
  lineNumber: number,
  conn?: Database
): number {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT MAX(id) as max_id FROM messages WHERE conversation_id=? AND line_number<=?"
      )
      .get(conversationId, lineNumber) as
      | { max_id: number | null }
      | undefined;
    return row && row.max_id ? row.max_id : 0;
  } finally {
    if (ownConn) db.close();
  }
}

export function deleteMessagesAboveLine(
  conversationId: string,
  lineNumber: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "DELETE FROM messages WHERE conversation_id=? AND line_number > ?"
      )
      .run(conversationId, lineNumber);
  } finally {
    if (ownConn) db.close();
  }
}

export function getDecisionsByConversation(
  conversationId: string,
  conn?: Database
): Array<{ id: number; evidence_msg_ids: string }> {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    return db
      .prepare(
        "SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?"
      )
      .all(conversationId) as Array<{ id: number; evidence_msg_ids: string }>;
  } finally {
    if (ownConn) db.close();
  }
}

export function deleteTopicDecision(
  decisionId: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare("DELETE FROM topic_decisions WHERE id=?")
      .run(decisionId);
  } finally {
    if (ownConn) db.close();
  }
}

export function getMessageTimestamp(
  messageId: number,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare("SELECT timestamp FROM messages WHERE id=?")
      .get(messageId) as { timestamp: string } | undefined;
    return row ? row.timestamp : null;
  } finally {
    if (ownConn) db.close();
  }
}

export function deleteDecisionsByConversationAfter(
  conversationId: string,
  createdAfter: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?"
      )
      .run(conversationId, createdAfter);
  } finally {
    if (ownConn) db.close();
  }
}

export function deletePendingEvents(
  projectUuid: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'"
      )
      .run(projectUuid);
  } finally {
    if (ownConn) db.close();
  }
}

export function updateWatermark(
  projectUuid: string,
  conversationId: string,
  msgId: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "UPDATE watermarks SET last_msg_id=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?"
      )
      .run(msgId, projectUuid, conversationId);
  } finally {
    if (ownConn) db.close();
  }
}

export function ensureWatermark(
  projectUuid: string,
  conversationId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)"
      )
      .run(projectUuid, conversationId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Update messages.topic_id JSON array for evidence message backfill.
 */
export function backfillMessageTopicIds(
  topicId: string,
  messageIds: Set<number>,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const stmt = db.prepare(
      `UPDATE messages SET topic_id =
         CASE
           WHEN topic_id IS NULL THEN json_array(?)
           ELSE json_insert(topic_id, '$[#]', ?)
         END
       WHERE id = ?`
    );
    for (const mid of messageIds) {
      stmt.run(topicId, topicId, mid);
    }
  } finally {
    if (ownConn) db.close();
  }
}
