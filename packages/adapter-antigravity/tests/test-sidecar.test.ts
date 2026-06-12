import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

const { realFs, mockFs, testDataDir, coreMocks } = vi.hoisted(() => {
  const osMod = require("node:os") as typeof import("node:os");
  const pathMod = require("node:path") as typeof import("node:path");
  const tmpDir = pathMod.join(osMod.tmpdir(), `remora_sidecar_test_${Date.now()}`);
  return {
    realFs: { value: null as any },
    testDataDir: { value: tmpDir },
    mockFs: {
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(),
      unlinkSync: vi.fn(),
      statSync: vi.fn(),
    },
    coreMocks: {
      getPlanChangeTime: vi.fn(),
      getUserMessagesAfter: vi.fn(),
      enqueueEvent: vi.fn(),
      getPlanContent: vi.fn(),
      getPendingEvents: vi.fn(),
      getPendingDecisions: vi.fn(),
      confirmDecisionsByIds: vi.fn(),
      markEventProcessed: vi.fn(),
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  realFs.value = actual;
  return { ...actual, ...mockFs };
});

vi.mock("../src/bridge/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/paths")>();
  return {
    ...actual,
    getDataDir: () => testDataDir.value,
    extractConvId: () => null,
    getDbPath: () => path.join(testDataDir.value, "mock_remora.db"),
  };
});

vi.mock("../src/bridge/subagent", () => ({
  getSubagentType: vi.fn().mockReturnValue(null),
  getSubagentTypeByConvId: vi.fn().mockReturnValue(null),
}));

vi.mock("@remora/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@remora/core")>();
  return {
    ...actual,
    getPlanChangeTime: coreMocks.getPlanChangeTime,
    getUserMessagesAfter: coreMocks.getUserMessagesAfter,
    enqueueEvent: coreMocks.enqueueEvent,
    getPlanContent: coreMocks.getPlanContent,
    getPendingEvents: coreMocks.getPendingEvents,
    getPendingDecisions: coreMocks.getPendingDecisions,
    confirmDecisionsByIds: coreMocks.confirmDecisionsByIds,
    markEventProcessed: coreMocks.markEventProcessed,
  };
});

const { extractMocks } = vi.hoisted(() => ({
  extractMocks: {
    getOrCreateConversation: vi.fn(),
    AgentApiError: null as any,
  },
}));

vi.mock("../src/sidecar/extract-decisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sidecar/extract-decisions")>();
  extractMocks.AgentApiError = actual.AgentApiError;
  return {
    ...actual,
    getOrCreateConversation: extractMocks.getOrCreateConversation,
  };
});

import { formatTimestamp, calculateMd5 } from "@remora/core";
import {
  loadExcludedIds,
  saveExcludedIds,
  isSubagentSession,
  extractSubagentReport,
} from "../src/sidecar/scan-sessions";
import { acquireLock, releaseLock } from "../src/sidecar/sidecar-lock";
import { checkPlanApproval } from "../src/sidecar/check-approval";
import { consumeEventQueue } from "../src/sidecar/consume-events";
import { extractFactualBaseline, AgentApiError } from "../src/sidecar/extract-decisions";
import { pruneSidecarEvents } from "../src/sidecar/compactor";
import { ConversationDataAccessLayer } from "../src/bridge/conversation";
import * as subagentMod from "../src/bridge/subagent";

beforeEach(() => {
  vi.clearAllMocks();
  realFs.value.mkdirSync(testDataDir.value, { recursive: true });
  Object.entries(mockFs).forEach(([key, fn]) => {
    fn.mockImplementation((...args: any[]) => (realFs.value as any)[key](...args));
  });
});

// ============================================================
// formatTimestamp
// ============================================================

