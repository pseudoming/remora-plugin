import { PreToolUseResponse, DynamicRuleContext, DynamicRule } from "../../types";
import { makeDenyReason, isUnifiedLimitExceeded, isUnifiedLimitApproaching, SYSTEM_POLICY, estimateGrepReadBytes, estimateReadBytes, isAccumulatedLimitExceeded } from "@remora/core";
import { getStats, accumulate } from "../../bridge/stats";
import { isExemptedPath, isPathSensitive } from "../../bridge/paths";
import * as fs from "node:fs";

const rotReason = makeDenyReason(
	"ANTI-ROT",
	"Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.",
	"Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications.",
);

export const checkUnifiedReadLimitRule: DynamicRule = (ctx: DynamicRuleContext): PreToolUseResponse | undefined => {
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
				const sizeLimit = ctx.mode === "relax" ? SYSTEM_POLICY.SAFETY.SINGLE_FILE_SIZE_RELAX : SYSTEM_POLICY.SAFETY.SINGLE_FILE_SIZE_LIMIT;
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
