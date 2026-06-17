import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
	warn,
	debug,
	setTraceId,
	parseSqliteTimestamp,
	findAllUuids,
	judgeZombie,
	getLatestNonUserMessages,
	getHookState,
	setHookState,
	trimHookStates,
	getProjectUuidByConv,
	getActiveTopicCreatedAt,
	watermarkExists,
	getConn,
} from "@remora/core";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { ProgressSentinel } from "../bridge/progress";
import { getBrainDir } from "../bridge/paths";

function globSingle(
	dirPath: string,
	patternSegments: string[],
	segIdx: number,
): string[] {
	if (segIdx >= patternSegments.length) {
		return [dirPath];
	}
	const seg = patternSegments[segIdx];
	const isLast = segIdx === patternSegments.length - 1;
	const results: string[] = [];

	if (!fs.existsSync(dirPath)) {
		return results;
	}

	if (seg === "*" || seg === "**") {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() || (isLast && entry.isFile())) {
				results.push(
					...globSingle(
						path.join(dirPath, entry.name),
						patternSegments,
						segIdx + 1,
					),
				);
			}
		}
	} else if (seg.includes("*")) {
		const regex = new RegExp(
			"^" +
				seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") +
				"$",
		);
		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (
					(entry.isDirectory() || (isLast && entry.isFile())) &&
					regex.test(entry.name)
				) {
					results.push(
						...globSingle(
							path.join(dirPath, entry.name),
							patternSegments,
							segIdx + 1,
						),
					);
				}
			}
		} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }
	} else {
		const nextPath = path.join(dirPath, seg);
		if (isLast) {
			if (fs.existsSync(nextPath)) {
				results.push(nextPath);
			}
		} else {
			results.push(...globSingle(nextPath, patternSegments, segIdx + 1));
		}
	}

	return results;
}

