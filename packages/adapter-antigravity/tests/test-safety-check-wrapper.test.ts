import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// hoisted mocks (must appear before any import of mocked modules)
// ============================================================
const mocks = vi.hoisted(() => {
  return {
    getSubagentType: vi.fn<[string], string | null>(),
    accumulate: vi.fn(),
    cleanup: vi.fn(),
    cdallGetCurrentTurnIdx: vi.fn<[], number>().mockReturnValue(0),
    cdallGetCompactionWatermark: vi.fn<[], number>().mockReturnValue(-1),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    findPluginRoot: vi.fn(),
  };
});

// -- bridge/subagent --
vi.mock("../src/bridge/subagent", () => ({
  getSubagentType: mocks.getSubagentType,
}));

// -- bridge/stats --
vi.mock("../src/bridge/stats", () => ({
  accumulate: mocks.accumulate,
  cleanup: mocks.cleanup,
}));

// -- bridge/conversation --
vi.mock("../src/bridge/conversation", () => {
  const mockInstance = {
    getCurrentTurnIdx: mocks.cdallGetCurrentTurnIdx,
    getCompactionWatermark: mocks.cdallGetCompactionWatermark,
  };
  return {
    ConversationDataAccessLayer: vi.fn(function () {
      return mockInstance;
    }),
  };
});

// -- @remora/core --
const coreMocks = vi.hoisted(() => ({
  readMode: vi.fn().mockReturnValue("strict"),
  warn: vi.fn(),
  error: vi.fn(),
  makeDenyReason: vi.fn(function (prefix: string, message: string, tip: string) {
    return `${prefix}: ${message} ${tip}`;
  }),
  formatJitInjection: vi.fn(() =>
    "REMORA COORDINATOR JIT INJECTION: You have just launched subagents..."
  ),
  formatAccumulatedLimitExceeded: vi.fn(() => "CUMULATIVE READ LIMIT EXCEEDED"),
  formatDelegationBlocked: vi.fn(() => "DELEGATION-BLOCKED"),
  enforcePromptLengthLimit: vi
    .fn()
    .mockReturnValue([false, null] as [boolean, { prefix: string; message: string; action_tip: string } | null]),
  enforceSandboxWorkspace: vi
    .fn()
    .mockReturnValue([false, null] as [boolean, { prefix: string; message: string; action_tip: string } | null]),
  isRotSensitiveFile: vi.fn().mockReturnValue(false),
  isRotSensitivePath: vi.fn().mockReturnValue(false),
  estimateReadBytes: vi.fn().mockReturnValue(0),
  isAccumulatedLimitExceeded: vi.fn().mockReturnValue(false),
  trimStaleHookStates: vi.fn(),
  inspectCommand: vi.fn().mockReturnValue(["allow", ""]),
  getHookState: vi.fn().mockReturnValue(null),
  setHookState: vi.fn(),
}));

vi.mock("@remora/core", () => coreMocks);

// -- node:fs --
vi.mock("node:fs", async () => {
  return {
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
    readFileSync: mocks.readFileSync,
  };
});

// -- bridge/paths --
vi.mock("../src/bridge/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/paths")>();
  return {
    ...actual,
    findPluginRoot: mocks.findPluginRoot,
  };
});

// module under test (import *after* mocks)
import { main } from "../src/hooks/safety-check";

// ============================================================
// Helper – build a minimal toolCall context
// ============================================================
function makeCtx(
  toolName: string,
  args: Record<string, unknown> = {},
  transcriptPath = "/brain/conv123/transcript.jsonl"
): Record<string, unknown> {
  return {
    toolCall: { name: toolName, args },
    transcriptPath,
  };
}

