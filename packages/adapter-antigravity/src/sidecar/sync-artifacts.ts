import * as fs from "node:fs";
import * as path from "node:path";
import { extractConvId } from "../bridge/paths";
import {
	calculateMd5,
	getArtifactHash,
	upsertArtifactHash,
	deleteArtifactMessages,
	insertArtifactMessage,
	upsertArtifactTopic,
	enqueueEvent,
	insertFileChange,
} from "@remora/core";

export function scanAndIngestArtifacts(context: Record<string, unknown>): void {
	const artifactDir = (context["artifactDirectoryPath"] as string) ?? "";
	const projectUuid =
		process.env["ANTIGRAVITY_PROJECT_ID"] ||
		process.env["REMORA_PROJECT_ID"] ||
		"unknown";
	if (!artifactDir || !fs.existsSync(artifactDir)) {
		return;
	}

	const targetFiles = ["implementation_plan.md", "walkthrough.md"];

	for (const filename of targetFiles) {
		const filePath = path.join(artifactDir, filename);
		if (!fs.existsSync(filePath)) {
			continue;
		}

		const currentHash = calculateMd5(filePath);

		const currentStored = getArtifactHash(filePath);
		if (currentStored === currentHash) {
			continue;
		}

		const content = fs.readFileSync(filePath, "utf-8");

		upsertArtifactHash(filePath, currentHash);

		const syncConvId = `artifact_sync_${projectUuid}`;

		deleteArtifactMessages(syncConvId, filename);

		insertArtifactMessage(
			syncConvId,
			999900 + targetFiles.indexOf(filename),
			filename,
			content,
			JSON.stringify(["artifact_topic"]),
		);

		const convId = extractConvId((context["transcriptPath"] as string) ?? "");
		if (convId) {
			insertFileChange(projectUuid, convId, filename, "artifact");
		}
		upsertArtifactTopic(
			projectUuid,
			"artifact_topic",
			`Consolidated architecture decisions from ${filename}`,
		);

		if (filename === "implementation_plan.md") {
			continue;
		}
		const eventType = `${filename.split(".")[0]}_sync`;
		enqueueEvent(projectUuid, eventType, content);

		console.log(`[Remora] 成功同步制品记忆: ${filename}`);
	}
}
