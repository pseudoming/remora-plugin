import * as fs from "node:fs";
import * as path from "node:path";
import { extractConvId, getAntigravityDir } from "./paths";
import { parseProtobuf } from "./step-codec";

function parseSummariesPb(): Record<
	string,
	{ parentConversationId?: string; typeName?: string }
> {
	const pbPath = path.join(getAntigravityDir(), "agyhub_summaries_proto.pb");
	if (!fs.existsSync(pbPath)) return {};

	const data = fs.readFileSync(pbPath);
	let root: Record<number, any[]>;
	try {
		root = parseProtobuf(data);
	} catch {
		return {};
	}

	const entries = root[1] ?? [];
	const result: Record<
		string,
		{ parentConversationId?: string; typeName?: string }
	> = {};

	for (const blob of entries) {
		try {
			const msg = parseProtobuf(blob);
			const cId = msg[1]?.[0]?.toString("utf-8");
			if (!cId) continue;

			const metaBlob = msg[2]?.[0];
			if (!metaBlob) continue;
			const meta = parseProtobuf(metaBlob);

			const cfgBlob = meta[17]?.[0];
			if (!cfgBlob) continue;
			const cfg = parseProtobuf(cfgBlob);

			const pId = cfg[5]?.[0]?.toString("utf-8") || undefined;

			let tName: string | undefined;
			if (cfg[8]?.[0]) {
				const spec = parseProtobuf(cfg[8][0]);
				tName = spec[1]?.[0]?.toString("utf-8") || undefined;
			}

			result[cId] = { parentConversationId: pId, typeName: tName };
		} catch {
			// skip malformed entry
		}
	}

	return result;
}

export function getSubagentTypeByConvId(convId: string): string | null {
	if (!convId || convId.length !== 36) return null;

	try {
		const map = parseSummariesPb();
		const info = map[convId];
		if (info?.parentConversationId) {
			return info.typeName ?? "Remora_Subagent_Fallback";
		}
	} catch (e) {
		console.error("[getSubagentTypeByConvId]", e);
	}

	return null;
}

export function getParentConvId(convId: string): string | null {
	if (!convId || convId.length !== 36) return null;
	try {
		const map = parseSummariesPb();
		return map[convId]?.parentConversationId ?? null;
	} catch {
		return null;
	}
}

export function getSubagentType(
	transcriptPath: string | undefined | null,
): string | null {
	if (!transcriptPath) return null;
	const convId = extractConvId(transcriptPath);
	if (!convId) return null;
	return getSubagentTypeByConvId(convId);
}
