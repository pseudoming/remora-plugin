import { describe, it, expect, vi } from "vitest";

let throwOnGetConn = false;

vi.mock("../src/storage/connection", () => {
	const Database = require("better-sqlite3");
	return {
		getDbPath: () => "",
		getConn: () => {
			if (throwOnGetConn) {
				throw new Error("database is locked");
			}
			// Return a valid-looking but non-functional connection
			// (The test never actually calls this path because we always set throwOnGetConn)
			return new Database(":memory:");
		},
		checkDbExists: () => false,
	};
});

import {
	runTopicGarbageCollection,
	pruneExpiredWatermarks,
} from "../src/storage/maintenance";

function mockExit() {
	const original = process.exit;
	process.exit = ((code?: number) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as any;
	return () => {
		process.exit = original;
	};
}

describe("runTopicGarbageCollection lock contention", () => {
	it("test_run_topic_garbage_collection_lock_contention", () => {
		const restore = mockExit();
		throwOnGetConn = true;
		try {
			expect(() => runTopicGarbageCollection()).toThrow("EXIT_1");
		} finally {
			throwOnGetConn = false;
			restore();
		}
	});
});

describe("pruneExpiredWatermarks lock contention", () => {
	it("test_prune_expired_watermarks_lock_contention", () => {
		const restore = mockExit();
		throwOnGetConn = true;
		try {
			expect(() => pruneExpiredWatermarks("/fake/brain")).toThrow("EXIT_1");
		} finally {
			throwOnGetConn = false;
			restore();
		}
	});
});
