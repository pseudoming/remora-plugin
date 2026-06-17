import * as fs from "node:fs";
import * as path from "node:path";

export function getDbPath(): string {
	return (
		process.env.REMORA_DB_PATH ??
		process.env.HOME + "/.remora/data/remora_memory.db"
	);
}

export function getConn(): any {
	const dbPath = getDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	let DatabaseConstructor: any;
	try {
		DatabaseConstructor = require("better-sqlite3");
	} catch (err: any) {
		throw new Error(
			`[Remora DB Loader] Failed to load better-sqlite3 native bindings: ${err.message}`
		);
	}

	const Database =
		(DatabaseConstructor && (DatabaseConstructor as any).default) ||
		DatabaseConstructor;

	const conn = new Database(dbPath, { timeout: 15000 });
	conn.exec(
		"PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -2000;",
	);
	return conn;
}

export function checkDbExists(): boolean {
	try {
		const stat = fs.statSync(getDbPath());
		return stat.isFile();
	} catch {
		return false;
	}
}
