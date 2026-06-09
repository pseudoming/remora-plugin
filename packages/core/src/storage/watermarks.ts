import Database from "better-sqlite3";
import { getConn } from "./connection";

export function getProjectUuidByConv(sessionId: string, conn?: any): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db.prepare(
      "SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1"
    ).get(sessionId) as { project_uuid: string | null } | undefined;
    return row ? row.project_uuid : null;
  } catch (e) {
    console.warn(`getProjectUuidByConv: ${e}`);
    return null;
  } finally {
    if (ownConn) db.close();
  }
}

export function watermarkExists(projectUuid: string, conversationId: string, conn?: any): boolean {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db.prepare(
      "SELECT 1 FROM watermarks WHERE project_uuid=? AND conversation_id=? LIMIT 1"
    ).get(projectUuid, conversationId);
    return row !== undefined;
  } catch (e) {
    console.warn(`watermarkExists: ${e}`);
    return false;
  } finally {
    if (ownConn) db.close();
  }
}

export function getActiveTopicCreatedAt(projectUuid: string, conn?: any): string | null {
  const { getActiveTopicCreatedAt: impl } = require("./topics");
  return impl(projectUuid, conn);
}
