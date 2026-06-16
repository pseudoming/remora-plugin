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
		"FATAL: Cannot find plugin.json to anchor PLUGIN_ROOT. Are you running outside the plugin directory?",
	);
}

export function getDataDir(): string {
	const pluginRoot = findPluginRoot();
	try {
		fs.accessSync(pluginRoot, fs.constants.W_OK);
		return path.join(pluginRoot, "data");
	} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }
	return path.join(os.homedir(), ".remora", "data");
}

export function getDbPath(): string {
	try {
		if (!process.env.REMORA_DB_PATH) {
			process.env.REMORA_DB_PATH = path.join(getDataDir(), "remora_memory.db");
		}
	} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }
	return coreGetDbPath();
}

// Auto-bridge database path for core modules at module load time
try {
	if (!process.env.REMORA_DB_PATH) {
		process.env.REMORA_DB_PATH = path.join(getDataDir(), "remora_memory.db");
	}
} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }

export function extractConvId(transcriptPath: string): string | null {
	if (!transcriptPath) {
		return null;
	}
	const match = transcriptPath.match(/\/brain\/([^/]+)\//);
	return match ? match[1] : null;
}

function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

export function getAntigravityDir(): string {
	return path.join(homeDir(), ".gemini", "antigravity");
}

export function getBrainDir(): string {
	return path.join(getAntigravityDir(), "brain");
}

export function getConversationsDir(): string {
	return path.join(getAntigravityDir(), "conversations");
}

export function getGeminiConfigDir(): string {
	return path.join(homeDir(), ".gemini", "config");
}

/**
 * Physical secure path resolution:
 * 1. Try resolving physical path with fs.realpathSync to resolve symlinks and relative path traversal.
 * 2. If path doesn't exist (e.g. before file creation), resolve its physical parent dir and join with basename.
 * 3. Fallback to path.resolve(targetPath) if parent dir also doesn't exist.
 */
export function resolveSecurePath(targetPath: string): string {
	try {
		return fs.realpathSync(targetPath);
	} catch (e) {
		try {
			const parentDir = path.dirname(targetPath);
			const realParent = fs.realpathSync(parentDir);
			return path.join(realParent, path.basename(targetPath));
		} catch (err) {
			return path.resolve(targetPath);
		}
	}
}

export function isExemptedPath(targetFile: string): boolean {
	return (
		targetFile.includes("/artifacts/") ||
		targetFile.includes("scratch/parent_shared/") ||
		targetFile.includes(".gemini/config/projects/") ||
		targetFile.includes(".gemini/config/plugins/")
	);
}
