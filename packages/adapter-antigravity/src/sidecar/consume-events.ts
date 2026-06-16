import Database from "better-sqlite3";
import { getPendingEvents, markEventProcessed } from "@remora/core";
import { getPendingDecisions, confirmDecisionsByIds } from "@remora/core";
import { getOrCreateConversation, AgentApiError } from "./extract-decisions";

export function consumeEventQueue(
	startTime: number,
	conn?: Database.Database,
): void {
	const events = getPendingEvents(conn);
	if (!events.length) {
		return;
	}

	for (const event of events) {
		const pendingDecisions = getPendingDecisions(event.project_uuid, 30, conn);

		if (!pendingDecisions.length) {
			markEventProcessed(event.id, conn);
			continue;
		}

		const prompt = `[SYSTEM CONSTRAINT]
You are a precise Architecture Decision Validator.
We have a list of pending decisions that need user confirmation.
Your task is to analyze the synchronization payload (${event.event_type}) provided below and determine which pending decisions have been successfully implemented or explicitly approved.

Pending Decisions to Validate:
${JSON.stringify(pendingDecisions, null, 2)}

Sync Event Payload:
${event.payload}

You MUST output ONLY a valid JSON object listing the IDs of decisions that are confirmed:
{"confirmed_ids": [12, 15]}
If none match, return: {"confirmed_ids": []}
`;

		if (Date.now() / 1000 - startTime > 270) {
			console.error("[Remora] 临界超时熔断，剩余事件留待下轮处理。");
			break;
		}

		try {
			const llmOutput = getOrCreateConversation(prompt);
			const jsonMatch = llmOutput.match(/({.*})/s);
			if (jsonMatch) {
				const resultData = JSON.parse(jsonMatch[1].trim());
				const confirmedIds: number[] = resultData.confirmed_ids ?? [];
				confirmDecisionsByIds(confirmedIds, event.project_uuid, conn);
				console.log(
					`[Remora] 事件 ${event.id} (${event.event_type}) 消费成功，已将决策集 ${JSON.stringify(confirmedIds)} 打标锁定。`,
				);
			}
		} catch (e) {
			if (e instanceof AgentApiError) {
				throw e;
			}
			console.error(`[Remora] 消费事件 ${event.id} 发生异常: ${String(e)}`);
			continue;
		}

		markEventProcessed(event.id, conn);
	}
}
