import Database from "better-sqlite3";

import {
	getWatermark,
	getMaxLineNumber,
	insertMessage,
	getMaxMessageId,
	getMaxMessageIdUpToLine,
	deleteMessagesAboveLine,
	getDecisionsByConversation,
	deleteTopicDecision,
	getMessageTimestamp,
	deleteDecisionsByConversationAfter,
	deletePendingEvents,
	updateWatermark,
	ensureWatermark,
	formatTimestamp,
} from "@remora/core";

import { isSubagentSession } from "./scan-sessions";
import { ConversationDataAccessLayer } from "../bridge/conversation";

const MAX_PROMPT_LENGTH = 8000;

export function readIncrementalLogs(
	conn: any,
	session: Record<string, string>,
): [string, number, number] {
	const isSub = isSubagentSession(session["conversationId"]);
	const convId = session["conversationId"];

	let lastMsgId = getWatermark(session["projectUuid"], convId, conn);

	let lastLine = getMaxLineNumber(convId, conn);

	const cdal = new ConversationDataAccessLayer(convId);

	let currentLine = lastLine;
	const newSnippets: string[] = [];
	let totalLength = 0;

	const dbMaxIdx = cdal.getMaxStepIndex();
	let startIdx: number;
	if (dbMaxIdx < lastLine) {
		currentLine = 0;
		startIdx = 0;
	} else {
		startIdx = lastLine + 1;
	}

	try {
		for (const step of cdal.streamStepsForward(startIdx)) {
			const stepIndex = step["step_index"];
			if (stepIndex == null) {
				continue;
			}

			currentLine = stepIndex;
			if (currentLine > lastLine) {
				let stepType = step["type"] || "";

				if (
					isSub &&
					stepType !== "USER_INPUT" &&
					stepType !== "PLANNER_RESPONSE"
				) {
					continue;
				}

				const content = step["content"] || "";

				let role = step["role"];
				if (!role) {
					role = step["source"] || "";
				}
				if (!role) {
					stepType = step["type"] || "";
					if (stepType === "USER_INPUT") {
						role = "user";
					} else if (stepType === "PLANNER_RESPONSE") {
						role = "model";
					} else {
						role = "unknown";
					}
				}

				const msgId = Number(
					insertMessage(
						convId,
						currentLine,
						formatTimestamp(step["timestamp"] || ""),
						role,
						content,
						conn,
					),
				);

				if (
					content &&
					(stepType === "USER_INPUT" || stepType === "PLANNER_RESPONSE")
				) {
					const snippet = `[msg_${msgId}] ${content.slice(0, 500)}`;
					if (totalLength < MAX_PROMPT_LENGTH) {
						newSnippets.push(snippet);
						totalLength += snippet.length;
					}
				}
			}
		}
	} catch {
		// pass
	}

	if (currentLine < lastLine) {
		const targetRollbackLine = Math.max(0, currentLine - 1);

		const targetMsgId = getMaxMessageIdUpToLine(
			convId,
			targetRollbackLine,
			conn,
		);

		deleteMessagesAboveLine(convId, targetRollbackLine, conn);

		const decisions = getDecisionsByConversation(convId, conn);
		for (const { id: decId, evidence_msg_ids: evIdsStr } of decisions) {
			try {
				const evIds: number[] = evIdsStr ? JSON.parse(evIdsStr) : [];
				if (evIds.some((eid: number) => eid > targetMsgId)) {
					deleteTopicDecision(decId, conn);
				}
			} catch {
				// pass
			}
		}

		const targetTimestamp = getMessageTimestamp(targetMsgId, conn);
		if (targetTimestamp) {
			deleteDecisionsByConversationAfter(convId, targetTimestamp, conn);
		}

		deletePendingEvents(session["projectUuid"], conn);

		updateWatermark(session["projectUuid"], convId, targetMsgId, conn);

		console.log(
			`[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至 msg_id: ${targetMsgId}`,
		);
		lastLine = targetRollbackLine;
		lastMsgId = targetMsgId;
	}

	let currentMsgId = getMaxMessageId(convId, conn);
	if (!currentMsgId) {
		currentMsgId = lastMsgId;
	}

	ensureWatermark(session["projectUuid"], convId, conn);

	const keyContent = newSnippets.join("\\n");

	return [keyContent, currentMsgId, lastMsgId];
}
