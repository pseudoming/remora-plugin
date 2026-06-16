import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { profile as logProfile } from "@remora/core";

type HookContext = Record<string, unknown>;

interface ProfilerEvent {
	name: string;
	time: number;
}

export class HookProfiler {
	hookName: string;
	tStart: number;
	events: ProfilerEvent[];
	context: HookContext;
	convId: string;

	constructor(hookName: string, context?: HookContext) {
		this.hookName = hookName;
		this.tStart = performance.now();
		this.events = [{ name: "start", time: this.tStart }];
		this.context = context ?? {};

		// 尝试提取 conv_id
		this.convId = "unknown";
		const transcriptPath = (this.context["transcriptPath"] as string) ?? "";
		if (transcriptPath) {
			const match = transcriptPath.match(/\/brain\/([^/]+)\//);
			if (match) {
				this.convId = match[1];
			}
		}
	}

	step(eventName: string): void {
		this.events.push({ name: eventName, time: performance.now() });
	}

	finish(): void {
		const tEnd = performance.now();
		this.events.push({ name: "end", time: tEnd });

		const totalMs = tEnd - this.tStart;

		const logLines: string[] = [];
		logLines.push(
			`=== [${this.hookName}] Run at ${new Date().toISOString()} (Conv: ${this.convId}) ===`,
		);
		for (let i = 1; i < this.events.length; i++) {
			const curr = this.events[i];
			const prev = this.events[i - 1];
			const elapsedMs = curr.time - prev.time;
			logLines.push(
				`  [${prev.name} -> ${curr.name}]: ${elapsedMs.toFixed(2)} ms`,
			);
		}
		logLines.push(`Total: ${totalMs.toFixed(2)} ms\n`);

		const logContent = logLines.join("\n") + "\n";

		// 1. 写入全局日志
		logProfile(logContent);

		// 2. 顺着 transcriptPath 解析并写入 scratch 目录
		const transcriptPath = (this.context["transcriptPath"] as string) ?? "";
		if (transcriptPath) {
			try {
				const scratchDir = path.join(
					path.dirname(path.dirname(path.dirname(transcriptPath))),
					"scratch",
				);
				fs.mkdirSync(scratchDir, { recursive: true });
				logProfile(logContent, path.join(scratchDir, "hooks_profile.log"));
			} catch (e) {
    console.error("[Remora Policy Error] Failure:", e);
  }
		}
	}
}
