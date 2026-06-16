import Database from "better-sqlite3";
import {
	getRuntimeHookValue,
	setRuntimeHookValue,
	trimRuntimeHookStates,
} from "./storage/runtime-state";

/**
 * Trim stale hook states from a conversation at the given turn index.
 *
 * Reads the last-seen turn from the hook state store (using sentinel turn_idx = -1).
 * If it differs from the current turn or is absent, all hook states at turn_idx >= current
 * are deleted and the last-seen marker is updated.
 */
export function trimStaleHookStates(
	convId: string,
	currentTurnIdx: unknown,
	conn?: Database.Database,
): void {
	const lastSeen = getRuntimeHookValue(convId, -1, "last_seen_turn", conn);
	let shouldTrim: boolean;

	if (lastSeen === null) {
		shouldTrim = true;
	} else {
		const lastSeenNum = Number(lastSeen);
		const currentNum = Number(currentTurnIdx);
		if (isNaN(lastSeenNum) || isNaN(currentNum)) {
			shouldTrim = false;
		} else {
			shouldTrim = lastSeenNum !== currentNum;
		}
	}

	if (shouldTrim) {
		let trimTurn = Number(currentTurnIdx);
		if (isNaN(trimTurn)) {
			trimTurn = 0;
		}
		trimRuntimeHookStates(convId, trimTurn, conn);
		setRuntimeHookValue(convId, -1, "last_seen_turn", String(trimTurn), conn);
	}
}
