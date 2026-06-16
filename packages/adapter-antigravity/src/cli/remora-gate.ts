#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTraceId } from "@remora/core";
import { findPluginRoot } from "../bridge/paths";

export function main(): void {
	setTraceId(`c_${randomUUID().slice(0, 8)}`);

	const args = process.argv.slice(2);
	if (!args.includes("--rollback")) {
		console.error("Error: --rollback flag is required.");
		process.exit(1);
	}

	const pluginRoot = findPluginRoot();
	const safetyCheckRelPath =
		"packages/adapter-antigravity/src/hooks/safety-check.ts";
	const safetyCheckPath = path.join(pluginRoot, safetyCheckRelPath);

	if (!fs.existsSync(safetyCheckPath)) {
		console.error(`Error: safety-check.ts not found at ${safetyCheckPath}`);
		process.exit(1);
	}

	try {
		console.log("Backing up safety-check.ts...");
		const diffCmd = `git diff -- ${safetyCheckRelPath} > ${safetyCheckRelPath}.bak.patch`;
		execSync(diffCmd, { cwd: pluginRoot, stdio: "inherit" });

		console.log("Resetting safety-check.ts hook...");
		const checkoutCmd = `git checkout -- ${safetyCheckRelPath}`;
		execSync(checkoutCmd, { cwd: pluginRoot, stdio: "inherit" });

		console.log("Rollback completed successfully.");
	} catch (error: any) {
		console.error(`Rollback failed: ${error.message}`);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}
