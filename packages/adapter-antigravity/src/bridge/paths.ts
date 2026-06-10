import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getDbPath as coreGetDbPath, HOOKS_PROFILE_LOG } from "@remora/core";
export { HOOKS_PROFILE_LOG };

export function findPluginRoot(): string {
  let currentDir = path.resolve(__dirname);
  while (currentDir !== "/" && currentDir !== "") {
    if (fs.existsSync(path.join(currentDir, "plugin.json"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(
    "FATAL: Cannot find plugin.json to anchor PLUGIN_ROOT. Are you running outside the plugin directory?"
  );
}

export function getDataDir(): string {
  const pluginRoot = findPluginRoot();
  try {
    fs.accessSync(pluginRoot, fs.constants.W_OK);
    return path.join(pluginRoot, "data");
  } catch {
    // pass
  }
  return path.join(os.homedir(), ".remora", "data");
}

export function getDbPath(): string {
  try {
    if (!process.env.REMORA_DB_PATH) {
      process.env.REMORA_DB_PATH = path.join(getDataDir(), "remora_memory.db");
    }
  } catch {
    // pass
  }
  return coreGetDbPath();
}

// Auto-bridge database path for core modules at module load time
try {
  if (!process.env.REMORA_DB_PATH) {
    process.env.REMORA_DB_PATH = path.join(getDataDir(), "remora_memory.db");
  }
} catch {
  // pass
}

export function extractConvId(transcriptPath: string): string | null {
  if (!transcriptPath) {
    return null;
  }
  const match = transcriptPath.match(/\/brain\/([^/]+)\//);
  return match ? match[1] : null;
}
