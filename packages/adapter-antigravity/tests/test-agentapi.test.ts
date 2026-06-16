import { describe, it, expect, vi } from "vitest";

const { mockExecSync, mockExecFileSync, mockExistsSync } = vi.hoisted(() => ({
	mockExecSync: vi.fn(),
	mockExecFileSync: vi.fn(),
	mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: mockExecSync,
	execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: mockExistsSync };
});

import {
	getBinary,
	getMetadata,
	getProjectId,
	sendMessage,
	createConversation,
} from "../src/bridge/agentapi";

describe("TestGetBinary", () => {
	it("test_found_via_which", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		expect(getBinary()).toBe("/bin/agentapi");
	});

	it("test_fallback_path_exists", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("not found");
		});
		mockExistsSync.mockReturnValue(true);
		const result = getBinary();
		expect(result).toContain("agentapi");
	});

	it("test_fallback_path_missing", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("not found");
		});
		mockExistsSync.mockReturnValue(false);
		expect(getBinary()).toBe("agentapi");
	});
});

describe("TestGetMetadata", () => {
	it("test_returns_metadata", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(
			Buffer.from(
				JSON.stringify({
					response: {
						conversationMetadata: { metadata: { typeName: "Test" } },
					},
				}),
			),
		);
		const meta = getMetadata("conv1");
		expect(meta).toEqual({ typeName: "Test" });
	});

	it("test_missing_metadata_returns_empty", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(Buffer.from('{"other": "stuff"}'));
		const meta = getMetadata("conv2");
		expect(meta).toEqual({});
	});
});

describe("TestGetProjectId", () => {
	it("test_returns_project_id", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(
			Buffer.from(
				JSON.stringify({
					response: {
						conversationMetadata: { metadata: { projectId: "proj_abc" } },
					},
				}),
			),
		);
		expect(getProjectId("conv1")).toBe("proj_abc");
	});

	it("test_returns_default_when_missing", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(
			Buffer.from(
				JSON.stringify({
					response: { conversationMetadata: { metadata: {} } },
				}),
			),
		);
		expect(getProjectId("conv1")).toBe("11111111-1111-1111-1111-111111111111");
	});

	it("test_returns_default_on_exception", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockImplementation(() => {
			throw new Error("down");
		});
		expect(getProjectId("conv1")).toBe("11111111-1111-1111-1111-111111111111");
	});
});

describe("TestSendMessage", () => {
	it("test_calls_send_message", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(Buffer.from(""));
		mockExecFileSync.mockClear();
		sendMessage("conv1", "hello");
		expect(mockExecFileSync).toHaveBeenCalled();
		const callArgs = mockExecFileSync.mock.calls[0];
		// execFileSync(file, args, options); args is callArgs[1]
		const args = callArgs[1] as string[];
		expect(args.find((a) => a === "send-message")).toBeTruthy();
		expect(args.find((a) => a === "conv1")).toBeTruthy();
		expect(args.find((a) => a === "hello")).toBeTruthy();
	});
});

describe("TestCreateConversation", () => {
	it("test_returns_parsed_json", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(
			Buffer.from(
				'{"response": {"newConversation": {"conversationId": "new_conv"}}}',
			),
		);
		const result = createConversation("init prompt") as any;
		expect(result.response.newConversation.conversationId).toBe("new_conv");
	});

	it("test_model_flag_injected", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(Buffer.from('{"ok": true}'));
		mockExecFileSync.mockClear();
		createConversation("prompt", undefined, "custom-model");
		const args = mockExecFileSync.mock.calls[0][1] as string[];
		expect(args.some((a) => a.startsWith("--model="))).toBe(true);
	});

	it("test_no_model_flag_when_none", () => {
		mockExecSync.mockReturnValue(Buffer.from("/bin/agentapi\n"));
		mockExecFileSync.mockReturnValue(Buffer.from('{"ok": true}'));
		mockExecFileSync.mockClear();
		createConversation("prompt");
		const args = mockExecFileSync.mock.calls[0][1] as string[];
		expect(args.every((arg) => !arg.startsWith("--model="))).toBe(true);
	});
});
