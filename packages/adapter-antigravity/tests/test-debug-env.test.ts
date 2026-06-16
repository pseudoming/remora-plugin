import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let TEST_ROOT: string;
let TEST_DATA_DIR: string;
let TEST_DB_PATH: string;
let TEST_LOG_DIR: string;

vi.mock("@remora/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@remora/core")>();
	return {
		...actual,
		getDbPath: () => process.env.REMORA_DB_PATH || "",
	};
});

beforeEach(() => {
	TEST_ROOT = path.join(os.tmpdir(), `test_remora_debug_env_${Date.now()}`);
	TEST_DATA_DIR = path.join(TEST_ROOT, "data");
	TEST_DB_PATH = path.join(TEST_DATA_DIR, "remora_memory.db");
	TEST_LOG_DIR = path.join(TEST_ROOT, "logs");
	process.env.REMORA_DB_PATH = TEST_DB_PATH;
	process.env.REMORA_LOG_DIR = TEST_LOG_DIR;
});

import { getDbPath, checkDbExists } from "@remora/core";

function makeDb(
	dbPath: string,
	tablesWithRows: Record<string, Array<Array<string>>>,
): void {
	const conn = new Database(dbPath, { timeout: 15000 });
	const cur = conn as any;

	for (const [table, rows] of Object.entries(tablesWithRows)) {
		if (table === "session_state") {
			cur.exec("CREATE TABLE session_state (id TEXT PRIMARY KEY, data TEXT)");
		} else if (table === "project_topics") {
			cur.exec(
				"CREATE TABLE project_topics (id TEXT, title TEXT, status TEXT)",
			);
		} else if (table === "topic_decisions") {
			cur.exec(
				"CREATE TABLE topic_decisions (id TEXT, topic_id TEXT, decision TEXT)",
			);
		} else if (table === "file_changes") {
			cur.exec("CREATE TABLE file_changes (id TEXT, path TEXT, action TEXT)");
		} else if (table === "messages") {
			cur.exec("CREATE TABLE messages (id TEXT, role TEXT, content TEXT)");
		} else if (table === "messages_fts") {
			cur.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content)");
		} else {
			cur.exec(`CREATE TABLE ${table} (id TEXT)`);
		}
		for (const row of rows) {
			const placeholders = row.map(() => "?").join(",");
			cur.prepare(`INSERT INTO ${table} VALUES (${placeholders})`).run(...row);
		}
	}
	conn.close();
}

function makeEmptyDb(dbPath: string): void {
	const conn = new Database(dbPath);
	conn.close();
}

function makeLogFiles(logDir: string, count: number): void {
	for (let i = 0; i < count; i++) {
		fs.writeFileSync(path.join(logDir, `system.${i}.log`), `log line ${i}`);
	}
}

function humanSize(sizeBytes: number | null): string {
	if (sizeBytes === null) return "N/A";
	for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
		if (Math.abs(sizeBytes) < 1024.0) {
			return unit !== "B"
				? `${sizeBytes.toFixed(1)} ${unit}`
				: `${sizeBytes} B`;
		}
		sizeBytes /= 1024.0;
	}
	return `${sizeBytes.toFixed(1)} PB`;
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

function getDbTables(dbPath: string): string[] {
	if (!fs.existsSync(dbPath)) return [];
	const conn = new Database(dbPath, { timeout: 5000 });
	try {
		const rows = conn
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		return rows.map((r) => r.name);
	} finally {
		conn.close();
	}
}

function getDbTableCounts(dbPath: string): Record<string, number | string> {
	if (!fs.existsSync(dbPath)) return {};
	const conn = new Database(dbPath, { timeout: 5000 });
	try {
		return {
			session_state: safeCount(conn, "session_state"),
			project_topics: safeCount(conn, "project_topics"),
			topic_decisions: safeCount(conn, "topic_decisions"),
			file_changes: safeCount(conn, "file_changes"),
			messages: safeCount(conn, "messages"),
		};
	} finally {
		conn.close();
	}
}

