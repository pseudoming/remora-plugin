import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { warn, error, HOOKS_PROFILE_LOG } from "@remora/core";
import { INFRASTRUCTURE_KEYWORDS, isInfrastructureProcess, isProcessExpired } from "@remora/core";
import { getSysUptime, cleanWhitelist } from "../sandbox/zombie-linux";

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

            // It's an Antigravity task. Check uptime.
            const statData = fs.readFileSync(path.join(pidDir, 'stat'), 'utf-8').split(/\s+/);
            // Skip if process is in D state (Uninterruptible sleep) to avoid hanging
            if (statData.length > 2 && statData[2] === 'D') {
                continue;
            }
            // Field 22 is starttime (1-indexed in docs, 21 in 0-indexed list)
            const starttime = parseInt(statData[21], 10);

            const elapsedSeconds = sysUptime - (starttime / clkTck);

            if (isProcessExpired(elapsedSeconds)) {
                if (whitelistedPids.has(pid)) {
                    continue;
                }

                const cmdlineBuf = fs.readFileSync(path.join(pidDir, 'cmdline'));
                const cmdline = cmdlineBuf.toString('utf-8')
                    .split('\0')
                    .filter(c => c.length > 0)
                    .join(' ')
                    .trim();

                // Static infrastructure whitelist
                const isInfra = isInfrastructureProcess(cmdline);

                if (isInfra) {
                    continue;
                }

                // ZOMBIE DETECTED!
                warn(`[!] UNMANAGED BACKGROUND PROCESS DETECTED.\nSUSPECT: ${cmdline} (UPTIME: ${Math.floor(elapsedSeconds)}s, PID: ${pid})`);

                logDuration((performance.now() - t0) * 1000.0, 0);


                if (isToolUse) {
                    const toolName = context?.toolCall?.name || '';
                    if (toolName === 'manage_task') {
                        continue;
                    }
                    return {
                        decision: "deny",
                        reason: `⚠️ 后台僵尸进程 PID=${pid} (${Math.floor(elapsedSeconds)}s)。请 manage_task(list) 确认，确认已死则忽略，确认滞留则等 60s 后 kill。`
                    };
                } else {
                    return {
                        injectSteps: [
                            {
                                ephemeralMessage: `⚠️ 检测到未托管衍生后台进程 (PID: ${pid}, UPTIME: ${Math.floor(elapsedSeconds)}s, CMD: ${cmdline.slice(0, 80)})。\n请执行以下自愈流程：\n1. 调用 manage_task(list) 确认进程当前是否仍在运行。\n2. 若进程已自然退出 → 无需操作。\n3. 若进程仍在运行但确已无必要保留 → 等待 60 秒后调用 manage_task(kill, TaskId=${pid}) 物理强杀。\n4. 若进程为正常任务 → 忽略，系统稍后将重新评估。`
                            }
                        ]
                    };
                }
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

