export function decodeVarint(
	data: Buffer,
	offset: number = 0,
): [number, number] {
	let result = 0;
	let shift = 0;
	while (true) {
		if (offset >= data.length) {
			throw new Error("Unexpected end of data while reading varint");
		}
		const b = data[offset];
		offset += 1;
		result |= (b & 0x7f) << shift;
		if (!(b & 0x80)) {
			break;
		}
		shift += 7;
	}
	return [result, offset];
}

export function parseProtobuf(data: Buffer): Record<number, any[]> {
	let offset = 0;
	const results: Record<number, any[]> = {};

	while (offset < data.length) {
		let tagType: number;
		try {
			[tagType, offset] = decodeVarint(data, offset);
		} catch {
			break;
		}
		const tag = tagType >> 3;
		const wireType = tagType & 0x07;

		if (!(tag in results)) {
			results[tag] = [];
		}

		if (wireType === 0) {
			// Varint
			let val: number;
			[val, offset] = decodeVarint(data, offset);
			results[tag].push(val);
		} else if (wireType === 1) {
			// 64-bit
			if (offset + 8 > data.length) break;
			const val = data.readBigUInt64LE(offset);
			offset += 8;
			results[tag].push(Number(val));
		} else if (wireType === 2) {
			// Length-delimited
			let length: number;
			[length, offset] = decodeVarint(data, offset);
			if (offset + length > data.length) break;
			const valBytes = data.subarray(offset, offset + length);
			offset += length;
			results[tag].push(valBytes);
		} else if (wireType === 5) {
			// 32-bit
			if (offset + 4 > data.length) break;
			const val = data.readUInt32LE(offset);
			offset += 4;
			results[tag].push(val);
		} else {
			// Unsupported wire type, abort parsing to avoid infinite loop
			break;
		}
	}

	return results;
}

export function extractStepPayload(blob: Buffer): Record<string, any> {
	if (!blob || blob.length === 0) {
		return {};
	}

	let root: Record<number, any[]>;
	try {
		root = parseProtobuf(blob);
	} catch {
		return {};
	}

	const entry: Record<string, any> = {};

	const stepTypeList = root[1] ?? [];
	if (stepTypeList.length > 0) {
		const stepType = stepTypeList[0];
		if (stepType === 15) {
			entry["type"] = "PLANNER_RESPONSE";
		} else if (stepType === 14) {
			entry["type"] = "USER_INPUT";
		} else {
			entry["type"] = `UNKNOWN_${stepType}`;
		}
	}

	const tag5s = root[5] ?? [];
	for (const tag5Blob of tag5s) {
		try {
			const tag5Msg = parseProtobuf(tag5Blob);

			// Extract role
			if (3 in tag5Msg) {
				const roleVal = tag5Msg[3][0];
				if (roleVal === 4) {
					entry["role"] = "user";
				} else if (roleVal === 2) {
					entry["role"] = "model";
				} else if (roleVal === 5) {
					entry["role"] = "system";
				} else {
					entry["role"] = `unknown_${roleVal}`;
				}
			}

			// Extract timestamp from Tag 1 -> Tag 1
			if (1 in tag5Msg) {
				const subMsg = parseProtobuf(tag5Msg[1][0]);
				if (1 in subMsg) {
					const tsVal = subMsg[1][0];
					const dt = new Date(tsVal * 1000);
					entry["timestamp"] = dt.toISOString().replace("T", " ").slice(0, 19);
				}
			}
		} catch {
			// pass
		}
	}

	const tag20s = root[20] ?? [];
	for (const tag20Blob of tag20s) {
		// Tag 20 is a nested message containing the core payload
		const tag20Msg = parseProtobuf(tag20Blob);

		if (1 in tag20Msg) {
			try {
				entry["content"] = tag20Msg[1][0].toString("utf-8");
			} catch {
				// pass
			}
		}
		if (3 in tag20Msg) {
			try {
				entry["internal_monologue"] = tag20Msg[3][0].toString("utf-8");
			} catch {
				// pass
			}
		}

		if (7 in tag20Msg) {
			entry["tool_calls"] = [];
			for (const toolCallBlob of tag20Msg[7]) {
				const tcMsg = parseProtobuf(toolCallBlob);
				const tc: Record<string, any> = {};
				if (1 in tcMsg) tc["id"] = tcMsg[1][0].toString("utf-8");
				if (2 in tcMsg) tc["name"] = tcMsg[2][0].toString("utf-8");
				if (3 in tcMsg) {
					const rawArgs = tcMsg[3][0].toString("utf-8");
					try {
						tc["arguments"] = JSON.parse(rawArgs);
					} catch {
						tc["arguments"] = rawArgs;
					}
				}
				entry["tool_calls"].push(tc);
			}
		}
	}

	return entry;
}