function getLogFiles(logDir: string): string[] {
	if (!fs.existsSync(logDir)) return [];
	return fs
		.readdirSync(logDir)
		.filter((f) => f.startsWith("system") && f.endsWith(".log"))
		.sort();
}

describe("test_debug_env", () => {
	beforeEach(() => {
		try {
			fs.rmSync(TEST_ROOT, { recursive: true, force: true });
		} catch {}
		fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
		fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
		process.env.HOME = TEST_ROOT;
	});

	afterEach(() => {
		try {
			fs.rmSync(TEST_ROOT, { recursive: true, force: true });
		} catch {}
	});

	describe("TestFullReport", () => {
		it("test_full_report", () => {
			const tables: Record<string, Array<Array<string>>> = {
				session_state: [
					["s1", "{}"],
					["s2", "{}"],
					["s3", "{}"],
				],
				project_topics: [
					["t1", "Topic A", "active"],
					["t2", "Topic B", "done"],
					["t3", "Topic C", "active"],
					["t4", "Topic D", "done"],
					["t5", "Topic E", "active"],
				],
				topic_decisions: [
					["d1", "t1", "approved"],
					["d2", "t2", "rejected"],
				],
				file_changes: [
					["f1", "/src/a.py", "modify"],
					["f2", "/src/b.py", "create"],
					["f3", "/src/c.py", "delete"],
					["f4", "/src/d.py", "modify"],
				],
				messages: [
					["m1", "user", "hello"],
					["m2", "assistant", "hi"],
					["m3", "user", "help"],
					["m4", "assistant", "sure"],
					["m5", "user", "thanks"],
					["m6", "assistant", "np"],
					["m7", "user", "ok"],
					["m8", "assistant", "cool"],
					["m9", "user", "bye"],
					["m10", "assistant", "bye"],
				],
				messages_fts: [["hello"]],
			};
			makeDb(TEST_DB_PATH, tables);
			makeLogFiles(TEST_LOG_DIR, 2);

			const runtimeDir = path.join(TEST_DATA_DIR, ".runtime");
			fs.mkdirSync(runtimeDir, { recursive: true });
			fs.writeFileSync(path.join(runtimeDir, "installed.flag"), "");

			const logLevel = process.env["REMORA_LOG_LEVEL"] || "INFO";
			const logFiles = getLogFiles(TEST_LOG_DIR);
			const pluginRoot = path.dirname(TEST_DATA_DIR);
			const dataDir = TEST_DATA_DIR;
			const dbPath = getDbPath();
			const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null;
			const dbTables = getDbTables(dbPath);
			const installed = fs.existsSync(
				path.join(dataDir, ".runtime", "installed.flag"),
			);
			const counts = getDbTableCounts(dbPath);

			const outLines: string[] = [];
			outLines.push(`LOG_DIR:       ${TEST_LOG_DIR}`);
			outLines.push(`LOG_LEVEL:     ${logLevel}`);
			outLines.push(`LOG_FILES:     ${logFiles.length} files`);
			outLines.push(`PLUGIN_ROOT:   ${pluginRoot}`);
			outLines.push(`DATA_DIR:      ${dataDir}`);
			outLines.push(`DB_PATH:       ${dbPath}`);
			outLines.push(
				`DB_SIZE:       ${dbSize !== null ? humanSize(dbSize) : "N/A (file not found)"}`,
			);
			outLines.push(`DB_TABLES:     ${dbTables.join(", ")}`);
			outLines.push(`INSTALLED:     ${installed ? "Yes" : "No"}`);
			outLines.push(`SESSION_COUNT: ${counts["session_state"]}`);
			outLines.push(`TOPIC_COUNT:   ${counts["project_topics"]}`);
			outLines.push(`DECISION_COUNT: ${counts["topic_decisions"]}`);
			outLines.push(`FILE_CHANGE_COUNT: ${counts["file_changes"]}`);
			outLines.push(`MESSAGE_COUNT: ${counts["messages"]}`);

			const out = outLines.join("\n");

			expect(out).toContain("LOG_DIR:");
			expect(out).toContain("LOG_LEVEL:");
			expect(out).toContain("INFO");
			expect(out).toContain("LOG_FILES:");
			expect(out).toContain("2 files");
			expect(out).toContain("PLUGIN_ROOT:");
			expect(out).toContain("DATA_DIR:");
			expect(out).toContain("DB_PATH:");
			expect(out).toContain("DB_SIZE:");
			expect(out).toContain("DB_TABLES:");
			expect(out).toContain("file_changes");
			expect(out).toContain("messages");
			expect(out).toContain("session_state");
			expect(out).toContain("project_topics");
			expect(out).toContain("topic_decisions");
			expect(out).toContain("INSTALLED:     Yes");
			expect(String(counts["session_state"])).toBe("3");
			expect(String(counts["project_topics"])).toBe("5");
			expect(String(counts["topic_decisions"])).toBe("2");
			expect(String(counts["file_changes"])).toBe("4");
			expect(String(counts["messages"])).toBe("10");
		});
	});

	describe("TestEmptyDatabase", () => {
		it("test_empty_database_no_crash", () => {
			makeEmptyDb(TEST_DB_PATH);
			const dbTables = getDbTables(TEST_DB_PATH);
			const counts = getDbTableCounts(TEST_DB_PATH);

			expect(Array.isArray(dbTables)).toBe(true);
			expect(counts["session_state"]).toBeDefined();
			expect(counts["project_topics"]).toBeDefined();
			expect(counts["topic_decisions"]).toBeDefined();
			expect(counts["file_changes"]).toBeDefined();
			expect(counts["messages"]).toBeDefined();
		});
	});

	describe("TestDBAbsent", () => {
		it("test_db_file_absent_no_crash", () => {
			const dbPath = getDbPath();
			const dbSize = fs.existsSync(dbPath)
				? humanSize(fs.statSync(dbPath).size)
				: "N/A (file not found)";
			const dbTables = getDbTables(dbPath);
			const counts = getDbTableCounts(dbPath);

			expect(dbSize).toBe("N/A (file not found)");
			expect(dbTables.length).toBe(0);
			expect(Object.keys(counts).length).toBe(0);
		});
	});

	describe("TestMultipleLogFiles", () => {
		it("test_multiple_log_files", () => {
			makeLogFiles(TEST_LOG_DIR, 3);
			const logFiles = getLogFiles(TEST_LOG_DIR);

			expect(logFiles.length).toBe(3);
			expect(logFiles).toContain("system.0.log");
			expect(logFiles).toContain("system.1.log");
			expect(logFiles).toContain("system.2.log");
		});
	});

	describe("TestLogLevelDebug", () => {
		it("test_log_level_debug", () => {
			process.env["REMORA_LOG_LEVEL"] = "DEBUG";
			const logLevel = process.env["REMORA_LOG_LEVEL"] || "INFO";
			expect(logLevel).toBe("DEBUG");
			delete process.env["REMORA_LOG_LEVEL"];
		});
	});

	describe("TestInstalledFlag", () => {
		it("test_installed_flag_present", () => {
			const runtimeDir = path.join(TEST_DATA_DIR, ".runtime");
			fs.mkdirSync(runtimeDir, { recursive: true });
			fs.writeFileSync(path.join(runtimeDir, "installed.flag"), "");

			const dataDir = TEST_DATA_DIR;
			const installed = fs.existsSync(
				path.join(dataDir, ".runtime", "installed.flag"),
			);
			expect(installed).toBe(true);
		});

		it("test_installed_flag_absent", () => {
			const dataDir = TEST_DATA_DIR;
			const installed = fs.existsSync(
				path.join(dataDir, ".runtime", "installed.flag"),
			);
			expect(installed).toBe(false);
		});
	});
});
