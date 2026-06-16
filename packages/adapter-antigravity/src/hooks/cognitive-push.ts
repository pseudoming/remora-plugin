import { PreInvocationResponse, AntigravityInjectStep, AntigravityHookContext } from "../types";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	shouldFire,
	markFired,
	isDuplicate,
	formatRelaxDisciplinePrompt,
	formatWorkTrackingPrompt,
	formatDecisionsForSessionResume,
	formatConflictInjectionMessage,
	formatFileDecisionsInjection,
	formatWriteGateDenyPrompt,
	isPlanningArtifact,
	readMode,
	getSession,
	getLatestSession,
	updateColdStart,
	getActiveTopic,
	getProjectUuidByConv,
	getHookState,
	setHookState,
	insertFileChange,
	getDecisionsByFile,
	getRecentDecisions,
	getRejectedOrDeferredByRelevance,
	bumpInjection,
	cleanSystemReminders,
	buildConflictDetectionPrompt,
	trimStaleHookStates,
	error,
	warn,
	debug,
} from "@remora/core";
import { extractConvId, getDataDir } from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { createConversation } from "../bridge/agentapi";
import { getOrCreateConversation } from "../sidecar/extract-decisions";

function _getActiveTopicAndDecisions(
	uuid: string,
): [string | null, AntigravityInjectStep[]] {
	const topicId = getActiveTopic(uuid);
	if (!topicId) {
		return [null, []];
	}
	// Use get_recent_decisions for read-only within-hook access (single-shot conn)
	const decisions = getRecentDecisions(uuid, topicId, 5);
	return [topicId, decisions];
}

function _handlePreInvocation(
	context: AntigravityHookContext,
	convId: string,
	currentTurnIdx: number,
): { injectSteps: AntigravityInjectStep[] } {
	// 检查同回合内是否已经注入过会话重载提示
	if (isDuplicate(convId, "resume_injected", String(currentTurnIdx))) {
		return { injectSteps: [] };
	}

	const injectSteps: AntigravityInjectStep[] = [];

	// In PreInvocation, when in discussion/planning phase, inject system discipline
	const mode = readMode(convId, "strict");
	if (mode === "relax") {
		injectSteps.push({
			ephemeralMessage: formatRelaxDisciplinePrompt("/artifacts/", [
				"write_to_file",
				"replace_file_content",
				"run_command",
			]),
		});
	}

	// Work tracking — once per session
	if (!isDuplicate(convId, "work_tracking", "injected")) {
		markFired(convId, "work_tracking", "injected");
		injectSteps.push({
			ephemeralMessage: formatWorkTrackingPrompt(),
		});
	}

	// Line C: semantic conflict detection (feature-gated)
	if (_checkLineCEnabled()) {
		try {
			const lineCInjections = _runLineC(context, convId, currentTurnIdx);
			if (lineCInjections) {
				for (const step of lineCInjections) {
					injectSteps.push(step);
				}
			}
		} catch (_e) {
			console.debug("[Hook Debug] Line C injection query failed:", _e);
			// Line C failure must never block the conversation
		}
	}

	// 查找 session 判定冷启动
	const session = getSession(convId);
	if (!session || session.is_cold_start === 0) {
		// session[2] = is_cold_start
		markFired(convId, "resume_injected", String(currentTurnIdx));
		return { injectSteps };
	}

	const uuid = getProjectUuidByConv(convId);
	if (!uuid) {
		markFired(convId, "resume_injected", String(currentTurnIdx));
		return { injectSteps };
	}

	const [topicId, decisions] = _getActiveTopicAndDecisions(uuid);

	if (decisions && decisions.length > 0) {
		debug(
			`session resumed: ${convId}, injecting ${decisions.length} decisions`,
		);
		injectSteps.push({
			ephemeralMessage: formatDecisionsForSessionResume(
				decisions as unknown as import("@remora/core").Decision[],
				topicId!,
			),
		});
		for (const d of decisions) {
			_safeBumpInjection(Number(d.id ?? 0), convId, currentTurnIdx);
		}
	}

	// 恢复物理消费，仅在消费成功且执行 Line A 后置 0
	updateColdStart(convId, 0);
	markFired(convId, "resume_injected", String(currentTurnIdx));

	return { injectSteps };
}

function _checkLineCEnabled(): boolean {
	const configPath = path.join(
		path.dirname(getDataDir()),
		"conf",
		"features.json",
	);
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		return !!config?.semantic_conflict_detection?.enabled;
	} catch (_e: any) {
		console.error("[Hook Error] cognitive-push critical update failed:", _e);
		return false;
	}
}

