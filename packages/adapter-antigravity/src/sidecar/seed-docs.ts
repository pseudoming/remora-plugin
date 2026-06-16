import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createConversation } from "../bridge/agentapi";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { getDbPath } from "../bridge/paths";
import { getConn, insertDecision } from "@remora/core";

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTargetFiles(cwd: string): string[] {
	const files: string[] = [];
	const standardFiles = [
		"AGENTS.md",
		"CLAUDE.md",
		".cursorrules",
		".github/copilot-instructions.md",
	];

	for (const f of standardFiles) {
		const fullPath = path.join(cwd, f);
		if (fs.existsSync(fullPath)) {
			files.push(fullPath);
		}
	}

	// Claude Code memory
	const normalizedCwd = cwd.replace(/\//g, "-");
	const ccMemoryDir = path.join(
		os.homedir(),
		".claude",
		"projects",
		normalizedCwd,
		"memory",
	);

	if (fs.existsSync(ccMemoryDir)) {
		try {
			const memFiles = fs.readdirSync(ccMemoryDir);
			for (const mf of memFiles) {
				if (mf.endsWith(".md")) {
					files.push(path.join(ccMemoryDir, mf));
				}
			}
		} catch (e) {
			console.error(`[seed-docs] Failed to read CC memory dir: ${e}`);
		}
	}

	return files;
}

async function run() {
	const startTime = Date.now();
	const projectUuid = process.argv[2];
	const cwd = process.argv[3];

	if (!projectUuid || !cwd) {
		console.error("[seed-docs] Usage: node seed-docs.js <projectUuid> <cwd>");
		process.exit(1);
	}

	// Initialize REMORA_DB_PATH
	getDbPath();

	console.log(`[seed-docs] [START] Extraction for ${projectUuid} at ${cwd}`);

	const files = getTargetFiles(cwd);

	interface FileContent {
		path: string;
		mtime: Date;
		content: string;
	}

	const contents: FileContent[] = [];
	for (const file of files) {
		try {
			const stat = fs.statSync(file);
			const content = fs.readFileSync(file, "utf-8");
			contents.push({ path: file, mtime: stat.mtime, content });
		} catch (e) {
			console.error(`[seed-docs] Failed to read ${file}:`, e);
		}
	}

	// Sort newest first
	contents.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	let combinedContent = "";
	const MAX_CHARS = 60000;

	for (const file of contents) {
		const header = `\n\n[SOURCE: ${file.path}] (Last Modified: ${file.mtime.toISOString()})\n`;
		const block = header + file.content;
		if (combinedContent.length + block.length > MAX_CHARS) {
			const remaining = MAX_CHARS - combinedContent.length;
			if (remaining > header.length) {
				combinedContent += block.substring(0, remaining) + "\n...[TRUNCATED]";
			}
			break;
		} else {
			combinedContent += block;
		}
	}

	let gitLog = "";
	try {
		gitLog = execSync("git log --oneline -30", { cwd, timeout: 5000 }).toString();
	} catch (e) {
		gitLog = "[No git log available]";
	}

	const prompt = `
You are an expert architecture and rule extractor.
Analyze the provided project documentation, memory files, and git history below. Treat the written documents as "hypotheses" and cross-verify them against the actual commit patterns and CC's memory before finalizing the rules.

If conflicting constraints exist across documents, the document with the newest modification timestamp wins.

Extract the information into a strict JSON format with two lists:
1. "constraints": Strict behavioral prohibitions, red-lines, and absolute rules that the agent MUST NOT violate (e.g., "禁止 push", "Do not format files").
2. "conventions": General code style, preferred libraries, build commands, and standard project metadata.

Format your output EXACTLY as this JSON schema (do not wrap in markdown tags like \`\`\`json, just pure JSON):
{
  "constraints": [
    {
      "decision": "The core rule",
      "rationale": "Why it exists, or context"
    }
  ],
  "conventions": [
    {
      "decision": "The convention or command",
      "rationale": "Context"
    }
  ]
}

[GIT HISTORY (Recent 30 commits)]
${gitLog}

[PROJECT DOCUMENTS & MEMORY]
${combinedContent}
`;

	console.log(`[seed-docs] Calling LLM model=flash...`);
	let llmResponse: any;
	try {
		llmResponse = createConversation(prompt, 60, "flash");
	} catch (e) {
		console.error("[seed-docs] LLM call failed:", e);
		process.exit(1);
	}

	const convId = llmResponse?.response?.newConversation?.conversationId;
	if (!convId) {
		console.error("[seed-docs] Invalid response from createConversation.");
		process.exit(1);
	}

	console.log(`[seed-docs] Waiting for LLM response in convId: ${convId}`);
	let text = "";
	const cdal = new ConversationDataAccessLayer(convId);
	for (let i = 0; i < 60; i++) {
		let isDone = false;
		let currentContent = "";
		for (const step of cdal.streamStepsReverse(20)) {
			if (step.type === "PLANNER_RESPONSE") {
				currentContent = step.content || "";
				const match = currentContent.match(/\{[\s\S]*\}/);
				if (match) {
					try {
						JSON.parse(match[0]);
						isDone = true;
					} catch {
						// Still generating or malformed, continue polling
					}
				}
				break;
			}
		}

		if (isDone && currentContent) {
			text = currentContent;
			break;
		}
		await sleep(2000);
	}

	if (!text) {
		console.error("[seed-docs] Timed out waiting for LLM reply.");
		console.error("[seed-docs] Dumping last 5 steps:");
		let c = 0;
		for (const step of cdal.streamStepsReverse(5)) {
			console.error(`Step ${c++}: type=${step.type}, status=${step.status}, content=${step.content?.substring(0, 50)}...`);
		}
		process.exit(1);
	}
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) {
		console.error("[seed-docs] Could not find JSON in response:", text);
		process.exit(1);
	}

	let parsed: any;
	try {
		parsed = JSON.parse(match[0]);
	} catch (e) {
		console.error("[seed-docs] JSON parse failed:", e);
		console.error("[seed-docs] Raw extracted text was:\n", text);
		process.exit(1);
	}

	const db = getConn();
	try {
		// Ensure the topic exists so foreign key doesn't fail
		db.prepare(`
			INSERT INTO project_topics (uuid, topic_id, summary, status)
			SELECT ?, 't_static_rules', 'Global Static Rules extracted from repo constraints', 'open'
			WHERE NOT EXISTS (SELECT 1 FROM project_topics WHERE uuid = ? AND topic_id = 't_static_rules')
		`).run(projectUuid, projectUuid);

		// Idempotency Wipe
		db.prepare("DELETE FROM topic_decisions WHERE project_uuid = ? AND source = 'seed_docs'").run(projectUuid);

		const insertStmt = db.prepare(`
			INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale, user_confirmed, is_constraint, source, decision_type)
			VALUES (?, 't_static_rules', 'seed_docs_extraction', ?, ?, 1, ?, 'seed_docs', 'approved')
		`);

		const constraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
		for (const item of constraints) {
			if (item.decision && item.rationale) {
				insertStmt.run(projectUuid, item.decision, item.rationale, 1);
			}
		}

		const conventions = Array.isArray(parsed.conventions) ? parsed.conventions : [];
		for (const item of conventions) {
			if (item.decision && item.rationale) {
				insertStmt.run(projectUuid, item.decision, item.rationale, 0);
			}
		}

		console.log(`[seed-docs] [DONE] ${constraints.length} constraints + ${conventions.length} conventions in ${Date.now() - startTime}ms`);
	} catch (e) {
		console.error("[seed-docs] Database error:", e);
		process.exit(1);
	} finally {
		db.close();
	}
}

run().catch((e) => {
	console.error("[seed-docs] Unhandled error:", e);
	process.exit(1);
});
