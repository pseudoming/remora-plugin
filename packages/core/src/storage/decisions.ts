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
  topicId: string,
  conn?: Database
): ConfirmedDecision[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
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
            const msgRow = db
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
    if (ownConn) db.close();
  }
}

export function confirmDecision(
  projectUuid: string,
  decisionId: number,
  conn?: Database
): boolean {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const changes = db.transaction(() => {
      const info = db
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
    if (ownConn) db.close();
  }
}

export function getTopicIdByDecision(
  decisionId: number,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare("SELECT topic_id FROM topic_decisions WHERE id = ?")
      .get(decisionId) as { topic_id: string } | undefined;
    return row ? row.topic_id : null;
  } catch (e) {
    console.warn(`get_topic_id_by_decision: ${e}`);
    return null;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Check if an identical decision already exists for this project+topic.
 */
export function decisionExists(
  projectUuid: string,
  topicId: string,
  decisionText: string,
  conn?: Database
): boolean {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT id FROM topic_decisions WHERE project_uuid = ? AND topic_id = ? AND decision = ?"
      )
      .get(projectUuid, topicId, decisionText);
    return row !== undefined;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Delete all user_confirmed=0 decisions for this topic before inserting a new extraction batch.
 */
export function supersedeUnconfirmed(
  projectUuid: string,
  topicId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "DELETE FROM topic_decisions WHERE project_uuid = ? AND topic_id = ? AND user_confirmed = 0"
      )
      .run(projectUuid, topicId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Returns list of unconfirmed decisions for event consumption.
 */
export function getPendingDecisions(
  projectUuid: string,
  limit: number = 30,
  conn?: Database
): PendingDecision[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        `SELECT id, decision, rationale
         FROM topic_decisions
         WHERE project_uuid = ? AND user_confirmed = 0
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(projectUuid, limit) as PendingDecision[];
    return rows;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Batch-confirm decisions by their IDs.
 */
export function confirmDecisionsByIds(
  decisionIds: number[],
  projectUuid: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    for (const dId of decisionIds) {
      db
        .prepare(
          "UPDATE topic_decisions SET user_confirmed = 1 WHERE id = ? AND project_uuid = ?"
        )
        .run(dId, projectUuid);
    }
  } finally {
    if (ownConn) db.close();
  }
}

export function insertDecision(
  projectUuid: string,
  topicId: string,
  conversationId: string,
  decision: string,
  rationale: string,
  evidenceMsgIds: string,
  userConfirmed: number,
  decisionType: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
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
  } finally {
    if (ownConn) db.close();
  }
}

export function getDecisionConfirmed(
  decisionId: number,
  conn?: Database
): boolean {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare("SELECT user_confirmed FROM topic_decisions WHERE id = ?")
      .get(decisionId) as { user_confirmed: number } | undefined;
    return !!(row && row.user_confirmed === 1);
  } finally {
    if (ownConn) db.close();
  }
}

export function getConfirmedDecisionIds(
  projectUuid: string,
  conn?: Database
): Set<number> {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        "SELECT id FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 1"
      )
      .all(projectUuid) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Returns recent decisions (both uc=0 and uc=1) sorted by created_at DESC.
 */
export function getRecentDecisions(
  projectUuid: string,
  topicId: string,
  limit: number = 5,
  conn?: Database
): RecentDecision[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        `SELECT id, decision, rationale, user_confirmed, created_at
         FROM topic_decisions
         WHERE project_uuid = ? AND topic_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(projectUuid, topicId, limit) as RecentDecision[];
    return rows;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * BM25-ranked rejected/deferred decisions matching the user query, with LIKE fallback.
 */
export function getRejectedOrDeferredByRelevance(
  projectUuid: string,
  queryText: string,
  limit: number = 12,
  conn?: Database
): RelevanceDecision[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const safeQuery = queryText.replace(/"/g, '""');

    let candidates: RelevanceDecision[] = [];
    let existingIds: Set<number> = new Set();

    try {
      const rows = db
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
          const rows = db
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
          const rows = db
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
  } finally {
    if (ownConn) db.close();
  }
}

export function bumpInjection(
  decisionId: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        `UPDATE topic_decisions
         SET injected_count = injected_count + 1, last_injected_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(decisionId);
  } finally {
    if (ownConn) db.close();
  }
}