function _runLineC(
	context: AntigravityHookContext,
	convId: string,
	currentTurnIdx: number,
): AntigravityInjectStep[] {
	/** Returns list of inject step dicts, or []. */
	const cdal = new ConversationDataAccessLayer(convId);
	const userInputCount = cdal.getUserInputCount();
	if (userInputCount == null) {
		return [];
	}
	const turnInterval = Math.floor(Number(userInputCount) / 10);
	if (turnInterval === 0) {
		return [];
	}

	const windowKey = `line_c_window:${turnInterval}`;
	if (!shouldFire(convId, windowKey, String(turnInterval))) {
		return [];
	}

	let lastMsg = context.last_msg ?? "";
	if (!lastMsg) {
		const steps = cdal.streamStepsReverse(50);
		for (const step of steps) {
			if (step.type === "USER_INPUT") {
				lastMsg = step.content ?? "";
				break;
			}
		}
	}
	if (!lastMsg) {
		return [];
	}

	const cleanMsg = cleanSystemReminders(lastMsg);
	if (!cleanMsg.trim()) {
		return [];
	}

	const uuid = getProjectUuidByConv(convId);
	if (!uuid) {
		return [];
	}

	const candidates = getRejectedOrDeferredByRelevance(uuid, cleanMsg);

	if (!candidates || candidates.length === 0) {
		markFired(convId, windowKey, String(turnInterval));
		return [];
	}

	const prompt = buildConflictDetectionPrompt(
		cleanMsg,
		candidates as import("@remora/core").ConflictCandidate[],
	);

	let llmOutput: string;
	try {
		llmOutput = getOrCreateConversation(prompt);
	} catch (_e1) {
		try {
			const resp = createConversation(prompt, 15, "flash_lite") as any;
			llmOutput =
				resp?.response?.newConversation?.reply ?? JSON.stringify(resp);
		} catch (_e2) {
			console.debug("[Hook Debug] Failed to invoke flash_lite conversation:", _e2);
			markFired(convId, windowKey, String(turnInterval));
			return [];
		}
	}

	const jsonMatch = /({.*})/s.exec(llmOutput);
	if (!jsonMatch) {
		markFired(convId, windowKey, String(turnInterval));
		return [];
	}

	let result: { conflicts?: Array<{ decision_id?: number; reason?: string }> };
	try {
		result = JSON.parse(jsonMatch[1].trim());
	} catch (_e3) {
		console.debug("[Hook Debug] JSON parse result conflicts failed:", _e3);
		markFired(convId, windowKey, String(turnInterval));
		return [];
	}

	const conflicts = result.conflicts ?? [];
	if (!conflicts || conflicts.length === 0) {
		markFired(convId, windowKey, String(turnInterval));
		return [];
	}

	const candidateMap: Record<number, Record<string, unknown>> = {};
	for (const c of candidates) {
		candidateMap[Number(c.id)] = c;
	}
	const injectStepsResult: AntigravityInjectStep[] = [];
	let hasAnyConflict = false;

	for (const c of conflicts) {
		const cid = c.decision_id;
		if (cid == null || !(cid in candidateMap)) {
			continue;
		}
		hasAnyConflict = true;

		const d = candidateMap[cid];
		const conflictKey = `line_c_conflict:${cid}`;
		if (isDuplicate(convId, conflictKey, String(turnInterval))) {
			continue;
		}

		const isRepeat = getHookState(convId, -1, conflictKey) !== null;
		injectStepsResult.push({
			ephemeralMessage: formatConflictInjectionMessage(
				d as unknown as import("@remora/core").Decision,
				c as unknown as import("@remora/core").ConflictInfo,
				isRepeat,
			),
		});
		markFired(convId, conflictKey, String(turnInterval));
	}

	if (hasAnyConflict) {
		markFired(convId, windowKey, String(turnInterval));
		for (const c of conflicts) {
			const cid = c.decision_id;
			if (cid) {
				_safeBumpInjection(cid, convId, currentTurnIdx);
			}
		}
	}

	return injectStepsResult;
}