export function runAudit(
	convId: string,
	parentConvId?: string,
): Record<string, unknown> {
	const shortId = convId.length >= 8 ? convId.slice(0, 8) : convId;
	const brainDir = getBrainDir();
	const convDirWildcard = parentConvId || "*";
	const worktreePattern = `*${shortId}*`;

	let progressPath: string | null = null;

	const pattern1 = [
		brainDir,
		convDirWildcard,
		".system_generated",
		"worktrees",
		worktreePattern,
		"scratch",
		"progress.json",
	];
	const matches1 = globSingle("/", pattern1, 0);
	if (matches1.length > 0) {
		progressPath = matches1[0];
	} else {
		const pattern2 = [
			brainDir,
			convDirWildcard,
			".system_generated",
			"worktrees",
			convId,
			"scratch",
			"progress.json",
		];
		const matches2 = globSingle("/", pattern2, 0);
		if (matches2.length > 0) {
			progressPath = matches2[0];
		} else {
			progressPath = path.join(brainDir, convId, "scratch", "progress.json");
		}
	}

	let progressData: Record<string, unknown> = {};
	const progressExists = progressPath ? fs.existsSync(progressPath) : false;
	if (progressExists && progressPath) {
		try {
			progressData = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
		} catch (e: unknown) {
			warn(`${String(e)}`);
		}
	}

	let latestMsgTs = 0.0;
	let latestMsgRole: string | null = null;
	let latestMsgContent: string | null = null;
	let dbBlocked = false;
	let dbBlockedReason = "";

	try {
		const conn = getConn();
		try {
			const rows = getLatestNonUserMessages(convId, 5, conn);
			if (rows.length > 0) {
				const tsVal = rows[0].timestamp;
				const role = rows[0].role;
				const content = rows[0].content || "";
				latestMsgTs = parseSqliteTimestamp(tsVal);
				latestMsgRole = role;
				latestMsgContent =
					content.length > 100 ? content.slice(0, 100) + "..." : content;

				for (const row of rows) {
					const contentStr = row.content || "";
					const contentLower = contentStr.toLowerCase();
					if (
						contentLower.includes("permission_denied") ||
						contentLower.includes("tool_missing") ||
						contentLower.includes("permission denied") ||
						contentLower.includes("remora safety intercept") ||
						contentLower.includes("exit status") ||
						contentLower.includes("unknown tool name")
					) {
						dbBlocked = true;
						dbBlockedReason = `Fatal block in messages: ${contentStr.slice(0, 80)}`;
						break;
					}
				}
			}
		} finally {
			conn.close();
		}
	} catch (e: unknown) {
		warn(`${String(e)}`);
	}

	const status = progressData["status"] as string | undefined;

	const nowUtc = Date.now() / 1000;

	let progressTs = 0.0;
	const lastUpdatedAtVal = progressData["last_updated_at"];
	if (lastUpdatedAtVal != null) {
		try {
			progressTs = parseFloat(String(lastUpdatedAtVal));
		} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }
	}

	if (status === "completed") {
		return {
			liveness: "alive",
			reason: "Task is already completed.",
		};
	}

	if (status === "blocked" || dbBlocked) {
		const blockedMsg =
			status === "blocked"
				? (progressData["details"] as string) || ""
				: dbBlockedReason;
		return {
			liveness: "dead",
			reason: `Status is blocked: ${blockedMsg}`,
		};
	}

	let progressElapsed = -1.0;
	if (progressTs > 0) {
		progressElapsed = Date.now() / 1000 - progressTs;
	}

	let msgElapsed = -1.0;
	if (latestMsgTs > 0) {
		msgElapsed = nowUtc - latestMsgTs;
	}

	const activeElapseds: number[] = [];
	if (progressElapsed >= 0) {
		activeElapseds.push(progressElapsed);
	}
	if (msgElapsed >= 0) {
		activeElapseds.push(msgElapsed);
	}

	let isDead = false;
	let deathReason = "";

	if (activeElapseds.length === 0) {
		if (!progressExists) {
			return {
				liveness: "alive",
				reason: "No liveness signals yet. Subagent might be initializing.",
			};
		} else {
			isDead = true;
			deathReason = "Progress file exists but contains no valid timestamp.";
		}
	} else {
		const idleSeconds = Math.floor(Math.min(...activeElapseds));
		const [isZombie, limit] = judgeZombie(
			idleSeconds,
			latestMsgRole || "unknown",
			new Set(["run_command", "grep_search"]),
		);
		isDead = isZombie;
		if (isDead) {
			deathReason = `Liveness timeout: last updated ${idleSeconds}s ago (Threshold: ${limit}s).`;
		}
	}

	const idleSeconds = msgElapsed >= 0 ? msgElapsed : progressElapsed;
	const lastToolName = latestMsgRole || "unknown";
	debug(
		`subagent ${convId}: status=${isDead ? "zombie" : "active"}, idle=${idleSeconds.toFixed(0)}s, tool=${lastToolName}`,
	);

	if (isDead) {
		try {
			const transcriptDummy = path.join(
				getBrainDir(),
				convId,
				".system_generated",
				"transcript.jsonl",
			);
			ProgressSentinel.update(
				transcriptDummy,
				"blocked",
				undefined,
				deathReason,
			);
		} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }

		return {
			liveness: "dead",
			reason: deathReason,
			details: {
				progress_status: status,
				progress_elapsed_seconds: progressElapsed,
				db_message_elapsed_seconds: msgElapsed,
				latest_role: latestMsgRole,
				latest_content: latestMsgContent,
			},
		};
	} else {
		return {
			liveness: "alive",
			reason: "Subagent is active.",
			details: {
				progress_status: status,
				progress_elapsed_seconds: progressElapsed,
				db_message_elapsed_seconds: msgElapsed,
			},
		};
	}
}

export function main(
	context: Record<string, unknown>,
): Record<string, unknown> {
	try {
		return _main(context);
	} catch {
		return { decision: "allow" };
	}
}

function getLatestMessageString(lastMsg: unknown): string {
	if (!lastMsg) return "";
	if (typeof lastMsg === "string") {
		return lastMsg;
	}
	if (typeof lastMsg === "object" && lastMsg !== null) {
		const msgObj = lastMsg as Record<string, unknown>;
		if (typeof msgObj.content === "string") {
			return msgObj.content;
		}
		try {
			return JSON.stringify(lastMsg);
		} catch {
			return "";
		}
	}
	return String(lastMsg);
}

