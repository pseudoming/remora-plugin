import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { HookProfiler } from "./profiler";
import { ProgressSentinel } from "./progress";
import {
	warn,
	error,
	debug,
	HOOKS_PROFILE_LOG,
	setTraceId,
} from "@remora/core";

export class SystemExit extends Error {
	code: number;
	constructor(code: number) {
		super(`SystemExit: ${code}`);
		this.code = code;
	}
}

let activeProfiler: HookProfiler | null = null;

export function getProfiler(): HookProfiler | null {
	return activeProfiler;
}

export function setProfiler(p: HookProfiler | null): void {
	activeProfiler = p;
}

export function hookEntrypoint(fallbackResult?: Record<string, unknown>) {
	const fallback = fallbackResult ?? { decision: "allow" };

	return function (
		func: (inputData: Record<string, unknown>) => Record<string, unknown>,
	) {
		return function (): void {
			const t0 = performance.now();
			const hookName = "unknown_hook";
			debug(`hook ${hookName} started`);
			setTraceId(`h_${randomUUID().slice(0, 8)}`);

			let inputData: Record<string, unknown>;
			try {
				inputData = JSON.parse(fs.readFileSync(process.stdin.fd, "utf-8"));
			} catch (e: unknown) {
				const t1 = performance.now();
				const logContent = `=== [${hookName}] Stdin Read Failed at ${new Date().toISOString()} (Elapsed: ${(t1 - t0).toFixed(2)} ms) (Error: ${String(e)}) ===\n\n`;
				try {
					fs.appendFileSync(HOOKS_PROFILE_LOG, logContent, "utf-8");
				} catch {
					// pass
				}
				process.stdout.write(JSON.stringify(fallback) + "\n");
				process.exit(0);
			}

			let transcriptPath = "";
			try {
				activeProfiler = new HookProfiler(hookName, inputData);
				activeProfiler.step("stdin_read");

				transcriptPath = (inputData["transcriptPath"] as string) ?? "";

				ProgressSentinel.update(
					transcriptPath,
					"running",
					undefined,
					`Starting hook: ${hookName}`,
				);

				const result = func(inputData);
				activeProfiler.step("func_execute");

				if (
					result &&
					typeof result === "object" &&
					result["decision"] === "deny"
				) {
					ProgressSentinel.update(
						transcriptPath,
						"blocked",
						undefined,
						`Blocked by hook ${hookName}: ${result["reason"] ?? "No reason provided"}`,
					);
				} else {
					let status = "running";
					let details = `Hook ${hookName} execution allowed`;
					if (
						result &&
						typeof result === "object" &&
						result["status"] === "completed"
					) {
						status = "completed";
						details = (result["details"] as string) ?? details;
					}
					ProgressSentinel.update(transcriptPath, status, undefined, details);
				}

				const isToolUse = !!(
					inputData &&
					typeof inputData === "object" &&
					inputData["toolCall"] != null
				);
				const isStopHook = !!(
					inputData &&
					typeof inputData === "object" &&
					inputData["executionNum"] != null
				);
				const isInvocationHook = !!(
					inputData &&
					typeof inputData === "object" &&
					inputData["invocationNum"] != null
				);

				let output: Record<string, unknown>;
				if (isInvocationHook) {
					if (result && typeof result === "object") {
						const injectSteps = (result["injectSteps"] as Array<unknown>) ?? [];
						output = injectSteps.length > 0 ? { injectSteps } : {};
					} else {
						output = {};
					}
				} else if (!isToolUse && !isStopHook) {
					output = {};
				} else {
					output = result as Record<string, unknown>;
				}

				process.stdout.write(JSON.stringify(output) + "\n");
			} catch (se: unknown) {
				const isToolUse = !!(
					inputData &&
					typeof inputData === "object" &&
					inputData["toolCall"] != null
				);
				const isStopHook = !!(
					inputData &&
					typeof inputData === "object" &&
					inputData["executionNum"] != null
				);

				// Python: except SystemExit → check if it's a system-level exit
				if (se instanceof SystemExit) {
					const exitCode = se.code;
					if (exitCode === 0) {
						ProgressSentinel.update(
							transcriptPath,
							"running",
							undefined,
							`Hook ${hookName} exited with code 0`,
						);
						if (isToolUse || isStopHook) {
							process.stdout.write(
								JSON.stringify({ decision: "allow" }) + "\n",
							);
						} else {
							process.stdout.write(JSON.stringify({}) + "\n");
						}
					} else {
						activeProfiler?.step(`func_sys_exit: ${exitCode}`);
						error(`Hook SystemExit code ${exitCode}`);
						process.stderr.write(se.stack ?? String(se) + "\n");
						ProgressSentinel.update(
							transcriptPath,
							"blocked",
							undefined,
							`Hook SystemExit ${exitCode}`,
						);
						if (isToolUse || isStopHook) {
							process.stdout.write(
								JSON.stringify({
									decision: "deny",
									reason: `SystemExit with code ${exitCode}`,
								}) + "\n",
							);
						} else {
							process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
						}
					}
				} else if (se instanceof Error) {
					// Python: except Exception → regular exception
					activeProfiler?.step(`func_error: ${String(se)}`);
					const safeFallback = { ...fallback };
					if ("decision" in safeFallback) {
						safeFallback["decision_reason"] =
							`Remora Fallback (Error: ${String(se)})`;
					}
					error(`Hook Error: ${String(se)}`);
					process.stderr.write(se.stack ?? String(se) + "\n");
					ProgressSentinel.update(
						transcriptPath,
						"blocked",
						undefined,
						`Hook Exception: ${String(se)}`,
					);
					if (isToolUse || isStopHook) {
						process.stdout.write(JSON.stringify(safeFallback) + "\n");
					} else {
						process.stdout.write(JSON.stringify({}) + "\n");
					}
				} else {
					// Python: except BaseException → fatal (KeyboardInterrupt etc.)
					activeProfiler?.step(`func_fatal: ${String(se)}`);
					error(`Hook Fatal Error: ${String(se)}`);
					process.stderr.write(String(se) + "\n");
					ProgressSentinel.update(
						transcriptPath,
						"blocked",
						undefined,
						`Hook Fatal Exception: ${String(se)}`,
					);
					if (isToolUse || isStopHook) {
						process.stdout.write(
							JSON.stringify({
								decision: "deny",
								reason: `Fatal Exception: ${String(se)}`,
							}) + "\n",
						);
					} else {
						process.stdout.write(JSON.stringify({}) + "\n");
					}
				}
			} finally {
				if (activeProfiler) {
					activeProfiler.finish();
				}
				process.exit(0);
			}
		};
	};
}
