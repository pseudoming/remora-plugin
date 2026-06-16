import { PreInvocationResponse, AntigravityHookContext } from "../types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

export function recoverCoreDistSymlink(pluginRoot: string): void {
	if (!pluginRoot) return;
	const sandboxedCoreDist = path.join(pluginRoot, "packages", "core", "dist");
	const gitPath = path.join(pluginRoot, ".git");
	const isBranchSandbox =
		fs.existsSync(gitPath) && fs.statSync(gitPath).isFile();

	if (isBranchSandbox && !fs.existsSync(sandboxedCoreDist)) {
		let parentDir = "";
		try {
			const gitContent = fs.readFileSync(gitPath, "utf-8").trim();
			const parts = gitContent.split("/.git/worktrees/");
			if (parts.length > 1) {
				parentDir = parts[0].replace("gitdir:", "").trim();
			}
		} catch (e: any) {
			console.debug("[Hook Debug] Error:", e);
		}

		if (parentDir) {
			const parentCoreDist = path.join(parentDir, "packages", "core", "dist");
			if (fs.existsSync(parentCoreDist)) {
				try {
					const stat = fs.lstatSync(sandboxedCoreDist);
					if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) {
						fs.rmSync(sandboxedCoreDist, { recursive: true, force: true });
					}
				} catch (e: any) {
					console.debug("[Hook Debug] FS cleanup skipped (expected):", e);
				}
				fs.symlinkSync(parentCoreDist, sandboxedCoreDist);
			} else {
				throw new Error(
					`[MONOREPO_BUILD_ERROR] Core package not built in parent workspace. Please run: cd ${parentDir} && npm run build`
				);
			}
		}
	}
}

export function ensureRemoraSystemProjectConfig(): void {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "";
	if (homeDir) {
		const projectDir = path.join(homeDir, ".gemini", "config", "projects");
		const configPath = path.join(
			projectDir,
			"11111111-1111-1111-1111-111111111111.json",
		);
		if (!fs.existsSync(configPath)) {
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(
				configPath,
				JSON.stringify(
					{
						id: "11111111-1111-1111-1111-111111111111",
						name: "remora-system",
						projectResources: { resources: [] },
					},
					null,
					2,
				),
				"utf-8",
			);
		}
	}
}

// Bootstrap: Auto-recover packages/core/dist symlink before importing @remora/core
(function bootstrap() {
	const findPluginRoot = () => {
		let currentDir = require("node:path").resolve(__dirname);
		while (currentDir !== "/" && currentDir !== "") {
			if (fs.existsSync(require("node:path").join(currentDir, "plugin.json"))) {
				return currentDir;
			}
			currentDir = require("node:path").dirname(currentDir);
		}
		// Fallback fallback if __dirname is dist/
		let fallbackDir = require("node:path").resolve(__dirname, "..", "..");
		if (fs.existsSync(require("node:path").join(fallbackDir, "plugin.json"))) {
			return fallbackDir;
		}
		return "";
	};

	try {
		const pluginRoot = findPluginRoot();
		recoverCoreDistSymlink(pluginRoot);
	} catch (e: any) {
		console.warn("[session-guardian] recoverCoreDistSymlink failed:", e);
	}

	try {
		ensureRemoraSystemProjectConfig();
	} catch (e: any) {
		console.warn("[session-guardian] ensureRemoraSystemProjectConfig failed:", e);
	}
})();

import {
	warn,
	error,
	cleanSystemReminders,
	detectMode,
	isTimerCanceled,
	markFired,
	formatStrictRecallReminder,
	formatAlertRecallPrompt,
	formatHeartbeatTimerInjection,
	formatCumulativeReadWarning,
	formatSubagentDispatchReminder,
	writeMode,
	getHookState,
	getConn,
	getProjectUuidByConv,
	getActiveTopic,
	getDecisionsByTopic,
	getProjectConstraints,
	SYSTEM_POLICY,
	getArtifactHash,
	upsertArtifactHash,
} from "@remora/core";
import { createHash } from "node:crypto";
import { cleanup, getStats } from "../bridge/stats";
import {
	getSubagentTypeByConvId,
	getParentConvId,
} from "../bridge/subagent";
import {
	getBrainDir,
	getDataDir,
	extractConvId,
	findPluginRoot,
} from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";

