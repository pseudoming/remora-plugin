import { DynamicRuleContext, PreToolUseResponse } from "../../types";
import { ConversationDataAccessLayer } from "../../bridge/conversation";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "../../bridge/paths";

export function auditHighRiskCmdRule(
	ctx: DynamicRuleContext,
): PreToolUseResponse | undefined {
	if (ctx.toolName !== "run_command" && ctx.toolName !== "unsandboxed") return undefined;

	const cmd = (ctx.args["CommandLine"] as string) || "";
	if (!cmd) return undefined;

	// Load dynamic high risk commands config
	let highRiskCommands: string[] = [];
	try {
		const configPath = path.join(getDataDir(), "..", "conf", "high-risk-commands.json");
		if (fs.existsSync(configPath)) {
			const configContent = fs.readFileSync(configPath, "utf-8");
			highRiskCommands = JSON.parse(configContent).highRiskCommands || [];
		} else {
            // Fallback default
            highRiskCommands = [
                "^git\\s+push\\b",
                "\\brm\\s+-rf\\b",
                "^npm\\s+publish\\b"
            ];
        }
	} catch (e) {
		console.error("[HighRiskGate] Failed to load config:", e);
	}

	let matchedPattern = false;
	for (const patternStr of highRiskCommands) {
		const regex = new RegExp(patternStr);
		if (regex.test(cmd)) {
			matchedPattern = true;
			break;
		}
	}

	if (!matchedPattern) {
		return undefined; // Not a high risk command
	}

	// It's a high risk command. Check CDAL for exact authorization.
	const cdal = new ConversationDataAccessLayer(ctx.convId);
	let authorized = false;
    const requiredAuthStr = `[授权执行] ${cmd}`;

	try {
		for (const step of cdal.streamStepsReverse(50)) {
			const stepType = step["type"];
			const source = step["source"];
			const content = (step["content"] as string) || "";

			if (stepType === "TOOL_RESPONSE" && source === "SYSTEM") {
				if (content.includes(requiredAuthStr)) {
					authorized = true;
					break;
				}
			}
		}
	} catch (e) {
		console.error("[HighRiskGate] Error reading CDAL:", e);
	}

	if (authorized) {
		return { decision: "allow" };
	}

	// Not authorized, block and inject prompt
	const promptInjection = `<system-reminder>
⛔ 高危操作阻断：需要手动授权

你试图执行高危命令：\`${cmd}\`。
该操作被系统物理阻断。要继续执行，你必须使用 \`ask_question\` 工具向用户申请授权，且**必须一字不差**地设置以下两个选项（严禁修改任何标点和空格）：
- 选项 1：\`[授权执行] ${cmd}\`
- 选项 2：\`[拒绝执行] 放弃操作\`

系统将在用户点击同意后扫描底层存储。在没有获得用户通过弹窗的明确同意前，再次执行该命令将面临永久失败。立即发起弹窗！
</system-reminder>`;

	return {
		decision: "deny",
		reason: "Missing interactive authorization for high-risk command.",
		injectSteps: [
			{
				systemMessage: promptInjection,
			},
		],
	};
}
