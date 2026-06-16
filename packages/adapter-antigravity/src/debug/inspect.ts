#!/usr/bin/env node
/** CLI tool to inspect remora_memory.db in read-only mode. */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

import {
	getTopicsByUuid,
	getConfirmedDecisions,
	getDecisionsByFile,
	getConn,
	getDbPath,
} from "@remora/core";
import { getDataDir } from "../bridge/paths";

function resolveProjectUuid(args: { project?: string }): string | null {
	const uuid = args.project || process.env.ANTIGRAVITY_PROJECT_ID;
	if (!uuid) {
		process.stderr.write("Set ANTIGRAVITY_PROJECT_ID or use --project UUID\n");
		return null;
	}
	return uuid;
}

function getAllProjectUuidsWithFallback(): string[] {
	try {
		const conn = getConn();
		try {
			let uuids: string[] = [];
			const topicRows = conn
				.prepare("SELECT DISTINCT uuid FROM project_topics")
				.all() as { uuid: string }[];
			uuids = topicRows.map((r) => r.uuid);
			if (!uuids.length) {
				const watermarkRows = conn
					.prepare("SELECT DISTINCT project_uuid FROM watermarks")
					.all() as { project_uuid: string }[];
				uuids = watermarkRows.map((r) => r.project_uuid);
			}
			return uuids;
		} finally {
			conn.close();
		}
	} catch (e) {
		process.stderr.write(`Error querying project uuids: ${e}\n`);
		return [];
	}
}

function cmdTopics(): void {
	const uuids = getAllProjectUuidsWithFallback();
	if (!uuids.length) {
		process.stdout.write("No project_topics found.\n");
		return;
	}

	const lines: string[] = [];
	lines.push(
		`${"UUID".padEnd(36)}  ${"TOPIC_ID".padEnd(50)}  ${"STATUS".padEnd(8)}  SUMMARY`,
	);
	lines.push("-".repeat(120));
	for (const uuid of uuids) {
		const topics = getTopicsByUuid(uuid);
		for (const { topicId, status, summary } of topics) {
			const summaryShort = (summary || "").slice(0, 60);
			lines.push(
				`${uuid.padEnd(36)}  ${topicId.padEnd(50)}  ${status.padEnd(8)}  ${summaryShort}`,
			);
		}
	}
	process.stdout.write(lines.join("\n") + "\n");
}

function cmdDecisions(args: { decisions?: string; project?: string }): void {
	const uuid = resolveProjectUuid(args);
	if (!uuid) {
		process.exit(1);
	}
	const topicId = args.decisions!;
	const decisions = getConfirmedDecisions(uuid, topicId);
	if (!decisions.length) {
		process.stdout.write(`No confirmed decisions for topic ${topicId}\n`);
		return;
	}
	process.stdout.write(
		JSON.stringify(
			{ project_uuid: uuid, topic_id: topicId, decisions },
			null,
			2,
		) + "\n",
	);
}

function cmdFile(args: { file?: string; project?: string }): void {
	const uuid = resolveProjectUuid(args);
	if (!uuid) {
		process.exit(1);
	}
	const fileName = args.file!;
	const rows = getDecisionsByFile(uuid, fileName);
	if (!rows.length) {
		process.stdout.write(`No decisions found for file: ${fileName}\n`);
		return;
	}
	process.stdout.write(
		JSON.stringify(
			{ project_uuid: uuid, file: fileName, decisions: rows },
			null,
			2,
		) + "\n",
	);
}

function cmdSessions(): void {
	try {
		const conn = getConn();
		try {
			const rows = conn
				.prepare(
					"SELECT session_id, mode, is_cold_start, updated_at FROM session_state ORDER BY updated_at DESC LIMIT 20",
				)
				.all() as {
				session_id: string;
				mode: string | null;
				is_cold_start: number;
				updated_at: string;
			}[];
			if (!rows.length) {
				process.stdout.write("No sessions found.\n");
				return;
			}
			const lines: string[] = [];
			lines.push(
				`${"SESSION_ID".padEnd(40)}  ${"MODE".padEnd(12)}  ${"COLD_START".padEnd(10)}  UPDATED_AT`,
			);
			lines.push("-".repeat(100));
			for (const { session_id, mode, is_cold_start, updated_at } of rows) {
				const modeStr = mode || "standard";
				lines.push(
					`${session_id.padEnd(40)}  ${modeStr.padEnd(12)}  ${String(is_cold_start).padEnd(10)}  ${updated_at}`,
				);
			}
			process.stdout.write(lines.join("\n") + "\n");
		} finally {
			conn.close();
		}
	} catch (e) {
		process.stderr.write(`Error: ${e}\n`);
		process.exit(1);
	}
}

