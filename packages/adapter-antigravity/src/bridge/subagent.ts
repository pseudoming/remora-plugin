import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractConvId, getDataDir } from "./paths";

function getBinary(): string {
  const cmd = which("agentapi");
  if (cmd) {
    return cmd;
  }
  const fallback = path.join(os.homedir(), ".gemini", "antigravity", "bin", "agentapi");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return "agentapi";
}

function which(cmd: string): string | null {
  const envPath = process.env.PATH || "";
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return null;
}

function callAgentapi(
  action: string,
  args: string[],
  timeout: number = 30
): Buffer {
  const cmd = [getBinary(), action, ...args];
  return child_process.execFileSync(cmd[0], cmd.slice(1), {
    env: { ...process.env } as Record<string, string>,
    timeout: timeout * 1000,
    maxBuffer: 1024 * 1024,
  });
}

function getMetadata(
  convId: string,
  timeout: number = 10
): Record<string, unknown> {
  const result = callAgentapi("get-conversation-metadata", [convId], timeout);
  const data = JSON.parse(result.toString("utf-8"));
  return (
    data?.response?.conversationMetadata?.metadata ?? {}
  ) as Record<string, unknown>;
}

function cacheSubagentTypes(dataDir: string, mainId: string): void {
  const cacheFile = path.join(dataDir, ".runtime", "subagent_types.json");
  let cache: Record<string, string> = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    } catch {
      // pass
    }
  }

  const brainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
  if (!fs.existsSync(brainDir)) return;

  let cacheChanged = false;
  const dirs = fs.readdirSync(brainDir);
  for (const d of dirs) {
    if (d.length !== 36 || d === mainId || cache[d]) {
      continue;
    }
    try {
      const metadata = getMetadata(d);
      const subagentSpec = metadata["subagentSpec"] as Record<string, unknown> | undefined;
      const typeName = subagentSpec?.["typeName"] as string | undefined;
      if (typeName) {
        cache[d] = typeName;
        cacheChanged = true;
      }
    } catch {
      // pass
    }
  }

  if (cacheChanged) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // pass
    }
  }
}

export function getSubagentType(
  transcriptPath: string | undefined | null
): string | null {
  const convId = extractConvId(transcriptPath);
  if (!convId) {
    return null;
  }

  const dataDir = getDataDir();
  const cacheFile = path.join(dataDir, ".runtime", "subagent_types.json");

  try {
    const mainIdFile = path.join(dataDir, ".runtime", "remora_main_conv_id.txt");
    if (fs.existsSync(mainIdFile)) {
      const mainId = fs.readFileSync(mainIdFile, "utf-8").trim();
      if (convId === mainId) {
        cacheSubagentTypes(dataDir, mainId);
      }
    }
  } catch {
    // pass
  }

  if (fs.existsSync(cacheFile)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      if (cache[convId]) {
        return cache[convId];
      }
    } catch {
      // pass
    }
  }

  try {
    const metadata = getMetadata(convId);
    const parentId = metadata["parentConversationId"];
    if (!parentId) {
      return null;
    }
    const subagentSpec = metadata["subagentSpec"] as Record<string, unknown> | undefined;
    return (subagentSpec?.["typeName"] as string) ?? null;
  } catch {
    // pass
  }

  try {
    const mainIdFile = path.join(
      dataDir,
      ".runtime",
      "remora_main_conv_id.txt"
    );
    if (fs.existsSync(mainIdFile)) {
      const mainId = fs.readFileSync(mainIdFile, "utf-8").trim();
      if (mainId && convId !== mainId) {
        return "Remora_Subagent_Fallback";
      }
    }
  } catch {
    // pass
  }
  return null;
}

