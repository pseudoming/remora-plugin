import * as fs from "node:fs";
import * as path from "node:path";

import { ConversationDataAccessLayer } from "../bridge/conversation";
import { getProjectId } from "../bridge/agentapi";
import { getSubagentTypeByConvId } from "../bridge/subagent";
import { getBrainDir, getDataDir } from "../bridge/paths";

function getBrainDirValue(): string {
  return getBrainDir();
}

function getExcludeFile(): string {
  return path.join(getDataDir(), "compactor_managed_conversations.json");
}

export function loadExcludedIds(): Set<string> {
  const excludeFile = getExcludeFile();
  if (fs.existsSync(excludeFile)) {
    const data = fs.readFileSync(excludeFile, "utf-8");
    return new Set(JSON.parse(data));
  }
  return new Set();
}

export function saveExcludedIds(ids: Set<string>): void {
  fs.writeFileSync(getExcludeFile(), JSON.stringify([...ids]));
}

function getProjectIdForConv(convId: string): string {
  return getProjectId(convId);
}

export function getActiveConversations(): Array<{ projectUuid: string; conversationId: string }> {
  const activeSessions: Array<{ projectUuid: string; conversationId: string }> = [];
  const brainDir = getBrainDirValue();
  if (!fs.existsSync(brainDir)) {
    return [];
  }

  const excludedIds = loadExcludedIds();
  const currentTime = Date.now() / 1000;

  for (const convId of fs.readdirSync(brainDir)) {
    if (excludedIds.has(convId)) {
      continue;
    }
    if (convId.length !== 36 || (convId.match(/-/g) || []).length !== 4) {
      continue;
    }

    const cdal = new ConversationDataAccessLayer(convId);
    if (cdal.exists()) {
      const mtime = cdal.getDbMtime();
      if (currentTime - mtime <= 10 * 24 * 3600) {
        const projectUuid = getProjectIdForConv(convId);
        activeSessions.push({
          projectUuid: projectUuid,
          conversationId: convId,
        });
      }
    }
  }

  for (let i = activeSessions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [activeSessions[i], activeSessions[j]] = [activeSessions[j], activeSessions[i]];
  }
  return activeSessions;
}

export function isSubagentSession(convId: string): boolean {
  return getSubagentTypeByConvId(convId) !== null;
}

export function extractSubagentReport(convId: string): { changedFiles: string[]; referencedFiles: string[] } {
  let changedFiles: string[] = [];
  let referencedFiles: string[] = [];

  try {
    const cdal = new ConversationDataAccessLayer(convId);
    const steps = cdal.streamStepsReverse(100);
    for (const step of steps) {
      const content = step["content"] || "";
      if (content && content.includes("remora_subagent_report")) {
        const match = content.match(/\{.*?"remora_subagent_report".*\}/s);
        if (match) {
          const data = JSON.parse(match[0]);
          const report = data["remora_subagent_report"] || {};
          changedFiles = report["changed_files"] || [];
          referencedFiles = report["referenced_files"] || [];
          return { changedFiles, referencedFiles };
        }
      }
    }
  } catch {
    // pass
  }
  return { changedFiles, referencedFiles };
}
