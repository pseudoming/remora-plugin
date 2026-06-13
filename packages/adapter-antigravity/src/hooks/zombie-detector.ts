import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  warn,
  error,
  HOOKS_PROFILE_LOG,
  INFRASTRUCTURE_KEYWORDS,
  isInfrastructureProcess,
  isProcessExpired,
  findAllUuids,
  getProjectUuidByConv,
  watermarkExists,
  parseSqliteTimestamp
} from "@remora/core";
import { getSysUptime, cleanWhitelist } from "../sandbox/zombie-linux";
import { getParentConvId } from "../bridge/subagent";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { runAudit } from "../sandbox/check-subagents-liveness";

export function logDuration(elapsed: number, exitCode: number = 0): void {
    try {
        if (fs.existsSync(HOOKS_PROFILE_LOG) && fs.statSync(HOOKS_PROFILE_LOG).size > 1024 * 1024) {
            fs.writeFileSync(HOOKS_PROFILE_LOG, `=== Log Rotated at ${new Date().toISOString()} ===\n`, "utf-8");
        }
        fs.appendFileSync(HOOKS_PROFILE_LOG, `=== [zombie-detector.ts] Run at ${new Date().toISOString()} ===\n`, "utf-8");
        fs.appendFileSync(HOOKS_PROFILE_LOG, `  [total]: ${elapsed.toFixed(2)} ms (Exit Code: ${exitCode})\n\n`, "utf-8");
    } catch (e) {
        // pass
    }
}

export function main(context?: any): { decision?: string; reason?: string; injectSteps?: any[] } {
    try {
        return _main(context);
    } catch (e) {
        console.error("ZOMBIE DETECTOR ERROR:", e);
        return { decision: "allow" };
    }
}

function getActiveSubagents(convId: string): Set<string> {
    const activeSubagents = new Set<string>();
    if (!convId) return activeSubagents;

    let parentConvId = convId;
    try {
        const parentId = getParentConvId(convId);
        if (parentId) {
            parentConvId = parentId;
        }
    } catch (e) {
        // pass
    }

    try {
        const cdal = new ConversationDataAccessLayer(parentConvId);
        const allSteps = Array.from(cdal.streamStepsForward());
        const subagentIds = new Set<string>();
        for (const step of allSteps) {
            for (const uuid of findAllUuids(step, parentConvId)) {
                subagentIds.add(uuid);
            }
        }

        let projectUuid: string | null = null;
        try {
            projectUuid = getProjectUuidByConv(parentConvId);
        } catch (e) {
            // pass
        }

        for (const subId of subagentIds) {
            if (projectUuid) {
                if (!watermarkExists(projectUuid, subId)) {
                    continue;
                }
            }

            let isAlive = false;
            try {
                const res = runAudit(subId, parentConvId);
                if (res && res["liveness"] === "alive") {
                    isAlive = true;
                }
            } catch (e) {
                isAlive = true;
            }

            if (isAlive) {
                activeSubagents.add(subId);
            }
        }
    } catch (e) {
        // pass
    }

    return activeSubagents;
}

function _main(context?: any): { decision?: string; reason?: string; injectSteps?: any[] } {
    const t0 = performance.now();
    const myUid = process.getuid ? process.getuid() : -1;
    const myPid = String(process.pid);
    const sysUptime = getSysUptime();
    const clkTck = 100;  // os.sysconf('SC_CLK_TCK') hardcoded Linux default

    const whitelistPath = path.join(os.homedir(), ".remora", "zombie_whitelist");
    const whitelistedPids = cleanWhitelist(whitelistPath);

    const isToolUse = !!(context && typeof context === 'object' && context.toolCall != null);

    let pids: string[];
    try {
        pids = fs.readdirSync('/proc');
    } catch (e) {
        logDuration((performance.now() - t0) * 1000.0, 0);
        if (isToolUse) {
            return { decision: "allow" };
        } else {
            return { injectSteps: [] };
        }
    }

    const transcriptPath = (context && typeof context === 'object') ? (context.transcriptPath as string) : "";
    const match = transcriptPath ? transcriptPath.match(/\/brain\/([^/]+)\//) : null;
    const convId = match ? match[1] : "";
    const activeSubagents = getActiveSubagents(convId);

    for (const pid of pids) {
        if (!/^\d+$/.test(pid) || pid === myPid) {
            continue;
        }

        const pidDir = path.join('/proc', pid);
        try {
            if (fs.statSync(pidDir).uid !== myUid) {
                continue;
            }

            const envBuf = fs.readFileSync(path.join(pidDir, 'environ'));
            const envItems = envBuf.toString('utf-8').split('\0');

            let isAntigravity = false;
            for (const item of envItems) {
                if (item.startsWith('ANTIGRAVITY_AGENT=')) {
                    isAntigravity = true;
                    break;
                }
            }

            if (!isAntigravity) {
                continue;
            }

            // It's an Antigravity task. Check cmdline first to determine dual threshold.
            const cmdlineBuf = fs.readFileSync(path.join(pidDir, 'cmdline'));
            const cmdline = cmdlineBuf.toString('utf-8')
                .split('\0')
                .filter(c => c.length > 0)
                .join(' ')
                .trim();

            const isInfra = isInfrastructureProcess(cmdline);
            if (isInfra) {
                continue;
            }

            // Check if active subagent process
            let isSubagentProc = false;
            try {
                const cwdLink = path.join(pidDir, 'cwd');
                const cwd = fs.readlinkSync(cwdLink);
                const envStr = envBuf.toString('utf-8');

                for (const subId of activeSubagents) {
                    if (cwd.includes(subId) || envStr.includes(subId)) {
                        isSubagentProc = true;
                        break;
                    }
                }
            } catch (e) {
                // pass
            }

            if (isSubagentProc) {
                continue;
            }

            const statData = fs.readFileSync(path.join(pidDir, 'stat'), 'utf-8').split(/\s+/);
            if (statData.length > 2 && statData[2] === 'D') {
                continue;
            }
            const starttime = parseInt(statData[21], 10);
            const elapsedSeconds = sysUptime - (starttime / clkTck);

            // Set dual thresholds: 60s for short commands, 180s for integration tests
            const isIntegrationTest = /test|vitest|jest|mocha|pytest|integration/i.test(cmdline);
            const threshold = isIntegrationTest ? 180 : 60;

            if (isProcessExpired(elapsedSeconds, threshold)) {
                if (whitelistedPids.has(pid)) {
                    continue;
                }

                // Stage 1: DO NOT kill. Just print warning log when expired
                const msg = `⚠️ [ZOMBIE WARNING] Hung process detected (PID: ${pid}, Cmd: ${cmdline}) surviving ${Math.floor(elapsedSeconds)}s. Auto-kill deferred for audit verification.`;
                warn(msg);
                console.warn(msg);
            }
        } catch (e) {
            continue;
        }
    }

    logDuration((performance.now() - t0) * 1000.0, 0);
    if (isToolUse) {
        return { decision: "allow" };
    } else {
        return { injectSteps: [] };
    }
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
  hookEntrypoint()(main)();
}
