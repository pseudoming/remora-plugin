import {
	RuleEngine,
	Rule,
	Fact,
	IFactExtractor,
	DecisionResult,
} from "@remora/core";
import { findPluginRoot, resolveSecurePath } from "../bridge/paths";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	info,
	error,
	isRotSensitiveFile,
	isRotSensitivePath,
	inspectCommand,
	getHookState,
	setHookState,
	stripMarkdownCodeBlocks,
	readMode,
} from "@remora/core";
import { getSubagentType, getSubagentTypeByConvId } from "../bridge/subagent";
import { ConversationDataAccessLayer } from "../bridge/conversation";

function isPathSensitive(target: string): boolean {
	if (!target) return false;
	const secure = resolveSecurePath(target);
	try {
		const cwd = fs.realpathSync(process.cwd());
		if (secure.startsWith(cwd)) {
			const relPath = secure.slice(cwd.length);
			return isRotSensitivePath(relPath) || isRotSensitiveFile(relPath);
		}
	} catch (e) {}
	return isRotSensitivePath(secure) || isRotSensitiveFile(secure);
}

export class AntigravityFactExtractor implements IFactExtractor {
	public extract(rawPayload: Record<string, any>): Fact {
		const transcriptPath = (rawPayload["transcriptPath"] as string) ?? "";
		const toolCall = rawPayload["toolCall"] as Record<string, any> | undefined;
		const toolName = (toolCall?.["name"] as string) ?? "";
		const args = (toolCall?.["args"] as Record<string, any>) ?? {};

		let convId = "default";
		if (transcriptPath) {
			const match = transcriptPath.match(/\/brain\/([^/]+)\//);
			if (match) {
				convId = match[1];
			}
		}
		let currentTurnIdx = 0;
		try {
			const cdal = new ConversationDataAccessLayer(convId);
			currentTurnIdx = cdal.getCurrentTurnIdx();
		} catch {}

		const subagentType = getSubagentType(transcriptPath);
		const isSub = subagentType !== null;

		const isWriteTool = [
			"write_to_file",
			"replace_file_content",
			"multi_replace_file_content",
		].includes(toolName);
		const isNonAllowRunCommand =
			toolName === "run_command" &&
			inspectCommand((args["CommandLine"] as string) ?? "")[0] !== "allow";
		const isWriteOperation = isWriteTool || isNonAllowRunCommand;

		// isSandboxEscaped bug fix (only restrict Deep Diver)
		let isSandboxEscaped = false;
		if (toolName === "invoke_subagent") {
			const subagents = (args["Subagents"] as Array<Record<string, any>>) ?? [];
			for (const sub of subagents) {
				const tName = (sub["TypeName"] as string) ?? "";
				const ws = (sub["Workspace"] as string) ?? "inherit";
				if (
					tName === "Remora_Deep_Diver" &&
					ws !== "branch" &&
					ws !== "share"
				) {
					isSandboxEscaped = true;
					break;
				}
			}
		}

		let promptLength = 0;
		let promptDensityViolation = false;
		let isActionableInherit = false;
		if (toolName === "invoke_subagent") {
			const subagents = (args["Subagents"] as Array<Record<string, any>>) ?? [];
			for (const sub of subagents) {
				const promptStr = (sub["Prompt"] as string) ?? "";
				const ws = (sub["Workspace"] as string) ?? "inherit";
				const cleanPromptLength = stripMarkdownCodeBlocks(promptStr).length;
				if (cleanPromptLength > promptLength) {
					promptLength = cleanPromptLength;
				}
				if (
					cleanPromptLength > 500 &&
					!promptStr.includes("task.md") &&
					!promptStr.includes("scratch/")
				) {
					promptDensityViolation = true;
				}
				if (ws === "inherit") {
					const actionableRegex =
						/write_to_file|replace_file_content|git commit|git add|git am|npm install|npm run build|vitest run|npm run test|npx vitest|modify packages\/|edit src\//;
					if (actionableRegex.test(promptStr)) {
						isActionableInherit = true;
					}
				}
			}
		}

		const gitEscapeDetected =
			toolName === "run_command" &&
			inspectCommand((args["CommandLine"] as string) ?? "")[0] !== "allow";

		const absolutePath = (args["AbsolutePath"] as string) ?? "";
		const pbReadAttempted =
			absolutePath.endsWith(".pb") || absolutePath.includes(".pb");

		const isReadOnlySubagent = subagentType === "Remora_ReadOnly_Extractor";
		const isMergerSubagent = subagentType === "Remora_Merger";
		const isRelaxMode = readMode(convId, "strict") === "relax";
		const isMainContext = !subagentType;

		const facts: Fact = {
			isReadOnlySubagent,
			isMergerSubagent,
			isMainContext,
			isRelaxMode,
			toolName,
			isSandboxEscaped,
			promptLength,
			promptDensityViolation,
			isActionableInherit,
			gitEscapeDetected,
			pbReadAttempted,
			isWriteOperation,
		};

		Object.defineProperties(facts, {
			isSensitiveLog: {
				get: () => {
					if (toolName !== "view_file") return false;
					const absolutePath = (args["AbsolutePath"] as string) ?? "";
					return isPathSensitive(absolutePath);
				},
				enumerable: true,
			},
			view_fileSize: {
				get: () => {
					if (toolName !== "view_file") return 0;
					const absolutePath = (args["AbsolutePath"] as string) ?? "";
					if (absolutePath) {
						try {
							const secure = resolveSecurePath(absolutePath);
							if (fs.existsSync(secure)) {
								return fs.statSync(secure).size;
							}
						} catch {}
					}
					return 0;
				},
				enumerable: true,
			},
			view_fileRangeCount: {
				get: () => {
					if (toolName !== "view_file") return 0;
					const startLine = args["StartLine"];
					const endLine = args["EndLine"];
					if (startLine === undefined || endLine === undefined) {
						return 99999;
					}
					const s =
						typeof startLine === "number"
							? startLine
							: parseInt(String(startLine), 10);
					const e =
						typeof endLine === "number"
							? endLine
							: parseInt(String(endLine), 10);
					if (!isNaN(s) && !isNaN(e)) {
						return e - s + 1;
					}
					return 99999;
				},
				enumerable: true,
			},
			readonlySubTurnsExceeded: {
				get: () => {
					if (toolName !== "send_message") return false;
					const recipient = (args["Recipient"] as string) ?? "";
					if (recipient) {
						let subagentType = getHookState(
							convId,
							0,
							`subagent_type_${recipient}`,
						);
						if (!subagentType) {
							try {
								const resolvedType = getSubagentTypeByConvId(recipient);
								if (resolvedType) {
									subagentType = resolvedType;
									setHookState(
										convId,
										0,
										`subagent_type_${recipient}`,
										subagentType,
									);
								}
							} catch {}
						}
						if (subagentType === "Remora_ReadOnly_Extractor") {
							const stateKey = `subagent_turn_limit_${recipient}`;
							const currentCount = parseInt(
								getHookState(convId, 0, stateKey) || "0",
								10,
							);
							if (currentCount >= 4) {
								return true;
							}
						}
					}
					return false;
				},
				enumerable: true,
			},
			hasDbEnvFacts: {
				get: () => {
					if (toolName !== "invoke_subagent") return true;
					const subagents =
						(args["Subagents"] as Array<Record<string, any>>) ?? [];
					for (const sub of subagents) {
						const roleLower = ((sub["Role"] as string) ?? "").toLowerCase();
						const promptStr = (sub["Prompt"] as string) ?? "";
						const triggerRole = [
							"db",
							"database",
							"recall",
							"sqlite",
							"compactor",
						].some((kw) => roleLower.includes(kw));
						const triggerPrompt = [
							"remora_memory.db",
							"conversation.db",
							"remora-recall",
						].some((kw) => promptStr.includes(kw));
						if (triggerRole || triggerPrompt) {
							const pluginRoot = findPluginRoot();
							const hasDbPath = promptStr.includes("REMORA_DB_PATH");
							const hasProjectUuid = promptStr.includes("project_uuid");
							const hasPluginRoot = promptStr.includes(pluginRoot);
							if (!hasDbPath || !hasProjectUuid || !hasPluginRoot) {
								return false;
							}
						}
					}
					return true;
				},
				enumerable: true,
			},
			isDuplicateSpawn: {
				get: () => {
					if (toolName !== "invoke_subagent") return false;
					const subagents =
						(args["Subagents"] as Array<Record<string, any>>) ?? [];
					const rawHistory = getHookState(
						convId,
						currentTurnIdx,
						"subagent_dispatch_history",
					);
					let history: any[] = [];
					if (rawHistory) {
						try {
							history = JSON.parse(rawHistory);
						} catch {}
					}
					if (Array.isArray(history)) {
						for (const sub of subagents) {
							const role = (sub["Role"] as string) ?? "";
							const promptStr = (sub["Prompt"] as string) ?? "";
							const promptHash = promptStr.slice(0, 100);
							const now = Date.now();
							const duplicate = history.find((entry: any) => {
								const isSameRole = role && entry.role === role;
								const isSameHash = entry.promptHash === promptHash;
								const isWithinWindow = now - entry.timestamp <= 180000;
								return (isSameRole || isSameHash) && isWithinWindow;
							});
							if (duplicate) {
								return true;
							}
						}
					}
					return false;
				},
				enumerable: true,
			},
			isInherit: {
				get: () => {
					let targetDir = "";
					if (toolName === "run_command") {
						targetDir = (args["Cwd"] as string) ?? "";
					} else if (isWriteTool) {
						targetDir = (args["TargetFile"] as string) ?? "";
					}
					if (targetDir) {
						targetDir = resolveSecurePath(targetDir);
					}
					const isBrainPath = targetDir.includes("/brain/");
					let hasWorktreesInCwd = false;
					try {
						const realCwd = fs.realpathSync(process.cwd());
						if (realCwd.includes(".system_generated/worktrees")) {
							hasWorktreesInCwd = true;
						}
					} catch {}
					const isBranch =
						targetDir.includes(".system_generated/worktrees") ||
						hasWorktreesInCwd ||
						isBrainPath ||
						process.env.REMORA_WORKSPACE === "branch";
					const workspaceEnv = process.env.REMORA_WORKSPACE;
					return (
						isSub &&
						(workspaceEnv === "inherit" ||
							(!workspaceEnv &&
								!isBranch &&
								!process.env.VITEST &&
								process.env.NODE_ENV !== "test"))
					);
				},
				enumerable: true,
			},
		});

		return facts;
	}
}

export class RuleRunner {
	private rules: Rule[] = [];
	private loaded = false;

