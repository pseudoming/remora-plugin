import { PreToolUseResponse, DynamicRuleContext, DynamicRule, AntigravityHookContext } from "../types";
import { readMode } from "@remora/core";
import { getSubagentType } from "../bridge/subagent";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { globalRuleRunner } from "./rule-runner";
import { hookEntrypoint } from "../bridge/context";

import { trimTimelineRule } from "./post-filters/trim-timeline";
import { checkDuplicateSpawnRule } from "./post-filters/duplicate-spawn";
import { checkPromptSyntaxRule } from "./post-filters/prompt-syntax";
import { injectSubagentJITRule } from "./post-filters/subagent-jit";
import { checkDefineSubagentOverrideRule } from "./post-filters/define-subagent-override";
import { checkSharedWorkspaceTraversalRule } from "./post-filters/shared-workspace-traversal";
import { checkSendMessageTurnLimitRule } from "./post-filters/send-message-turn-limit";
import { checkUnifiedReadLimitRule } from "./post-filters/unified-read-limit";
import { checkGitMcpRule } from "./post-filters/git-mcp-deny";

import { auditMergerCmdRule } from "./command-auditors/merger-audit";
import { auditReadonlyCmdRule } from "./command-auditors/readonly-audit";
import { auditDeepDiverCmdRule } from "./command-auditors/deep-diver-audit";
import { auditMainCmdRule } from "./command-auditors/main-audit";

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

export function main(
	context: AntigravityHookContext,
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

if (typeof require !== "undefined" && require.main === module) {
	hookEntrypoint()(main)();
}
