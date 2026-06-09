import Database from "better-sqlite3";
import { getConn } from "./connection";

/** Return type for {@link getTopicsByUuid}. */
export interface TopicRow {
  topicId: string;
  status: string;
  summary: string;
}

/**
 * Get the currently active (open) topic_id for a given project.
 *
 * Returns the topic_id of the most recently updated 'open' topic, or null.
 */
export function getActiveTopic(
  projectUuid: string,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectUuid) as { topic_id: string } | undefined;
    return row ? row.topic_id : null;
  } catch (e) {
    console.warn(`getActiveTopic: ${e}`);
    return null;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Insert or update a project topic.
 *
 * If the (uuid, topic_id) pair does not exist, create it with status='open'.
 * If it does exist, set status='open' and update summary (non-empty only) and source.
 */
export function createOrUpdateTopic(
  projectUuid: string,
  topicId: string,
  summary: string = "",
  source: string = "auto",
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        `INSERT INTO project_topics (uuid, topic_id, status, summary, source, last_accessed_at)
         VALUES (?, ?, 'open', ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', summary=COALESCE(NULLIF(excluded.summary, ''), summary), source=excluded.source, last_accessed_at=CURRENT_TIMESTAMP`
      )
      .run(projectUuid, topicId, summary, source);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Close all open topics for a project and open the given new_topic_id.
 *
 * All existing topics with this uuid are set to status='closed', then
 * new_topic_id is inserted or re-opened.
 */
export function switchTopic(
  projectUuid: string,
  newTopicId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare("UPDATE project_topics SET status='closed' WHERE uuid=?")
      .run(projectUuid);
    db
      .prepare(
        `INSERT INTO project_topics (uuid, topic_id, status, last_accessed_at) VALUES (?, ?, 'open', CURRENT_TIMESTAMP)
         ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', last_accessed_at=CURRENT_TIMESTAMP`
      )
      .run(projectUuid, newTopicId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Mark a specific topic as closed manually.
 */
export function closeTopic(
  projectUuid: string,
  topicId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "UPDATE project_topics SET status='closed', source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
      )
      .run(projectUuid, topicId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * List all topics for a project, ordered by created_at DESC.
 *
 * Returns [{topicId, status, summary}]
 */
export function getTopicsByUuid(
  projectUuid: string,
  conn?: Database
): TopicRow[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare(
        "SELECT topic_id, status, summary FROM project_topics WHERE uuid=? ORDER BY created_at DESC"
      )
      .all(projectUuid) as Array<{
      topic_id: string;
      status: string;
      summary: string;
    }>;
    return rows.map((r) => ({
      topicId: r.topic_id,
      status: r.status,
      summary: r.summary,
    }));
  } catch (e) {
    console.warn(`getTopicsByUuid: ${e}`);
    return [];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Mark a topic's source as 'manual' (user-initiated) and bump last_accessed_at.
 */
export function touchTopicSourceManual(
  projectUuid: string,
  topicId: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "UPDATE project_topics SET source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
      )
      .run(projectUuid, topicId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Merge physical file paths into the associated_files JSON array for a topic.
 *
 * Each physical file is added as {"file": "<path>", "source": "physical"}.
 * If the file already exists with a non-physical source, ", physical" is appended.
 * The entire operation runs inside an EXCLUSIVE transaction.
 */
export function mergePhysicalFilesToTopic(
  projectUuid: string,
  topicId: string,
  physicalFiles: string[],
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const begin = db.prepare("BEGIN EXCLUSIVE");
    begin.run();
    try {
      const row = db
        .prepare(
          "SELECT associated_files FROM project_topics WHERE uuid=? AND topic_id=?"
        )
        .get(projectUuid, topicId) as
        | { associated_files: string | null }
        | undefined;
      const existingAssocJson =
        row && row.associated_files ? row.associated_files : "[]";
      let existingAssoc: Array<{ file: string; source: string }> = [];
      try {
        existingAssoc = JSON.parse(existingAssocJson);
      } catch {
        existingAssoc = [];
      }

      const assocDict: Record<string, { file: string; source: string }> = {};
      for (const item of existingAssoc) {
        if (item.file) {
          assocDict[item.file] = item;
        }
      }
      for (const pf of physicalFiles) {
        if (!(pf in assocDict)) {
          assocDict[pf] = { file: pf, source: "physical" };
        } else if (!assocDict[pf].source.includes("physical")) {
          assocDict[pf].source = assocDict[pf].source + ", physical";
        }
      }

      db
        .prepare(
          "UPDATE project_topics SET associated_files=? WHERE uuid=? AND topic_id=?"
        )
        .run(JSON.stringify(Object.values(assocDict)), projectUuid, topicId);

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Returns topic_id of the currently open topic for this project, or null.
 *
 * This variant accepts an external conn parameter for use within
 * larger transactions.
 */
export function getOpenTopic(
  projectUuid: string,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectUuid) as { topic_id: string } | undefined;
    return row ? row.topic_id : null;
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Returns (associated_files, referenced_files) for a topic.
 *
 * Returns [associatedFilesJson, referencedFilesJson] — either may be null
 * if the row or column is absent.
 */
export function getTopicFiles(
  projectUuid: string,
  topicId: string,
  conn?: Database
): [string | null, string | null] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT associated_files, referenced_files FROM project_topics WHERE uuid=? AND topic_id=?"
      )
      .get(projectUuid, topicId) as
      | { associated_files: string | null; referenced_files: string | null }
      | undefined;
    return row
      ? [row.associated_files, row.referenced_files]
      : [null, null];
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Update both associated_files and referenced_files for a topic,
 * and bump last_accessed_at.
 */
export function updateTopicFiles(
  projectUuid: string,
  topicId: string,
  associatedFiles: string,
  referencedFiles: string,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        "UPDATE project_topics SET associated_files=?, referenced_files=?, last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
      )
      .run(associatedFiles, referencedFiles, projectUuid, topicId);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Upsert a topic with summary and compression confidence.
 *
 * Uses INSERT ON CONFLICT to either create a new topic (source='auto')
 * or update the existing one's summary and confidence.
 */
export function upsertTopic(
  projectUuid: string,
  topicId: string,
  summary: string,
  confidence: number,
  conn?: Database
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db
      .prepare(
        `INSERT INTO project_topics (uuid, topic_id, summary, compression_confidence, source)
         VALUES (?, ?, ?, ?, 'auto')
         ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?, compression_confidence=?`
      )
      .run(projectUuid, topicId, summary, confidence, summary, confidence);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Return all distinct project_uuids present in the project_topics table.
 */
export function getAllProjectUuids(
  conn?: Database
): string[] {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const rows = db
      .prepare("SELECT DISTINCT uuid FROM project_topics")
      .all() as Array<{ uuid: string }>;
    return rows.map((r) => r.uuid);
  } finally {
    if (ownConn) db.close();
  }
}

/**
 * Get the created_at timestamp of the currently open topic for a project.
 *
 * Returns the ISO 8601 timestamp string, or null if no open topic exists.
 */
export function getActiveTopicCreatedAt(
  projectUuid: string,
  conn?: Database
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT created_at FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectUuid) as { created_at: string } | undefined;
    return row ? row.created_at : null;
  } catch (e) {
    console.warn(`getActiveTopicCreatedAt: ${e}`);
    return null;
  } finally {
    if (ownConn) db.close();
  }
}