function _handlePreToolUse(
	context: AntigravityHookContext,
	convId: string,
	currentTurnIdx: number,
): {
	decision?: "allow" | "deny" | "fallback";
	reason?: string;
	injectSteps: AntigravityInjectStep[];
} {
	const toolName = context.toolName ?? "";
	if (
		![
			"write_to_file",
			"multi_replace_file_content",
			"replace_file_content",
		].includes(toolName)
	) {
		return { injectSteps: [] };
	}

	const toolArgs = context.toolArgs ?? {};
	const targetFile = (toolArgs["TargetFile"] ??
		toolArgs["AbsolutePath"] ??
		"") as string;
	if (!targetFile) {
		return { injectSteps: [] };
	}

	// 撤销 strict 模式门控：只要动了关键实体文件，全天候强制物理拦截
	const latest = getLatestSession();
	if (!latest) {
		return { injectSteps: [] };
	}

	const sessionId = latest.session_id;
	const uuid = getProjectUuidByConv(sessionId);
	if (!uuid) {
		return { injectSteps: [] };
	}

	const [topicId, decisions] = _getActiveTopicAndDecisions(uuid);

	// 方案 2：全局核心代码"首写拦截 + 自适应二次放行"
	// 检查目标文件是否是规划制品
	const isArtifact = isPlanningArtifact(targetFile, "/artifacts/", [
		"task.md",
		"implementation_plan.md",
		"walkthrough.md",
	]);

	if (!isArtifact) {
		// 如果不是规划制品且没有命中特定的保护决策（是普通的业务代码文件）
		const stateKey = "first_write_deny:" + targetFile;
		const retryStatus = getHookState(convId, currentTurnIdx, stateKey);
		if (retryStatus === "1") {
			// 第二次尝试，清除状态直接放行 (allow)
			setHookState(convId, currentTurnIdx, stateKey, "0");
			insertFileChange(uuid, convId, path.basename(targetFile), "write_tool");
			const injectSteps: AntigravityInjectStep[] = [];
			const fileName = path.basename(targetFile);
			const fileDecisions = getDecisionsByFile(uuid, fileName);
			if (fileDecisions && fileDecisions.length > 0) {
				const dedupKey = `file_decisions_injected:${fileName}`;
				if (shouldFire(convId, dedupKey, String(currentTurnIdx))) {
					injectSteps.push({
						ephemeralMessage: formatFileDecisionsInjection(
							fileName,
							fileDecisions as unknown as import("@remora/core").Decision[],
						),
					});
					markFired(convId, dedupKey, String(currentTurnIdx));
					for (const d of fileDecisions) {
						_safeBumpInjection(d.id, convId, currentTurnIdx);
					}
				}
			}
			return { decision: "allow", injectSteps };
		} else {
			// 第一次尝试，记录状态为 "1"，并返回 deny 与 prompt 注入
			setHookState(convId, currentTurnIdx, stateKey, "1");

			// 中文翻译：
			// ⛔ REMORA 安全限制 [全局写门禁]：未获授权的代码修改已拦截！
			// ============================================================
			// !!! 研讨防护与防冲动门禁触发 !!!
			// 你正在非 Coding 阶段或首次调用中修改核心代码文件（目标：{target_file}）。
			//
			// 如需继续，你必须：
			// 1. 解释意图：向用户说明你正在修改的核心代码文件及改动逻辑。
			// 2. 自适应重试：若此修改确有必要且用户已批准，你必须在当前回合立即再次调用此写工具以解锁释放。
			// ============================================================
			const prompt = formatWriteGateDenyPrompt(targetFile);
			return {
				decision: "deny",
				reason: `⛔ REMORA SAFETY LIMIT [GLOBAL-WRITE-GATE]: Unauthorized edit to ${targetFile} blocked. Explain intent and retry.`,
				injectSteps: [{ ephemeralMessage: prompt }],
			};
		}
	}

	return { injectSteps: [] };
}

export function main(context: AntigravityHookContext): PreInvocationResponse {
	try {
		return _main(context);
	} catch (_e: any) {
		console.error("[Hook Error] cognitive-push critical update failed:", _e);
		return { injectSteps: [] };
	}
}

function _main(context: AntigravityHookContext): PreInvocationResponse {
	const fallback: { injectSteps: AntigravityInjectStep[] } = {
		injectSteps: [],
	};

	// argparse.ArgumentParser → manual argv parsing
	const stageIdx = process.argv.indexOf("--stage");
	let stage: string | undefined;
	if (stageIdx !== -1 && stageIdx + 1 < process.argv.length) {
		stage = process.argv[stageIdx + 1];
	}
	if (!stage || !["pre-invoke", "pre-tool"].includes(stage)) {
		return fallback;
	}

	const transcriptPath = context.transcriptPath ?? "";
	let convId = extractConvId(transcriptPath) ?? "default";
	if (convId === "default") {
		const latest = getLatestSession();
		if (latest) {
			convId = latest.session_id;
		}
	}

	const cdal = new ConversationDataAccessLayer(convId);
	const currentTurnIdx = cdal.getCurrentTurnIdx();

	trimStaleHookStates(convId, currentTurnIdx);

	try {
		if (stage === "pre-invoke") {
			return _handlePreInvocation(context, convId, currentTurnIdx) as {
				decision?: "allow" | "deny" | "fallback";
				reason?: string;
				injectSteps: AntigravityInjectStep[];
			};
		} else {
			// stage === "pre-tool"
			return _handlePreToolUse(context, convId, currentTurnIdx);
		}
	} catch (e) {
		error(`cognitive-push failed: ${e}`);
		if (e instanceof Error && e.stack) {
			process.stderr.write(e.stack + "\n");
		}
	}

	return fallback;
}

function _safeBumpInjection(
	decisionId: number,
	convId: string,
	turnIdx: number,
): void {
	try {
		bumpInjection(decisionId);
	} catch (e) {
		warn(
			`[REMORA WARNING] Failed to bump injection count for decision ${decisionId}: ${e}`,
		);
		try {
			const stateKey = "injection_bump_failures";
			const currentFailures = Number(
				getHookState(convId, turnIdx, stateKey) ?? 0,
			);
			setHookState(convId, turnIdx, stateKey, String(currentFailures + 1));
		} catch (stateErr) {
			console.error("[Hook Error] Fail-safe fallback writing injection_bump_failures failed:", stateErr);
		}
	}
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
	hookEntrypoint()(main)();
}
