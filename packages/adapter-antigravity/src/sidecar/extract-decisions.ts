import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import { getDataDir } from "../bridge/paths";
import { sendMessage, createConversation } from "../bridge/agentapi";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { calculateFactualConfidence, validateIdInheritance } from "@remora/core";
import {
  insertDecision,
  decisionExists,
  supersedeUnconfirmed,
} from "@remora/core";
import {
  getOpenTopic,
  getTopicFiles,
  updateTopicFiles,
  upsertTopic,
} from "@remora/core";
import { backfillMessageTopicIds, updateWatermark } from "@remora/core";
import { getDbPath } from "@remora/core";
import {
  getActiveConversations,
  isSubagentSession,
  extractSubagentReport,
  loadExcludedIds,
  saveExcludedIds,
} from "./scan-sessions";
import { readIncrementalLogs } from "./warm-storage-sync";

const CONV_MARKER_FILE = path.join(getDataDir(), "compactor_conversation_id.txt");
const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity", "brain");
const MAX_EXECUTION_TIME = 300;

export class AgentApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentApiError";
  }
}

export function getOrCreateConversation(prompt: string): string {
  const excludedIds = loadExcludedIds();

  if (fs.existsSync(CONV_MARKER_FILE)) {
    const convId = fs.readFileSync(CONV_MARKER_FILE, "utf-8").trim();
    if (convId) {
      const cdal = new ConversationDataAccessLayer(convId);
      let shouldRollover = false;
      if (fs.existsSync(cdal.dbPath)) {
        try {
          const db = new Database(cdal.dbPath, { timeout: 15000 });
          try {
            const row = db.prepare("SELECT count(*) as cnt FROM steps").get() as { cnt: number };
            const lineCount = row.cnt;
            if (lineCount > 150) {
              shouldRollover = true;
              console.log(`[Remora] 会话 ${convId} 步数已达 ${lineCount}，启动自动换代。`);
            }
          } finally {
            db.close();
          }
        } catch {
          // pass
        }
      }

      if (shouldRollover) {
        try {
          fs.unlinkSync(CONV_MARKER_FILE);
        } catch {
          // pass
        }
      } else {
        try {
          sendMessage(convId, prompt, 180);
          const reply = cdal.getLatestPlannerResponse();
          return reply || "";
        } catch (e: any) {
          const stderr = e?.stderr?.toString() || String(e);
          throw new AgentApiError(`Fail-Fast: send-message failed. Abandoning execution. Error: ${stderr}`);
        }
      }
    }
  }

  try {
    const currentDateStr = new Date().toISOString().slice(0, 10);
    const initPrompt = `# Remora Memory Compactor (${currentDateStr})\n\n` + prompt;
    const resp: any = createConversation(initPrompt, 180, "flash");

    const reply = resp?.response?.newConversation?.reply || "";
    const newConvId = resp?.response?.newConversation?.conversationId || "";
    if (newConvId) {
      fs.writeFileSync(CONV_MARKER_FILE, newConvId);
      excludedIds.add(newConvId);
      saveExcludedIds(excludedIds);
    }

    return reply || JSON.stringify(resp);
  } catch (e: any) {
    const stderr = e?.stderr?.toString() || String(e);
    throw new AgentApiError(`Fail-Fast: new-conversation failed. Abandoning execution. Error: ${stderr}`);
  }
}

export function extractFactualBaseline(convId: string, startLine: number): [string[], string[]] {
  const baselineFiles = new Set<string>();
  const baselineActions = new Set<string>();

  const cdal = new ConversationDataAccessLayer(convId);
  if (cdal.getMaxStepIndex() === 0) {
    return [[], []];
  }

  try {
    for (const step of cdal.streamStepsForward()) {
      const stepIndex = step["step_index"];
      if (stepIndex == null || stepIndex <= startLine) {
        continue;
      }

      for (const tool of step["tool_calls"] || []) {
        const toolName = tool["name"] || "";
        let args = tool["args"] || tool["arguments"] || {};
        if (["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(toolName)) {
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              // pass
            }
          }
          if (typeof args === "object" && args !== null) {
            const targetFile = args["TargetFile"] || args["AbsolutePath"];
            if (targetFile) {
              baselineFiles.add(path.basename(targetFile));
            }
          }
        }
      }

      const content = step["content"] || "";
      if (content) {
        const confirmMatches = content.match(/\/confirm\s+(\d+)/g);
        if (confirmMatches) {
          for (const m of confirmMatches) {
            const numMatch = m.match(/\d+/);
            if (numMatch) {
              baselineActions.add(`confirm:${numMatch[0]}`);
            }
          }
        }
      }
    }
  } catch {
    // pass
  }

  return [[...baselineFiles], [...baselineActions]];
}