// ============================================================
// Tests
// ============================================================
describe("SafetyCheckWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // restore default return values
    mocks.getSubagentType.mockReturnValue(null);
    mocks.existsSync.mockReturnValue(false);
    mocks.statSync.mockReturnValue({ size: 100 });
    mocks.readFileSync.mockReturnValue("");
    mocks.findPluginRoot.mockReturnValue("/tmp/plugin-root");
    coreMocks.readMode.mockReturnValue("strict");
    coreMocks.enforcePromptLengthLimit.mockReturnValue([false, null]);
    coreMocks.enforceSandboxWorkspace.mockReturnValue([false, null]);
    coreMocks.isRotSensitiveFile.mockReturnValue(false);
    coreMocks.isRotSensitivePath.mockReturnValue(false);
    coreMocks.estimateReadBytes.mockReturnValue(0);
    coreMocks.isAccumulatedLimitExceeded.mockReturnValue(false);
    coreMocks.inspectCommand.mockReturnValue(["allow", ""]);
    coreMocks.getHookState.mockReturnValue(null);
    mocks.accumulate.mockReturnValue({ accumulated_source_bytes: 0, accumulated_data_bytes: 0 });
  });

  // ----------------------------------------------------------
  describe("getSubagentType", () => {
    it("returns null for invalid paths", () => {
      mocks.getSubagentType.mockReturnValue(null);
      // safety-check calls getSubagentType internally; we verify the mock setup
      expect(mocks.getSubagentType("")).toBeNull();
      expect(mocks.getSubagentType("/no/brain/here")).toBeNull();
    });

    it("get_subagent_type_api_success", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");

      const res = main(makeCtx("view_file", { AbsolutePath: "/some/file.txt" }));
      // The handler returns { decision: "allow" } for normal view_file (not sensitive)
      expect(res["decision"]).toBe("allow");
    });

    it("get_subagent_type_fallback", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Subagent_Fallback");
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const res = main(makeCtx("view_file", { AbsolutePath: "/path/to/log.jsonl" }));
      // subagent allows sensitive file views
      expect(res["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("invoke_subagent", () => {
    it("payload limit >1500 deny", () => {
      mocks.getSubagentType.mockReturnValue(null);

      const longPrompt = "x".repeat(1501);
      const ctx = makeCtx("invoke_subagent", {
        Subagents: [
          {
            TypeName: "Remora_Deep_Diver",
            Prompt: longPrompt,
            Workspace: "branch",
          },
        ],
      });

      coreMocks.enforcePromptLengthLimit.mockReturnValue([
        true,
        { prefix: "PAYLOAD ENFORCEMENT", message: "prompt too long", action_tip: "shorten" },
      ]);

      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("PAYLOAD ENFORCEMENT");
    });

    it("sandbox enforcement deny", () => {
      mocks.getSubagentType.mockReturnValue(null);

      const ctx = makeCtx("invoke_subagent", {
        Subagents: [
          {
            TypeName: "Remora_Deep_Diver",
            Prompt: "short prompt",
            Workspace: "inherit",
          },
        ],
      });

      coreMocks.enforcePromptLengthLimit.mockReturnValue([false, null]);
      coreMocks.enforceSandboxWorkspace.mockReturnValue([
        true,
        { prefix: "SANDBOX ENFORCEMENT", message: "invalid workspace", action_tip: "use branch/share" },
      ]);

      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("SANDBOX ENFORCEMENT");
    });

    it("allow with JIT injection", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.getHookState.mockReturnValue(null);

      const ctx = makeCtx("invoke_subagent", {
        Subagents: [
          {
            TypeName: "Remora_Deep_Diver",
            Prompt: "short prompt",
            Workspace: "branch",
          },
        ],
      });

      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
      expect(res["injectSteps"]).toBeDefined();
      const steps = res["injectSteps"] as Array<Record<string, unknown>>;
      expect(steps[0]["ephemeralMessage"]).toContain("REMORA COORDINATOR JIT INJECTION");
      expect(coreMocks.setHookState).toHaveBeenCalled();
    });

    it("JIT already injected skip", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.getHookState.mockReturnValue("injected");

      const ctx = makeCtx("invoke_subagent", {
        Subagents: [
          {
            TypeName: "Remora_Deep_Diver",
            Prompt: "short prompt",
            Workspace: "branch",
          },
        ],
      });

      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
      expect(res["injectSteps"]).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  describe("define_subagent override protection", () => {
    it("blocks built-in name with escalated write permission", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.findPluginRoot.mockReturnValue("/tmp/plugin-root");
      mocks.existsSync.mockReturnValue(true);
      mocks.readFileSync.mockReturnValue(
        JSON.stringify({ enable_write_tools: false, enable_subagent_tools: false })
      );
      const result = main(makeCtx("define_subagent", {
        name: "Remora_ReadOnly_Extractor",
        enable_write_tools: true,
      }));
      expect(result["decision"]).toBe("deny");
      expect(result["reason"]).toContain("CONFIG_OVERRIDE");
      expect(result["reason"]).toContain("Remora_ReadOnly_Extractor");
    });

    it("blocks built-in name with escalated subagent permission", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.findPluginRoot.mockReturnValue("/tmp/plugin-root");
      mocks.existsSync.mockReturnValue(true);
      mocks.readFileSync.mockReturnValue(
        JSON.stringify({ enable_write_tools: true, enable_subagent_tools: false })
      );
      const result = main(makeCtx("define_subagent", {
        name: "Remora_Deep_Diver",
        enable_subagent_tools: true,
      }));
      expect(result["decision"]).toBe("deny");
      expect(result["reason"]).toContain("CONFIG_OVERRIDE");
    });

    it("allows built-in name with matching permissions", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.findPluginRoot.mockReturnValue("/tmp/plugin-root");
      mocks.existsSync.mockReturnValue(true);
      mocks.readFileSync.mockReturnValue(
        JSON.stringify({ enable_write_tools: false, enable_subagent_tools: false })
      );
      const result = main(makeCtx("define_subagent", {
        name: "Remora_ReadOnly_Extractor",
        enable_write_tools: false,
      }));
      expect(result["decision"]).toBe("allow");
    });

    it("allows non-built-in name", () => {
      mocks.getSubagentType.mockReturnValue(null);
      const result = main(makeCtx("define_subagent", {
        name: "My_Custom_Agent",
        enable_write_tools: true,
      }));
      expect(result["decision"]).toBe("allow");
    });

    it("blocks write to parent_shared with path traversal", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      const result = main(makeCtx("write_to_file", {
        TargetFile: "scratch/parent_shared/../../etc/passwd",
        CodeContent: "malicious",
      }));
      expect(result["decision"]).toBe("deny");
      expect(result["reason"]).toContain("PATH_TRAVERSAL");
    });

    it("blocks write to parent_shared with tilde escape", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      const result = main(makeCtx("replace_file_content", {
        TargetFile: "scratch/parent_shared/~/escape.txt",
      }));
      expect(result["decision"]).toBe("deny");
      expect(result["reason"]).toContain("PATH_TRAVERSAL");
    });

    it("blocks ReadOnly from writing to parent_shared", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
      const result = main(makeCtx("write_to_file", {
        TargetFile: "scratch/parent_shared/legit_file.txt",
        CodeContent: "hello",
      }));
      expect(result["decision"]).toBe("deny");
      expect(result["reason"]).toContain("READONLY");
    });

    it("allows Deep_Diver to write to non-parent_shared path", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      const result = main(makeCtx("multi_replace_file_content", {
        TargetFile: "scratch/normal_file.txt",
      }));
      expect(result["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("view_file", () => {
    it("sensitive suffixes deny in main context", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/log.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("prohibited to prevent context explosion");
    });

    it("sensitive suffixes allow for readonly subagent", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/log.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("single size limit strict mode deny", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.readMode.mockReturnValue("strict");
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 51 * 1024 });

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/source.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
    });

    it("single size limit relax mode allow", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.readMode.mockReturnValue("relax");
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 51 * 1024 });

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/source.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("cumulative limit exceeded deny", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 1000 });
      coreMocks.estimateReadBytes.mockReturnValue(1000);
      coreMocks.isAccumulatedLimitExceeded.mockReturnValue(true);
      mocks.accumulate.mockReturnValue({
        accumulated_source_bytes: 401 * 1024,
        accumulated_data_bytes: 0,
      });

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/code.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("CUMULATIVE READ LIMIT EXCEEDED");
    });

    it("getsize exception falls through to allow", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockImplementation(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/file.py", StartLine: "1", EndLine: "10" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("range accumulation allow", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 1000 });
      coreMocks.estimateReadBytes.mockReturnValue(500);
      mocks.accumulate.mockReturnValue({ accumulated_source_bytes: 500, accumulated_data_bytes: 0 });

      const ctx = makeCtx("view_file", {
        AbsolutePath: "/path/to/file.py",
        StartLine: "10",
        EndLine: "20",
      });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("accumulate exception falls through to allow", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 1000 });
      coreMocks.estimateReadBytes.mockReturnValue(2000);
      mocks.accumulate.mockImplementation(() => {
        throw new Error("db error");
      });

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/file.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("sensitive suffix without subagent deny", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 100 });
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/file.sqlite" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("prohibited to prevent context explosion");
    });

    it("sensitive suffix with subagent allows", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({ size: 100 });
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/file.log" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("run_command", () => {
    it("rot feature deny in main context", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["allow", ""]);

      const ctx = makeCtx("run_command", { CommandLine: "jq . /path/to/data.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
    });

    it("rot feature allow for readonly subagent", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
      coreMocks.inspectCommand.mockReturnValue(["allow", ""]);

      const ctx = makeCtx("run_command", { CommandLine: "jq . /path/to/data.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("deep diver build command allowed", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      coreMocks.inspectCommand.mockReturnValue(["deny", "build"]);

      const ctx = makeCtx("run_command", { CommandLine: "make build" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("normal deny test category", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["deny", "test"]);

      const ctx = makeCtx("run_command", { CommandLine: "some command" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("DIRECT COMMAND RUNS BLOCKED!");
      expect(res["reason"]).toContain("UNTRUSTED CODE EXECUTION PREVENTED");
    });

    it("normal deny build category", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["deny", "build"]);

      const ctx = makeCtx("run_command", { CommandLine: "some command" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("DIRECT COMMAND RUNS BLOCKED!");
      expect(res["reason"]).toContain("UNTRUSTED CODE EXECUTION PREVENTED");
    });

    it("readonly deny non-allow command", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
      coreMocks.inspectCommand.mockReturnValue(["deny", "unknown"]);

      const ctx = makeCtx("run_command", { CommandLine: "cat /path/to/data.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("READONLY");
    });

    it("other category deny returns delegation", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["deny", "unknown_category"]);

      const ctx = makeCtx("run_command", { CommandLine: "some_command" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("DELEGATION");
    });

    it("allow no rot feature returns allow", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["allow", ""]);

      const ctx = makeCtx("run_command", { CommandLine: "echo hello" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("grep_search", () => {
    it("sensitive path deny in main context", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.isRotSensitivePath.mockReturnValue(true);

      const ctx = makeCtx("grep_search", { SearchPath: "/path/to/logs" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
    });

    it("sensitive file subagent allows", () => {
      mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
      coreMocks.isRotSensitiveFile.mockReturnValue(true);

      const ctx = makeCtx("grep_search", { SearchPath: "/path/to/log.jsonl" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("sensitive dir subagent allows", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      coreMocks.isRotSensitivePath.mockReturnValue(true);

      const ctx = makeCtx("grep_search", { SearchPath: "/some/.system_generated/logs" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });

    it("normal search allows", () => {
      mocks.getSubagentType.mockReturnValue(null);

      const ctx = makeCtx("grep_search", { SearchPath: "/path/to/normal_file.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("trim turn edge cases", () => {
    it("trim turn type error handled", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.cdallGetCurrentTurnIdx.mockReturnValue("not_a_number" as unknown as number);
      coreMocks.readMode.mockReturnValue("strict");
      coreMocks.getHookState.mockReturnValue("not_a_number");

      const ctx = makeCtx("grep_search", { SearchPath: "/path/to/file.py" });
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });
  });

  // ----------------------------------------------------------
  describe("edge cases", () => {
    it("get_subagent_type env cache", () => {
      mocks.getSubagentType.mockReturnValue(null);

      const ctx: Record<string, unknown> = {
        toolCall: { name: "invoke_subagent", args: { Subagents: [] } },
        transcriptPath: "/brain/conv123/transcript.jsonl",
      };
      const res = main(ctx);
      // With empty Subagents list, invokes JIT injection
      expect(res["decision"]).toBe("allow");
      expect(res["injectSteps"]).toBeDefined();
    });

    it("get_subagent_type no parent id", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.readMode.mockReturnValue("strict");

      const ctx: Record<string, unknown> = {
        toolCall: {
          name: "view_file",
          args: {},
        },
        transcriptPath: "",
      };
      const res = main(ctx);
      expect(res["decision"]).toBe("allow");
    });
  });
});
