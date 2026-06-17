import * as fs from "node:fs";
import * as path from "node:path";
import { getConn } from "@remora/core";
import { getBrainDir } from "../bridge/paths";

function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: npx tsx cleanup-stale-session.ts <session_id>");
		process.exit(1);
	}

	const sessionId = args[0];
	console.log(`[Remora Cleanup] Starting physical cleanup for session: ${sessionId}`);

	// 1. 从 SQLite 数据库中注销会话
	try {
		const conn = getConn();
		try {
			conn.execute(
				"DELETE FROM session_state WHERE session_id = ?",
				[sessionId]
			);
			conn.execute(
				"DELETE FROM runtime_hook_state WHERE session_id = ?",
				[sessionId]
			);
			console.log("✅ Successfully deleted session records from SQLite DB.");
		} finally {
			conn.close();
		}
	} catch (err) {
		console.error("❌ Failed to clean database records:", err);
	}

	// 2. 清理临时进度 Sentinel 文件
	try {
		const brainDir = getBrainDir();
		const progressPath = path.join(brainDir, sessionId, "scratch", "progress.json");
		if (fs.existsSync(progressPath)) {
			fs.unlinkSync(progressPath);
			console.log(`✅ Successfully unlinked progress file: ${progressPath}`);
		}
	} catch (err) {
		console.error("❌ Failed to delete progress file:", err);
	}

	console.log("[Remora Cleanup] Session cleanup completed.");
}

main();
