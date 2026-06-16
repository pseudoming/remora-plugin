#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import * as dao from "@remora/core";
import { setTraceId } from "@remora/core";

export function main(): void {
	setTraceId(`c_${randomUUID().slice(0, 8)}`);
	if (process.argv.length < 3) {
		console.log("Usage: remora-recall.ts <keyword> [project_uuid]");
		process.exit(1);
	}

	const keyword = process.argv[2];
	let projectUuid = process.argv.length > 3 ? process.argv[3] : "";

	if (!projectUuid) {
		projectUuid = process.env.ANTIGRAVITY_PROJECT_ID ?? "";
	}

	let convId = "";
	if (!projectUuid) {
		const metadataStr = process.env.ANTIGRAVITY_SOURCE_METADATA ?? "";
		if (metadataStr) {
			const match = metadataStr.match(/"conversationId":"([^"]+)/);
			if (match) {
				convId = match[1];
			}
		}
	}

	if (!dao.checkDbExists()) {
		console.log("[Remora] 温存储数据库尚未建立");
		process.exit(1);
	}

	if (convId && !projectUuid) {
		const uuid = dao.getProjectUuidByConv(convId);
		if (uuid) {
			projectUuid = uuid;
		}
	}

	if (!projectUuid && !convId) {
		console.log("[Remora] 错误: 无法获取项目标识，检索被拒绝。");
		process.exit(1);
	}

	const ftsKeyword = keyword;
	let matchCount = 0;

	console.log("=== FTS5 原始日志召回 (通道 A) ===");
	const logs = dao.recallFts5Logs(projectUuid, convId, ftsKeyword);
	for (const log of logs) {
		matchCount += 1;
		console.log(log);
	}

	console.log("\n=== 关联架构决策召回 (通道 A 反向牵引) ===");
	const decisionsFts = dao.recallDecisionsByFts5Topic(
		projectUuid,
		convId,
		ftsKeyword,
	);
	for (const d of decisionsFts) {
		matchCount += 1;
		console.log(d);
	}

	console.log("\n=== 直接匹配架构决策 (通道 B) ===");
	const likeDecisions = dao.recallDecisionsByLike(
		projectUuid,
		convId,
		ftsKeyword,
	);
	for (const d of likeDecisions) {
		matchCount += 1;
		console.log(d);
	}

	if (matchCount > 0) {
		dao.touchTopicsAccessedByRecall(projectUuid, convId, ftsKeyword);
	}
}

if (typeof require !== "undefined" && require.main === module) {
	main();
}
