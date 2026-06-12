import * as fs from "node:fs";
import * as path from "node:path";
import { getAntigravityDir } from "./paths";
import { execSync, execFileSync } from "node:child_process";

export function getBinary(): string {
  try {
    const cmd = execSync("which agentapi").toString().trim();
    if (cmd) {
      return cmd;
    }
  } catch {
    // which failed, continue to fallback
  }
  const fallback = path.join(getAntigravityDir(), "bin", "agentapi");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return "agentapi";
}

export function _call(action: string, args: string[], timeout: number = 30, env?: Record<string, string>): string {
  const cmd = [getBinary(), action].concat(args);
  const effectiveEnv = env ?? { ...process.env };
  const result = execFileSync(cmd[0], cmd.slice(1), {
    env: effectiveEnv,
    timeout: timeout * 1000,
  });
  return result.toString();
}

export function getMetadata(convId: string, timeout: number = 10): Record<string, unknown> {
  const result = _call("get-conversation-metadata", [convId], timeout);
  const data = JSON.parse(result);
  return data?.response?.conversationMetadata?.metadata ?? {};
}

export function getProjectId(
  convId: string,
  defaultVal: string = "11111111-1111-1111-1111-111111111111",
  timeout: number = 10
): string {
  try {
    const meta = getMetadata(convId, timeout);
    return (meta as any).projectId || defaultVal;
  } catch {
    return defaultVal;
  }
}

export function sendMessage(convId: string, prompt: string, timeout: number = 120): void {
  const env = { ...process.env, ANTIGRAVITY_PROJECT_ID: "11111111-1111-1111-1111-111111111111" };
  _call("send-message", [convId, prompt], timeout, env);
}

export function createConversation(prompt: string, timeout: number = 120, model?: string | null): unknown {
  const env = { ...process.env, ANTIGRAVITY_PROJECT_ID: "11111111-1111-1111-1111-111111111111" };
  const binary = getBinary();
  const cmdArgs = [binary, "new-conversation"];
  if (model) {
    cmdArgs.push(`--model=${model}`);
  }
  cmdArgs.push(prompt);
  const result = execFileSync(cmdArgs[0], cmdArgs.slice(1), {
    env,
    timeout: timeout * 1000,
  });
  return JSON.parse(result.toString());
}
