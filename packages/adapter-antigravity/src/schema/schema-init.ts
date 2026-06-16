import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import { getDbPath } from "../bridge/paths";

function initDb(): void {
	const dbPath = getDbPath();
	const schemaPath = path.join(__dirname, "schema.sql");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath, { timeout: 15000 });

	try {
		db.exec(fs.readFileSync(schemaPath, "utf-8"));

		try {
			db.prepare("SELECT user_confirmed FROM topic_decisions LIMIT 1").run();
		} catch {
			db.exec(
				"ALTER TABLE topic_decisions ADD COLUMN user_confirmed INTEGER DEFAULT 0",
			);
		}
		try {
			db.prepare("SELECT injected_count FROM topic_decisions LIMIT 1").run();
		} catch {
			db.exec(
				"ALTER TABLE topic_decisions ADD COLUMN injected_count INTEGER DEFAULT 0",
			);
		}
		try {
			db.prepare("SELECT last_injected_at FROM topic_decisions LIMIT 1").run();
		} catch {
			db.exec("ALTER TABLE topic_decisions ADD COLUMN last_injected_at TEXT");
		}
		try {
			db.prepare(
				"SELECT compressed_summary FROM topic_decisions LIMIT 1",
			).run();
		} catch {
			db.exec("ALTER TABLE topic_decisions ADD COLUMN compressed_summary TEXT");
		}

		for (const [col, colDef] of [
			["source", "TEXT DEFAULT 'auto'"],
			["last_accessed_at", "TIMESTAMP DEFAULT '2026-06-05 00:00:00'"],
			["associated_files", "TEXT DEFAULT '[]'"],
			["referenced_files", "TEXT DEFAULT '[]'"],
		]) {
			try {
				db.prepare(`SELECT ${col} FROM project_topics LIMIT 1`).run();
			} catch {
				db.exec(`ALTER TABLE project_topics ADD COLUMN ${col} ${colDef}`);
			}
		}

		db.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        mode TEXT DEFAULT 'relax',
        is_cold_start INTEGER DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

		db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_hook_state (
        session_id TEXT NOT NULL,
        turn_idx INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (session_id, turn_idx, key)
      )
    `);

		for (const [col, colDef] of [
			["decision_type", "TEXT DEFAULT 'approved'"],
			["associated_files", "TEXT DEFAULT '[]'"],
			["updated_at", "TIMESTAMP DEFAULT '2026-06-05 00:00:00'"],
		]) {
			try {
				db.prepare(`SELECT ${col} FROM topic_decisions LIMIT 1`).run();
			} catch {
				db.exec(`ALTER TABLE topic_decisions ADD COLUMN ${col} ${colDef}`);
			}
		}

		try {
			db.prepare("SELECT last_msg_id FROM watermarks LIMIT 1").run();
		} catch {
			db.exec(
				"ALTER TABLE watermarks ADD COLUMN last_msg_id INTEGER DEFAULT 0",
			);
		}
	} finally {
		db.close();
	}
}

export { initDb };
