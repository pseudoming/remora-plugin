import { PreToolUseResponse } from "../types";
import {
	readMode,
	makeDenyReason,
	isRotSensitiveFile,
	isRotSensitivePath,
	estimateReadBytes,
	isAccumulatedLimitExceeded,
	validatePromptSyntax,
	trimStaleHookStates,
	inspectCommand,
	getHookState,
	setHookState,
	formatJitInjection,
	
	estimateGrepReadBytes,
	isUnifiedLimitExceeded,
	isUnifiedLimitApproaching,
	SYSTEM_POLICY,
} from "@remora/core";
import { accumulate, getStats } from "../bridge/stats";
import { getSubagentType } from "../bridge/subagent";
import {
	findPluginRoot,
	resolveSecurePath,
	isExemptedPath,
} from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { globalRuleRunner } from "./rule-runner";
import * as fs from "node:fs";
import * as path from "node:path";

const BUILTIN_AGENTS: ReadonlySet<string> = new Set([
	"Remora_Deep_Diver",
	"Remora_ReadOnly_Extractor",
]);

function loadBuiltinAgentPerms(name: string): Record<string, boolean> | null {
	try {
		const pluginRoot = findPluginRoot();
		const filePath = path.join(pluginRoot, "agents", `${name}.json`);
		if (!fs.existsSync(filePath)) return null;
		const def = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return {
			enable_write_tools: !!def["enable_write_tools"],
			enable_subagent_tools: !!def["enable_subagent_tools"],
		};
	} catch (e: any) {
		console.debug("[Hook Debug] loadBuiltinAgentPerms failed:", e);
		return null;
	}
}

// ##########################################################
// AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
// ⚠️ 警告：本脚本是主干 Agent 拦截 high 危操作的物理防线。
//   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
//   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
//   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
//   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
// ##########################################################

// ==========================================================
// 设计原理一：动态副作用防线 (Dynamic Stateful Rules)
// ==========================================================
// 1. 与 JSON 引擎分工：所有无状态、纯特征匹配的黑名单均已转移至 remora-rules.json。
//    本模块仅保留涉及数据库写入、状态读取、文件系统交叉校验及 JIT 临时注入的“副作用规则”。
// 2. 函数式责任链 (Functional Registry)：所有复杂逻辑被解耦为独立的纯函数 (DynamicRule)，
//    统一接收 DynamicRuleContext 并由 executeDynamicRuleChain 短路执行。

// ==========================================================
// 设计原理二：文件读取累加器与防腐 (Anti-Context-Rot)
// ==========================================================
// 1. 水位线熔断机制：在主干上下文中追踪单回合文件读取 (view_file) 及检索 (grep_search) 字节数，
//    突破绝对阈值时实施硬熔断，强制委派只读子代理，防止上下文因零散读取而慢速腐败。
// 2. O(1) 乘算估值策略：针对大日志特征执行快速估算，避免磁盘全表扫描导致超时。

// ==========================================================
// 设计原理三：运行时命令/特工边界审计 (Runtime Audit Guard)
// ==========================================================
// 1. 特权隔离限制：禁止只读特工执行任何写盘或测试命令；限定 Git MCP 仅供合并专员调用。
// 2. 构建/测试防护：拦截主代理环境下的直接 vitest/build 执行，强制在子特工的隔离沙盒内运行，防止污染。
// 3. 速率压制：拦截高频重复的子代理唤起，限制并发风暴。

function isPathSensitive(target: string): boolean {
	const secure = resolveSecurePath(target);
	try {
		const cwd = fs.realpathSync(process.cwd());
		// If path is inside our sandboxed workspace, validate its relative sub-path to avoid false positives on sandbox worktree path fragments
		if (secure.startsWith(cwd)) {
			const relPath = secure.slice(cwd.length);
			return isRotSensitivePath(relPath) || isRotSensitiveFile(relPath);
		}
	} catch (e: any) {
		console.debug("[Hook Debug] Path resolution failed:", e);
	}
	// If path escapes our workspace (or fails workspace prefix match), perform strict core checks on full physical path
	return isRotSensitivePath(secure) || isRotSensitiveFile(secure);
}

