import Database from "better-sqlite3";

const USER_ROLES = ["USER", "USER_INPUT", "USER_EXPLICIT", "user"];

export function getLatestNonUserMessages(
  conn: Database.Database,
  convId: string,
  limit: number = 5
): Array<{ timestamp: string; role: string; content: string }> {
  try {
    const rows = conn
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
  }
}

/**
 * Returns last_msg_id from watermarks, or 0 if no row exists.
 */
export function getWatermark(
  conn: Database.Database,
  projectUuid: string,
  conversationId: string
): number {
  const row = conn
    .prepare(
      "SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?"
    )
    .get(projectUuid, conversationId) as
    | { last_msg_id: number }
    | undefined;
  return row ? row.last_msg_id : 0;
}

export function getMaxLineNumber(
  conn: Database.Database,
  conversationId: string
): number {
  const row = conn
    .prepare(
      "SELECT MAX(line_number) as max_ln FROM messages WHERE conversation_id=?"
    )
    .get(conversationId) as { max_ln: number | null } | undefined;
  return row && row.max_ln ? row.max_ln : 0;
}

export function insertMessage(
  conn: Database.Database,
  conversationId: string,
  lineNumber: number,
  timestamp: string,
  role: string,
  content: string
): number | bigint {
  const result = conn
    .prepare(
      "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)"
    )
    .run(conversationId, lineNumber, timestamp, role, content);
  return result.lastInsertRowid;
}

export function getMaxMessageId(
  conn: Database.Database,
  conversationId: string
): number {
  const row = conn
    .prepare("SELECT MAX(id) as max_id FROM messages WHERE conversation_id=?")
    .get(conversationId) as { max_id: number | null } | undefined;
  return row && row.max_id ? row.max_id : 0;
}

export function getMaxMessageIdUpToLine(
  conn: Database.Database,
  conversationId: string,
  lineNumber: number
): number {
  const row = conn
    .prepare(
      "SELECT MAX(id) as max_id FROM messages WHERE conversation_id=? AND line_number<=?"
    )
    .get(conversationId, lineNumber) as
    | { max_id: number | null }
    | undefined;
  return row && row.max_id ? row.max_id : 0;
}

export function deleteMessagesAboveLine(
  conn: Database.Database,
  conversationId: string,
  lineNumber: number
): void {
  conn
    .prepare(
      "DELETE FROM messages WHERE conversation_id=? AND line_number > ?"
    )
    .run(conversationId, lineNumber);
}

export function getDecisionsByConversation(
  conn: Database.Database,
  conversationId: string
): Array<{ id: number; evidence_msg_ids: string }> {
  return conn
    .prepare(
      "SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?"
    )
    .all(conversationId) as Array<{ id: number; evidence_msg_ids: string }>;
}

export function deleteTopicDecision(
  conn: Database.Database,
  decisionId: number
): void {
  conn
    .prepare("DELETE FROM topic_decisions WHERE id=?")
    .run(decisionId);
}

export function getMessageTimestamp(
  conn: Database.Database,
  messageId: number
): string | null {
  const row = conn
    .prepare("SELECT timestamp FROM messages WHERE id=?")
    .get(messageId) as { timestamp: string } | undefined;
  return row ? row.timestamp : null;
}

export function deleteDecisionsByConversationAfter(
  conn: Database.Database,
  conversationId: string,
  createdAfter: string
): void {
  conn
    .prepare(
      "DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?"
    )
    .run(conversationId, createdAfter);
}

export function deletePendingEvents(
  conn: Database.Database,
  projectUuid: string
): void {
  conn
    .prepare(
      "DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'"
    )
    .run(projectUuid);
}

export function updateWatermark(
  conn: Database.Database,
  projectUuid: string,
  conversationId: string,
  msgId: number
): void {
  conn
    .prepare(
      "UPDATE watermarks SET last_msg_id=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?"
    )
    .run(msgId, projectUuid, conversationId);
}

export function ensureWatermark(
  conn: Database.Database,
  projectUuid: string,
  conversationId: string
): void {
  conn
    .prepare(
      "INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)"
    )
    .run(projectUuid, conversationId);
}

/**
 * Update messages.topic_id JSON array for evidence message backfill.
 */
export function backfillMessageTopicIds(
  conn: Database.Database,
  topicId: string,
  messageIds: Set<number>
): void {
  const stmt = conn.prepare(
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
}
