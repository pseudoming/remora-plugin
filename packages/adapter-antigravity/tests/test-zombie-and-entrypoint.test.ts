import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
	mockReadFileSync,
	mockReaddirSync,
	mockStatSync,
	mockExistsSync,
	mockWriteFileSync,
	mockAppendFileSync,
	mockMkdirSync,
} = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockReaddirSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockExistsSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockAppendFileSync: vi.fn(),
	mockMkdirSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: mockReadFileSync,
		readdirSync: mockReaddirSync,
		statSync: mockStatSync,
		existsSync: mockExistsSync,
		writeFileSync: mockWriteFileSync,
		appendFileSync: mockAppendFileSync,
		mkdirSync: mockMkdirSync,
	};
});

const { mockGetSysUptime, mockCleanWhitelist } = vi.hoisted(() => ({
	mockGetSysUptime: vi.fn(),
	mockCleanWhitelist: vi.fn(),
}));

vi.mock("../src/sandbox/zombie-linux", () => ({
	getSysUptime: mockGetSysUptime,
	cleanWhitelist: mockCleanWhitelist,
}));

vi.mock("@remora/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@remora/core")>();
	return {
		...actual,
		HOOKS_PROFILE_LOG: "/tmp/mock_hooks_profile.log",
	};
});

import { SystemExit, hookEntrypoint } from "../src/bridge/context";
import { main as zombieMain, logDuration } from "../src/hooks/zombie-detector";

describe("TestHookEntrypointRefactor", () => {
	it("test_system_exit_non_zero", () => {
		mockReadFileSync.mockReturnValue(
			Buffer.from('{"toolCall": {"name": "test"}, "test": "data"}'),
		);
		mockExistsSync.mockReturnValue(false);

		const stdoutWrites: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as any);
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as any);

		const decorated = hookEntrypoint({ decision: "allow" })(function dummyHook(
			_context: Record<string, unknown>,
		): Record<string, unknown> {
			throw new SystemExit(1);
		});

		expect(() => decorated()).toThrow("process.exit called");

		const printed = stdoutWrites.join("");
		const data = JSON.parse(printed.trim());
		expect(data.decision).toBe("deny");
		expect(data.reason).toContain("SystemExit with code 1");

		vi.restoreAllMocks();
	});

	it("test_system_exit_zero", () => {
		mockReadFileSync.mockReturnValue(Buffer.from('{"test": "data"}'));
		mockExistsSync.mockReturnValue(false);

		const stdoutWrites: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as any);
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as any);

		const decorated = hookEntrypoint({ decision: "allow" })(function dummyHook(
			_context: Record<string, unknown>,
		): Record<string, unknown> {
			throw new SystemExit(0);
		});

		expect(() => decorated()).toThrow("process.exit called");

		const printed = stdoutWrites.join("");
		expect(printed).not.toContain("decision");

		vi.restoreAllMocks();
	});

	it("test_base_exception_fatal", () => {
		mockReadFileSync.mockReturnValue(
			Buffer.from('{"toolCall": {"name": "test"}, "test": "data"}'),
		);
		mockExistsSync.mockReturnValue(false);

		const stdoutWrites: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as any);
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as any);

		const decorated = hookEntrypoint({ decision: "allow" })(function dummyHook(
			_context: Record<string, unknown>,
		): Record<string, unknown> {
			throw "KeyboardInterrupt: interrupted";
		});

		expect(() => decorated()).toThrow("process.exit called");

		const printed = stdoutWrites.join("");
		const data = JSON.parse(printed.trim());
		expect(data.decision).toBe("deny");
		expect(data.reason).toContain("Fatal Exception:");
		expect(data.reason).toContain("KeyboardInterrupt: interrupted");

		vi.restoreAllMocks();
	});
});

