import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { judgeZombie, suggestZombieAction } from "@remora/core";

export function main(): void {
  if (process.argv.length < 3) {
    console.log(JSON.stringify({ status: "error", message: "Missing conversation_id argument" }));
    process.exit(1);
  }

  const convId = process.argv[2];
  const parentConvId = process.argv.length > 3 ? process.argv[3] : convId;

  const cdal = new ConversationDataAccessLayer(convId);

  let steps: Record<string, any>[];
  try {
    steps = Array.from(cdal.streamStepsReverse(200));
  } catch (e: any) {
    console.log(JSON.stringify({ status: "error", message: `Failed to read db logs: ${String(e)}` }));
    process.exit(1);
  }

  if (!steps || steps.length === 0) {
    const SPAWN_TIMEOUT_SEC = 30;
    const mtime = cdal.getDbMtime();
    const now = Date.now() / 1000;
    const ageSeconds = mtime > 0 ? now - mtime : 0;
    if (mtime > 0 && ageSeconds > SPAWN_TIMEOUT_SEC) {
      const fromPb = cdal.hasPb() && cdal.getPbStepCount() === 0;
      console.log(JSON.stringify({
        status: "spawn_failed",
        conversation_id: convId,
        parent_conversation_id: parentConvId,
        from_pb: fromPb || undefined,
        message: `Subagent created but produced no steps after ${Math.floor(ageSeconds)}s`,
      }));
      process.exit(1);
    }
    console.log(JSON.stringify({ status: "empty", message: "No steps recorded yet" }));
    process.exit(0);
  }

  let latestTimeStr: string | null = null;
  let lastToolName: string | null = null;

  for (const step of steps) {
    try {
      const stepType = step["type"];
      if (!lastToolName) {
        if (["RUN_COMMAND", "VIEW_FILE", "CODE_ACTION", "GREP_SEARCH", "FIND", "LIST_DIR", "LIST_DIRECTORY"].includes(stepType)) {
          lastToolName = stepType.toLowerCase();
        } else if (stepType === "PLANNER_RESPONSE" && step["tool_calls"]) {
          const tCalls = step["tool_calls"] || [];
          for (const tc of tCalls) {
            if (tc["name"] === "run_command") {
              lastToolName = tc["name"];
              break;
            }
          }
          if (!lastToolName && tCalls.length > 0) {
            lastToolName = tCalls[tCalls.length - 1]["name"];
          }
        }
      }
      if (lastToolName) {
        break;
      }
    } catch (e) {
      continue;
    }
  }

  const mtime = cdal.getDbMtime();
  const lastUpdate = new Date(mtime * 1000);

  const now = new Date();
  const idleSeconds = Math.floor((now.getTime() - lastUpdate.getTime()) / 1000);

  const [isZombie, limit] = judgeZombie(idleSeconds, lastToolName || "", new Set(["run_command", "grep_search"]));
  const status = isZombie ? "zombie" : "active";

  const retryDir = path.join(getDataDir(), ".runtime", "remora_subagent_retries");
  const retryFile = `${retryDir}/${parentConvId}.json`;
  let retryCount = 0;

  if (status === "zombie") {
    try {
      fs.mkdirSync(retryDir, { recursive: true });
      if (fs.existsSync(retryFile)) {
        const raw = fs.readFileSync(retryFile, "utf-8");
        const retryData = JSON.parse(raw);
        retryCount = retryData["retry_count"] ?? 0;
      }

      retryCount += 1;
      fs.writeFileSync(retryFile, JSON.stringify({ retry_count: retryCount }), "utf-8");
    } catch (e) {
      // pass
    }
  } else {
    try {
      if (fs.existsSync(retryFile)) {
        fs.unlinkSync(retryFile);
      }
    } catch (e) {
      // pass
    }
  }

  let actionSuggestion: string;
  if (status === "zombie") {
    actionSuggestion = suggestZombieAction(retryCount);
  } else {
    actionSuggestion = "continue_monitoring";
  }

  console.log(JSON.stringify({
    status: status,
    conversation_id: convId,
    parent_conversation_id: parentConvId,
    last_tool: lastToolName || "None",
    idle_seconds: idleSeconds,
    limit_threshold: limit,
    last_active_time: lastUpdate.toISOString(),
    retry_count: retryCount,
    action_suggestion: actionSuggestion
  }));
}

// ── CLI entrypoint: only auto-execute when run directly ──────────────
if (process.argv[1]?.includes("subagent-monitor")) {
  main();
}
