import { describe, it, expect, vi } from "vitest";
import { AntigravityFactExtractor } from "../src/hooks/rule-runner";
import * as fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		statSync: vi.fn().mockImplementation((p) => {
			return actual.statSync(p);
		}),
	};
});

vi.mock("@remora/core", async (importOriginal) => {
	const actual = await importOriginal<any>();
	return {
		...actual,
		stripMarkdownCodeBlocks: vi.fn((str) => str),
	};
});

describe("AntigravityFactExtractor Lazy Load & Sandbox Escape Fix", () => {
	it("should lazy load view_fileSize and view_fileRangeCount facts and avoid unnecessary I/O", () => {
		const statSpy = vi.mocked(fs.statSync);
		statSpy.mockClear();

		const extractor = new AntigravityFactExtractor();
		const rawPayload = {
			transcriptPath: "/brain/test-session-123/",
			toolCall: {
				name: "view_file",
				args: {
					AbsolutePath: "/home/agent/wsl_code/remora-plugin/plugin.json",
				},
			},
		};

		const facts = extractor.extract(rawPayload);

		// 1. 在提取 facts 之后，还没有访问 view_fileSize 时，不应该触发 fs.statSync 调用
		expect(statSpy).not.toHaveBeenCalled();

		// 2. 访问 view_fileSize 时，触发 Getter 计算，执行 fs.statSync
		const size = facts.view_fileSize;
		expect(size).toBeGreaterThan(0);
		expect(statSpy).toHaveBeenCalled();
	});

	it("should correctly handle isSandboxEscaped according to subagent TypeName (fix deep diver and allow readonly)", () => {
		const extractor = new AntigravityFactExtractor();

		// 1. 只读提取器在 inherit 模式下运行，isSandboxEscaped 必须为 false
		const readonlyPayload = {
			transcriptPath: "/brain/test-session-123/",
			toolCall: {
				name: "invoke_subagent",
				args: {
					Subagents: [
						{
							TypeName: "Remora_ReadOnly_Extractor",
							Workspace: "inherit",
						},
					],
				},
			},
		};
		const readonlyFacts = extractor.extract(readonlyPayload);
		expect(readonlyFacts.isSandboxEscaped).toBe(false);

		// 2. 开发特工在 inherit 模式下运行，isSandboxEscaped 必须为 true
		const deepDiverPayload = {
			transcriptPath: "/brain/test-session-123/",
			toolCall: {
				name: "invoke_subagent",
				args: {
					Subagents: [
						{
							TypeName: "Remora_Deep_Diver",
							Workspace: "inherit",
						},
					],
				},
			},
		};
		const deepDiverFacts = extractor.extract(deepDiverPayload);
		expect(deepDiverFacts.isSandboxEscaped).toBe(true);

		// 3. 开发特工在 branch 模式下运行，isSandboxEscaped 必须为 false
		const deepDiverBranchPayload = {
			transcriptPath: "/brain/test-session-123/",
			toolCall: {
				name: "invoke_subagent",
				args: {
					Subagents: [
						{
							TypeName: "Remora_Deep_Diver",
							Workspace: "branch",
						},
					],
				},
			},
		};
		const deepDiverBranchFacts = extractor.extract(deepDiverBranchPayload);
		expect(deepDiverBranchFacts.isSandboxEscaped).toBe(false);
	});
});
