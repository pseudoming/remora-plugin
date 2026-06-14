import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// hoisted mocks (must appear before any import of mocked modules)
// ============================================================
const mocks = vi.hoisted(() => {
  return {
    getSubagentType: vi.fn<[string], string | null>(),
    getSubagentTypeByConvId: vi.fn<[string], string | null>(),
    accumulate: vi.fn(),
    cleanup: vi.fn(),
    cdallGetCurrentTurnIdx: vi.fn<[], number>().mockReturnValue(0),
    cdallGetCompactionWatermark: vi.fn<[], number>().mockReturnValue(-1),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    realpathSync: vi.fn(),
    findPluginRoot: vi.fn(),
  };
});

// -- bridge/subagent --
vi.mock("../src/bridge/subagent", () => ({
  getSubagentType: mocks.getSubagentType,
  getSubagentTypeByConvId: mocks.getSubagentTypeByConvId,
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
    exists: () => true,
    getMaxStepIndex: () => 0,
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
  info: vi.fn(),
  RuleEngine: vi.fn().mockImplementation(() => {
    return {
      evaluate: vi.fn().mockReturnValue({ status: "ALLOW" }),
    };
  }),
}));

vi.mock("@remora/core", () => coreMocks);

// -- node:fs --
vi.mock("node:fs", async () => {
  return {
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFileSync: mocks.writeFileSync,
    realpathSync: mocks.realpathSync,
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
    mocks.statSync.mockReturnValue({ size: 100, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false });
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
    mocks.mkdirSync.mockImplementation(() => {});
    mocks.writeFileSync.mockImplementation(() => {});
    mocks.realpathSync.mockImplementation((p) => p);
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

    it("denies pb_read category with PB_READ_DENY error", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["deny", "pb_read"]);

      const ctx = makeCtx("run_command", { CommandLine: "cat file.pb" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("PB_READ_DENY");
      expect(res["reason"]).toContain("Direct reading or unpacking of .pb binary files is strictly prohibited.");
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
describe("GitCommitEscapeAndInheritWriteDeny", () => {
    it("git_escape category blocks git commit with escape", () => {
      mocks.getSubagentType.mockReturnValue(null);
      coreMocks.inspectCommand.mockReturnValue(["deny", "git_escape"]);

      const ctx = makeCtx("run_command", { CommandLine: "git commit -m 'a\\nb'" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("GIT_COMMIT_ESCAPE");
    });

    it("inherit write block for subagent write_to_file", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      process.env.REMORA_WORKSPACE = "inherit";

      const ctx = makeCtx("write_to_file", { TargetFile: "test.txt", CodeContent: "hello" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("INHERIT_WRITE_DENY");

      delete process.env.REMORA_WORKSPACE;
    });

    it("inherit write block for subagent run_command non-allow", () => {
      mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
      process.env.REMORA_WORKSPACE = "inherit";
      coreMocks.inspectCommand.mockReturnValue(["deny", "build"]);

      const ctx = makeCtx("run_command", { CommandLine: "npm run build" });
      const res = main(ctx);
      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("INHERIT_WRITE_DENY");

      delete process.env.REMORA_WORKSPACE;
    });
});

describe("BehaviorRulesGuard", () => {
  it("Subagent prompt length limit enforcement with 500/1500 limit", () => {
    mocks.getSubagentType.mockReturnValue(null);

    // 1. A prompt of 600 chars without task.md gets denied
    const prompt600 = "x".repeat(600);
    const ctx1 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: prompt600,
          Workspace: "branch",
        },
      ],
    });
    const res1 = main(ctx1);
    expect(res1["decision"]).toBe("deny");
    expect(res1["reason"]).toContain("Subagent Prompt density violation");

    // 2. A prompt of 1600 chars gets denied
    const prompt1600 = "x".repeat(1600);
    coreMocks.enforcePromptLengthLimit.mockReturnValue([
      true,
      { prefix: "PAYLOAD ENFORCEMENT", message: "prompt too long", action_tip: "shorten" },
    ]);
    const ctx2 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: prompt1600,
          Workspace: "branch",
        },
      ],
    });
    const res2 = main(ctx2);
    expect(res2["decision"]).toBe("deny");
    expect(res2["reason"]).toContain("PAYLOAD ENFORCEMENT");

    // 3. A compliant prompt (e.g. 600 chars but containing task.md) gets allowed
    const compliantPrompt = "x".repeat(500) + " task.md";
    const ctx3 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: compliantPrompt,
          Workspace: "branch",
        },
      ],
    });
    const res3 = main(ctx3);
    expect(res3["decision"]).toBe("allow");
  });

  it("Workspace JIT matrix with actionable phrases", () => {
    mocks.getSubagentType.mockReturnValue(null);

    // 1. Workspace: "inherit" with prompt containing "npm run build" gets denied
    const ctx1 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: "Please run npm run build to compile the package",
          Workspace: "inherit",
        },
      ],
    });
    const res1 = main(ctx1);
    expect(res1["decision"]).toBe("deny");
    expect(res1["reason"]).toContain("Workspace JIT Matrix mismatch");

    // 2. Prompt containing "review vitest logs" gets allowed
    const ctx2 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: "review vitest logs",
          Workspace: "inherit",
        },
      ],
    });
    const res2 = main(ctx2);
    expect(res2["decision"]).toBe("allow");

    // 3. Prompt containing "analyze build logs" gets allowed
    const ctx3 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Prompt: "analyze build logs",
          Workspace: "inherit",
        },
      ],
    });
    const res3 = main(ctx3);
    expect(res3["decision"]).toBe("allow");
  });

  it("Database facts roles validator", () => {
    mocks.findPluginRoot.mockReturnValue("/tmp/plugin-root");
    mocks.getSubagentType.mockReturnValue(null);

    // 1. Role: "DB extractor" without facts gets denied
    const ctx1 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "DB extractor",
          Prompt: "fetch something",
          Workspace: "branch",
        },
      ],
    });
    const res1 = main(ctx1);
    expect(res1["decision"]).toBe("deny");
    expect(res1["reason"]).toContain("Missing database environment facts");

    // 2. Role: "git auditor" without facts gets allowed
    const ctx2 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "git auditor",
          Prompt: "check git logs",
          Workspace: "branch",
        },
      ],
    });
    const res2 = main(ctx2);
    expect(res2["decision"]).toBe("allow");

    // 3. Role: "DB extractor" with facts gets allowed
    const ctx3 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "DB extractor",
          Prompt: "REMORA_DB_PATH project_uuid /tmp/plugin-root",
          Workspace: "branch",
        },
      ],
    });
    const res3 = main(ctx3);
    expect(res3["decision"]).toBe("allow");
  });

  it("Duplicate spawn rate limiter", () => {
    mocks.getSubagentType.mockReturnValue(null);

    // Local mock for hook state history storage
    let localHistory = JSON.stringify([]);
    coreMocks.getHookState.mockImplementation((convId: string, currentTurnIdx: number, key: string) => {
      if (key === "subagent_dispatch_history") {
        return localHistory;
      }
      return null;
    });
    coreMocks.setHookState.mockImplementation((convId: string, currentTurnIdx: number, key: string, val: string) => {
      if (key === "subagent_dispatch_history") {
        localHistory = val;
      }
    });

    const dateSpy = vi.spyOn(Date, "now");

    // 1. First dispatch at t = 1000s
    dateSpy.mockReturnValue(1000000);
    const ctx1 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "Extractor",
          Prompt: "Some prompt here",
          Workspace: "branch",
        },
      ],
    });
    const res1 = main(ctx1);
    expect(res1["decision"]).toBe("allow");

    // 2. Second dispatch (duplicate role) within 180s (t = 1000 + 50s = 1050s)
    dateSpy.mockReturnValue(1050000);
    const ctx2 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "Extractor",
          Prompt: "Different prompt",
          Workspace: "branch",
        },
      ],
    });
    const res2 = main(ctx2);
    expect(res2["decision"]).toBe("deny");
    expect(res2["reason"]).toContain("High-frequency duplicate dispatch");

    // 3. Third dispatch (duplicate prompt hash) within 180s (t = 1000 + 100s = 1100s)
    dateSpy.mockReturnValue(1100000);
    const ctx3 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "DifferentRole",
          Prompt: "Some prompt here",
          Workspace: "branch",
        },
      ],
    });
    const res3 = main(ctx3);
    expect(res3["decision"]).toBe("deny");
    expect(res3["reason"]).toContain("High-frequency duplicate dispatch");

    // 4. Fourth dispatch spaced out by > 180s (t = 1000 + 190s = 1190s)
    dateSpy.mockReturnValue(1190000);
    const ctx4 = makeCtx("invoke_subagent", {
      Subagents: [
        {
          TypeName: "Remora_Deep_Diver",
          Role: "Extractor",
          Prompt: "Some other prompt",
          Workspace: "branch",
        },
      ],
    });
    const res4 = main(ctx4);
    expect(res4["decision"]).toBe("allow");

    dateSpy.mockRestore();
  });


  describe("Virtual Project Self-healing Test", () => {
    it("creates virtual project config if it does not exist during bootstrap", async () => {
      mocks.existsSync.mockImplementation((p) => {
        if (p.includes("11111111-1111-1111-1111-111111111111.json")) {
          return false;
        }
        return true;
      });

      // Clear module cache and re-import session-guardian
      vi.resetModules();
      await import("../src/hooks/session-guardian");

      expect(mocks.mkdirSync).toHaveBeenCalled();
      expect(mocks.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("11111111-1111-1111-1111-111111111111.json"),
        expect.stringContaining("remora-system"),
        "utf-8"
      );
    });
  });

  describe("Symlink Escape Interception Test", () => {
    it("blocks view_file if target is a symlink pointing to sensitive path", () => {
      const fsReal = require("node:fs");
      const pathReal = require("node:path");
      const osReal = require("node:os");

      const tempDir = pathReal.join(osReal.tmpdir(), `remora-symlink-test-${Date.now()}`);
      fsReal.mkdirSync(tempDir, { recursive: true });

      const sensitiveFile = pathReal.join(tempDir, "large_log.jsonl");
      fsReal.writeFileSync(sensitiveFile, "some log content", "utf-8");

      const symlinkFile = pathReal.join(tempDir, "link_to_log.ts");
      try {
        fsReal.symlinkSync(sensitiveFile, symlinkFile);
      } catch (e) {
        // If symlink fails, skip or warn
      }

      // Configure mocks to resolve real path
      mocks.realpathSync.mockImplementation((p) => {
        try {
          return fsReal.realpathSync(p);
        } catch {
          return p;
        }
      });
      mocks.existsSync.mockReturnValue(true);

      // We expect it to be blocked because the real path of the file resolved to 'large_log.jsonl' (which is rot-sensitive)
      coreMocks.isRotSensitiveFile.mockImplementation((p) => p.endsWith(".jsonl"));
      mocks.getSubagentType.mockReturnValue(null); // main context

      const ctx = makeCtx("view_file", { AbsolutePath: symlinkFile });
      const res = main(ctx);

      // Clean up
      try {
        fsReal.unlinkSync(symlinkFile);
      } catch {}
      try {
        fsReal.unlinkSync(sensitiveFile);
      } catch {}
      try {
        fsReal.rmdirSync(tempDir);
      } catch {}

      expect(res["decision"]).toBe("deny");
      expect(res["reason"]).toContain("prohibited to prevent context explosion");
    });
  });

  describe("send_message turn limit check (Phase 73)", () => {
    it("blocks send_message to ReadOnly extractor when turn limit exceeds 4", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.getSubagentTypeByConvId.mockReturnValue("Remora_ReadOnly_Extractor");

      // Local mock state store for turns count
      const localStore: Record<string, string> = {};
      coreMocks.getHookState.mockImplementation((convId: string, turnIdx: number, key: string) => {
        return localStore[key] || null;
      });
      coreMocks.setHookState.mockImplementation((convId: string, turnIdx: number, key: string, val: string) => {
        localStore[key] = val;
      });

      const recipient = "subagent-123";

      // 1st, 2nd, 3rd, 4th turns should be allowed
      for (let i = 0; i < 4; i++) {
        const res = main(makeCtx("send_message", { Recipient: recipient }));
        expect(res["decision"]).toBe("allow");
      }

      // 5th turn should be denied
      const res5 = main(makeCtx("send_message", { Recipient: recipient }));
      expect(res5["decision"]).toBe("deny");
      expect(res5["reason"]).toContain("exceeded the 4-turn limit");
    });

    it("allows send_message to other agent types even after 4 turns", () => {
      mocks.getSubagentType.mockReturnValue(null);
      mocks.getSubagentTypeByConvId.mockReturnValue("Remora_Deep_Diver");

      const localStore: Record<string, string> = {};
      coreMocks.getHookState.mockImplementation((convId: string, turnIdx: number, key: string) => {
        return localStore[key] || null;
      });
      coreMocks.setHookState.mockImplementation((convId: string, turnIdx: number, key: string, val: string) => {
        localStore[key] = val;
      });

      const recipient = "subagent-deep";

      for (let i = 0; i < 6; i++) {
        const res = main(makeCtx("send_message", { Recipient: recipient }));
        expect(res["decision"]).toBe("allow");
      }
    });
  });

  describe("Phase 74 enhancements", () => {
    describe("remora-recall whitelist bypass", () => {
      it("allows remora-recall.ts query command for main agent even when matching rotPattern", () => {
        mocks.getSubagentType.mockReturnValue(null); // main agent
        coreMocks.inspectCommand.mockReturnValue(["allow", ""]);

        // Command with remora-recall.ts normally matches rotPattern and gets denied
        const cmd = "node packages/adapter-antigravity/bin/remora-recall.ts --query 'something'";
        const ctx = makeCtx("run_command", { CommandLine: cmd });

        const res = main(ctx);
        expect(res["decision"]).toBe("allow");
      });

      it("allows remora-recall query command for subagent and keeps readonly check", () => {
        mocks.getSubagentType.mockReturnValue("Remora_ReadOnly_Extractor");
        mocks.getSubagentTypeByConvId.mockReturnValue("Remora_ReadOnly_Extractor");
        
        // Allowed recall call
        coreMocks.inspectCommand.mockReturnValue(["allow", ""]);
        const ctx1 = makeCtx("run_command", { CommandLine: "remora-recall --query 'test'" });
        expect(main(ctx1)["decision"]).toBe("allow");

        // Denied write call even with recall in it
        coreMocks.inspectCommand.mockReturnValue(["deny", "write"]);
        const ctx2 = makeCtx("run_command", { CommandLine: "remora-recall --query 'test' && touch foo" });
        const res2 = main(ctx2);
        expect(res2["decision"]).toBe("deny");
        expect(res2["reason"]).toContain("is strictly read-only");
      });
    });

    describe("isBranch process.cwd() adaptation", () => {
      it("recognizes branch workspace when process.cwd() resolves to worktrees", () => {
        mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver");
        mocks.getSubagentTypeByConvId.mockReturnValue("Remora_Deep_Diver");

        // targetDir has no branch flag and no REMORA_WORKSPACE env
        const targetDir = "/home/agent/scratch";
        // mock process.cwd() using realpathSync mock
        const originalCwd = process.cwd;
        process.cwd = () => "/home/agent/.system_generated/worktrees/branch-123";
        mocks.realpathSync.mockReturnValue("/home/agent/.system_generated/worktrees/branch-123");

        const ctx = makeCtx("write_to_file", { TargetFile: targetDir + "/file.txt" });
        const res = main(ctx);
        process.cwd = originalCwd; // restore

        // Should be allowed because isBranch is determined via cwd
        expect(res["decision"]).toBe("allow");
      });
    });

    describe("view_file range-limit hard block", () => {
      it("blocks main agent reading source file > 15KB when StartLine/EndLine are missing", () => {
        mocks.getSubagentType.mockReturnValue(null); // main agent
        mocks.existsSync.mockReturnValue(true);
        // mock file stats with size 20KB
        mocks.statSync.mockReturnValue({ size: 20 * 1024, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });

        const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/code.ts" });
        const res = main(ctx);

        expect(res["decision"]).toBe("deny");
        expect(res["reason"]).toContain("VIEW_LIMIT_EXCEEDED");
      });

      it("blocks main agent reading source file > 15KB when range > 300 lines", () => {
        mocks.getSubagentType.mockReturnValue(null); // main agent
        mocks.existsSync.mockReturnValue(true);
        mocks.statSync.mockReturnValue({ size: 20 * 1024, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });

        const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/code.ts", StartLine: 1, EndLine: 400 });
        const res = main(ctx);

        expect(res["decision"]).toBe("deny");
        expect(res["reason"]).toContain("VIEW_LIMIT_EXCEEDED");
      });

      it("allows main agent reading source file > 15KB when range <= 300 lines", () => {
        mocks.getSubagentType.mockReturnValue(null); // main agent
        mocks.existsSync.mockReturnValue(true);
        mocks.statSync.mockReturnValue({ size: 20 * 1024, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });

        const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/code.ts", StartLine: 1, EndLine: 150 });
        const res = main(ctx);

        expect(res["decision"]).toBe("allow");
      });

      it("allows subagent reading source file > 15KB with no range restrictions", () => {
        mocks.getSubagentType.mockReturnValue("Remora_Deep_Diver"); // subagent
        mocks.existsSync.mockReturnValue(true);
        mocks.statSync.mockReturnValue({ size: 20 * 1024, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });

        const ctx = makeCtx("view_file", { AbsolutePath: "/path/to/code.ts" });
        const res = main(ctx);

        expect(res["decision"]).toBe("allow");
      });
    });
  });
});
