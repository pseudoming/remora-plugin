import { describe, it, expect } from "vitest";
import {
	isInfrastructureProcess,
	isProcessExpired,
	INFRASTRUCTURE_KEYWORDS,
} from "../src/zombie";

describe("TestIsInfrastructureProcess", () => {
	it("test_matches_keyword", () => {
		expect(isInfrastructureProcess("node cognitive-push.js arg")).toBe(true);
	});

	it("test_no_match", () => {
		expect(isInfrastructureProcess("/usr/bin/python3 my_script.py")).toBe(
			false,
		);
	});

	it("test_custom_keywords", () => {
		expect(
			isInfrastructureProcess("run my_tool.sh", new Set(["my_tool.sh"])),
		).toBe(true);
		expect(
			isInfrastructureProcess("run other.sh", new Set(["my_tool.sh"])),
		).toBe(false);
	});
});

describe("TestIsProcessExpired", () => {
	it("test_expired", () => {
		expect(isProcessExpired(301.0)).toBe(true);
		expect(isProcessExpired(20.0, 10.0)).toBe(true);
	});

	it("test_not_expired", () => {
		expect(isProcessExpired(5.0)).toBe(false);
		expect(isProcessExpired(299.0)).toBe(false);
	});

	it("test_custom_threshold", () => {
		expect(isProcessExpired(5.0, 3.0)).toBe(true);
		expect(isProcessExpired(5.0, 10.0)).toBe(false);
	});
});

describe("TestInfrastructureKeywords", () => {
	it("test_contains_expected_entries", () => {
		const expected = new Set([
			"compactor.js",
			"safety-check.js",
			"zombie-detector.js",
			"cognitive-push.js",
			"snapshot-git.js",
			"session-guardian.js",
			"tone-injector.js",
			"clean-session-stats.js",
			"action-gate.js",
			"shellIntegration-bash.sh",
		]);
		expect(INFRASTRUCTURE_KEYWORDS).toEqual(expected);
	});

	it("test_is_frozenset", () => {
		// isinstance 检查：Python frozenset → TypeScript Set
		expect(INFRASTRUCTURE_KEYWORDS instanceof Set).toBe(true);
	});
});
