import { cleanupGhostMessages, info } from "@remora/core";

export function fixDb(): void {
	info("Connecting to DB...");
	const count = cleanupGhostMessages();
	if (count > 0) {
		info(`Deleted ${count} ghost records. FTS index rebuilt.`);
	} else {
		info("No ghost records to clean up.");
	}
}
