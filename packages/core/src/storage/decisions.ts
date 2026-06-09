import Database from "better-sqlite3";
import { getConn } from "./connection";

// ── Type definitions ──────────────────────────────────────────────

type EvidenceRow = { content: string };

type TopicDecisionRow = {
  decision: string;
  rationale: string;
  evidence_msg_ids: string | null;
  decision_type: string | null;
};

export type ConfirmedDecision = {
  text: string;
  evidence: string;
  decision_type: string;
};

export type PendingDecision = {
  id: number;
  decision: string;
  rationale: string;
};

export type RecentDecision = {
  id: number;
  decision: string;
  rationale: string;
  user_confirmed: number;
  created_at: string;
};

export type RelevanceDecision = {
  id: number;
  decision: string;
  rationale: string;
  decision_type: string;
  created_at: string;
};

// ── Public functions ──────────────────────────────────────────────

/**
 * Returns [{'text': '...', 'decision_type': '...', 'evidence': '...'}]
 */
export function getConfirmedDecisions(
  projectUuid: string,
  topicId: string
): ConfirmedDecision[] {
  let conn: Database | null = null;
  try {
    conn = getConn();
    const rows = conn
      .prepare(
        `SELECT decision, rationale, evidence_msg_ids, decision_type
         FROM topic_decisions
         WHERE project_uuid = ? AND topic_id = ? AND user_confirmed = 1
         ORDER BY created_at ASC`
      )
      .all(projectUuid, topicId) as TopicDecisionRow[];

    const decisions: ConfirmedDecision[] = [];
    for (const row of rows) {
      let evidenceTexts: string[] = [];
      if (row.evidence_msg_ids) {
        try {
          const msgIds: number[] = JSON.parse(row.evidence_msg_ids);
          for (const msgId of msgIds) {
            const msgRow = conn
              .prepare("SELECT content FROM messages WHERE id = ?")
              .get(msgId) as EvidenceRow | undefined;
            if (msgRow) {
              evidenceTexts.push(msgRow.content);
            }
          }
        } catch (e) {
          console.warn(`evidence_msg_ids parse: ${e}`);
        }
      }
      decisions.push({
        text: `${row.decision} (原因: ${row.rationale})`,
        evidence: evidenceTexts.join("\n"),
        decision_type: row.decision_type || "approved",
      });
    }
    return decisions;
  } catch (e) {
    console.warn(`get_confirmed_decisions: ${e}`);
    return [];
  } finally {
    if (conn) conn.close();
  }
}

export function confirmDecision(
  projectUuid: string,
  decisionId: number
): boolean {
  let conn: Database | null = null;
  try {
    conn = getConn();
    const changes = conn.transaction(() => {
      const info = conn!
        .prepare(
          `UPDATE topic_decisions
           SET user_confirmed = 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND project_uuid = ?`
        )
        .run(decisionId, projectUuid);
      return info.changes;
    })();
    return changes > 0;
  } catch (e) {
    console.warn(`confirm_decision: ${e}`);
    return false;
  } finally {
    if (conn) conn.close();
  }
}

export function getTopicIdByDecision(decisionId: number): string | null {
  let conn: Database | null = null;
  try {
    conn = getConn();
    const row = conn
      .prepare("SELECT topic_id FROM topic_decisions WHERE id = ?")
      .get(decisionId) as { topic_id: string } | undefined;
    return row ? row.topic_id : null;
  } catch (e) {
    console.warn(`get_topic_id_by_decision: ${e}`);
    return null;
  } finally {
    if (conn) conn.close();
  }
}

/**
 * Check if an identical decision already exists for this project+topic.
 * Uses the supplied connection for transaction consistency.
 */
export function decisionExists(
  conn: Database,
  projectUuid: string,
  topicId: string,
  decisionText: string
): boolean {
  const row = conn
    .prepare(
      "SELECT id FROM topic_decisions WHERE project_uuid = ? AND topic_id = ? AND decision = ?"
    )
    .get(projectUuid, topicId, decisionText);
  return row !== undefined;
}

/**
 * Delete all user_confirmed=0 decisions for this topic before inserting a new extraction batch.
 */
export function supersedeUnconfirmed(
  conn: Database,
  projectUuid: string,
  topicId: string
): void {
  conn
    .prepare(
      "DELETE FROM topic_decisions WHERE project_uuid = ? AND topic_id = ? AND user_confirmed = 0"
    )
    .run(projectUuid, topicId);
}

/**
 * Returns list of unconfirmed decisions for event consumption.
 */
