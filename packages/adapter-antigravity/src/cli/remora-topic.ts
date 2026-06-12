#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import * as dao from "@remora/core";
import { error, warn, info, setTraceId } from "@remora/core";
import { getBrainDir, getDataDir } from "../bridge/paths";

function forceColdStart(): void {
  let mainConvId: string | undefined = undefined;
  const convIdFile = path.join(getDataDir(), ".runtime", "remora_main_conv_id.txt");
  if (fs.existsSync(convIdFile)) {
    try {
      mainConvId = fs.readFileSync(convIdFile, "utf-8").trim();
    } catch {
      // pass
    }
  }
  dao.forceColdStartLatestSession(mainConvId);
}

function parseArgs(argv: string[]): {
  action: string | null;
  uuid: string | null;
  name: string | null;
  decisionId: number | null;
} {
  const result: { action: string | null; uuid: string | null; name: string | null; decisionId: number | null } = {
    action: null,
    uuid: null,
    name: null,
    decisionId: null,
  };

  const validActions = ["new", "switch", "close", "confirm"];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (validActions.includes(arg)) {
      result.action = arg;
    } else if (arg === "-u" || arg === "--uuid") {
      result.uuid = argv[++i];
    } else if (arg === "-n" || arg === "--name") {
      result.name = argv[++i];
    } else if (arg === "-d" || arg === "--decision-id") {
      result.decisionId = parseInt(argv[++i], 10);
    }
  }

  return result;
}

export function main(): void {
  setTraceId(`c_${randomUUID().slice(0, 8)}`);
  const args = parseArgs(process.argv);

  if (!args.action) {
    error("Action is required (new/switch/close/confirm).");
    process.exit(1);
  }

  const projectUuid = args.uuid ?? process.env.ANTIGRAVITY_PROJECT_ID;
  if (!projectUuid) {
    error("Project UUID is required. Please specify via -u/--uuid or ANTIGRAVITY_PROJECT_ID env var.");
    process.exit(1);
  }

  if (!dao.checkDbExists()) {
    error("Database file not found.");
    process.exit(1);
  }

  try {
    if (args.action === "new") {
      if (!args.name) {
        error("Topic name (-n/--name) is required for new action.");
        process.exit(1);
      }
      dao.createOrUpdateTopic(projectUuid, args.name, "", "manual");
      forceColdStart();
      console.log(`Created active topic ${args.name} in project ${projectUuid}.`);

    } else if (args.action === "switch") {
      if (!args.name) {
        error("Topic name (-n/--name) is required for switch action.");
        process.exit(1);
      }
      dao.switchTopic(projectUuid, args.name);
      forceColdStart();
      console.log(`Switched active topic to ${args.name} in project ${projectUuid}.`);

    } else if (args.action === "close") {
      if (!args.name) {
        error("Topic name (-n/--name) is required for close action.");
        process.exit(1);
      }
      dao.closeTopic(projectUuid, args.name);
      console.log(`Topic ${args.name} closed in project ${projectUuid}.`);

    } else if (args.action === "confirm") {
      if (args.decisionId === null) {
        error("Decision ID (-d/--decision-id) is required for confirm action.");
        process.exit(1);
      }
      const success = dao.confirmDecision(projectUuid, args.decisionId);
      if (!success) {
        warn(`No decision found with ID ${args.decisionId} in project ${projectUuid}.`);
      } else {
        console.log(`Decision ${args.decisionId} confirmed in project ${projectUuid}.`);

        const tId = dao.getTopicIdByDecision(args.decisionId);
        if (tId) {
          dao.touchTopicSourceManual(projectUuid, tId);
        }

        info("Checking for isolated subagent sandboxes to merge...");
        try {
          const brainDir = getBrainDir();
          const worktrees: string[] = [];

          if (fs.existsSync(brainDir)) {
            for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const wtDir = path.join(brainDir, entry.name, ".system_generated", "worktrees");
                if (fs.existsSync(wtDir)) {
                  for (const wt of fs.readdirSync(wtDir)) {
                    if (wt.startsWith("subagent-")) {
                      worktrees.push(path.join(wtDir, wt));
                    }
                  }
                }
              }
            }
            worktrees.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          }

          if (worktrees.length > 0) {
            const latestWorktree = worktrees[0];
            const wtName = path.basename(latestWorktree);
            info(`Found latest subagent sandbox: ${wtName}`);

            const mergeScript = path.join(__dirname, "..", "sandbox", "sandbox-merge.ts");
            const res = execSync(
              `${process.execPath} ${mergeScript} ${wtName} --target-cwd ${process.cwd()}`,
              { encoding: "utf-8" }
            );

            const physicalFiles: string[] = [];
            for (const line of res.split("\n")) {
              if (line.startsWith("[PHYSICAL_CHANGES]")) {
                const parts = line.split(" ", 2);
                if (parts.length > 1) {
                  physicalFiles.push(path.basename(parts[1].trim()));
                }
              }
            }

            if (physicalFiles.length > 0 && tId) {
              dao.mergePhysicalFilesToTopic(projectUuid, tId, physicalFiles);
              for (const pf of physicalFiles) {
                dao.insertFileChange(projectUuid, wtName, pf, "sandbox");
              }
              console.log(`[Remora] Integrated ${physicalFiles.length} physical changed files from sandbox.`);
            }
          } else {
            info("No active sandbox worktree found. Nothing to merge.");
          }
        } catch (e: any) {
          error(`Sandbox automatic merge failed: ${String(e)}`);
        }
      }
    }

  } catch (e: any) {
    error(`Execution failed: ${String(e)}`);
    process.exit(1);
  }
}