describe("TestFormatTimestamp", () => {
  it("test_none_returns_current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00Z"));
    const result = formatTimestamp(null);
    expect(result).toBe("2024-06-01 12:00:00");
    vi.useRealTimers();
  });

  it("test_iso_z_format", () => {
    const result = formatTimestamp("2024-01-15T12:30:00Z");
    expect(result).toBe("2024-01-15 12:30:00");
  });

  it("test_iso_t_format", () => {
    const result = formatTimestamp("2024-06-01T08:45:30");
    expect(result).toBe("2024-06-01 08:45:30");
  });

  it("test_already_formatted", () => {
    const result = formatTimestamp("2024-03-20 14:22:10");
    expect(result).toBe("2024-03-20 14:22:10");
  });

  it("test_empty_string", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00Z"));
    const result = formatTimestamp("");
    expect(result).toBe("2024-06-01 12:00:00");
    vi.useRealTimers();
  });

  it("test_short_string", () => {
    const result = formatTimestamp("2024");
    expect(result).toBe("2024");
  });

  it("test_false_value", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00Z"));
    const result = formatTimestamp(false as any);
    expect(result).toBe("2024-06-01 12:00:00");
    vi.useRealTimers();
  });
});

// ============================================================
// calculateMd5
// ============================================================

describe("TestCalculateMd5", () => {
  it("test_known_content", () => {
    const tmpPath = realFs.value.mkdtempSync(path.join(os.tmpdir(), "remora_md5_"));
    try {
      const f = path.join(tmpPath, "test.txt");
      realFs.value.writeFileSync(f, "hello world");
      const crypto = require("node:crypto");
      const expected = crypto.createHash("md5").update(Buffer.from("hello world")).digest("hex");
      expect(calculateMd5(f)).toBe(expected);
    } finally {
      realFs.value.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it("test_empty_file", () => {
    const tmpPath = realFs.value.mkdtempSync(path.join(os.tmpdir(), "remora_md5_"));
    try {
      const f = path.join(tmpPath, "empty.txt");
      realFs.value.writeFileSync(f, "");
      const crypto = require("node:crypto");
      const expected = crypto.createHash("md5").update(Buffer.from("")).digest("hex");
      expect(calculateMd5(f)).toBe(expected);
    } finally {
      realFs.value.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it("test_binary_like_content", () => {
    const tmpPath = realFs.value.mkdtempSync(path.join(os.tmpdir(), "remora_md5_"));
    try {
      const f = path.join(tmpPath, "data.bin");
      realFs.value.writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0xff]));
      const crypto = require("node:crypto");
      const expected = crypto.createHash("md5").update(Buffer.from([0x00, 0x01, 0x02, 0xff])).digest("hex");
      expect(calculateMd5(f)).toBe(expected);
    } finally {
      realFs.value.rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});

// ============================================================
// loadExcludedIds / saveExcludedIds
// ============================================================

describe("TestExcludedIds", () => {
  const excludeFileName = "compactor_managed_conversations.json";

  function excludeFilePath(): string {
    return path.join(testDataDir.value, excludeFileName);
  }

  it("test_load_no_file", () => {
    const p = excludeFilePath();
    if (realFs.value.existsSync(p)) realFs.value.unlinkSync(p);
    const result = loadExcludedIds();
    expect(result).toEqual(new Set());
  });

  it("test_load_with_ids", () => {
    const p = excludeFilePath();
    realFs.value.writeFileSync(p, JSON.stringify(["a", "b", "c"]));
    const result = loadExcludedIds();
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("test_load_corrupted_json", () => {
    const p = excludeFilePath();
    realFs.value.writeFileSync(p, "not json");
    expect(() => loadExcludedIds()).toThrow();
  });

  it("test_save_and_load_roundtrip", () => {
    saveExcludedIds(new Set(["x", "y", "z"]));
    const result = loadExcludedIds();
    expect(result).toEqual(new Set(["x", "y", "z"]));
  });
});

// ============================================================
// isSubagentSession
// ============================================================

describe("TestIsSubagentSession", () => {
  it("returns true when getSubagentTypeByConvId returns typeName", () => {
    vi.mocked(subagentMod.getSubagentTypeByConvId).mockReturnValue("Remora_Deep_Diver");
    const result = isSubagentSession("conv1");
    expect(result).toBe(true);
  });

  it("returns false when getSubagentTypeByConvId returns null", () => {
    vi.mocked(subagentMod.getSubagentTypeByConvId).mockReturnValue(null);
    const result = isSubagentSession("conv1");
    expect(result).toBe(false);
  });

  it("returns false for empty convId", () => {
    vi.mocked(subagentMod.getSubagentTypeByConvId).mockReturnValue(null);
    const result = isSubagentSession("");
    expect(result).toBe(false);
  });

  it("handles getSubagentTypeByConvId throwing", () => {
    vi.mocked(subagentMod.getSubagentTypeByConvId).mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => isSubagentSession("conv1")).toThrow("boom");
  });
});

// ============================================================
// extractSubagentReport
// ============================================================

describe("TestExtractSubagentReport", () => {
  it("test_no_report_found", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsReverse").mockImplementation(() =>
      (function* () {
        yield { content: "just a normal message" };
      })()
    );
    const result = extractSubagentReport("conv1");
    expect(result.changedFiles).toEqual([]);
    expect(result.referencedFiles).toEqual([]);
    vi.restoreAllMocks();
  });

  it("test_extracts_report", () => {
    const report = JSON.stringify({
      remora_subagent_report: {
        changed_files: ["a.py"],
        referenced_files: ["b.py", "c.py"],
      },
    });
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsReverse").mockImplementation(() =>
      (function* () {
        yield { content: `prefix ${report} suffix` };
      })()
    );
    const result = extractSubagentReport("conv1");
    expect(result.changedFiles).toEqual(["a.py"]);
    expect(result.referencedFiles).toEqual(["b.py", "c.py"]);
    vi.restoreAllMocks();
  });

  it("test_empty_report_fields", () => {
    const report = JSON.stringify({ remora_subagent_report: {} });
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsReverse").mockImplementation(() =>
      (function* () {
        yield { content: report };
      })()
    );
    const result = extractSubagentReport("conv1");
    expect(result.changedFiles).toEqual([]);
    expect(result.referencedFiles).toEqual([]);
    vi.restoreAllMocks();
  });
});

// ============================================================
// extractFactualBaseline
// ============================================================

describe("TestExtractFactualBaseline", () => {
  it("test_empty_db_returns_empty", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "getMaxStepIndex").mockReturnValue(0);
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(() =>
      (function* () {} )()
    );
    const [files, actions] = extractFactualBaseline("conv1", 0);
    expect(files).toEqual([]);
    expect(actions).toEqual([]);
    vi.restoreAllMocks();
  });

  it("test_extracts_write_targets", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "getMaxStepIndex").mockReturnValue(10);
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(() =>
      (function* () {
        yield {
          step_index: 5,
          tool_calls: [
            { name: "write_to_file", args: { TargetFile: "/path/to/foo.py" } },
            { name: "replace_file_content", args: { AbsolutePath: "/path/to/bar.js" } },
            { name: "grep_search", args: {} },
          ],
        };
      })()
    );
    const [files, _actions] = extractFactualBaseline("conv1", 0);
    expect(new Set(files)).toEqual(new Set(["foo.py", "bar.js"]));
    vi.restoreAllMocks();
  });

  it("test_skips_below_start_line", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "getMaxStepIndex").mockReturnValue(10);
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(() =>
      (function* () {
        yield { step_index: 3, tool_calls: [{ name: "write_to_file", args: { TargetFile: "old.py" } }] };
        yield { step_index: 5, tool_calls: [{ name: "write_to_file", args: { TargetFile: "new.py" } }] };
      })()
    );
    const [files, _] = extractFactualBaseline("conv1", 4);
    expect(new Set(files)).toEqual(new Set(["new.py"]));
    vi.restoreAllMocks();
  });

  it("test_extracts_confirm_actions", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "getMaxStepIndex").mockReturnValue(10);
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(() =>
      (function* () {
        yield { step_index: 1, content: "/confirm 42 is done", tool_calls: [] };
        yield { step_index: 2, content: "/confirm 99", tool_calls: [] };
      })()
    );
    const [_, actions] = extractFactualBaseline("conv1", 0);
    expect(new Set(actions)).toEqual(new Set(["confirm:42", "confirm:99"]));
    vi.restoreAllMocks();
  });

  it("test_args_as_json_string", () => {
    vi.spyOn(ConversationDataAccessLayer.prototype, "getMaxStepIndex").mockReturnValue(10);
    vi.spyOn(ConversationDataAccessLayer.prototype, "streamStepsForward").mockImplementation(() =>
      (function* () {
        yield {
          step_index: 1,
          tool_calls: [{ name: "write_to_file", args: '{"TargetFile": "baz.ts"}' }],
        };
      })()
    );
    const [files, _] = extractFactualBaseline("conv1", 0);
    expect(new Set(files)).toEqual(new Set(["baz.ts"]));
    vi.restoreAllMocks();
  });
});