function cmdLiveness(): void {
	const dataDir = getDataDir();
	const retriesDir = path.join(dataDir, ".runtime", "remora_subagent_retries");
	if (!fs.existsSync(retriesDir) || !fs.statSync(retriesDir).isDirectory()) {
		process.stdout.write(`No retries directory: ${retriesDir}\n`);
		return;
	}
	const jsonFiles = fs
		.readdirSync(retriesDir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	if (!jsonFiles.length) {
		process.stdout.write("No subagent retry files found.\n");
		return;
	}
	process.stdout.write(`Retry files (${jsonFiles.length}):\n`);
	for (const fname of jsonFiles) {
		const fpath = path.join(retriesDir, fname);
		try {
			const raw = fs.readFileSync(fpath, "utf-8");
			const data = JSON.parse(raw);
			if (Array.isArray(data)) {
				process.stdout.write(`  ${fname}: ${data.length} entries\n`);
			} else if (typeof data === "object" && data !== null) {
				process.stdout.write(`  ${fname}: ${Object.keys(data).length} keys\n`);
			} else {
				process.stdout.write(`  ${fname}: non-collection\n`);
			}
		} catch (e) {
			process.stdout.write(`  ${fname}: error reading (${e})\n`);
		}
	}
}

function cmdSql(args: { sql?: string }): void {
	const dbPath = getDbPath();
	if (!fs.existsSync(dbPath)) {
		process.stderr.write(`Database not found: ${dbPath}\n`);
		process.exit(1);
	}
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const stmt = db.prepare(args.sql!);
			const rows = stmt.all();
			const cols = stmt.columns().map((c) => c.name);
			if (!rows.length) {
				process.stdout.write("(no rows)\n");
				return;
			}
			if (cols.length) {
				process.stdout.write(cols.join(" | ") + "\n");
				process.stdout.write("-".repeat(80) + "\n");
			}
			for (const row of rows) {
				process.stdout.write(
					JSON.stringify(Object.values(row as Record<string, unknown>)) + "\n",
				);
			}
		} finally {
			db.close();
		}
	} catch (e) {
		process.stderr.write(`SQL error: ${e}\n`);
		process.exit(1);
	}
}

interface ParsedArgs {
	project?: string;
	topics: boolean;
	decisions?: string;
	file?: string;
	sessions: boolean;
	liveness: boolean;
	sql?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		topics: false,
		sessions: false,
		liveness: false,
	};
	for (let i = 2; i < argv.length; i++) {
		switch (argv[i]) {
			case "--project":
				result.project = argv[++i];
				break;
			case "--topics":
				result.topics = true;
				break;
			case "--decisions":
				result.decisions = argv[++i];
				break;
			case "--file":
				result.file = argv[++i];
				break;
			case "--sessions":
				result.sessions = true;
				break;
			case "--liveness":
				result.liveness = true;
				break;
			case "--sql":
				result.sql = argv[++i];
				break;
		}
	}
	return result;
}

function countFlags(args: ParsedArgs): number {
	return [
		args.topics,
		!!args.decisions,
		!!args.file,
		args.sessions,
		args.liveness,
		!!args.sql,
	].filter(Boolean).length;
}

export function main(): void {
	const args = parseArgs(process.argv);
	const flagCount = countFlags(args);
	if (flagCount === 0) {
		process.stderr.write(
			"Usage: inspect.ts --topics | --decisions TOPIC | --file FILE | --sessions | --liveness | --sql SQL [--project UUID]\n",
		);
		process.exit(1);
		return;
	}

	if (args.topics) {
		cmdTopics();
	} else if (args.decisions) {
		cmdDecisions(args);
	} else if (args.file) {
		cmdFile(args);
	} else if (args.sessions) {
		cmdSessions();
	} else if (args.liveness) {
		cmdLiveness();
	} else if (args.sql) {
		cmdSql(args);
	}
}
