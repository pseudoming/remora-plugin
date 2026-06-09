import Database from "better-sqlite3";
import { getConn } from "./connection";

export function insertFileChange(projectUuid: string, conversationId: string, fileName: string, source: string, conn?: Database): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db.prepare(
      "INSERT OR IGNORE INTO file_changes (project_uuid, conversation_id, file_name, source) VALUES (?, ?, ?, ?)"
    ).run(projectUuid, conversationId, fileName, source);
  } finally {
    if (ownConn) db.close();
  }
}

export function getFilesByTopic(projectUuid: string, topicId: string, conn?: Database): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db.prepare(
      `SELECT DISTINCT fc.file_name FROM file_changes fc
       JOIN topic_decisions td ON fc.conversation_id = td.conversation_id
       WHERE td.project_uuid = ? AND td.topic_id = ?`
    ).all(projectUuid, topicId) as { file_name: string }[];
    return rows.map((row) => row.file_name);
  } catch (e) {
    console.warn(`getFilesByTopic: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

export function getDecisionsByFile(projectUuid: string, fileName: string, conn?: Database): Array<{ id: number; decision: string; rationale: string }> {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db.prepare(
      `SELECT DISTINCT td.id, td.decision, td.rationale
       FROM topic_decisions td
       JOIN file_changes fc ON fc.conversation_id = td.conversation_id
       WHERE td.project_uuid = ? AND fc.file_name = ?
       ORDER BY td.created_at DESC`
    ).all(projectUuid, fileName) as Array<{ id: number; decision: string; rationale: string }>;
    return rows.map((r) => ({ id: r.id, decision: r.decision, rationale: r.rationale }));
  } catch (e) {
    console.warn(`getDecisionsByFile: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}