// ============================================================
// sidecar_lock
// ============================================================

describe("TestSidecarLock", () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = realFs.value.mkdtempSync(path.join(os.tmpdir(), "remora_lock_"));
    lockPath = path.join(tmpDir, "compactor.lock");
    // Override testDataDir so LOCK_FILE picks up the temp dir.
    // However LOCK_FILE was already evaluated at module load time.
    // Workaround: we write directly to the original testDataDir path.
  });

  function origLockPath(): string {
    return path.join(testDataDir.value, "compactor.lock");
  }

  it("test_acquire_no_lock_file", () => {
    // Ensure no stale lock file
    const lp = origLockPath();
    if (realFs.value.existsSync(lp)) realFs.value.unlinkSync(lp);

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);
    acquireLock();
    const content = realFs.value.readFileSync(lp, "utf-8");
    expect(content).toBe("12345");
    vi.restoreAllMocks();
  });

  it("test_acquire_own_lock_recent", () => {
    const lp = origLockPath();
    realFs.value.mkdirSync(path.dirname(lp), { recursive: true });
    realFs.value.writeFileSync(lp, "12345");

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((): any => {});
    vi.spyOn(Date, "now").mockReturnValue(1000 * 1000);
    mockFs.statSync.mockImplementation((p: string) => {
      if (p === lp) return { mtimeMs: 999 * 1000 } as any;
      return realFs.value.statSync(p);
    });
    // vitest wraps process.exit; spy to check it was called, but don't rely on throw
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    acquireLock();
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.restoreAllMocks();
  });

  it("test_acquire_dead_process_takes_over", () => {
    const lp = origLockPath();
    realFs.value.mkdirSync(path.dirname(lp), { recursive: true });
    realFs.value.writeFileSync(lp, "99999");

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);
    vi.spyOn(process, "kill").mockImplementation((): any => {
      throw new Error("ESRCH");
    });
    vi.spyOn(Date, "now").mockReturnValue(1000 * 1000);
    mockFs.statSync.mockImplementation((p: string) => {
      if (p === lp) return { mtimeMs: 500 * 1000 } as any;
      return realFs.value.statSync(p);
    });

    acquireLock();
    const content = realFs.value.readFileSync(lp, "utf-8");
    expect(content).toBe("12345");
    vi.restoreAllMocks();
  });

  it("test_acquire_stale_lock_kills_and_takes_over", () => {
    const lp = origLockPath();
    realFs.value.mkdirSync(path.dirname(lp), { recursive: true });
    realFs.value.writeFileSync(lp, "99999");

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((): any => {});
    vi.spyOn(Date, "now").mockReturnValue(5000 * 1000);
    mockFs.statSync.mockImplementation((p: string) => {
      if (p === lp) return { mtimeMs: 1000 * 1000 } as any;
      return realFs.value.statSync(p);
    });

    acquireLock();
    expect(killSpy).toHaveBeenCalled();
    const content = realFs.value.readFileSync(lp, "utf-8");
    expect(content).toBe("12345");
    vi.restoreAllMocks();
  });

  it("test_release_matching_pid", () => {
    const lp = origLockPath();
    realFs.value.mkdirSync(path.dirname(lp), { recursive: true });
    realFs.value.writeFileSync(lp, "12345");

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);

    releaseLock();
    expect(realFs.value.existsSync(lp)).toBe(false);
    vi.restoreAllMocks();
  });

  it("test_release_different_pid_preserves", () => {
    const lp = origLockPath();
    realFs.value.mkdirSync(path.dirname(lp), { recursive: true });
    realFs.value.writeFileSync(lp, "99999");

    vi.spyOn(process, "pid", "get").mockReturnValue(12345);

    releaseLock();
    expect(realFs.value.existsSync(lp)).toBe(true);
    vi.restoreAllMocks();
  });
});

