import Database from "better-sqlite3";

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
  conn: Database.Database,
  projectUuid: string
): string | null {
  try {
    const row = conn
      .prepare(
        "SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectUuid) as { topic_id: string } | undefined;
    return row ? row.topic_id : null;
  } catch (e) {
    console.warn(`getActiveTopic: ${e}`);
    return null;
  }
}

/**
 * Insert or update a project topic.
 *
 * If the (uuid, topic_id) pair does not exist, create it with status='open'.
 * If it does exist, set status='open' and update summary (non-empty only) and source.
 */
export function createOrUpdateTopic(
  conn: Database.Database,
  projectUuid: string,
  topicId: string,
  summary: string = "",
  source: string = "auto"
): void {
  conn
    .prepare(
      `INSERT INTO project_topics (uuid, topic_id, status, summary, source, last_accessed_at)
       VALUES (?, ?, 'open', ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', summary=COALESCE(NULLIF(excluded.summary, ''), summary), source=excluded.source, last_accessed_at=CURRENT_TIMESTAMP`
    )
    .run(projectUuid, topicId, summary, source);
}

/**
 * Close all open topics for a project and open the given new_topic_id.
 *
 * All existing topics with this uuid are set to status='closed', then
 * new_topic_id is inserted or re-opened.
 */
export function switchTopic(
  conn: Database.Database,
  projectUuid: string,
  newTopicId: string
): void {
  conn
    .prepare("UPDATE project_topics SET status='closed' WHERE uuid=?")
    .run(projectUuid);
  conn
    .prepare(
      `INSERT INTO project_topics (uuid, topic_id, status, last_accessed_at) VALUES (?, ?, 'open', CURRENT_TIMESTAMP)
       ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', last_accessed_at=CURRENT_TIMESTAMP`
    )
    .run(projectUuid, newTopicId);
}

/**
 * Mark a specific topic as closed manually.
 */
export function closeTopic(
  conn: Database.Database,
  projectUuid: string,
  topicId: string
): void {
  conn
    .prepare(
      "UPDATE project_topics SET status='closed', source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
    )
    .run(projectUuid, topicId);
}

/**
 * List all topics for a project, ordered by created_at DESC.
 *
 * Returns [{topicId, status, summary}]
 */
export function getTopicsByUuid(
  conn: Database.Database,
  projectUuid: string
): TopicRow[] {
  try {
    const rows = conn
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
  }
}

/**
 * Mark a topic's source as 'manual' (user-initiated) and bump last_accessed_at.
 */
export function touchTopicSourceManual(
  conn: Database.Database,
  projectUuid: string,
  topicId: string
): void {
  conn
    .prepare(
      "UPDATE project_topics SET source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
    )
    .run(projectUuid, topicId);
}

/**
 * Merge physical file paths into the associated_files JSON array for a topic.
 *
 * Each physical file is added as {"file": "<path>", "source": "physical"}.
 * If the file already exists with a non-physical source, ", physical" is appended.
 * The entire operation runs inside an EXCLUSIVE transaction.
 */
export function mergePhysicalFilesToTopic(
  conn: Database.Database,
  projectUuid: string,
  topicId: string,
  physicalFiles: string[]
): void {
  const begin = conn.prepare("BEGIN EXCLUSIVE");
  begin.run();
  try {
    const row = conn
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

    conn
      .prepare(
        "UPDATE project_topics SET associated_files=? WHERE uuid=? AND topic_id=?"
      )
      .run(JSON.stringify(Object.values(assocDict)), projectUuid, topicId);

    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Returns topic_id of the currently open topic for this project, or null.
 *
 * This variant accepts an external conn parameter for use within
 * larger transactions.
 */
export function getOpenTopic(
  conn: Database.Database,
  projectUuid: string
): string | null {
  const row = conn
    .prepare(
      "SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
    )
    .get(projectUuid) as { topic_id: string } | undefined;
  return row ? row.topic_id : null;
}

/**
 * Returns (associated_files, referenced_files) for a topic.
 *
 * Returns [associatedFilesJson, referencedFilesJson] — either may be null
 * if the row or column is absent.
 */
export function getTopicFiles(
  conn: Database.Database,
  projectUuid: string,
  topicId: string
): [string | null, string | null] {
  const row = conn
    .prepare(
      "SELECT associated_files, referenced_files FROM project_topics WHERE uuid=? AND topic_id=?"
    )
    .get(projectUuid, topicId) as
    | { associated_files: string | null; referenced_files: string | null }
    | undefined;
  return row
    ? [row.associated_files, row.referenced_files]
    : [null, null];
}

/**
 * Update both associated_files and referenced_files for a topic,
 * and bump last_accessed_at.
 */
export function updateTopicFiles(
  conn: Database.Database,
  projectUuid: string,
  topicId: string,
  associatedFiles: string,
  referencedFiles: string
): void {
  conn
    .prepare(
      "UPDATE project_topics SET associated_files=?, referenced_files=?, last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?"
    )
    .run(associatedFiles, referencedFiles, projectUuid, topicId);
}

/**
 * Upsert a topic with summary and compression confidence.
 *
 * Uses INSERT ON CONFLICT to either create a new topic (source='auto')
 * or update the existing one's summary and confidence.
 */
export function upsertTopic(
  conn: Database.Database,
  projectUuid: string,
  topicId: string,
  summary: string,
  confidence: number
): void {
  conn
    .prepare(
      `INSERT INTO project_topics (uuid, topic_id, summary, compression_confidence, source)
       VALUES (?, ?, ?, ?, 'auto')
       ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?, compression_confidence=?`
    )
    .run(projectUuid, topicId, summary, confidence, summary, confidence);
}

/**
 * Return all distinct project_uuids present in the project_topics table.
 */
export function getAllProjectUuids(conn: Database.Database): string[] {
  const rows = conn
    .prepare("SELECT DISTINCT uuid FROM project_topics")
    .all() as Array<{ uuid: string }>;
  return rows.map((r) => r.uuid);
}

/**
 * Get the created_at timestamp of the currently open topic for a project.
 *
 * Returns the ISO 8601 timestamp string, or null if no open topic exists.
 */
export function getActiveTopicCreatedAt(
  conn: Database.Database,
  projectUuid: string
): string | null {
  try {
    const row = conn
      .prepare(
        "SELECT created_at FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectUuid) as { created_at: string } | undefined;
    return row ? row.created_at : null;
  } catch (e) {
    console.warn(`getActiveTopicCreatedAt: ${e}`);
    return null;
  }
}
