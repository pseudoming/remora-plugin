#!/usr/bin/env node
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { filterUserAiRounds, setTraceId } from "@remora/core";
import { ConversationDataAccessLayer } from "../bridge/conversation";

function readLastUserAiRounds(convId: string, rounds: number = 10): void {
  const cdal = new ConversationDataAccessLayer(convId);

  if (!cdal.exists()) {
    console.log(`Error: db path not found for ID: ${convId}`);
    process.exit(1);
  }

  let roundsData: Array<{ role: string; content: string }>;
  try {
    const limit = rounds * 50;
    roundsData = filterUserAiRounds(cdal.streamStepsReverse(limit), rounds);
  } catch (e) {
    console.log(`Error reading db: ${e}`);
    process.exit(1);
  }

  for (const r of roundsData.reverse()) {
    console.log(`[${r.role.toUpperCase()}]: ${r.content}`);
  }
}

export function main(): void {
  setTraceId(`c_${randomUUID().slice(0, 8)}`);
  if (process.argv.length < 3) {
    console.log("Usage: read-session-log.ts <conversation_id> [rounds]");
    process.exit(1);
  }

  let arg = process.argv[2];
  if (arg.includes("/")) {
    const match = arg.match(/\/brain\/([^/]+)/);
    if (match) {
      arg = match[1];
    }
  }

  const r = process.argv.length > 3 ? parseInt(process.argv[3], 10) : 10;
  readLastUserAiRounds(arg, r);
}

if (typeof require !== "undefined" && require.main === module) {
  main();
}
