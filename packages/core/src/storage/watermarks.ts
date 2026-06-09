import Database from "better-sqlite3";

export function getProjectUuidByConv(conn: Database.Database, sessionId: string): string | null {
  try {
    const row = conn.prepare(
      "SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1"
    ).get(sessionId) as { project_uuid: string | null } | undefined;
    return row ? row.project_uuid : null;
  } catch (e) {
    console.warn(`getProjectUuidByConv: ${e}`);
    return null;
  }
}

export function watermarkExists(conn: Database.Database, projectUuid: string, conversationId: string): boolean {
  try {
    const row = conn.prepare(
      "SELECT 1 FROM watermarks WHERE project_uuid=? AND conversation_id=? LIMIT 1"
    ).get(projectUuid, conversationId);
    return row !== undefined;
  } catch (e) {
    console.warn(`watermarkExists: ${e}`);
    return false;
  }
}

export function getActiveTopicCreatedAt(conn: Database.Database, projectUuid: string): string | null {
  const { getActiveTopicCreatedAt: impl } = require("./topics");
  return impl(conn, projectUuid);
}