	private loadRules(): void {
		if (this.loaded) return;
		try {
			const pluginRoot = findPluginRoot();
			const rulesPath = path.join(pluginRoot, "conf", "remora-rules.json");
			if (fs.existsSync(rulesPath)) {
				console.log("TRYING TO LOAD RULES FROM:", rulesPath);
				const raw = fs.readFileSync(rulesPath, "utf-8");
				console.log(
					"LOADED RAW:",
					typeof raw,
					raw ? raw.substring(0, 50) : raw,
				);
				const parsed = JSON.parse(raw);
				this.rules = parsed.rules || [];
			}
			this.loaded = true;
		} catch (e: any) {
			error(`[RuleRunner] failed to load rules: ${e.message}`);
		}
	}

	public runActiveBlock(
		hookType: string,
		rawContext: Record<string, any>,
	): DecisionResult {
		this.loadRules();
		const extractor = new AntigravityFactExtractor();
		const facts = extractor.extract(rawContext);
		const engine = new RuleEngine();
		const filteredRules = this.rules.filter((r) => r.hookType === hookType);
		return engine.evaluate(facts, filteredRules);
	}

	public runDarkRead(hookType: string, rawContext: Record<string, any>): void {
		try {
			const result = this.runActiveBlock(hookType, rawContext);
			info(
				`[RuleRunner DarkRead] hookType: ${hookType}, result: ${JSON.stringify(result)}`,
			);
		} catch (e: any) {
			error(`[RuleRunner DarkRead] failed: ${e.message}`);
		}
	}
}

export const globalRuleRunner = new RuleRunner();
