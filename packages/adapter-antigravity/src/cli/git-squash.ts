import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function squashCommits() {
	// 1. Perform dirty check
	const status = execSync("git status --porcelain", {
		encoding: "utf-8",
	}).trim();
	if (status !== "") {
		throw new Error(
			"Workspace is dirty. Please commit or stash changes before squashing.",
		);
	}

	// 2. Fetch the last commit hash starting with `[Phase`
	const logLimit = 50;
	const logOutput = execSync(`git log -n ${logLimit} --format="%H %s"`, {
		encoding: "utf-8",
	});
	const lines = logOutput.split("\n");

	let targetHash: string | null = null;
	let targetSubject: string | null = null;
	for (const line of lines) {
		const spaceIdx = line.indexOf(" ");
		if (spaceIdx === -1) continue;
		const hash = line.slice(0, spaceIdx);
		const subject = line.slice(spaceIdx + 1);
		if (subject.startsWith("[Phase")) {
			targetHash = hash;
			targetSubject = subject;
			break;
		}
	}

	if (!targetHash) {
		throw new Error(
			"Could not find any commit starting with '[Phase' in the last 50 commits.",
		);
	}

	// 3. Collect commit messages between that hash (exclusive) and HEAD (inclusive)
	const commitMsgsOutput = execSync(
		`git log ${targetHash}..HEAD --format="%B"`,
		{ encoding: "utf-8" },
	);

	const rawMsgs = commitMsgsOutput.split("\n\n");
	const bodies: string[] = [];
	for (const rawMsg of rawMsgs) {
		const trimmed = rawMsg.trim();
		if (!trimmed) continue;

		const msgLines = trimmed
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		for (const msgLine of msgLines) {
			if (msgLine.startsWith("-") || msgLine.startsWith("*")) {
				bodies.push(msgLine);
			} else {
				if (!msgLine.startsWith("[Phase")) {
					bodies.push(`- ${msgLine}`);
				}
			}
		}
	}

	// 4. Reset to the target hash
	execSync(`git reset --soft ${targetHash}`);

	// 5. Re-commit
	const uniqueBodies = Array.from(new Set(bodies));
	const newMsg = `${targetSubject}\n\nChangelog:\n${uniqueBodies.join("\n")}`;

	const tempMsgPath = path.join(process.cwd(), ".git", "SQUASH_MSG");
	fs.writeFileSync(tempMsgPath, newMsg, "utf-8");

	try {
		execSync(`git commit --amend -F ${tempMsgPath}`);
	} finally {
		if (fs.existsSync(tempMsgPath)) {
			fs.unlinkSync(tempMsgPath);
		}
	}
}

if (typeof require !== "undefined" && require.main === module) {
	try {
		squashCommits();
		console.log("Git squash completed successfully.");
	} catch (error: any) {
		console.error("Git squash failed:", error.message);
		process.exit(1);
	}
}
