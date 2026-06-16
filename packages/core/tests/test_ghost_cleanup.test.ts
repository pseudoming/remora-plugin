import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";

const txPath = path.join(os.tmpdir(), `test_ghost_${Date.now()}.db`);

vi.mock("../src/storage/connection", () => {
	const Database = require("better-sqlite3");
	return {
		getDbPath: () => txPath,
		getConn: () => new Database(txPath, { timeout: 15000 }),
		checkDbExists: () => {
			try {
				return require("node:fs").statSync(txPath).isFile();
			} catch {
				return false;
			}
		},
	};
});

import { cleanupGhostMessages } from "../src/storage/maintenance";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      timestamp TIMESTAMP,
      role TEXT,
      content TEXT,
      topic_id TEXT,
      UNIQUE(conversation_id, line_number)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content=messages, content_rowid=id, tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
`;

function createTestDb(): Database.Database {
	const db = new Database(txPath);
	db.exec("DELETE FROM messages");
	db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
	return db;
}

// test_fix_db_no_ghost_records
describe("fix_db", () => {
	beforeAll(() => {
		const db = new Database(txPath);
		db.exec(SCHEMA);
		db.close();
	});

	it("no ghost records", () => {
		const db = createTestDb();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')",
		).run();

		const count = cleanupGhostMessages();
		expect(count).toBe(0);

		const rows = db.prepare("SELECT * FROM messages").all();
		expect(rows.length).toBe(1);

		db.close();
	});

	// test_fix_db_with_ghost_records
	it("with ghost records", () => {
		const db = createTestDb();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 1, 'user', 'hello')",
		).run();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 2, NULL, 'ghost role null')",
		).run();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 3, '', 'ghost role empty')",
		).run();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 4, 'assistant', NULL)",
		).run();
		db.prepare(
			"INSERT INTO messages (conversation_id, line_number, role, content) VALUES ('conv1', 5, 'assistant', '')",
		).run();

		const count = cleanupGhostMessages();
		expect(count).toBe(4);

		const rows = db.prepare("SELECT id FROM messages").all();
		expect(rows.length).toBe(1);

		db.close();
	});
});
