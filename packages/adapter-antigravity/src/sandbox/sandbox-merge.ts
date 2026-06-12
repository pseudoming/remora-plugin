#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { getBrainDir } from "../bridge/paths";

export function main(): void {
    if (process.argv.length < 3) {
        console.log("Usage: sandbox-merge.js <subagent_conv_id> --target-cwd <dir>");
        process.exit(1);
    }

    const subagentId = process.argv[2];

    let targetCwd: string | null = null;
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === "--target-cwd" && i + 1 < process.argv.length) {
            targetCwd = process.argv[i + 1];
            break;
        }
    }
    if (!targetCwd) {
        console.log("ERROR: --target-cwd is required.");
        process.exit(1);
    }

    const brainDir = getBrainDir();
    const worktreesRel = path.join(".system_generated", "worktrees");

    let wtDir: string | null = null;
    if (fs.existsSync(brainDir)) {
        for (const projectDir of fs.readdirSync(brainDir)) {
            const worktreesDir = path.join(brainDir, projectDir, worktreesRel);
            if (!fs.existsSync(worktreesDir)) {
                continue;
            }
            for (const entry of fs.readdirSync(worktreesDir)) {
                if (entry.includes(subagentId)) {
                    wtDir = path.join(worktreesDir, entry);
                    break;
                }
            }
            if (wtDir) {
                break;
            }
        }
    }

    if (!wtDir) {
        console.log(`ERROR: Could not find isolated worktree for ${subagentId}. Either it doesn't exist, or it wasn't invoked with 'Workspace: branch'.`);
        process.exit(1);
    }

    try {
        const branchName = execSync("git branch --show-current", { cwd: wtDir, encoding: "utf-8" }).trim();

        if (!branchName) {
            console.log("ERROR: Could not determine branch name in worktree.");
            process.exit(1);
        }

        console.log(`Merging branch ${branchName} from worktree ${wtDir} ...`);

        console.log("[Remora] Detecting physical changed files in sandbox...");
        try {
            const diffOutput = execSync(`git diff --name-only main...${branchName}`, { cwd: targetCwd, encoding: "utf-8" });
            for (const line of diffOutput.split("\n")) {
                const trimmed = line.trim();
                if (trimmed) {
                    console.log(`[PHYSICAL_CHANGES] ${trimmed}`);
                }
            }
        } catch (e: unknown) {
            console.log(`Failed to detect physical changes: ${e}`);
        }

        execSync(`git merge ${branchName} -m "Merge sandbox changes from subagent ${subagentId}"`, {
            cwd: targetCwd,
            stdio: "inherit",
        });

        console.log("Sandbox merged successfully.");
    } catch (e: unknown) {
        console.log(`Git merge failed: ${e}`);
        process.exit(1);
    }
}

// ── CLI entrypoint: only auto-execute when run directly ──────────────
if (process.argv[1]?.includes("sandbox-merge")) {
  main();
}