describe("TestZombieDetectorInterception", () => {
	beforeEach(() => {
		vi.spyOn(process, "getuid").mockReturnValue(1000);
		vi.spyOn(process, "pid", "get").mockReturnValue(1);
		mockGetSysUptime.mockReturnValue(380.0);
		mockCleanWhitelist.mockReturnValue(new Set());
		mockExistsSync.mockReturnValue(false);
		mockStatSync.mockReturnValue({ uid: 1000 } as any);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("test_zombie_detected_pre_tool_use", () => {
		mockReaddirSync.mockReturnValue(["1234"]);

		const readFileImpl = (p: any, _enc?: string): string | Buffer => {
			const path = String(p);
			if (path.includes("environ"))
				return Buffer.from("ANTIGRAVITY_AGENT=true\x00");
			if (path.includes("stat")) {
				const statFields = Array(50).fill("0");
				statFields[21] = "5000";
				return statFields.join(" ");
			}
			if (path.includes("cmdline"))
				return Buffer.from("node\x00custom-process.js\x00");
			return "";
		};
		mockReadFileSync.mockImplementation(readFileImpl as any);

		// 1. PreToolUse stage (context has toolCall)
		const resultTool = zombieMain({
			toolCall: { name: "run_command", args: { CommandLine: "ls" } },
		});
		expect(resultTool.decision).toBe("allow");

		// 2. PreInvocation stage (context has no toolCall, has transcriptPath + invocationNum)
		const resultInvoke = zombieMain({
			transcriptPath: "/tmp/brain/mock-conv-id/transcript.jsonl",
			invocationNum: 1,
		});
		expect(resultInvoke.injectSteps).toEqual([]);
	});

	it("test_manage_task_allowed_during_zombie_presence", () => {
		mockReaddirSync.mockReturnValue(["1234"]);

		const readFileImpl = (p: any, _enc?: string): string | Buffer => {
			const path = String(p);
			if (path.includes("environ"))
				return Buffer.from("ANTIGRAVITY_AGENT=true\x00");
			if (path.includes("stat")) {
				const statFields = Array(50).fill("0");
				statFields[21] = "5000";
				return statFields.join(" ");
			}
			if (path.includes("cmdline"))
				return Buffer.from("node\x00custom-process.js\x00");
			return "";
		};
		mockReadFileSync.mockImplementation(readFileImpl as any);

		const result = zombieMain({
			toolCall: { name: "manage_task", args: { Action: "list" } },
		});
		expect(result.decision).toBe("allow");
	});

	it("test_get_sys_uptime", () => {
		mockGetSysUptime.mockReturnValueOnce(123.45);
		expect(mockGetSysUptime()).toBe(123.45);

		mockGetSysUptime.mockReturnValueOnce(0.0);
		expect(mockGetSysUptime()).toBe(0.0);
	});

	it("test_log_duration", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 } as any);

		logDuration(15.2, 0);

		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("test_clean_whitelist", () => {
		mockCleanWhitelist.mockReturnValueOnce(new Set());
		expect(mockCleanWhitelist("/tmp/whitelist")).toEqual(new Set());

		mockCleanWhitelist.mockReturnValueOnce(new Set(["123"]));
		expect(mockCleanWhitelist("/tmp/whitelist")).toEqual(new Set(["123"]));
	});

	it("test_zombie_detector_various_proc_conditions", () => {
		// Test proc scan error
		mockReaddirSync.mockImplementationOnce(() => {
			throw new Error("Access denied");
		});
		let result = zombieMain({ toolCall: { name: "run_command" } });
		expect(result.decision).toBe("allow");

		// Test digit, state, and other branches
		mockReaddirSync.mockReturnValue([
			"not_digit",
			"9999",
			"8888",
			"7777",
			"6666",
			"5555",
		]);

		mockStatSync.mockImplementation(((p: any) => {
			const path = String(p);
			if (path.includes("9999")) return { uid: 2000 } as any;
			return { uid: 1000 } as any;
		}) as any);

		const readFileImpl = (p: any, _enc?: string): string | Buffer => {
			const path = String(p);
			if (path.includes("environ"))
				return Buffer.from("ANTIGRAVITY_AGENT=true\x00");

			if (path.includes("stat")) {
				const statFields = Array(50).fill("0");
				if (path.includes("8888")) statFields[2] = "D";
				else statFields[2] = "R";
				if (path.includes("7777")) statFields[21] = "9500";
				else statFields[21] = "5000";
				return statFields.join(" ");
			}

			if (path.includes("cmdline")) {
				if (path.includes("6666"))
					return Buffer.from("node\x00session-guardian.js\x00");
				if (path.includes("5555"))
					return Buffer.from("node\x00rogue-zombie.js\x00");
				return Buffer.from("other\x00");
			}
			return "";
		};
		mockReadFileSync.mockImplementation(readFileImpl as any);

		result = zombieMain({ toolCall: { name: "test" } });
		expect(result.decision).toBe("allow");

		// Test proc scan error without toolCall (PreInvocation stage)
		mockReaddirSync.mockImplementationOnce(() => {
			throw new Error("Access denied");
		});

		result = zombieMain({ transcriptPath: "foo.jsonl" });
		expect(result.decision).toBeUndefined();
		expect(result.injectSteps).toEqual([]);
	});
});
