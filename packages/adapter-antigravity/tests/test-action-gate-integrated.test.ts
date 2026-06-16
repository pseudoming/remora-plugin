import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
	mockReadFileSync,
	mockExistsSync,
	mockUnlinkSync,
	mockMkdirSync,
	mockWriteFileSync,
} = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockExistsSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: mockReadFileSync,
		existsSync: mockExistsSync,
		unlinkSync: mockUnlinkSync,
		mkdirSync: mockMkdirSync,
		writeFileSync: mockWriteFileSync,
	};
});

const { mockGetSnapshot, mockDiffSnapshots } = vi.hoisted(() => ({
	mockGetSnapshot: vi.fn(),
	mockDiffSnapshots: vi.fn(),
}));

vi.mock("@remora/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@remora/core")>();
	return {
		...actual,
		getSnapshot: mockGetSnapshot,
		diffSnapshots: mockDiffSnapshots,
		trimStaleHookStates: vi.fn(),
		getHookState: vi.fn().mockReturnValue(null),
		setHookState: vi.fn(),
		insertFileChange: vi.fn(),
		getProjectUuidByConv: vi.fn().mockReturnValue("p1"),
	};
});

const { mockReadMode } = vi.hoisted(() => ({
	mockReadMode: vi.fn(),
}));

vi.mock("../src/bridge/session", () => ({
	readMode: mockReadMode,
}));

import { normalizeFilepath } from "@remora/core";

import {
	getPhysicalModifications,
	getLatestConversationStates,
	_main,
	main,
} from "../src/hooks/action-gate";

import { ConversationDataAccessLayer } from "../src/bridge/conversation";
import { extractConvId } from "../src/bridge/paths";

// ─── normalizeFilepath tests ───────────────────────────────

describe("test_normalize_filepath", () => {
	it("normalize_filepath", () => {
		expect(normalizeFilepath(null)).toBe("");
		expect(normalizeFilepath("not a dict")).toBe("");
		expect(normalizeFilepath({ TargetFile: "/path/to/foo.py" })).toBe("foo.py");
		expect(normalizeFilepath({ AbsolutePath: "'/path/to/bar.js'" })).toBe(
			"bar.js",
		);
		expect(normalizeFilepath({ FilePath: '"/path/to/baz.ts"' })).toBe("baz.ts");
		expect(normalizeFilepath({ Target: "/path/to/qux.sh" })).toBe("qux.sh");
		expect(normalizeFilepath({ Other: "ignored" })).toBe("");
	});
});

// ─── getPhysicalModifications tests ────────────────────────

describe("test_get_physical_modifications", () => {
	it("detects modified and new files, removes snapshot", () => {
		const preData = {
			"/path/to/a.py": { mtime: 100.0, size: 100 },
			"/path/to/b.py": { mtime: 100.0, size: 100 },
		};

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(preData));

		mockGetSnapshot.mockReturnValue({
			"/path/to/a.py": { mtime: 100.0, size: 100 },
			"/path/to/b.py": { mtime: 101.0, size: 100 },
			"/path/to/c.py": { mtime: 200.0, size: 200 },
		});

		mockDiffSnapshots.mockReturnValue(new Set(["b.py", "c.py"]));

		const mods = getPhysicalModifications(
			"/tmp/cwd",
			"/tmp/brain/conv/transcript.jsonl",
		);
		expect(mods).toEqual(new Set(["b.py", "c.py"]));
		expect(mockUnlinkSync).toHaveBeenCalled();
	});
});

// ─── getLatestConversationStates tests ─────────────────────

describe("test_get_latest_conversation_states", () => {
	it("extracts planner text, tool files, and has_calls from CDAL", () => {
		const mockCdal = {
			streamStepsReverse: function* () {
				yield {
					type: "PLANNER_RESPONSE",
					step_index: 3,
					content: "I have modified standard.py",
					tool_calls: [
						{ name: "write_to_file", args: { TargetFile: "standard.py" } },
					],
				};
				yield {
					type: "TOOL_CALL",
					step_index: 2,
					tool_calls: [
						{
							name: "replace_file_content",
							args: '{"AbsolutePath": "helper.py"}',
						},
					],
				};
				yield {
					type: "USER_INPUT",
					step_index: 1,
					content: "please do something",
				};
			},
		} as unknown as ConversationDataAccessLayer;

		const [text, actualFiles, hasCalls] = getLatestConversationStates(
			mockCdal,
			0,
		);
		expect(text).toBe("I have modified standard.py");
		expect(actualFiles).toEqual(new Set(["standard.py", "helper.py"]));
		expect(hasCalls).toBe(true);
	});

	it("respects watermark cutoff", () => {
		const mockCdal = {
			streamStepsReverse: function* () {
				yield {
					type: "PLANNER_RESPONSE",
					step_index: 5,
					content: "hello",
				};
				yield {
					type: "PLANNER_RESPONSE",
					step_index: 4,
					content: "world",
				};
			},
		} as unknown as ConversationDataAccessLayer;

		const [text] = getLatestConversationStates(mockCdal, 4);
		expect(text).toBe("hello");
	});
});

// ─── _main (wrapped) integration tests ─────────────────────

