import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	getPlanChangeTime,
	getUserMessagesAfter,
	getPlanContent,
	enqueueEvent,
	scanApprovalSignals,
} from "@remora/core";

import { getDataDir } from "../bridge/paths";

const CONF_PATH = path.join(
	path.dirname(getDataDir()),
	"conf",
	"approval.json",
);
let approvalConfig: Record<string, unknown> | null = null;

function loadApprovalConfig(): Record<string, unknown> {
	if (approvalConfig === null) {
		try {
			approvalConfig = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
		} catch {
			approvalConfig = {};
		}
	}
	return approvalConfig || {};
}

export function checkPlanApproval(
	projectUuid: string,
	conn?: Database.Database,
): void {
	// [P0] Plan approval detection window scan
	const tPlanChange = getPlanChangeTime(projectUuid, conn);
	if (!tPlanChange) {
		return;
	}

	const userMessages = getUserMessagesAfter(tPlanChange, projectUuid, conn);

	const config = loadApprovalConfig();
	const hasApproval = scanApprovalSignals(
		userMessages,
		config["approval_keywords"] as string[] | undefined,
		config["negation_prefixes"] as string[] | undefined,
	);

	if (hasApproval) {
		const planContent = getPlanContent(projectUuid, conn);

		const payloadData = {
			user_approval_context: userMessages.join("\n"),
			plan_content: planContent,
		};

		enqueueEvent(
			projectUuid,
			"plan_approval_sync",
			JSON.stringify(payloadData),
			conn,
		);
		console.log(
			`[Remora] 探测到项目 ${projectUuid} 用户审批信号，已向事件队列抛入 plan_approval_sync。`,
		);
	}
}
