import * as fs from "node:fs";
import * as path from "node:path";
import { ConversationDataAccessLayer } from "./conversation";

export class ProgressSentinel {
	static getProgressPath(transcriptPath: string): string | null {
		if (!transcriptPath) {
			return null;
		}
		if (path.basename(path.dirname(transcriptPath)) === ".system_generated") {
			return path.join(
				path.dirname(path.dirname(transcriptPath)),
				"scratch",
				"progress.json",
			);
		} else {
			return path.join(
				path.dirname(transcriptPath),
				"scratch",
				"progress.json",
			);
		}
	}

	static update(
		transcriptPath: string,
		status: string,
		stepIndex?: number,
		details: string = "",
	): boolean {
		if (!transcriptPath) {
			return false;
		}

		const progressPath = ProgressSentinel.getProgressPath(transcriptPath);
		if (!progressPath) {
			return false;
		}

		fs.mkdirSync(path.dirname(progressPath), { recursive: true });

		let oldData: Record<string, any> = {};
		if (fs.existsSync(progressPath)) {
			oldData = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
		}

		let finalStepIndex = stepIndex;
		if (finalStepIndex === undefined) {
			if ("step_index" in oldData) {
				finalStepIndex = oldData["step_index"];
			} else {
				const match = transcriptPath.match(/\/brain\/([^/]+)\//);
				if (match) {
					const convId = match[1];
					finalStepIndex = new ConversationDataAccessLayer(
						convId,
					).getMaxStepIndex();
				}
			}
		}

		if (finalStepIndex === undefined) {
			finalStepIndex = 0;
		}

		const snapshot = {
			status: status,
			last_updated_at: Math.floor(Date.now() / 1000),
			step_index: finalStepIndex,
			details: details,
		};

		const lastDot = progressPath.lastIndexOf(".");
		const baseName =
			lastDot > 0 ? progressPath.slice(0, lastDot) : progressPath;
		const tmpPath = `${baseName}.${process.pid}.tmp`;

		const fd = fs.openSync(tmpPath, "w");
		fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2), "utf-8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fs.renameSync(tmpPath, progressPath);
		return true;
	}
}