function _main(context: Record<string, unknown>): Record<string, unknown> {
	const transcriptPath = (context["transcriptPath"] as string) || "";
	if (!transcriptPath) {
		return { decision: "allow", reason: "No transcriptPath in stdin" };
	}

	const match = transcriptPath.match(/\/brain\/([^/]+)\//);
	if (!match) {
		return {
			decision: "allow",
			reason: "Could not extract parent conversation_id",
		};
	}

	const parentConvId = match[1];

	const cdal = new ConversationDataAccessLayer(parentConvId);
	const currentTurnIdx = cdal.getCurrentTurnIdx();

	const lastSeen = getHookState(parentConvId, -1, "last_seen_turn");
	if (lastSeen === null || parseInt(lastSeen, 10) !== currentTurnIdx) {
		trimHookStates(parentConvId, currentTurnIdx);
		setHookState(parentConvId, -1, "last_seen_turn", String(currentTurnIdx));
	}

	try {
		const latestMsg = cdal.getLatestUserMessage() || "";
		const latestPlanner = cdal.getLatestPlannerResponse() || "";
		const fullText = latestMsg + " " + latestPlanner;
		if (
			!fullText.match(
				/(定时器|定时任务|schedule|heartbeat|心跳探活|等待子代理)/i,
			)
		) {
			return { decision: "allow", reason: "Not a liveness audit phase." };
		}
	} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }

	let subagentIds: string[] = [];
	try {
		const cdal2 = new ConversationDataAccessLayer(parentConvId);

		let projectUuid: string | null = null;
		let activeTopicTs = 0.0;
		try {
			projectUuid = getProjectUuidByConv(parentConvId);
			if (projectUuid) {
				const topicTs = getActiveTopicCreatedAt(projectUuid);
				if (topicTs) {
					activeTopicTs = parseSqliteTimestamp(topicTs);
				}
			}
		} catch (dbErr: unknown) {
			warn(`${String(dbErr)}`);
		}

		const allSteps = Array.from(cdal2.streamStepsForward());
		const last20Steps = allSteps.length > 20 ? allSteps.slice(-20) : allSteps;
		const last20Indices = new Set<number>();
		for (const s of last20Steps) {
			if (s["step_index"] != null) {
				last20Indices.add(s["step_index"] as number);
			}
		}

		const filteredSteps: Record<string, unknown>[] = [];
		for (const step of allSteps) {
			const isInLast20 =
				step["step_index"] != null &&
				last20Indices.has(step["step_index"] as number);
			let isInActiveTopic = false;
			if (activeTopicTs > 0.0) {
				const stepTsStr = step["timestamp"] as string | undefined;
				if (stepTsStr) {
					const stepTs = parseSqliteTimestamp(stepTsStr);
					if (stepTs >= activeTopicTs) {
						isInActiveTopic = true;
					}
				}
			}
			if (isInLast20 || isInActiveTopic) {
				filteredSteps.push(step);
			}
		}

		const candidateSubagentIds = new Set<string>();
		for (const step of filteredSteps) {
			for (const uuid of findAllUuids(step, parentConvId)) {
				candidateSubagentIds.add(uuid);
			}
		}

		if (projectUuid) {
			try {
				for (const subId of candidateSubagentIds) {
					if (watermarkExists(projectUuid, subId)) {
						subagentIds.push(subId);
					}
				}
			} catch (dbErr: unknown) {
				warn(`Failed during watermarks correlation filter: ${String(dbErr)}`);
				subagentIds = Array.from(candidateSubagentIds);
			}
		} else {
			subagentIds = Array.from(candidateSubagentIds);
		}

		subagentIds = Array.from(new Set(subagentIds));
	} catch (e: unknown) {
		return {
			decision: "allow",
			reason: `Failed to auto-detect subagents: ${String(e)}`,
		};
	}

	if (subagentIds.length === 0) {
		return { decision: "allow", reason: "No subagents detected" };
	}

	const deadAgents: Array<[string, string]> = [];
	for (const subId of subagentIds) {
		const res = runAudit(subId, parentConvId);
		if (res["liveness"] === "dead") {
			deadAgents.push([subId, (res["reason"] as string) || "unknown reason"]);
		}
	}

	if (deadAgents.length > 0) {
		const reasonMsg =
			"⚠️ 警告：检测到后台子特工已卡死：\n" +
			deadAgents.map(([sid, reason]) => `- 特工 ${sid}: ${reason}`).join("\n");
		const deadIdsStr = deadAgents.map(([sid]) => `'${sid}'`).join(", ");

		const sopInjected = getHookState(
			parentConvId,
			currentTurnIdx,
			"liveness_sop",
		);
		const hasSopInjected = sopInjected === "injected";

		let ephemeralMsg: string;
		if (!hasSopInjected) {
			setHookState(parentConvId, currentTurnIdx, "liveness_sop", "injected");
			ephemeralMsg =
				`⛔ REMORA LIVENESS WARNING: Subagents ${deadIdsStr} are unresponsive.\n` +
				`To resolve this, you MUST follow this Self-Healing SOP:\n` +
				`1. FORCE TERMINATE: Invoke \`manage_subagents(Action='kill', ConversationIds=[${deadIdsStr}]).\n` +
				`2. CLEAN ZOMBIE PROCESSES: Run a command to list processes under the subagent's path (e.g., \`ps aux | grep -v grep | grep -E 'pytest|build'\`). If any orphaned subprocesses are found, use kill/pkill to clean them up.\n` +
				`3. VERIFY LOCKS: Ensure there are no database journal locks (e.g., in SQLite .db-journal or .runtime/) that could block next subagent instances before you respawn or retry.`;
		} else {
			ephemeralMsg = `⛔ REMORA LIVENESS WARNING: Subagents ${deadIdsStr} are unresponsive.`;
		}

		// 1. 处理工具前置拦截 (防御性编程，以防未来挂载在 PreToolUse 阶段)
		const toolCall = context["toolCall"] as Record<string, any> | undefined;
		if (toolCall) {
			const toolName = toolCall.name;
			if (toolName === "manage_subagents") {
				return {
					decision: "allow",
					reason: `放行原生自愈工具: ${reasonMsg}`,
				};
			}
			if (toolName === "run_command") {
				const cmd = (toolCall.args?.CommandLine as string) || "";
				if (cmd.includes("cleanup-stale-session.ts")) {
					return {
						decision: "allow",
						reason: `放行物理自愈清理脚本: ${reasonMsg}`,
					};
				}
			}
			return {
				decision: "deny",
				reason: reasonMsg,
			};
		}

		// 2. 处理 PreInvocation 对话入口
		const currentRawMsg = context["last_msg"];
		const currentMsgStr = getLatestMessageString(currentRawMsg);
		const isSelfHealingIntent = 
			/(清理|强杀|自愈|kill|manage_subagents|cleanup-stale-session)/i.test(currentMsgStr);

		// 如果已经在当前 Turn 注入过 SOP，或者检测到明确的自愈意图，放行以获取自愈推理窗口
		if (hasSopInjected || isSelfHealingIntent) {
			return {
				decision: "allow",
				reason: `放行自愈请求或重试交互: ${reasonMsg}`,
			};
		}

		// 首次遭遇卡死且无明确自愈意图，执行物理拦截并注入 SOP 警示
		return {
			decision: "deny",
			reason: reasonMsg,
			injectSteps: [
				{
					ephemeralMessage: ephemeralMsg,
				},
			],
		};
	}

	return { decision: "allow", reason: "All subagents are active" };
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
	if (process.argv.length > 2) {
		setTraceId(`s_${randomUUID().slice(0, 8)}`);
		const convId = process.argv[2];
		const res = runAudit(convId);
		process.stdout.write(JSON.stringify(res) + "\n");
		if (res["liveness"] === "dead") {
			process.exit(1);
		} else {
			process.exit(0);
		}
	} else {
		hookEntrypoint()(main)();
	}
}