export function main(
	context: Record<string, unknown>,
): PreToolUseResponse {
	// 1. 先跑无副作用的引擎基础防御
	let engineResult;
	try {
		engineResult = globalRuleRunner.runActiveBlock("PreToolUse", context);
		if (((engineResult.status as string) || "allow").toUpperCase() === "DENY") {
			return {
				decision: "deny",
				reason: engineResult.payload?.message || "Blocked by Rule Engine",
				decision_reason:
					engineResult.payload?.message || "Blocked by Rule Engine",
			};
		}
	} catch (e: any) {
		console.error(
			`[RuleRunner] Evaluation failed, fallback to DENY (Fail-Closed): ${e.message}`,
		);
		return { decision: "deny", reason: "Rule engine exception." };
	}

	// 2. 引擎跑通后，跑有副作用/复杂的硬编码动态防御（JIT 注入、命令审查）
	try {
		const postResult = executeDynamicRuleChain(context);
		return postResult || { decision: "allow" };
	} catch (e: any) {
		console.error(`[PostFilter] Exception in executeDynamicRuleChain: ${e.stack}`);
		throw e;
	}
}

export interface DynamicRuleContext {
	rawContext: Record<string, unknown>;
	toolName: string;
	args: Record<string, unknown>;
	transcriptPath: string;
	convId: string;
	currentTurnIdx: number;
	isSub: boolean;
	isReadonlySub: boolean;
	isDeepDiverSub: boolean;
	isMergerSub: boolean;
	mode: string;
	subagentType: string | null;
}

export type DynamicRule = (
	ctx: DynamicRuleContext,
) => PreToolUseResponse | undefined;

function buildDynamicRuleContext(
	rawContext: Record<string, unknown>,
): DynamicRuleContext {
	const toolCall = rawContext["toolCall"] as
		| Record<string, unknown>
		| undefined;
	const toolName = (toolCall?.["name"] as string) ?? "";
	const args = (toolCall?.["args"] as Record<string, unknown>) ?? {};
	const transcriptPath = (rawContext["transcriptPath"] as string) ?? "";

	let mode = "strict";
	let convId = "default";
	if (transcriptPath) {
		const match = transcriptPath.match(/\/brain\/([^\/]+)\//);
		if (match) {
			convId = match[1];
			mode = readMode(convId, "strict");
		}
	}

	const cdal = new ConversationDataAccessLayer(convId);
	const currentTurnIdx = cdal.getCurrentTurnIdx();
	const subagentType = getSubagentType(transcriptPath);

	return {
		rawContext,
		toolName,
		args,
		transcriptPath,
		convId,
		currentTurnIdx,
		isSub: subagentType !== null,
		isReadonlySub: subagentType === "Remora_ReadOnly_Extractor",
		isDeepDiverSub: subagentType === "Remora_Deep_Diver",
		isMergerSub: subagentType === "Remora_Merger",
		mode,
		subagentType,
	};
}

const rotReason = makeDenyReason(
	"ANTI-ROT",
	"Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.",
	"Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications.",
);

function trimTimelineRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	trimStaleHookStates(ctx.convId, ctx.currentTurnIdx);
	return undefined;
}

function checkDuplicateSpawnRule(
	ctx: DynamicRuleContext,
	_now?: number
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "invoke_subagent") return undefined;
	const subagents = ctx.args["Subagents"];
	if (Array.isArray(subagents)) {
		for (const req of subagents) {
			const typeName = req["TypeName"];
			const role = req["Role"];
			const signature = typeName + "::" + role;

			let historyStr = getHookState(
				ctx.convId,
				ctx.currentTurnIdx,
				"subagent_spawns",
			);
			let history: any[] = [];
			try {
				if (historyStr) history = JSON.parse(historyStr);
			} catch (e: any) {
				console.debug("[Hook Debug] JSON parse failed for historyStr:", e);
			}
			if (!Array.isArray(history)) history = [];

			const now = _now ?? Date.now();
			const recentSpawns = history.filter(
				(h: any) =>
					h.signature === signature &&
					now - h.timestamp <
						SYSTEM_POLICY.ORCHESTRATION.REPEAT_SPAWN_WINDOW_MS,
			);

			if (recentSpawns.length > 0) {
				return {
					decision: "deny",
					reason:
						"⛔ [REMORA SAFETY INTERCEPT] High-frequency duplicate dispatch. Spawning '" +
						role +
						"' within 3 minutes for identical verification/extraction. ACTION REQUIRED: Please merge these tasks into a single subagent invocation (or use a self-contained verifier instruction in the developer prompt) to avoid cold startup latency.",
				};
			}

			const newHistory = history.filter(
				(h: any) => now - h.timestamp < 10 * 60 * 1000,
			);
			newHistory.push({ signature, timestamp: now });
			setHookState(
				ctx.convId,
				ctx.currentTurnIdx,
				"subagent_spawns",
				JSON.stringify(newHistory),
			);
		}
	}
	return undefined;
}

function checkPromptSyntaxRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "invoke_subagent") return undefined;
	const subagents =
		(ctx.args["Subagents"] as Array<Record<string, unknown>>) ?? [];
	const rawHistory = getHookState(
		ctx.convId,
		ctx.currentTurnIdx,
		"subagent_dispatch_history",
	);
	let history: Array<{ timestamp: number; role: string; promptHash: string }> =
		[];
	if (rawHistory) {
		try {
			history = JSON.parse(rawHistory);
			if (!Array.isArray(history)) history = [];
		} catch (e: any) {
			console.debug("[Hook Debug] JSON parse failed for rawHistory:", e);
			history = [];
		}
	}
	for (const sub of subagents) {
		const promptStr = (sub["Prompt"] as string) ?? "";
		const syntaxResult = validatePromptSyntax(promptStr);
		if (!syntaxResult.isValid) {
			return {
				decision: "deny",
				reason: `⛔ [REMORA SAFETY INTERCEPT] Subagent Prompt syntax truncation detected. ${syntaxResult.errorReason}. Action required: Verify prompt completeness.`,
			};
		}
	}
	setHookState(
		ctx.convId,
		ctx.currentTurnIdx,
		"subagent_dispatch_history",
		JSON.stringify(history),
	);
	return undefined;
}

function injectSubagentJITRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "invoke_subagent") return undefined;
	const jitInjected = getHookState(
		ctx.convId,
		ctx.currentTurnIdx,
		"subagent_jit",
	);
	if (!jitInjected) {
		setHookState(ctx.convId, ctx.currentTurnIdx, "subagent_jit", "injected");
		return {
			decision: "allow",
			injectSteps: [
				{
					ephemeralMessage: formatJitInjection(),
				},
			],
		};
	}
	return undefined;
}

function checkDefineSubagentOverrideRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "define_subagent") return undefined;
	const name = (ctx.args["name"] as string) ?? "";
	if (BUILTIN_AGENTS.has(name)) {
		const perms = loadBuiltinAgentPerms(name);
		if (perms) {
			const reqWrite = ctx.args["enable_write_tools"] !== false;
			const reqSubagent = ctx.args["enable_subagent_tools"] === true;
			if (
				reqWrite !== perms.enable_write_tools ||
				reqSubagent !== perms.enable_subagent_tools
			) {
				return {
					decision: "deny",
					reason: makeDenyReason(
						"CONFIG_OVERRIDE",
						`Cannot override built-in agent '${name}'. enable_write_tools must be ${perms.enable_write_tools}, enable_subagent_tools must be ${perms.enable_subagent_tools}.`,
						"Use a different name for custom agents.",
					),
				};
			}
		}
	}
	return undefined;
}

function checkSharedWorkspaceTraversalRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	const WRITE_TOOLS = [
		"write_to_file",
		"replace_file_content",
		"multi_replace_file_content",
	];
	if (!WRITE_TOOLS.includes(ctx.toolName)) return undefined;
	const tp = (ctx.args["TargetFile"] as string) ?? "";
	if (tp.includes("parent_shared")) {
		if (ctx.isReadonlySub) {
			return {
				decision: "deny",
				reason: makeDenyReason(
					"READONLY",
					"ReadOnly subagents cannot write to shared scratch.",
					"Read scripts from parent_shared via run_command instead.",
				),
			};
		}
		if (tp.includes("..") || tp.includes("~")) {
			return {
				decision: "deny",
				reason: makeDenyReason(
					"PATH_TRAVERSAL",
					"Path traversal detected in parent_shared target.",
					"Write only within the shared scratch directory.",
				),
			};
		}
		const realPath = resolveSecurePath(tp);
		let realBase: string;
		try {
			realBase = fs.realpathSync(
				path.join(process.cwd(), "scratch", "parent_shared"),
			);
		} catch (e: any) {
			console.warn("[Hook Warn] Shared scratch symlink resolution failed:", e);
			return {
				decision: "deny",
				reason: makeDenyReason(
					"LINK_BROKEN",
					"Shared scratch symlink is broken or missing.",
					"The parent_shared link may need to be recreated.",
				),
			};
		}
		if (!realPath.startsWith(realBase)) {
			return {
				decision: "deny",
				reason: makeDenyReason(
					"DIRECTORY_ESCAPE",
					"Write target resolves outside the shared scratch directory.",
					"Write only within scratch/parent_shared/.",
				),
			};
		}
	}
	return undefined;
}

function checkSendMessageTurnLimitRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "send_message") return undefined;
	const recipient = (ctx.args["Recipient"] as string) ?? "";
	if (recipient) {
		const stateKey = `subagent_turn_limit_${recipient}`;
		const currentCount = parseInt(
			getHookState(ctx.convId, 0, stateKey) || "0",
			10,
		);
		setHookState(ctx.convId, 0, stateKey, String(currentCount + 1));
	}
	return undefined;
}

function checkUnifiedReadLimitRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName === "view_file") {
		const targetFile = (ctx.args["AbsolutePath"] as string) ?? "";
		if (targetFile) {
			const stats = getStats(ctx.convId);
			const currentUnified = stats.unified_accumulated_read_bytes ?? 0;
			if (!ctx.isSub && !isExemptedPath(targetFile)) {
				if (isUnifiedLimitExceeded(currentUnified)) {
					return {
						decision: "deny",
						reason: makeDenyReason(
							"UNIFIED-ANTI-ROT",
							`Unified accumulated read limit exceeded (${Math.floor(currentUnified / 1024)}KB > ${Math.floor(SYSTEM_POLICY.SAFETY.FILE_READ_DENY_BYTES / 1024)}KB). Direct reading in main context is blocked.`,
							"Please delegate to a subagent (e.g. 'Remora_ReadOnly_Extractor' for query/read, 'Remora_Deep_Diver' for test/modify).",
						),
					};
				} else if (isUnifiedLimitApproaching(currentUnified)) {
					console.warn("[Warning] [ANTI-ROT_ALERT]");
				}
			}

			if (!ctx.isSub && ctx.transcriptPath) {
				const sizeLimit = ctx.mode === "relax" ? 200 * 1024 : 50 * 1024;
				try {
					if (
						fs.existsSync(targetFile) &&
						fs.statSync(targetFile).size > sizeLimit
					) {
						return { decision: "deny", reason: rotReason };
					}
				} catch (e: any) {
					console.debug("[Hook Debug] fs.existsSync or statSync failed:", e);
				}

				const isDataLog = /\.(?:jsonl|log|sqlite|csv)$/.test(targetFile);
				const incBytes = estimateReadBytes(ctx.args as any, targetFile);

				if (incBytes > 0) {
					try {
						let statsAccumulated = accumulate(
							ctx.convId,
							isDataLog ? 0 : incBytes,
							isDataLog ? incBytes : 0,
							incBytes,
						);
						if (isAccumulatedLimitExceeded(statsAccumulated)) {
							return {
								decision: "deny",
								reason:
									"⛔ REMORA SAFETY INTERCEPT: CUMULATIVE READ LIMIT EXCEEDED!\n" +
									"============================================================\n" +
									"!!! WARNING: MAIN CONTEXT CORRUPTION IMMINENT !!!\n" +
									`SOURCE READ: ${Math.floor(statsAccumulated.accumulated_source_bytes / 1024)}KB (MAX: 400KB)\n` +
									`DATA READ: ${Math.floor(statsAccumulated.accumulated_data_bytes / 1024)}KB (MAX: 150KB)\n\n` +
									"OPERATION BLOCKED! TO PRESERVE COGNITIVE STABILITY, YOU MUST IMMEDIATELY DELEGATE TO A SUBAGENT.\n\n" +
									"BEFORE YOU EXIT THIS TURN, YOU MUST:\n" +
									"1. ARCHIVE PROGRESS: WRITE A CONCISE PROGRESS REPORT AND TECHNICAL HYPOTHESES TO `/artifacts/task.md` OR THE ACTIVE DECISION LOG.\n" +
									"2. DELEGATE EXECUTION: INVOKE `Remora_ReadOnly_Extractor` FOR READS/QUERIES, OR `Remora_Deep_Diver` FOR MODIFICATIONS.\n" +
									'3. SCHEDULE MONITOR: YOU MUST SIMULTANEOUSLY CALL THE `schedule` TOOL WITH `DurationSeconds="30"` WHEN LAUNCHING THE SUBAGENT.\n\n' +
									"DO NOT ATTEMPT TO RE-RUN THE BLOCKED READ COMMAND IN THIS CONTEXT!\n" +
									"============================================================",
							};
						}
					} catch (e: any) {
						console.error("[Hook Error] safety-check accumulate failed:", e);
					}
				}
			}
		}
	} else if (ctx.toolName === "grep_search") {
		const searchPath = (ctx.args["SearchPath"] as string) ?? "";
		if (searchPath) {
			const stats = getStats(ctx.convId);
			const currentUnified = stats.unified_accumulated_read_bytes ?? 0;
			if (!ctx.isSub && !isExemptedPath(searchPath)) {
				if (isUnifiedLimitExceeded(currentUnified)) {
					return {
						decision: "deny",
						reason: makeDenyReason(
							"UNIFIED-ANTI-ROT",
							`Unified accumulated read limit exceeded (${Math.floor(currentUnified / 1024)}KB > ${Math.floor(SYSTEM_POLICY.SAFETY.FILE_READ_DENY_BYTES / 1024)}KB). Direct grep in main context is blocked.`,
							"Please delegate to a subagent (e.g. 'Remora_ReadOnly_Extractor' for query/read, 'Remora_Deep_Diver' for test/modify).",
						),
					};
				} else if (isUnifiedLimitApproaching(currentUnified)) {
					console.warn("[Warning] [ANTI-ROT_ALERT]");
				}
			}

			if (isPathSensitive(searchPath)) {
				if (!ctx.isSub) {
					return { decision: "deny", reason: rotReason };
				}
			}

			const grepBytes = estimateGrepReadBytes(searchPath);
			if (grepBytes > 0) {
				try {
					accumulate(ctx.convId, 0, 0, grepBytes);
				} catch (e: any) {
					console.error("[Hook Error] safety-check accumulate failed:", e);
				}
			}
		}
	}
	return undefined;
}

function checkGitMcpRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	const isLazyMcpMatch =
		ctx.toolName === "call_mcp_tool" &&
		((ctx.args["ServerName"] as string) || "").replace(/_/g, "-") ===
			"remora-git-mcp";
	const isEagerMcpMatch =
		ctx.toolName.startsWith("mcp_") &&
		/^mcp_remora[-_]git[-_]mcp_/i.test(ctx.toolName);

	if (isLazyMcpMatch || isEagerMcpMatch) {
		let actionName = "";
		let actionArgs: Record<string, unknown> = {};

		if (isLazyMcpMatch) {
			actionName = (ctx.args["ToolName"] as string) || "";
			actionArgs = (ctx.args["Arguments"] as Record<string, unknown>) || {};
		} else {
			actionName = ctx.toolName.replace(/^mcp_remora[-_]git[-_]mcp_/i, "");
			actionArgs = ctx.args;
		}

		const isWriteMcpTool = ["git_checkout", "git_merge", "git_commit"].includes(
			actionName,
		);

		if (isWriteMcpTool && !ctx.isMergerSub) {
			return {
				decision: "deny",
				reason: makeDenyReason(
					"MCP_GIT_DENY",
					`Write operation '${actionName}' via Git MCP is restricted to Remora_Merger.`,
					"Please delegate Git merge, checkout, or commit tasks to 'Remora_Merger' subagent.",
				),
			};
		}

		if (actionName === "git_commit") {
			const commitMsg = (actionArgs["message"] as string) || "";
			if (/[\r\n]|\*\*\*|(\&\&|;|\||`|\$\()/.test(commitMsg)) {
				return {
					decision: "deny",
					reason: makeDenyReason(
						"GIT_ESCAPE",
						"Git commit message contains forbidden characters (newlines, consecutive asterisks, or shell command separators).",
						"Ensure the commit message is clean and does not contain command injections.",
					),
				};
			}
		}
	}
	return undefined;
}

function checkGitCommitEscape(cmd: string): PreToolUseResponse | undefined {
	if (cmd.trim().startsWith("git commit")) {
		const [decision, category] = inspectCommand(cmd);
		if (decision === "deny" && category === "git_escape") {
			return {
				decision: "deny",
				reason: makeDenyReason(
					"GIT_COMMIT_ESCAPE",
					"Git commit message containing newline characters or consecutive asterisks is blocked to prevent escape vulnerabilities.",
					"Avoid using newline characters or consecutive asterisks in git commit message.",
				),
			};
		}
		return { decision: "allow" };
	}
	return undefined;
}

function auditMergerCmdRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "run_command" || !ctx.isMergerSub) return undefined;
	const cmd = (ctx.args["CommandLine"] as string) ?? "";
	const escapeResult = checkGitCommitEscape(cmd);
	if (escapeResult) return escapeResult;

	const trimmed = cmd.trim();
	const isGitAllowed = [
		"git checkout",
		"git merge",
		"git am",
		"git apply",
		"git add",
		"git commit",
		"git diff",
		"git status",
	].some((prefix) => trimmed.startsWith(prefix));

	const hasRestrictedKeywords = [
		"npm run",
		"vitest",
		"npm test",
		"jest",
		"pytest",
		"sh ",
		"bash ",
		"./",
		"source ",
		"exec ",
	].some((kw) => trimmed.includes(kw));

	if (!isGitAllowed || hasRestrictedKeywords) {
		return {
			decision: "deny",
			reason: makeDenyReason(
				"MERGER_DENY",
				"Remora_Merger is strictly restricted to approved version control actions.",
				"Only approved git commands (checkout, merge, am, apply, add, commit, diff, status) are allowed.",
			),
		};
	}
	return { decision: "allow" };
}

function auditReadonlyCmdRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "run_command" || !ctx.isReadonlySub) return undefined;
	const cmd = (ctx.args["CommandLine"] as string) ?? "";
	const escapeResult = checkGitCommitEscape(cmd);
	if (escapeResult) return escapeResult;


	const [decision] = inspectCommand(cmd);
	if (decision !== "allow") {
		return {
			decision: "deny",
			reason: makeDenyReason(
				"READONLY",
				"Remora_ReadOnly_Extractor is strictly read-only.",
				"Do not run write/test/build commands!",
			),
		};
	}
	return { decision: "allow" };
}

function auditDeepDiverCmdRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (
		ctx.toolName !== "run_command" ||
		!ctx.isSub ||
		ctx.isMergerSub ||
		ctx.isReadonlySub
	) {
		return undefined;
	}
	const cmd = (ctx.args["CommandLine"] as string) ?? "";
	const escapeResult = checkGitCommitEscape(cmd);
	if (escapeResult) return escapeResult;


	return { decision: "allow" };
}

function auditMainCmdRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "run_command" || ctx.isSub) return undefined;
	const cmd = (ctx.args["CommandLine"] as string) ?? "";
	const escapeResult = checkGitCommitEscape(cmd);
	if (escapeResult) return escapeResult;


	const rotPattern =
		/\b(?:cat|tail|grep|jq|awk|sed|sqlite3)\b.*?(?:\.jsonl|\.log|\.sqlite)\b|\bremora-recall\.(?:py|ts)\b/i;
	const hasRotFeature = rotPattern.test(cmd);
	const isRecallCall = /\bremora-recall\b/i.test(cmd);

	const [decision, category] = inspectCommand(cmd);

	if (hasRotFeature) {
		if (isRecallCall) {
			return { decision: "allow" };
		}
		return { decision: "deny", reason: rotReason };
	} else {
		if (decision === "deny") {if (category === "test" || category === "build") {
				return {
					decision: "deny",
					reason:
						"⛔ REMORA SAFETY LIMIT [DELEGATION-BLOCKED]: DIRECT COMMAND RUNS BLOCKED!\n" +
						"============================================================\n" +
						"!!! WARNING: UNTRUSTED CODE EXECUTION PREVENTED !!!\n" +
						"TO PROTECT THE ACTIVE WORKING TREE AND PRESERVE MASTER BRANCH INTEGRITY FROM UNSAFE STATE CHANGES OR UNREVIEWED CODE EXECUTION DURING BUILD/TEST PHASES, DIRECT EXECUTION OF pytest/build IS PROHIBITED.\n\n" +
						"YOU MUST RUN THESE COMMANDS IN AN ISOLATED WORKSPACE:\n" +
						'- FOR TESTING/DIAGNOSTICS: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: "branch"`.\n' +
						'- FOR COMPILING/BUILDING: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: "share"`.\n\n' +
						"DO NOT ATTEMPT TO BYPASS THIS DEFENSE BY ALIASING, SHELL SCRIPT WRAPPING, OR ALTERNATIVE PATH RUNS! ALL BYPASS ATTEMPTS WILL BE LOGGED AND BLOCKED.\n" +
						"============================================================",
				};
			} else {
				const trimmed = cmd.trim();
				const isGitMergeOrControl = [
					"git checkout",
					"git merge",
					"git am",
					"git apply",
					"git cherry-pick",
					"git rebase",
				].some((prefix) => trimmed.startsWith(prefix));

				if (isGitMergeOrControl) {
					return {
						decision: "deny",
						reason: makeDenyReason(
							"DELEGATION",
							"Version control merge or checkout commands cannot be run directly in main context.",
							"Please delegate to 'Remora_Merger' subagent with Workspace: 'inherit' and use 'remora-git-mcp' tools safely.",
						),
					};
				}

				return {
					decision: "deny",
					reason: makeDenyReason(
						"DELEGATION",
						"Command verification failed due to syntax parser error.",
						"Please delegate to a subagent under (Workspace: 'branch')!",
					),
				};
			}
		} else {
			const blastDone = getHookState(
				ctx.convId,
				ctx.currentTurnIdx,
				"blast_radius",
			);
			if (!blastDone) {
				const cdal = new ConversationDataAccessLayer(ctx.convId);
				const latestResp = cdal.getLatestPlannerResponse() ?? "";
				const alreadyAware =
					/(?:blast radius|reversible|undo|shared state|no-?verify|force push|irreversible)/i.test(
						latestResp,
					);
				if (!alreadyAware) {
					setHookState(ctx.convId, ctx.currentTurnIdx, "blast_radius", "1");
					return {
						decision: "allow",
						injectSteps: [
							{
								ephemeralMessage:
									"BLAST RADIUS CHECK:\n" +
									"- Does this command affect only your workspace, or shared state?\n" +
									"- If it goes wrong, can you undo it?\n" +
									"- Do NOT use --no-verify, --force, or rm -rf to bypass problems.\n" +
									'- If "shared" or "irreversible", delegate to a subagent with Workspace: branch.',
							},
						],
					};
				}
			}
			return { decision: "allow" };
		}
	}
}
export const dynamicRules: DynamicRule[] = [
	trimTimelineRule,
	checkDuplicateSpawnRule,
	checkPromptSyntaxRule,
	injectSubagentJITRule,
	checkDefineSubagentOverrideRule,
	checkSharedWorkspaceTraversalRule,
	checkSendMessageTurnLimitRule,
	checkUnifiedReadLimitRule,
	checkGitMcpRule,
	auditMergerCmdRule,
	auditReadonlyCmdRule,
	auditDeepDiverCmdRule,
	auditMainCmdRule,
];

export function executeDynamicRuleChain(
	rawContext: Record<string, unknown>,
): PreToolUseResponse | undefined {
	const ctx = buildDynamicRuleContext(rawContext);
	for (const rule of dynamicRules) {
		const result = rule(ctx);
		if (result) return result;
	}
	return { decision: "allow" };
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
	hookEntrypoint()(main)();
}