export function main(context: AntigravityHookContext): PreInvocationResponse {
	try {
		return _main(context);
	} catch (err) {
		const error = err as any;
		if (
			error &&
			error.message &&
			error.message.includes("[MONOREPO_BUILD_ERROR]")
		) {
			throw err;
		}
		return {
			injectSteps: [
				{
					ephemeralMessage:
						"<system-reminder>⚠️ Remora Session Guardian 发生异常。状态同步防线已降级，但不影响正常对话。</system-reminder>",
				},
			],
		};
	}
}

function _main(context: AntigravityHookContext): {
	injectSteps: Array<Record<string, unknown>>;
} {
	// 0. Fail-Fast 探测环境是否已被 install.py 初始化
	const initializedFile = path.join(getDataDir(), ".runtime", "installed.flag");
	if (!fs.existsSync(initializedFile)) {
		return {
			injectSteps: [
				{
					ephemeralMessage:
						"🚨 **[REMORA FATAL ERROR]** Plugin uninitialized! Please run `npm run build && node packages/adapter-antigravity/bin/install.js --force` in the plugin root.",
				},
			],
		};
	}

	const transcriptPath = context.transcriptPath ?? "";
	const pluginRoot = findPluginRoot();
	recoverCoreDistSymlink(pluginRoot);
	const sandboxedCoreDist = path.join(pluginRoot, "packages", "core", "dist");

	const isTest = !!(process.env.VITEST || process.env.NODE_ENV === "test");
	if (!isTest && !fs.existsSync(sandboxedCoreDist)) {
		return {
			injectSteps: [
				{
					ephemeralMessage: `🚨 **[MONOREPO_BUILD_ERROR]** Core package not built. Please run: cd ${pluginRoot} && npm run build`,
				},
			],
		};
	}

	// 物理缓存 LS API 凭据以解决子代理在 Hook 沙盒中缺乏鉴权环境变量的问题
	const lsAddr = process.env["ANTIGRAVITY_LS_ADDRESS"];
	const csrfToken = process.env["ANTIGRAVITY_CSRF_TOKEN"];
	if (lsAddr && csrfToken) {
		try {
			fs.mkdirSync(path.join(getDataDir(), ".runtime"), { recursive: true });
			fs.writeFileSync(
				path.join(getDataDir(), ".runtime", "remora_agent_env.json"),
				JSON.stringify({
					ANTIGRAVITY_LS_ADDRESS: lsAddr,
					ANTIGRAVITY_CSRF_TOKEN: csrfToken,
				}),
				"utf-8",
			);
		} catch (e: any) {
		console.warn("[Hook Warn] FS ops failed:", e);
	}
	}

	// 提取当前会话 ID
	const convId = extractConvId(transcriptPath) || "default";

	// --- Shared scratch mounting ---
	try {
		const parentConvId = getParentConvId(convId);
		if (parentConvId) {
			// Subagent: mount parent's shared scratch directory
			const sharedSrc = path.join(
				getBrainDir(),
				parentConvId,
				"scratch",
				"subagent_shared",
			);
			try {
				fs.mkdirSync(sharedSrc, { recursive: true });
			} catch (e: any) {
				console.warn("[Hook Warn] mkdirSync failed:", e);
			}

			const scratchDst = path.join(process.cwd(), "scratch");
			try {
				fs.mkdirSync(scratchDst, { recursive: true });
			} catch (e: any) {
				console.warn("[Hook Warn] mkdirSync failed:", e);
			}

			const linkDst = path.join(scratchDst, "parent_shared");

			let linkExists = false;
			try {
				fs.lstatSync(linkDst);
				linkExists = true;
			} catch {
				// link does not exist
			}

			if (!linkExists) {
				try {
					fs.symlinkSync(sharedSrc, linkDst, "dir");
				} catch (err: any) {
					if (err.code === "EEXIST") {
						try {
							fs.unlinkSync(linkDst);
							fs.symlinkSync(sharedSrc, linkDst, "dir");
						} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}
					}
				}
			}
		} else {
			// Main agent: initialize shared subdirectory
			const parentScratch = path.join(getBrainDir(), convId, "scratch");
			try {
				fs.mkdirSync(path.join(parentScratch, "subagent_shared"), { recursive: true });
			} catch (e: any) {
				console.warn("[Hook Warn] mkdirSync failed:", e);
			}

			// 导出活跃 Topic 决策到 项目级别 供所有会话共享
			try {
				const conn = getConn();
				try {
					const projectUuid = getProjectUuidByConv(convId, conn);
					if (projectUuid) {
						const activeTopicId = getActiveTopic(projectUuid, conn);
						if (activeTopicId) {
							const decisions = getDecisionsByTopic(
								projectUuid,
								activeTopicId,
								conn,
							);
							const exportData = {
								project_uuid: projectUuid,
								topic_id: activeTopicId,
								decisions: decisions,
								exported_at: new Date().toISOString(),
							};
							const projectDir = path.join(getDataDir(), projectUuid);
							if (!fs.existsSync(projectDir)) {
								fs.mkdirSync(projectDir, { recursive: true });
							}
							const exportPath = path.join(
								projectDir,
								"decisions.json",
							);
							fs.writeFileSync(
								exportPath,
								JSON.stringify(exportData, null, 2),
								"utf-8",
							);
						}
					}
				} finally {
					if (conn) conn.close();
				}
			} catch (e: any) {
		console.debug("[Hook Debug] FS cleanup skipped (expected):", e);
	}
		}
	} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}
	// --- End shared scratch ---

	const cdal = new ConversationDataAccessLayer(convId);

	// 动态读取 SQLite 获取最后一条用户指令
	let lastMsg = "";
	let heartbeatSteps: Array<Record<string, unknown>> = [];
	let isNewTurn = false;

	try {
		// 使用 CDAL 的原生 SQLite 倒序查询接口，安全获取最后 N 步
		const steps = cdal.streamStepsReverse(SYSTEM_POLICY.ORCHESTRATION.STREAM_HISTORY_DEPTH);
		heartbeatSteps = Array.isArray(steps) ? steps : Array.from(steps);

		// 提取 last_msg 和 is_new_turn
		// heartbeat_steps 已经是逆序的 (从新到旧)
		for (const step of heartbeatSteps.slice(0, 50)) {
			const stepType = step["type"] as string;
			if (
				stepType === "EPHEMERAL_MESSAGE" ||
				stepType === "SYSTEM_MESSAGE" ||
				stepType === "ERROR_MESSAGE"
			) {
				continue;
			}
			if (stepType === "USER_INPUT") {
				isNewTurn = true;
				lastMsg = (step["content"] as string) || "";
			}
			break;
		}
	} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}

	const keywordsConfigPath = path.join(
		findPluginRoot(),
		"conf",
		"keywords.json",
	);
	let relaxKws: string[] = [];
	let alertKws: string[] = [];
	try {
		const config = JSON.parse(
			fs.readFileSync(keywordsConfigPath, "utf-8"),
		) as Record<string, unknown>;
		relaxKws = (config["relax_keywords"] as string[]) || [];
		alertKws = (config["alert_keywords"] as string[]) || [];
	} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}

	const injectSteps: Array<Record<string, unknown>> = [];

	// ==========================================
	// 设计原理六：子代理创建的即时捕获与心跳断链续期状态机逻辑 (已优化无心跳提示语)
	// ==========================================
	// 由于平台的 One-shot 计时器会在子代理发送 any 中间进度同步消息时自动静默取消，
	// 我们直接在 PreInvocation 阶段从 CDAL 原生层中分析最新 UUID，并计算
	// 子代理最近活动与最近一次 schedule 定时器的相对时序。若已被取消且模型未续期，
	// 在上下文最前沿通过 injectSteps 注入强强制心跳指示。
	// 优化点：当无心跳定时器运行时，注入的消息及中文翻译使用角色名称 role_name 替代 uuid，
	// 并强制引导大模型使用拟人化的"进度+时间"汇报进度（如 subagent (role_name)），杜绝暴露底层安全定时器技术术语。
	let subagentUuid: string | null = null;
	let seenSubagent = false;
	let hasScheduleAfter = false;
	let latestSubagentActivityIndex = -1;
	let latestScheduleIndex = -1;
	let subagentFinishDetected = false;

	if (heartbeatSteps.length > 0) {
		try {
			// Pass 1：提取最新的 subagent_uuid 以及 schedule 挂载状态
			// 注意：heartbeat_steps 本来就是逆序的，所以直接遍历即可
			for (let idx = 0; idx < heartbeatSteps.length; idx++) {
				const step = heartbeatSteps[idx];
				const stepType = step["type"] as string;
				const stepStr = JSON.stringify(step);

				// 记录最新的 schedule 挂载，及 schedule 挂载判定（无论时序，只要同一轮且提及了 monitor 探活即可）
				// 从主干的 schedule 参数里直接正则提取最新拉起的子代理 UUID，从根源杜绝文本投毒及类型缺失的问题
				if (stepType === "PLANNER_RESPONSE" && step["tool_calls"]) {
					const toolCalls = step["tool_calls"] as Array<
						Record<string, unknown>
					>;
					for (const tc of toolCalls) {
						if (tc["name"] === "schedule") {
							const argsStr = JSON.stringify(
								tc["args"] || tc["arguments"] || {},
							);
							if (latestScheduleIndex === -1) {
								latestScheduleIndex = idx;
								if (argsStr.includes("subagent-monitor.js")) {
									hasScheduleAfter = true;
								} else {
									hasScheduleAfter = false;
								}
							}

							if (!subagentUuid && argsStr.includes("subagent-monitor.js")) {
								const uuidRegex =
									/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
								const cidMatches = Array.from(argsStr.matchAll(uuidRegex));
								for (const match of cidMatches) {
									const uid = match[1];
									if (
										uid !== convId &&
										uid !== "11111111-1111-1111-1111-111111111111"
									) {
										subagentUuid = uid;
										seenSubagent = true;
										break;
									}
								}
							}
							break;
						}
					}
				}

				// 判断子代理是否已被主动清理完成 (时序边界：模型发起清理，或物理回执明确包含 Successfully killed)
				// 注意：必须严格限定为 GENERIC 回执或 manage_subagents 调用，杜绝大模型在 thinking 字段 of 文本讨论触发假阳性
				if (!seenSubagent) {
					let isKillCommand = false;
					if (stepType === "PLANNER_RESPONSE" && step["tool_calls"]) {
						const toolCalls = step["tool_calls"] as Array<
							Record<string, unknown>
						>;
						for (const tc of toolCalls) {
							if (tc["name"] === "manage_subagents") {
								const args = (tc["args"] || tc["arguments"] || {}) as Record<
									string,
									unknown
								>;
								const action = String(args["Action"] || "").replace(
									/^"(.*)"$/,
									"$1",
								);
								if (action === "kill" || action === "kill_all") {
									isKillCommand = true;
									break;
								}
							}
						}
					}
					const isSystemConfirm =
						stepType === "GENERIC" &&
						step["content"] &&
						typeof step["content"] === "string" &&
						((step["content"] as string).includes("Successfully killed") ||
							(step["content"] as string).includes("Terminated subagent"));
					if (isKillCommand || isSystemConfirm) {
						subagentFinishDetected = true;
					}
				}
			}

			// Pass 2：在 subagent_uuid 提取成功后，以该特定 ID 进行精准活跃检测，排除其它 UUID 及主干物理工具调用输出 of 噪声干扰
			if (subagentUuid && !subagentFinishDetected) {
				for (let idx = 0; idx < heartbeatSteps.length; idx++) {
					const step = heartbeatSteps[idx];
					const stepType = step["type"] as string;
					const stepStr = JSON.stringify(step);

					// 彻底放宽拦截类型捕获各种格式的消息体，但严格排除系统自身的大型历史汇总记录
					if (
						stepType !== "CONVERSATION_HISTORY" &&
						stepType !== "CHECKPOINT"
					) {
						// 精确匹配本子代理的活跃，且排除主会话自己物理命令/文件读写/subagent状态查询所产生的带有 UUID 的输出干扰
						if (
							stepStr.includes(subagentUuid) &&
							![
								"run_command",
								"view_file",
								"grep_search",
								"manage_subagents",
								"schedule",
							].some((cmd) => stepStr.includes(cmd))
						) {
							latestSubagentActivityIndex = idx;
							break;
						}
					}
				}
			}

			// 正常退出自动物理清除重试计数缓存
			if (subagentFinishDetected) {
				try {
					const retryFile = path.join(
						getDataDir(),
						".runtime",
						`remora_subagent_retries_${convId}.json`,
					);
					if (fs.existsSync(retryFile)) {
						fs.unlinkSync(retryFile);
					}
				} catch (e: any) {
					console.debug("[Hook Debug] FS cleanup skipped (expected):", e);
				}
			}
		} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}
	}

	// 逆序索引越小时间越近。若子代理活动比最新的定时器更近，代表 timer 已经被该中间消息自动静默取消了
	const timerCanceled = isTimerCanceled(
		latestSubagentActivityIndex,
		latestScheduleIndex,
	);

	if (
		subagentUuid &&
		!subagentFinishDetected &&
		(!hasScheduleAfter || timerCanceled)
	) {
		const pluginRoot = findPluginRoot();
		const pythonBin = "node";

		let roleName = getSubagentTypeByConvId(subagentUuid) as string | null;

		if (!roleName && heartbeatSteps.length > 0) {
			try {
				for (const step of heartbeatSteps) {
					if (step["type"] === "PLANNER_RESPONSE" && step["tool_calls"]) {
						const toolCalls = step["tool_calls"] as Array<
							Record<string, unknown>
						>;
						for (const tc of toolCalls) {
							if (tc["name"] === "invoke_subagent") {
								const argsSub = (tc["args"] || tc["arguments"] || {}) as Record<
									string,
									unknown
								>;
								const subagents = argsSub["Subagents"] as
									| Array<Record<string, unknown>>
									| undefined;
								if (subagents && subagents.length > 0) {
									for (const s of subagents) {
										if (s["TypeName"]) {
											roleName = s["TypeName"] as string;
											break;
										}
									}
								} else if (argsSub["TypeName"]) {
									roleName = argsSub["TypeName"] as string;
								}
								if (roleName) {
									break;
								}
							}
						}
					}
					if (roleName) {
						break;
					}
				}
			} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}
		}

		if (!roleName) {
			roleName = subagentUuid;
		}

		injectSteps.push({
			ephemeralMessage: formatHeartbeatTimerInjection(
				roleName,
				subagentUuid,
				pythonBin,
				pluginRoot,
				convId,
			),
		});
	}

	const cleanMsg = cleanSystemReminders(lastMsg);

	const [mode, alertWord] = detectMode(cleanMsg, relaxKws, alertKws);

	if (alertWord) {
		const recallCmd = `npx tsx packages/adapter-antigravity/src/cli/remora-recall.ts "${alertWord}"`;
		injectSteps.push({
			ephemeralMessage: formatAlertRecallPrompt(alertWord, recallCmd),
		});
	} else if (mode === "strict") {
		let currentTurnIdx = cdal.getCurrentTurnIdx();
		let currentTurnIdxNum = 0;
		if (currentTurnIdx !== null && currentTurnIdx !== undefined) {
			const parsed = parseInt(String(currentTurnIdx), 10);
			if (!isNaN(parsed)) {
				currentTurnIdxNum = parsed;
			}
		}
		const lastRecallStr = getHookState(convId, -1, "last_recall_turn");
		let lastRecall = 0;
		if (lastRecallStr) {
			const parsed = parseInt(lastRecallStr, 10);
			if (!isNaN(parsed)) {
				lastRecall = parsed;
			}
		}
		if (currentTurnIdxNum - lastRecall >= 3) {
			injectSteps.push({
				ephemeralMessage: formatStrictRecallReminder("remora-recall.ts"),
			});
			markFired(convId, "last_recall_turn", String(currentTurnIdxNum));
		}
	}

	writeMode(convId, mode);

	try {
		if (isNewTurn) {
			cleanup(convId);
		}

		const stats = getStats(convId);
		const srcKb = Math.floor(
			((stats["accumulated_source_bytes"] as number) || 0) / 1024,
		);
		const dataKb = Math.floor(
			((stats["accumulated_data_bytes"] as number) || 0) / 1024,
		);

		const hasSubagentKeyword =
			/\b(?:subagent|diver|extractor)\b|委派|沙盒/i.test(cleanMsg);
		const lastDispatchTurnStr = getHookState(
			convId,
			-1,
			"dispatch_protocol_injected_turn",
		);
		let currentTurnIdx = cdal.getCurrentTurnIdx();
		let currentTurnIdxNum = 0;
		if (currentTurnIdx !== null && currentTurnIdx !== undefined) {
			const parsed = parseInt(String(currentTurnIdx), 10);
			if (!isNaN(parsed)) {
				currentTurnIdxNum = parsed;
			}
		}
		const alreadyInjectedThisTurn =
			lastDispatchTurnStr === String(currentTurnIdxNum);

		const projectUuid = getProjectUuidByConv(convId);
		if (projectUuid) {
			// Event-Driven Sync: Check docs hash & detached spawn
			try {
				const conn = getConn();
					try {
						let workspacePath = process.cwd();
						if (context.workspacePaths && context.workspacePaths.length > 0) {
							workspacePath = context.workspacePaths[0];
						} else if ((context as any).workspaceUris && (context as any).workspaceUris.length > 0) {
							workspacePath = (context as any).workspaceUris[0].replace(/^file:\/\//, "");
						} else {
							const homeDir = process.env.HOME || process.env.USERPROFILE || "";
							const projectDir = path.join(homeDir, ".gemini", "config", "projects");
							if (fs.existsSync(projectDir)) {
								const files = fs.readdirSync(projectDir);
								for (const f of files) {
									if (f.endsWith(".json")) {
										try {
											const config = JSON.parse(fs.readFileSync(path.join(projectDir, f), "utf-8"));
											if (config.projectResources && config.projectResources.resources && config.projectResources.resources.length > 0) {
												const folderUri = config.projectResources.resources[0].gitFolder?.folderUri || config.projectResources.resources[0].folder?.folderUri;
												if (folderUri) {
													const candidate = folderUri.replace(/^file:\/\//, "");
													if (fs.existsSync(path.join(candidate, "AGENTS.md"))) {
														workspacePath = candidate;
														break;
													}
												}
											}
										} catch(e) {}
									}
								}
							}
						}

						const debugPayload = {
							context_workspacePaths: context.workspacePaths,
							context_workspaceUris: (context as any).workspaceUris,
							resolved_workspacePath: workspacePath,
						};
						fs.writeFileSync("/tmp/hook_state.log", JSON.stringify(debugPayload, null, 2));

						const targetFiles = [
							path.join(workspacePath, "AGENTS.md"),
							path.join(workspacePath, "CLAUDE.md"),
							path.join(workspacePath, ".cursorrules"),
							path.join(workspacePath, ".github", "copilot-instructions.md"),
						];
						const normalizedCwd = workspacePath.replace(/\//g, "-");
						const ccMemoryDir = path.join(os.homedir(), ".claude", "projects", normalizedCwd, "memory");
						if (fs.existsSync(ccMemoryDir)) {
							const memFiles = fs.readdirSync(ccMemoryDir);
							for (const mf of memFiles) {
								if (mf.endsWith(".md")) {
									targetFiles.push(path.join(ccMemoryDir, mf));
								}
							}
						}

						let combinedData = "";
						for (const f of targetFiles) {
							if (fs.existsSync(f)) {
								combinedData += fs.readFileSync(f, "utf-8");
							}
						}

						if (combinedData.length > 0) {
							const currentHash = createHash("md5").update(combinedData).digest("hex");
							const hashKey = "project_docs_seed_hash";
							const prevHash = getArtifactHash(hashKey, conn);

							console.log(`[Hook Info] Docs hash check: prev=${prevHash || "(none)"}, current=${currentHash}, files=${targetFiles.length}`);
							if (currentHash !== prevHash) {
								console.log("[Hook Info] Project docs changed. Spawning detached seed extraction...");
								upsertArtifactHash(hashKey, currentHash, conn);
								const scriptPath = path.join(findPluginRoot(), "packages", "adapter-antigravity", "dist", "sidecar", "seed-docs.js");
								const worker = spawn(process.execPath, [scriptPath, projectUuid, workspacePath], {
									detached: true,
									stdio: "ignore",
									env: process.env,
								});
								worker.unref();
								console.log(`[Hook Info] Seed extraction worker spawned (pid=${worker.pid})`);
							} else {
							}
						} else {
						}
					} finally {
						if (conn) conn.close();
					}
			} catch (err) {
				console.error("[Hook Debug] Error in docs hash check:", err);
			}
		}

		if (!alreadyInjectedThisTurn && (srcKb > 15 || dataKb > 5 || hasSubagentKeyword)) {
			if (srcKb > 15 || dataKb > 5) {
				injectSteps.push({
					ephemeralMessage: formatCumulativeReadWarning(srcKb, dataKb),
				});
			}
			injectSteps.push({
				ephemeralMessage: formatSubagentDispatchReminder(),
			});
			
			console.log(`[Hook Info] dispatch triggered: convId=${convId}, projectUuid=${projectUuid || "(null)"}, srcKb=${srcKb}, dataKb=${dataKb}, hasSubagentKeyword=${hasSubagentKeyword}`);
			if (projectUuid) {
				const projectDecisionsPath = path.join(getDataDir(), projectUuid, "decisions.json");
				let constraintsText = "";
				try {
					const constraints = getProjectConstraints(projectUuid);
					console.log(`[Hook Info] Loaded ${constraints.length} behavioral constraints for ${projectUuid}`);
					if (constraints && constraints.length > 0) {
						constraintsText = `\n\n<system-discipline>\n[CRITICAL BEHAVIORAL CONSTRAINTS]\n${constraints.map(c => `- ${c.decision}`).join("\n")}\n</system-discipline>`;
					}
				} catch (err) {
					console.error("[Hook Debug] Error fetching project constraints:", err);
				}

				injectSteps.push({
					ephemeralMessage: `<system-reminder>⚠️ 项目决策持久化于 ${projectDecisionsPath}。跨会话前读取此文件可恢复历史决策。${constraintsText}</system-reminder>`
				});
			}

			markFired(
				convId,
				"dispatch_protocol_injected_turn",
				String(currentTurnIdxNum),
			);
		}
	} catch (e: any) {
		console.debug("[Hook Debug] Error:", e);
	}

	return { injectSteps: injectSteps };
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
	hookEntrypoint()(main)();
}
