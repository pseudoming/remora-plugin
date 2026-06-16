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
		try {
			db.prepare("SELECT is_constraint FROM topic_decisions LIMIT 1").run();
		} catch {
			db.exec(
				"ALTER TABLE topic_decisions ADD COLUMN is_constraint INTEGER DEFAULT 0",
			);
			db.exec(`
				UPDATE topic_decisions SET is_constraint = 1
				WHERE user_confirmed = 1 AND (
					decision LIKE '%禁止%' OR
					decision LIKE '%红线%' OR
					decision LIKE '%越权%'
				)
			`);
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
			["source", "TEXT DEFAULT 'auto'"],
		]) {
			try {
				db.prepare(`SELECT ${col} FROM topic_decisions LIMIT 1`).run();
			} catch {
				db.exec(`ALTER TABLE topic_decisions ADD COLUMN ${col} ${colDef}`);
			}
		}

		// Seed global system-wide constraints
		try {
			db.exec(`
				INSERT INTO project_topics (uuid, topic_id, summary, status)
				SELECT 'global', 't_global_rules', 'Global System Rules', 'open'
				WHERE NOT EXISTS (SELECT 1 FROM project_topics WHERE uuid = 'global' AND topic_id = 't_global_rules')
			`);

			const seedRules = [
				{ decision: '写完代码不自动 commit', rationale: '防止污染代码库历史' },
				{ decision: '不在 Hook payload 注入自定义字段', rationale: '遵循 Hook Schema Strictness，防止 JSON 解析崩溃' },
				{ decision: '临时脚本用完即删', rationale: '保持环境卫生，防止垃圾脚本残留' },
				{ decision: 'Seed 数据脚本必须存在门控校验', rationale: '防止无限制修改开发期数据库数据' },
			];

			const stmt = db.prepare(`
				INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale, user_confirmed, is_constraint, source, decision_type)
				SELECT 'global', 't_global_rules', 'system_init', ?, ?, 1, 1, 'system', 'approved'
				WHERE NOT EXISTS (
					SELECT 1 FROM topic_decisions
					WHERE project_uuid = 'global' AND decision = ?
				)
			`);
			for (const rule of seedRules) {
				stmt.run(rule.decision, rule.rationale, rule.decision);
			}
		} catch (e) {
			console.error("[Remora Schema Error] Failed to seed global constraints:", e);
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