describe("_main integration tests", () => {
	const testEnv = {
		transcriptPath: "/tmp/brain/conv123/transcript.jsonl",
		cwd: "/tmp/cwd",
	};

	function setupCdalMock(streamData: any[]) {
		const mockCdal = {
			streamStepsReverse: function* () {
				for (const s of streamData) yield s;
			},
			getCurrentTurnIdx: () => 0,
		};
		return mockCdal;
	}

	beforeEach(() => {
		vi.spyOn({ extractConvId } as any, "extractConvId").mockReturnValue(
			"conv123",
		);
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("{}");
		// Default: empty post-snapshot, no diff → empty physical modifications
		mockGetSnapshot.mockReturnValue({});
		mockDiffSnapshots.mockReturnValue(new Set());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("test_main_wrapped_relax_mode", () => {
		mockReadMode.mockReturnValue("relax");

		const mockCdal = setupCdalMock([
			{
				type: "PLANNER_RESPONSE",
				content: "I have updated a.py and b.py",
				step_index: 10,
			},
		]);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"streamStepsReverse",
		).mockImplementation(mockCdal.streamStepsReverse);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"getCurrentTurnIdx",
		).mockReturnValue(0);

		const res = _main(testEnv);
		expect(res).toEqual({ injectSteps: [], terminationBehavior: "" });
	});

	it("test_main_wrapped_phantom_detection", () => {
		mockReadMode.mockReturnValue("strict");
		// No physical modifications → phantom should be detected
		mockDiffSnapshots.mockReturnValue(new Set());

		const mockCdal = setupCdalMock([
			{
				type: "PLANNER_RESPONSE",
				content: "成功更新了 [test.py](file:///test.py) 和 `src/main.py`",
				step_index: 10,
				tool_calls: [
					{ name: "write_to_file", args: { TargetFile: "src/main.py" } },
				],
			},
		]);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"streamStepsReverse",
		).mockImplementation(mockCdal.streamStepsReverse);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"getCurrentTurnIdx",
		).mockReturnValue(0);

		const res = _main(testEnv);
		expect(res.injectSteps).toBeDefined();
		expect(res.injectSteps.length).toBe(1);
		expect(res.injectSteps[0].ephemeralMessage).toContain("test.py");
		expect(res.terminationBehavior).toBe("force_continue");
	});

	it("test_main_wrapped_no_phantom", () => {
		mockReadMode.mockReturnValue("strict");
		// test.py is physically modified → no phantom
		mockDiffSnapshots.mockReturnValue(new Set(["test.py"]));

		const mockCdal = setupCdalMock([
			{
				type: "PLANNER_RESPONSE",
				content: "成功更新了 [test.py](file:///test.py) 和 `src/main.py`",
				step_index: 10,
				tool_calls: [
					{ name: "write_to_file", args: { TargetFile: "src/main.py" } },
				],
			},
		]);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"streamStepsReverse",
		).mockImplementation(mockCdal.streamStepsReverse);
		vi.spyOn(
			ConversationDataAccessLayer.prototype,
			"getCurrentTurnIdx",
		).mockReturnValue(0);

		const res = _main(testEnv);
		expect(res.injectSteps).toBeDefined();
		expect(res.injectSteps.length).toBe(1);
		expect(res.injectSteps[0].ephemeralMessage).toContain(
			"POST-WRITE TRUTH CHECK",
		);
		expect(res.terminationBehavior).toBe("");
	});

	it("test_regex_patterns", () => {
		mockReadMode.mockReturnValue("strict");
		// No physical modifications
		mockDiffSnapshots.mockReturnValue(new Set());

		const testCases = [
			["已修改文件 `abc.py`", "abc.py"],
			["成功更新了 `dir/def.json`", "def.json"],
			["覆写了 [xyz.py](file:///path/xyz.py)", "xyz.py"],
			["已在 [hello.js](file:///hello.js) 中修改了", "hello.js"],
			["已在 `world.ts` 中更新了", "world.ts"],
			["updated `test.sh`", "test.sh"],
			["modified file `data.xml`", "data.xml"],
			["created file helper.py", "helper.py"],
		];

		for (const [text, expected] of testCases) {
			const mockCdal = setupCdalMock([
				{
					type: "PLANNER_RESPONSE",
					content: text,
					step_index: 10,
					tool_calls: [
						{ name: "write_to_file", args: { TargetFile: "other.py" } },
					],
				},
			]);
			vi.spyOn(
				ConversationDataAccessLayer.prototype,
				"streamStepsReverse",
			).mockImplementation(mockCdal.streamStepsReverse);
			vi.spyOn(
				ConversationDataAccessLayer.prototype,
				"getCurrentTurnIdx",
			).mockReturnValue(0);

			const res = _main(testEnv);
			expect(res.injectSteps).toBeDefined();
			expect(res.injectSteps.length).toBe(1);
			expect(res.injectSteps[0].ephemeralMessage).toContain(expected);
		}
	});
});

// ─── Zero-fault fallback tests ─────────────────────────────

describe("test_zero_fault_fallback", () => {
	it("returns empty dict on internal error", () => {
		vi.spyOn({ extractConvId } as any, "extractConvId").mockImplementation(
			() => {
				throw new Error("Simulated CDAL failure");
			},
		);

		const res = main({
			transcriptPath: "/tmp/brain/conv123/transcript.jsonl",
			cwd: "/tmp/cwd",
		});
		expect(res).toEqual({ injectSteps: [], terminationBehavior: "" });

		vi.restoreAllMocks();
	});
});