function _getActiveTopic(projectUuid: string, conn: Database): string | null {
  try {
    return getOpenTopic(projectUuid, conn);
  } catch (e) {
    console.error(`Error querying active topic: ${String(e)}`);
    return null;
  }
}

export function processSessions(startTime: number): void {
  const conn = new Database(getDbPath(), { timeout: 15000 });
  try {
  const activeSessions = getActiveConversations();
  for (const session of activeSessions) {
    if (Date.now() / 1000 - startTime > MAX_EXECUTION_TIME) {
      console.error("Max execution time reached, stopping.");
      break;
    }

    const [keyContent, currentMsgId, lastMsgId] = readIncrementalLogs(conn, session);

    const isSub = isSubagentSession(session.conversationId);
    if (isSub) {
      const { changedFiles, referencedFiles } = extractSubagentReport(session.conversationId);
      if (changedFiles.length || referencedFiles.length) {
        const activeTopic = _getActiveTopic(session.projectUuid, conn);
        if (activeTopic) {
          const [assocJson, refJson] = getTopicFiles(session.projectUuid, activeTopic, conn);
          const existingAssoc: Array<{ file: string; source: string }> = assocJson ? JSON.parse(assocJson) : [];
          const existingRef: Array<{ file: string; source: string }> = refJson ? JSON.parse(refJson) : [];
          const assocDict: Record<string, { file: string; source: string }> = {};
          for (const item of existingAssoc) {
            if (item.file) {
              assocDict[item.file] = item;
            }
          }
          const refDict: Record<string, { file: string; source: string }> = {};
          for (const item of existingRef) {
            if (item.file) {
              refDict[item.file] = item;
            }
          }
          for (const f of changedFiles) {
            const fb = path.basename(f);
            assocDict[fb] = { file: fb, source: "agent" };
          }
          for (const f of referencedFiles) {
            const fb = path.basename(f);
            refDict[fb] = { file: fb, source: "agent" };
          }
          updateTopicFiles(
            session.projectUuid,
            activeTopic,
            JSON.stringify(Object.values(assocDict)),
            JSON.stringify(Object.values(refDict)),
            conn
          );
        }
      }
      updateWatermark(session.projectUuid, session.conversationId, currentMsgId, conn);
      continue;
    }

    if (!keyContent.trim()) {
      updateWatermark(session.projectUuid, session.conversationId, currentMsgId, conn);
      continue;
    }

    const currentTimeStr = new Date().toISOString().replace("T", " ").slice(0, 19);

    const activeTopicId = _getActiveTopic(session.projectUuid, conn);
    let topicConstraintDesc = "";
    let topicConstraintPrompt = "";

    if (activeTopicId) {
      topicConstraintDesc = `\n[MANUAL TOPIC CONSTRAINT]\nThe current session is inside an active manual topic "${activeTopicId}".\nYou MUST group all extracted decisions under this specific topic_id: "${activeTopicId}".\nDo NOT generate a new topic_id or topic summary. Just reuse "${activeTopicId}" as the topic_id in your output.`;
      topicConstraintPrompt = `\nNote: You MUST reuse "${activeTopicId}" as the topic_id in your output, do NOT create any other topic_id.`;
    }

    const [baselineFiles, baselineActions] = extractFactualBaseline(session.conversationId, lastMsgId);

    const prompt = `[STATELESS CONSTRAINT]
THIS IS A STATELESS EXTRACTION. THE LOGS PROVIDED BELOW ARE A COMPLETELY INDEPENDENT FRAGMENT.
YOU MUST NOT REFERENCE, REPEAT, OR RE-EXTRACT ANY DECISIONS FROM PRIOR INVOCATIONS.
IF THE LOGS DO NOT CONTAIN ANY NEW ARCHITECTURAL DECISIONS, RETURN {"topics": []}.
ONLY EXTRACT DECISIONS THAT ARE EXPLICITLY VISIBLE IN THE PROVIDED LOG FRAGMENT.
Each line of the log is prefixed with its database ID, e.g. [msg_123]. You MUST reference these numbers.
${topicConstraintDesc}

You MUST output this exact timestamp on the first line before your JSON markdown block (do NOT put it inside the markdown code block):
[Sync Finished: ${currentTimeStr}]

You are an expert Architecture Decision Record (ADR) extractor.
Analyze the following conversation snippets and extract all key topics.

You MUST output ONLY a valid JSON object matching this schema:
{
  "topics": [
    {
      "topic_id": "t_001",
      "summary": "...",
      "decisions": [
        {"decision": "...", "rationale": "...", "evidence_msg_ids": [123, 125], "decision_type": "approved", "user_confirmed": false, "inherited_from": []}
      ]
    }
  ]
}
Note: decision_type MUST be one of: "approved" (decision accepted/made), "rejected" (proposal explicitly rejected), "deferred" (postponed for later).
Note: If this call compresses or merges old decisions with known IDs (e.g. 12, 15), you MUST list those original IDs in the "inherited_from" array. Otherwise, set "inherited_from": [].${topicConstraintPrompt}
Note: evidence_msg_ids MUST NOT be empty. Fill it with the actual IDs from [msg_XXXX] prefixes.
Note: If the MODEL output shows clear self-correction, agreement, or adoption of user's proposal, set "user_confirmed": true.
If no significant topics, output: {"topics": []}

[CONVERSATION]
` + keyContent;

    const llmOutput = getOrCreateConversation(prompt);
    if (!llmOutput) {
      updateWatermark(session.projectUuid, session.conversationId, currentMsgId, conn);
      continue;
    }

    let jsonMatch = llmOutput.match(/```json\s*(.*?)\s*```/s);
    if (!jsonMatch) {
      jsonMatch = llmOutput.match(/({.*})/s);
    }

    let jsonStr: string;
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else {
      jsonStr = llmOutput.trim();
    }

    try {
      const data = JSON.parse(jsonStr);

      const confidence = calculateFactualConfidence(baselineFiles, baselineActions, data.topics || []);

      validateIdInheritance(session.projectUuid, data.topics || []);

      for (const t of data.topics || []) {
        const decisions = t.decisions || [];
        if (!decisions.length) {
          continue;
        }
        supersedeUnconfirmed(session.projectUuid, t.topic_id || "", conn);
      }

      for (const t of data.topics || []) {
        upsertTopic(
          session.projectUuid,
          t.topic_id || "",
          t.summary || "",
          confidence,
          conn
        );

        const decisions = t.decisions || [];
        const topicId = t.topic_id || "";
        if (!decisions.length) {
          continue;
        }
        for (const d of decisions) {
          const decisionText = d.decision || "";
          if (decisionExists(session.projectUuid, topicId, decisionText, conn)) {
            continue;
          }

          const userConfirmedVal = d.user_confirmed ? 1 : 0;

          const evidenceMsgIds = d.evidence_msg_ids || [];

          const decisionType = d.decision_type || "approved";
          insertDecision(
            session.projectUuid,
            topicId,
            session.conversationId,
            d.decision || "",
            d.rationale || "",
            JSON.stringify(evidenceMsgIds),
            userConfirmedVal,
            decisionType,
            conn
          );
        }

        const topicEvidenceIds = new Set<number>();
        for (const d of t.decisions || []) {
          for (const mid of d.evidence_msg_ids || []) {
            topicEvidenceIds.add(Number(mid));
          }
        }
        backfillMessageTopicIds(t.topic_id || "", topicEvidenceIds, conn);
      }
    } catch (_e) {
      // pass  // JSONDecodeError or other parse failures
    }

    updateWatermark(session.projectUuid, session.conversationId, currentMsgId, conn);
  }
  } finally {
    conn.close();
  }
}
