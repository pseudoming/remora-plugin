import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditHighRiskCmdRule } from "../src/hooks/command-auditors/high-risk-gate";
import { ConversationDataAccessLayer } from "../src/bridge/conversation";
import * as fs from "node:fs";

vi.mock("../src/bridge/conversation", () => {
    return {
        ConversationDataAccessLayer: vi.fn(),
    };
});

vi.mock("../src/bridge/paths", () => {
    return {
        getDataDir: vi.fn().mockReturnValue("/mock/data"),
    };
});

vi.mock("node:fs", async () => {
    const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        ...originalFs,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});

describe("auditHighRiskCmdRule", () => {
    let mockStreamStepsReverse: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockStreamStepsReverse = vi.fn().mockReturnValue([]);

        (ConversationDataAccessLayer as any).mockImplementation(function() {
            return {
                streamStepsReverse: mockStreamStepsReverse,
            };
        });
        
        // Mock default config existence false to use fallback
        (fs.existsSync as any).mockReturnValue(false);
    });

    const createCtx = (toolName: string, cmd: string) => ({
        rawContext: {},
        toolName,
        args: { CommandLine: cmd },
        transcriptPath: "/brain/test-id/transcript.jsonl",
        convId: "test-id",
        currentTurnIdx: 1,
        isSub: false,
        isReadonlySub: false,
        isDeepDiverSub: false,
        isMergerSub: false,
        mode: "strict",
        subagentType: null,
    });

    it("should allow safe commands", () => {
        const ctx = createCtx("run_command", "ls -l");
        const result = auditHighRiskCmdRule(ctx);
        expect(result).toBeUndefined();
    });

    it("should deny high risk commands when no authorization is found", () => {
        const ctx = createCtx("run_command", "git push origin master");
        const result = auditHighRiskCmdRule(ctx);

        expect(result).toBeDefined();
        expect(result?.decision).toBe("deny");
        expect(result?.injectSteps?.[0]?.systemMessage).toContain("[授权执行] git push origin master");
        expect(result?.injectSteps?.[0]?.systemMessage).toContain("<system-reminder>");
    });

    it("should allow high risk commands when explicit authorization is found in CDAL", () => {
        // Mock authorization step in CDAL
        mockStreamStepsReverse.mockReturnValue([
            {
                type: "TOOL_RESPONSE",
                source: "SYSTEM",
                content: "A1: [授权执行] git push origin master"
            }
        ]);

        const ctx = createCtx("run_command", "git push origin master");
        const result = auditHighRiskCmdRule(ctx);

        expect(result).toBeDefined();
        expect(result?.decision).toBe("allow");
    });

    it("should deny if authorization text does not perfectly match", () => {
        // Missing the exact [授权执行] tag
        mockStreamStepsReverse.mockReturnValue([
            {
                type: "TOOL_RESPONSE",
                source: "SYSTEM",
                content: "A1: 授权执行 git push origin master"
            }
        ]);

        const ctx = createCtx("run_command", "git push origin master");
        const result = auditHighRiskCmdRule(ctx);

        expect(result).toBeDefined();
        expect(result?.decision).toBe("deny");
    });

    it("should dynamically load from config file", () => {
        (fs.existsSync as any).mockReturnValue(true);
        (fs.readFileSync as any).mockReturnValue(JSON.stringify({
            highRiskCommands: ["^echo\\s+danger\\b"]
        }));

        // The default fallback "git push" should now be ignored, and only "echo danger" triggers it
        const safeCtx = createCtx("run_command", "git push origin master");
        expect(auditHighRiskCmdRule(safeCtx)).toBeUndefined();

        const dangerCtx = createCtx("run_command", "echo danger world");
        const result = auditHighRiskCmdRule(dangerCtx);
        expect(result?.decision).toBe("deny");
    });
});
