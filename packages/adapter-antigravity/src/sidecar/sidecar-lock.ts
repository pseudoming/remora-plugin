import * as fs from "node:fs";
import * as path from "node:path";

import { getDataDir } from "../bridge/paths";

const LOCK_FILE = path.join(getDataDir(), "compactor.lock");

export function acquireLock(): void {
	if (fs.existsSync(LOCK_FILE)) {
		try {
			const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim());
			const mtimeMs = fs.statSync(LOCK_FILE).mtimeMs;
			if (Date.now() - mtimeMs < 1800 * 1000) {
				try {
					process.kill(pid, 0);
					console.error(`Lock active by PID ${pid}, exiting.`);
					process.exit(0);
				} catch {
					// pass: 原进程已死，允许接管
				}
			} else {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// pass: 超过30分钟，强制杀掉僵尸进程后允许接管
				}
			}
		} catch {
			// pass: 文件损坏或无法读取，允许强行接管
		}
	}

	fs.writeFileSync(LOCK_FILE, String(process.pid));
}

export function releaseLock(): void {
	if (fs.existsSync(LOCK_FILE)) {
		try {
			const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim());
			if (pid === process.pid) {
				fs.unlinkSync(LOCK_FILE);
			}
		} catch {
			// pass
		}
	}
}