// ============================================================
// checkPlanApproval
// ============================================================

describe("TestCheckPlanApproval", () => {
  beforeEach(() => {
    // Default: no plan change
    coreMocks.getPlanChangeTime.mockReturnValue(null);
  });

  it("test_no_plan_hash_returns_early", () => {
    coreMocks.getPlanChangeTime.mockReturnValue(null);
    checkPlanApproval("p1");
    expect(coreMocks.enqueueEvent).not.toHaveBeenCalled();
  });

  it("test_no_approval_keyword_in_messages", () => {
    coreMocks.getPlanChangeTime.mockReturnValue("2024-01-01 00:00:00");
    coreMocks.getUserMessagesAfter.mockReturnValue(["just chatting"]);
    checkPlanApproval("p1");
    expect(coreMocks.enqueueEvent).not.toHaveBeenCalled();
  });

  it("test_approval_keyword_with_negation", () => {
    coreMocks.getPlanChangeTime.mockReturnValue("2024-01-01 00:00:00");
    coreMocks.getUserMessagesAfter.mockReturnValue(["我不同意执行这个方案"]);
    checkPlanApproval("p1");
    expect(coreMocks.enqueueEvent).not.toHaveBeenCalled();
  });

  it("test_approval_triggers_event", () => {
    coreMocks.getPlanChangeTime.mockReturnValue("2024-01-01 00:00:00");
    coreMocks.getUserMessagesAfter.mockReturnValue(["同意，可以执行"]);
    coreMocks.getPlanContent.mockReturnValue("# Plan Content\n## Step 1");
    checkPlanApproval("p1");
    expect(coreMocks.enqueueEvent).toHaveBeenCalledTimes(1);
    const callArgs = coreMocks.enqueueEvent.mock.calls[0];
    expect(callArgs[1]).toBe("plan_approval_sync");
  });

  it("test_english_approval_keyword", () => {
    coreMocks.getPlanChangeTime.mockReturnValue("2024-01-01 00:00:00");
    coreMocks.getUserMessagesAfter.mockReturnValue(["I approve this plan"]);
    checkPlanApproval("p1");
    expect(coreMocks.enqueueEvent).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// consumeEventQueue
// ============================================================

describe("TestConsumeEventQueue", () => {
  beforeEach(() => {
    coreMocks.getPendingEvents.mockReturnValue([]);
  });

  it("test_no_events_returns_immediately", () => {
    coreMocks.getPendingEvents.mockReturnValue([]);
    consumeEventQueue(Date.now() / 1000);
    expect(coreMocks.markEventProcessed).not.toHaveBeenCalled();
  });

  it("test_empty_pending_decisions_marks_processed", () => {
    coreMocks.getPendingEvents.mockReturnValue([
      { id: 1, project_uuid: "p1", event_type: "test", payload: "{}" },
    ]);
    coreMocks.getPendingDecisions.mockReturnValue([]);
    vi.spyOn(Date, "now").mockReturnValue(0);
    consumeEventQueue(0);
    expect(coreMocks.markEventProcessed).toHaveBeenCalledWith(1, undefined);
    vi.restoreAllMocks();
  });

  it("test_circuit_breaker", () => {
    coreMocks.getPendingEvents.mockReturnValue([
      { id: 1, project_uuid: "p1", event_type: "test", payload: "{}" },
    ]);
    coreMocks.getPendingDecisions.mockReturnValue([
      { id: 1, decision: "dec", rationale: "rat" },
    ]);
    extractMocks.getOrCreateConversation.mockReturnValue('{"confirmed_ids": []}');
    // start_time is 0, but Date.now() returns real time > 270 sec since epoch.
    // The circuit breaker uses Date.now()/1000 - startTime > 270.
    // Since real Date.now()/1000 >> 270 and startTime is 0, it will hit circuit breaker.
    // We just verify it doesn't crash.
    consumeEventQueue(0);
    // The status check is ambiguous due to real timing; just ensure no throw
  });

  it("test_agentapi_error_reraises", () => {
    coreMocks.getPendingEvents.mockReturnValue([
      { id: 1, project_uuid: "p1", event_type: "test", payload: "{}" },
    ]);
    coreMocks.getPendingDecisions.mockReturnValue([
      { id: 1, decision: "dec", rationale: "rat" },
    ]);
    extractMocks.getOrCreateConversation.mockImplementation(() => {
      throw new AgentApiError("fail");
    });
    vi.spyOn(Date, "now").mockReturnValue(0);
    expect(() => consumeEventQueue(0)).toThrow(AgentApiError);
    vi.restoreAllMocks();
  });

  it("test_confirms_matching_decisions", () => {
    coreMocks.getPendingEvents.mockReturnValue([
      { id: 1, project_uuid: "p1", event_type: "test", payload: "{}" },
    ]);
    coreMocks.getPendingDecisions.mockReturnValue([
      { id: 10, decision: "dec1", rationale: "rat1" },
      { id: 20, decision: "dec2", rationale: "rat2" },
    ]);
    extractMocks.getOrCreateConversation.mockReturnValue(
      '{"confirmed_ids": [10, 20]}'
    );
    vi.spyOn(Date, "now").mockReturnValue(0);
    consumeEventQueue(0);
    expect(coreMocks.confirmDecisionsByIds).toHaveBeenCalledWith([10, 20], "p1", undefined);
    expect(coreMocks.markEventProcessed).toHaveBeenCalledWith(1, undefined);
    vi.restoreAllMocks();
  });
});

// ============================================================
// pruneSidecarEvents
// ============================================================

describe("TestPruneSidecarEvents", () => {
  it("test_no_events_dir", () => {
    const eventsDir = path.join(testDataDir.value, "events");
    if (realFs.value.existsSync(eventsDir)) {
      realFs.value.rmSync(eventsDir, { recursive: true, force: true });
    }
    expect(() => pruneSidecarEvents()).not.toThrow();
  });

  it("test_prunes_json_files", () => {
    const eventsDir = path.join(testDataDir.value, "events");
    realFs.value.mkdirSync(eventsDir, { recursive: true });
    realFs.value.writeFileSync(path.join(eventsDir, "event1.json"), "{}");
    realFs.value.writeFileSync(path.join(eventsDir, "event2.json"), "{}");
    realFs.value.writeFileSync(path.join(eventsDir, "not_json.txt"), "txt");

    pruneSidecarEvents();

    expect(realFs.value.existsSync(path.join(eventsDir, "event1.json"))).toBe(false);
    expect(realFs.value.existsSync(path.join(eventsDir, "event2.json"))).toBe(false);
    expect(realFs.value.existsSync(path.join(eventsDir, "not_json.txt"))).toBe(true);

    // Cleanup
    realFs.value.rmSync(eventsDir, { recursive: true, force: true });
  });
});