export function getPendingDecisions(
  conn: Database,
  projectUuid: string,
  limit: number = 30
): PendingDecision[] {
  const rows = conn
    .prepare(
      `SELECT id, decision, rationale
       FROM topic_decisions
       WHERE project_uuid = ? AND user_confirmed = 0
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(projectUuid, limit) as PendingDecision[];
  return rows;
}

/**
 * Batch-confirm decisions by their IDs.
 */
export function confirmDecisionsByIds(
  conn: Database,
  decisionIds: number[],
  projectUuid: string
): void {
  for (const dId of decisionIds) {
    conn
      .prepare(
        "UPDATE topic_decisions SET user_confirmed = 1 WHERE id = ? AND project_uuid = ?"
      )
      .run(dId, projectUuid);
  }
}

export function insertDecision(
  conn: Database,
  projectUuid: string,
  topicId: string,
  conversationId: string,
  decision: string,
  rationale: string,
  evidenceMsgIds: string,
  userConfirmed: number,
  decisionType: string
): void {
  conn
    .prepare(
      `INSERT INTO topic_decisions
       (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, decision_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectUuid,
      topicId,
      conversationId,
      decision,
      rationale,
      evidenceMsgIds,
      userConfirmed,
      decisionType
    );
}

export function getDecisionConfirmed(
  conn: Database,
  decisionId: number
): boolean {
  const row = conn
    .prepare("SELECT user_confirmed FROM topic_decisions WHERE id = ?")
    .get(decisionId) as { user_confirmed: number } | undefined;
  return !!(row && row.user_confirmed === 1);
}

export function getConfirmedDecisionIds(
  conn: Database,
  projectUuid: string
): Set<number> {
  const rows = conn
    .prepare(
      "SELECT id FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 1"
    )
    .all(projectUuid) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Returns recent decisions (both uc=0 and uc=1) sorted by created_at DESC.
 */
export function getRecentDecisions(
  conn: Database,
  projectUuid: string,
  topicId: string,
  limit: number = 5
): RecentDecision[] {
  const rows = conn
    .prepare(
      `SELECT id, decision, rationale, user_confirmed, created_at
       FROM topic_decisions
       WHERE project_uuid = ? AND topic_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(projectUuid, topicId, limit) as RecentDecision[];
  return rows;
}

/**
 * BM25-ranked rejected/deferred decisions matching the user query, with LIKE fallback.
 */
export function getRejectedOrDeferredByRelevance(
  conn: Database,
  projectUuid: string,
  queryText: string,
  limit: number = 12
): RelevanceDecision[] {
  const safeQuery = queryText.replace(/"/g, '""');

  let candidates: RelevanceDecision[] = [];
  let existingIds: Set<number> = new Set();

  try {
    const rows = conn
      .prepare(
        `SELECT td.id, td.decision, td.rationale, td.decision_type, td.created_at
         FROM topic_decisions td
         JOIN json_each(td.evidence_msg_ids) j
         JOIN messages m ON m.id = j.value
         JOIN messages_fts fts ON m.id = fts.rowid
         WHERE td.project_uuid = ?
           AND td.decision_type IN ('rejected', 'deferred')
           AND messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(projectUuid, `"${safeQuery}"`, limit) as RelevanceDecision[];
    candidates = rows;
    existingIds = new Set(candidates.map((c) => c.id));
  } catch {
    // FTS query failed; fall through to LIKE fallback
  }

  if (candidates.length < limit) {
    const shortage = limit - candidates.length;
    const likePattern = `%${safeQuery}%`;

    try {
      if (existingIds.size > 0) {
        const placeholders = Array.from(existingIds, () => "?").join(",");
        const rows = conn
          .prepare(
            `SELECT id, decision, rationale, decision_type, created_at
             FROM topic_decisions
             WHERE project_uuid = ?
               AND decision_type IN ('rejected','deferred')
               AND id NOT IN (${placeholders})
               AND (decision LIKE ? OR rationale LIKE ?)
             LIMIT ?`
          )
          .all(
            projectUuid,
            ...existingIds,
            likePattern,
            likePattern,
            shortage
          ) as RelevanceDecision[];
        candidates.push(...rows);
      } else {
        const rows = conn
          .prepare(
            `SELECT id, decision, rationale, decision_type, created_at
             FROM topic_decisions
             WHERE project_uuid = ?
               AND decision_type IN ('rejected','deferred')
               AND (decision LIKE ? OR rationale LIKE ?)
             LIMIT ?`
          )
          .all(projectUuid, likePattern, likePattern, shortage) as RelevanceDecision[];
        candidates.push(...rows);
      }
    } catch {
      // LIKE fallback also failed
    }
  }

  return candidates;
}

export function bumpInjection(conn: Database, decisionId: number): void {
  conn
    .prepare(
      `UPDATE topic_decisions
       SET injected_count = injected_count + 1, last_injected_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(decisionId);
}
