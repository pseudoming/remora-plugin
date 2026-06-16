import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

import { findPluginRoot, getDataDir } from "../bridge/paths";
import { getDbPath } from "@remora/core";

const LOG_DIR = process.env.REMORA_LOG_DIR ?? "/tmp/remora/log";

function humanSize(sizeBytes: number | null): string {
	if (sizeBytes === null) return "N/A";
	let bytes = sizeBytes;
	for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
		if (Math.abs(bytes) < 1024.0) {
			return unit !== "B" ? `${bytes.toFixed(1)} ${unit}` : `${bytes} B`;
		}
		bytes /= 1024.0;
	}
	return `${bytes.toFixed(1)} PB`;
}

function safeCount(conn: Database.Database, table: string): number | string {
	try {
		const row = conn.prepare(`SELECT COUNT(*) FROM ${table}`).get() as
			| { "COUNT(*)": number }
			| undefined;
		return row ? row["COUNT(*)"] : 0;
	} catch {
		return "N/A";
	}
}

export function main(): void {
	console.log("=== Remora Environment ===");

	// ── LOG_DIR ──
	console.log(`LOG_DIR:       ${LOG_DIR}`);

	// ── LOG_LEVEL ──
	const logLevel = process.env["REMORA_LOG_LEVEL"] ?? "INFO";
	console.log(
		`LOG_LEVEL:     ${logLevel} (from REMORA_LOG_LEVEL env, default INFO)`,
	);

	// ── LOG_FILES ──
	try {
		const logFiles = fs
			.readdirSync(LOG_DIR)
			.filter((f) => f.startsWith("system") && f.endsWith(".log"))
			.sort();
		const logCount = logFiles.length;
		const names = logFiles.join(", ");
		console.log(`LOG_FILES:     ${logCount} files (${names})`);
	} catch {
		console.log("LOG_FILES:     N/A");
	}

	// ── PLUGIN_ROOT / DATA_DIR / DB_PATH ──
	let pluginRoot: string;
	let dataDir: string;
	let dbPath: string;
	try {
		pluginRoot = findPluginRoot();
		dataDir = getDataDir();
		dbPath = getDbPath();
	} catch {
		pluginRoot = "N/A";
		dataDir = "N/A";
		dbPath = "N/A";
	}

	console.log(`PLUGIN_ROOT:   ${pluginRoot}`);
	console.log(`DATA_DIR:      ${dataDir}`);
	console.log(`DB_PATH:       ${dbPath}`);

	// ── DB_SIZE ──
	try {
		if (fs.existsSync(dbPath)) {
			const sizeBytes = fs.statSync(dbPath).size;
			console.log(`DB_SIZE:       ${humanSize(sizeBytes)}`);
		} else {
			console.log("DB_SIZE:       N/A (file not found)");
		}
	} catch {
		console.log("DB_SIZE:       N/A");
	}

	// ── DB_TABLES ──
	try {
		if (fs.existsSync(dbPath)) {
			const conn = new Database(dbPath, { readonly: true });
			try {
				const rows = conn
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
					)
					.all() as Array<{ name: string }>;
				const skipPrefixes = ["sqlite_", "messages_fts_"];
				const tableNames: string[] = [];
				let hasFts = false;
				for (const r of rows) {
					if (r.name === "messages_fts") {
						hasFts = true;
						continue;
					}
					if (!skipPrefixes.some((p) => r.name.startsWith(p))) {
						tableNames.push(r.name);
					}
				}
				let display = tableNames.join(", ");
				if (hasFts) {
					display += ", ...";
				}
				console.log(`DB_TABLES:     ${display}`);
			} finally {
				conn.close();
			}
		} else {
			console.log("DB_TABLES:     N/A (DB not found)");
		}
	} catch {
		console.log("DB_TABLES:     N/A");
	}

	// ── INSTALLED ──
	try {
		const flagPath = path.join(dataDir, ".runtime", "installed.flag");
		if (fs.existsSync(flagPath)) {
			console.log(`INSTALLED:     Yes (${flagPath})`);
		} else {
			console.log("INSTALLED:     No");
		}
	} catch {
		console.log("INSTALLED:     N/A");
	}

	// ── TABLE COUNTS ──
	try {
		if (fs.existsSync(dbPath)) {
			const conn = new Database(dbPath, { readonly: true });
			try {
				const sc = safeCount(conn, "session_state");
				const tc = safeCount(conn, "project_topics");
				const dc = safeCount(conn, "topic_decisions");
				const fc = safeCount(conn, "file_changes");
				const mc = safeCount(conn, "messages");
				console.log();
				console.log(`SESSION_COUNT: ${sc} (from session_state table)`);
				console.log(`TOPIC_COUNT:   ${tc} (from project_topics)`);
				console.log(`DECISION_COUNT: ${dc} (from topic_decisions)`);
				console.log(`FILE_CHANGE_COUNT: ${fc} (from file_changes)`);
				console.log(`MESSAGE_COUNT: ${mc} (from messages)`);
			} finally {
				conn.close();
			}
		} else {
			console.log();
			console.log("SESSION_COUNT: N/A (DB not found)");
			console.log("TOPIC_COUNT:   N/A (DB not found)");
			console.log("DECISION_COUNT: N/A (DB not found)");
			console.log("FILE_CHANGE_COUNT: N/A (DB not found)");
			console.log("MESSAGE_COUNT: N/A (DB not found)");
		}
	} catch {
		console.log();
		console.log("SESSION_COUNT: N/A");
		console.log("TOPIC_COUNT:   N/A");
		console.log("DECISION_COUNT: N/A");
		console.log("FILE_CHANGE_COUNT: N/A");
		console.log("MESSAGE_COUNT: N/A");
	}
}
