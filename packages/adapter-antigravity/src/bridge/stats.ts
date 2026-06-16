import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "./paths";

const STATS_DIR = path.join(getDataDir(), ".runtime", "remora_view_file_stats");

export interface AccumulatedStats {
	accumulated_source_bytes: number;
	accumulated_data_bytes: number;
	unified_accumulated_read_bytes?: number;
}

function getStatsPath(convId: string): string {
	fs.mkdirSync(STATS_DIR, { recursive: true });
	return path.join(STATS_DIR, `${convId}.json`);
}

export function getStats(convId: string): AccumulatedStats {
	const p = getStatsPath(convId);
	if (fs.existsSync(p)) {
		try {
			const parsed = JSON.parse(
				fs.readFileSync(p, "utf-8"),
			) as AccumulatedStats;
			return {
				accumulated_source_bytes: parsed.accumulated_source_bytes ?? 0,
				accumulated_data_bytes: parsed.accumulated_data_bytes ?? 0,
				unified_accumulated_read_bytes:
					parsed.unified_accumulated_read_bytes ?? 0,
			};
		} catch {
			// pass
		}
	}
	return {
		accumulated_source_bytes: 0,
		accumulated_data_bytes: 0,
		unified_accumulated_read_bytes: 0,
	};
}

export function accumulate(
	convId: string,
	sourceAdd: number = 0,
	dataAdd: number = 0,
	unifiedAdd: number = 0,
): AccumulatedStats {
	const p = getStatsPath(convId);
	try {
		if (!fs.existsSync(p)) {
			fs.writeFileSync(
				p,
				JSON.stringify({
					accumulated_source_bytes: 0,
					accumulated_data_bytes: 0,
					unified_accumulated_read_bytes: 0,
				}),
				"utf-8",
			);
		}

		// NOTE: fcntl.LOCK_EX from Python has no direct Node.js equivalent.
		// Race conditions on concurrent writes are accepted (no explicit file locking).
		const raw = fs.readFileSync(p, "utf-8");
		const data = (
			raw
				? JSON.parse(raw)
				: {
						accumulated_source_bytes: 0,
						accumulated_data_bytes: 0,
						unified_accumulated_read_bytes: 0,
					}
		) as AccumulatedStats;

		data.accumulated_source_bytes =
			(data.accumulated_source_bytes ?? 0) + sourceAdd;
		data.accumulated_data_bytes = (data.accumulated_data_bytes ?? 0) + dataAdd;
		data.unified_accumulated_read_bytes =
			(data.unified_accumulated_read_bytes ?? 0) + unifiedAdd;

		fs.writeFileSync(p, JSON.stringify(data), "utf-8");
		return data;
	} catch {
		return {
			accumulated_source_bytes: 0,
			accumulated_data_bytes: 0,
			unified_accumulated_read_bytes: 0,
		};
	}
}

export function cleanup(convId: string): void {
	const p = getStatsPath(convId);
	if (fs.existsSync(p)) {
		try {
			fs.unlinkSync(p);
		} catch {
			// pass
		}
	}
}
