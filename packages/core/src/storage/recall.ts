import Database from "better-sqlite3";
import { getConn } from "./connection";

/**
 * 从 messages 的 FTS5 索引中召回包含指定关键词的日志片段
 */
export function recallFts5Logs(
  projectUuid: string,
  convId: string,
  keyword: string,
  limit: number = 10,
  conn?: Database,
): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const safeKeyword = keyword.replace(/"/g, '""');
    const rows = db
      .prepare(
        `SELECT m.role || ': ' || m.content AS formatted_msg
         FROM messages m
         JOIN messages_fts fts ON m.id = fts.rowid
         WHERE m.conversation_id IN (
             SELECT conversation_id FROM watermarks WHERE project_uuid = ?
             UNION
             SELECT ? WHERE ? != ''
         )
         AND fts.content MATCH ?
         ORDER BY m.id ASC
         LIMIT ?`,
      )
      .all(
        projectUuid,
        convId,
        convId,
        `"${safeKeyword}"`,
        limit,
      ) as { formatted_msg: string }[];
    return rows.map((row) => row.formatted_msg);
  } catch (e) {
    console.warn(`recallFts5Logs: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * 根据 evidence_msg_ids JSON 数组构建证据摘要文本
 */
function _buildEvidenceTexts(
  conn: Database.Database,
  evidenceIdsJson: string | null,
): string {
  const evidenceTexts: string[] = [];
  if (evidenceIdsJson) {
    try {
      const msgIds = JSON.parse(evidenceIdsJson) as number[];
      for (const mid of msgIds) {
        const msgRow = conn
          .prepare("SELECT content FROM messages WHERE id = ?")
          .get(mid) as { content: string } | undefined;
        if (msgRow) {
          evidenceTexts.push(msgRow.content.slice(0, 200) + "...");
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return evidenceTexts.length
    ? ` [证据: ${evidenceTexts.join(" | ")}]`
    : "";
}

/**
 * 通过 FTS5 匹配消息中的 topic_id，召回相关决策
 */
export function recallDecisionsByFts5Topic(
  projectUuid: string,
  convId: string,
  keyword: string,
  conn?: Database,
): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const safeKeyword = keyword.replace(/"/g, '""');
    const rows = db
      .prepare(
        `SELECT topic_id, decision, rationale, evidence_msg_ids
         FROM topic_decisions
         WHERE (project_uuid = ? OR conversation_id = ?)
         AND topic_id IN (
             SELECT DISTINCT j.value
             FROM messages m
             JOIN messages_fts fts ON m.id = fts.rowid
             JOIN json_each(COALESCE(m.topic_id, '[]')) j
             WHERE m.conversation_id IN (
                 SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                 UNION
                 SELECT ? WHERE ? != ''
             )
             AND fts.content MATCH ?
         )
         ORDER BY created_at DESC`,
      )
      .all(
        projectUuid,
        convId,
        projectUuid,
        convId,
        convId,
        `"${safeKeyword}"`,
      ) as Array<{
      topic_id: string;
      decision: string;
      rationale: string;
      evidence_msg_ids: string;
    }>;

    const results: string[] = [];
    for (const row of rows) {
      const evidenceStr = _buildEvidenceTexts(db, row.evidence_msg_ids);
      results.push(
        `[${row.topic_id}] ${row.decision} (原因: ${row.rationale})${evidenceStr}`,
      );
    }
    return results;
  } catch (e) {
    console.warn(`recallDecisionsByFts5Topic: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * 通过 LIKE 模糊匹配决策文本（FTS5 的降级回退方案）
 */
export function recallDecisionsByLike(
  projectUuid: string,
  convId: string,
  keyword: string,
  limit: number = 5,
  conn?: Database,
): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const safeKeyword = keyword
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const likePattern = `%${safeKeyword}%`;
    const rows = db
      .prepare(
        `SELECT topic_id, decision, rationale, evidence_msg_ids
         FROM topic_decisions
         WHERE (project_uuid = ? OR conversation_id = ?)
         AND (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(
        projectUuid,
        convId,
        likePattern,
        likePattern,
        limit,
      ) as Array<{
      topic_id: string;
      decision: string;
      rationale: string;
      evidence_msg_ids: string;
    }>;

    const results: string[] = [];
    for (const row of rows) {
      const evidenceStr = _buildEvidenceTexts(db, row.evidence_msg_ids);
      results.push(
        `[${row.topic_id}] ${row.decision} (原因: ${row.rationale})${evidenceStr}`,
      );
    }
    return results;
  } catch (e) {
    console.warn(`recallDecisionsByLike: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * 更新被召回主题的 last_accessed_at 时间戳
 */
export function touchTopicsAccessedByRecall(
  projectUuid: string,
  convId: string,
  keyword: string,
  conn?: Database,
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const safeKeyword = keyword.replace(/"/g, '""');
    db
      .prepare(
        `UPDATE project_topics SET last_accessed_at = CURRENT_TIMESTAMP
         WHERE uuid = ?
         AND topic_id IN (
             SELECT value FROM (
                 SELECT j.value
                 FROM messages m
                 JOIN messages_fts fts ON m.id = fts.rowid
                 JOIN json_each(COALESCE(m.topic_id, '[]')) j
                 WHERE m.conversation_id IN (
                     SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                     UNION
                     SELECT ? WHERE ? != ''
                 )
                 AND fts.content MATCH ?
                 ORDER BY m.id ASC LIMIT 10
             )
             UNION
             SELECT topic_id FROM (
                 SELECT topic_id FROM topic_decisions
                 WHERE (project_uuid = ? OR conversation_id = ?)
                 AND (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
                 ORDER BY created_at DESC LIMIT 5
             )
         )`,
      )
      .run(
        projectUuid,
        projectUuid,
        convId,
        convId,
        `"${safeKeyword}"`,
        projectUuid,
        convId,
        `%${safeKeyword}%`,
        `%${safeKeyword}%`,
      );
  } finally {
    if (ownConn) db.close();
  }
}
