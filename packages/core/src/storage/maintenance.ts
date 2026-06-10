import Database from "better-sqlite3";
import { getConn } from "./connection";

/**
 * 静默清理 source='auto' 且 status='closed' 且 last_accessed_at 早于 72 小时前，
 * 且该话题下没有任何 user_confirmed = 1 的决策的话题。
 */
export function runTopicGarbageCollection(conn?: Database.Database): void {
  try {
    const db = conn ?? getConn();
    const ownConn = !conn;
    try {
      // Obtain EXCLUSIVE lock immediately to prevent Lock Upgrade Deadlocks in daemons
      db.prepare("BEGIN EXCLUSIVE").run();
      const toDelete = db
        .prepare(
          `SELECT pt.uuid, pt.topic_id FROM project_topics pt
           WHERE pt.source = 'auto' AND pt.status = 'closed'
             AND pt.topic_id NOT IN (
                 SELECT DISTINCT topic_id FROM topic_decisions WHERE user_confirmed = 1 AND project_uuid = pt.uuid
             )
             AND (
                 COALESCE(
                     (SELECT MAX(td.created_at) 
                      FROM topic_decisions td 
                      WHERE td.project_uuid = pt.uuid AND td.topic_id = pt.topic_id),
                     pt.last_accessed_at
                 ) < datetime('now', '-72 hours')
             )`
        )
        .all() as { uuid: string; topic_id: string }[];
      for (const row of toDelete) {
        db
          .prepare("DELETE FROM topic_decisions WHERE project_uuid=? AND topic_id=?")
          .run(row.uuid, row.topic_id);
        db
          .prepare("DELETE FROM project_topics WHERE uuid=? AND topic_id=?")
          .run(row.uuid, row.topic_id);
        console.log(
          `[Remora GC] Pruned cold auto topic: ${row.topic_id} in project ${row.uuid}`
        );
      }
      db.prepare("COMMIT").run();
    } finally {
      if (ownConn) db.close();
    }
  } catch (e) {
    console.warn(`topic garbage collection: ${e}`);
    process.exit(1);
  }
}

/**
 * 定期清理已失效的水印和关联数据。
 */
export function pruneExpiredWatermarks(
  brainDir: string,
  conn?: Database.Database,
): void {
  try {
    const db = conn ?? getConn();
    const ownConn = !conn;
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      if (!fs.statSync(brainDir).isDirectory()) {
        console.warn(
          `Invalid brain_dir ${brainDir}, aborting prune to prevent data loss.`
        );
        return;
      }

      // First query without exclusive lock
      const activeDbConvs = db
        .prepare(
          `SELECT w.conversation_id 
           FROM watermarks w
           LEFT JOIN messages m ON w.last_msg_id = m.id
           WHERE COALESCE(m.timestamp, w.last_updated) < datetime('now', '-30 days')
           OR NOT EXISTS (SELECT 1 FROM session_state ss WHERE ss.session_id = w.conversation_id)`
        )
        .all() as { conversation_id: string }[];
      const convIds = activeDbConvs.map((r) => r.conversation_id);

      const toDelete: [string, string][] = [];
      for (const convId of convIds) {
        if (convId.startsWith("artifact_sync_")) {
          continue;
        }
        const convDir = path.join(brainDir, convId);

        if (!fs.existsSync(convDir)) {
          toDelete.push([convId, "文件缺失"]);
        } else {
          const res = db
            .prepare(
              `SELECT 1 FROM watermarks w
               LEFT JOIN messages m ON w.last_msg_id = m.id
               WHERE w.conversation_id = ? 
               AND COALESCE(m.timestamp, w.last_updated) < datetime('now', '-30 days')
               AND NOT EXISTS (SELECT 1 FROM session_state ss WHERE ss.session_id = w.conversation_id)`
            )
            .get(convId);
          if (res) {
            toDelete.push([convId, "超期不活跃"]);
          }
        }
      }

      if (toDelete.length > 0) {
        db.prepare("BEGIN EXCLUSIVE").run();
        for (const [convId, reason] of toDelete) {
          db
            .prepare("DELETE FROM watermarks WHERE conversation_id=?")
            .run(convId);
          db
            .prepare("DELETE FROM messages WHERE conversation_id=?")
            .run(convId);
          db
            .prepare("DELETE FROM topic_decisions WHERE conversation_id=?")
            .run(convId);
          console.log(
            `[Remora] 水印回收已清除会话 (${reason}): ${convId}`
          );
        }
        db.prepare("COMMIT").run();
      }
    } finally {
      if (ownConn) db.close();
    }
  } catch (e) {
    console.warn(`pruning expired watermarks: ${e}`);
    process.exit(1);
  }
}

export function cleanupGhostMessages(conn?: Database.Database): number {
  try {
    const db = conn ?? getConn();
    const ownConn = !conn;
    try {
      db.prepare("BEGIN EXCLUSIVE").run();
      const result = db
        .prepare(
          "DELETE FROM messages WHERE role IS NULL OR role = '' OR content IS NULL OR content = ''"
        )
        .run();
      const deleted = result.changes;
      if (deleted > 0) {
        db
          .prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
          .run();
      }
      db.prepare("COMMIT").run();
      return deleted;
    } finally {
      if (ownConn) db.close();
    }
  } catch (e) {
    console.warn(`cleanupGhostMessages: ${e}`);
    return 0;
  }
}
