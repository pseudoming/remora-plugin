/* Linux /proc based zombie detection helpers. */
import * as fs from "node:fs";
import * as path from "node:path";

export function getSysUptime(): number {
	/* Read system uptime from /proc/uptime. Returns seconds as float, or 0.0 on failure. */
	try {
		return parseFloat(fs.readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0]);
	} catch (e) {
		return 0.0;
	}
}

export function cleanWhitelist(whitelistPath: string): Set<string> {
	/* Read whitelist file, remove PIDs that no longer exist, write back cleaned list. */
	if (!fs.existsSync(whitelistPath)) {
		return new Set();
	}

	const validPids = new Set<string>();
	let dirty = false;

	try {
		const content = fs.readFileSync(whitelistPath, "utf-8");
		for (const line of content.split("\n")) {
			const pid = line.trim();
			if (!pid) {
				continue;
			}
			if (fs.existsSync(`/proc/${pid}`)) {
				validPids.add(pid);
			} else {
				dirty = true;
			}
		}

		if (dirty) {
			fs.mkdirSync(path.dirname(whitelistPath), { recursive: true });
			let out = "";
			for (const pid of validPids) {
				out += `${pid}\n`;
			}
			fs.writeFileSync(whitelistPath, out, "utf-8");
		}
	} catch (e) {
		// pass
	}

	return validPids;
}
