import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { extractStepPayload, parseProtobuf } from "./step-codec";
import { getBrainDir, getConversationsDir } from "./paths";
const PB_KEY = Buffer.from("safeCodeiumworldKeYsecretBalloon", "utf8");

function decryptPb(data: Buffer): Buffer {
	const iv = data.subarray(0, 12);
	const tag = data.subarray(data.length - 16);
	const ciphertext = data.subarray(12, data.length - 16);
	const decipher = crypto.createDecipheriv("aes-256-gcm", PB_KEY, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class ConversationDataAccessLayer {
	convId: string;
	dbPath: string;
	pbPath: string;
	private _pbSteps: Record<string, any>[] | null = null;

	constructor(convId: string) {
		this.convId = convId;
		this.dbPath = path.join(getConversationsDir(), `${convId}.db`);
		this.pbPath = path.join(getConversationsDir(), `${convId}.pb`);
	}

	private _loadPbSteps(): Record<string, any>[] {
		if (this._pbSteps !== null) return this._pbSteps;
		const root = this.getPbRoot();
		if (!root) {
			this._pbSteps = [];
			return [];
		}
		const blobs = root[2] ?? [];
		this._pbSteps = blobs.map((b: Buffer, i: number) => {
			const entry = extractStepPayload(b);
			entry["step_index"] = i + 1;
			return entry;
		});
		return this._pbSteps;
	}

	public exists(): boolean {
		return this._dbHasContent() || this.hasPb();
	}

	private _dbHasContent(): boolean {
		if (!fs.existsSync(this.dbPath)) return false;
		try {
			return fs.statSync(this.dbPath).size > 0;
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------
	// 1. Database Metadata
	// ---------------------------------------------------------

	getCompactionWatermark(): number {
		if (!fs.existsSync(this.dbPath)) {
			return -1;
		}
		try {
			const db = new Database(this.dbPath, { timeout: 15000 });
			try {
				const row = db
					.prepare("SELECT MAX(idx) FROM steps WHERE status = 5;")
					.get() as { "MAX(idx)": number | null } | undefined;
				return row && row["MAX(idx)"] !== null ? row["MAX(idx)"] : -1;
			} finally {
				db.close();
			}
		} catch {
			return -1;
		}
	}

	getMaxStepIndex(): number {
		if (this._dbHasContent()) {
			try {
				const db = new Database(this.dbPath, { timeout: 15000 });
				try {
					const row = db.prepare("SELECT MAX(idx) FROM steps").get() as
						| { "MAX(idx)": number | null }
						| undefined;
					return row && row["MAX(idx)"] !== null ? row["MAX(idx)"] : 0;
				} finally {
					db.close();
				}
			} catch {
				// fall through to PB
			}
		}
		// PB fallback
		return this._loadPbSteps().length;
	}

	getDbMtime(): number {
		if (fs.existsSync(this.dbPath)) {
			return fs.statSync(this.dbPath).mtimeMs / 1000;
		}
		if (fs.existsSync(this.pbPath)) {
			return fs.statSync(this.pbPath).mtimeMs / 1000;
		}
		return 0;
	}

	// ---------------------------------------------------------
	// 2. Native SQLite Payload Extraction
	// ---------------------------------------------------------

	*streamStepsReverse(limit: number = 1000): Generator<Record<string, any>> {
		if (this._dbHasContent()) {
			try {
				const db = new Database(this.dbPath, { timeout: 15000 });
				try {
					const rows = db
						.prepare(
							"SELECT idx, step_payload FROM steps ORDER BY idx DESC LIMIT ?",
						)
						.all(limit) as Array<{ idx: number; step_payload: Buffer }>;
					for (const row of rows) {
						const entry = extractStepPayload(row.step_payload);
						entry["step_index"] = row.idx;
						yield entry;
					}
					return;
				} finally {
					db.close();
				}
			} catch {
				// fall through to PB
			}
		}
		// PB fallback
		const steps = this._loadPbSteps();
		let yielded = 0;
		for (let i = steps.length - 1; i >= 0 && yielded < limit; i--) {
			yield steps[i];
			yielded++;
		}
	}

	*streamStepsForward(startIdx: number = 0): Generator<Record<string, any>> {
		if (this._dbHasContent()) {
			try {
				const db = new Database(this.dbPath, { timeout: 15000 });
				try {
					const rows = db
						.prepare(
							"SELECT idx, step_payload FROM steps WHERE idx >= ? ORDER BY idx ASC",
						)
						.all(startIdx) as Array<{ idx: number; step_payload: Buffer }>;
					for (const row of rows) {
						const entry = extractStepPayload(row.step_payload);
						entry["step_index"] = row.idx;
						yield entry;
					}
					return;
				} finally {
					db.close();
				}
			} catch {
				// fall through to PB
			}
		}
		// PB fallback
		for (const s of this._loadPbSteps()) {
			if (s["step_index"] >= startIdx) {
				yield s;
			}
		}
	}

	getLatestUserMessage(): string | null {
		for (const step of this.streamStepsReverse(50)) {
			if (step["type"] === "USER_INPUT") {
				return step["content"] ?? "";
			}
		}
		return null;
	}

	getLatestPlannerResponse(): string | null {
		for (const step of this.streamStepsReverse(50)) {
			if (step["type"] === "PLANNER_RESPONSE") {
				return step["content"] ?? "";
			}
		}
		return null;
	}

	getCurrentTurnIdx(): number {
		for (const step of this.streamStepsReverse(1000)) {
			if (step["type"] === "USER_INPUT") {
				return step["step_index"] ?? 0;
			}
		}
		return 0;
	}

	getUserInputCount(): number {
		let count = 0;
		for (const step of this.streamStepsForward()) {
			if (step["type"] === "USER_INPUT") {
				count += 1;
			}
		}
		return count;
	}

	hasPb(): boolean {
		return fs.existsSync(this.pbPath);
	}

	getPbRoot(): Record<number, any[]> | null {
		if (!fs.existsSync(this.pbPath)) return null;
		try {
			const encrypted = fs.readFileSync(this.pbPath);
			const decrypted = decryptPb(encrypted);
			return parseProtobuf(decrypted);
		} catch {
			return null;
		}
	}

	getPbStepCount(): number | null {
		const root = this.getPbRoot();
		if (!root) return null;
		return (root[4]?.[0] as number) ?? null;
	}

	getLastModifiedTime(): number {
		let t = 0;
		if (fs.existsSync(this.dbPath)) {
			try {
				t = fs.statSync(this.dbPath).mtimeMs / 1000;
			} catch {
				// pass
			}
		}
		if (fs.existsSync(this.pbPath)) {
			try {
				const pt = fs.statSync(this.pbPath).mtimeMs / 1000;
				if (pt > t) t = pt;
			} catch {
				// pass
			}
		}
		return t;
	}
}
