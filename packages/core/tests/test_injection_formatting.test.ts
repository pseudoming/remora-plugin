import { describe, it, expect } from "vitest";
import {
  formatRelaxDisciplinePrompt,
  formatDecisionsForSessionResume,
  formatConflictInjectionMessage,
  formatFileDecisionsInjection,
  formatWriteGateDenyPrompt,
  formatPhantomFirstWarning,
  formatPhantomRepeatWarning,
  formatStrictRecallReminder,
  formatStrictTonePrompt,
  formatAlertRecallPrompt,
  formatHeartbeatTimerInjection,
  formatCumulativeReadWarning,
  makeDenyReason,
} from "../src/injection-formatting";

describe("injection-formatting", () => {
  it("test_format_relax_discipline_prompt", () => {
    const result = formatRelaxDisciplinePrompt("/artifacts/", [
      "write_to_file",
      "replace_file_content",
      "run_command",
    ]);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("<system-discipline>");
    expect(result).toContain("write_to_file");
    expect(result).toContain("run_command");
    expect(result).toContain("/artifacts/");
  });

  it("test_format_relax_discipline_prompt_generic", () => {
    const result = formatRelaxDisciplinePrompt();
    expect(typeof result).toBe("string");
    expect(result).toContain("DO NOT INVOKE ANY TOOLS THAT CHANGE CORE CODE FILES.");
    expect(result).toContain("YOU MAY FREELY EDIT PLANNING ARTIFACTS.");
    expect(result).not.toContain("/artifacts/");
    expect(result).not.toContain("write_to_file");
  });

  it("test_format_decisions_for_session_resume", () => {
    const decisions = [
      {
        created_at: "2025-01-15T10:30:00Z",
        user_confirmed: true,
        decision: "Use SQLite for all state storage",
        rationale: "Better persistence and queryability vs JSONL",
        decision_type: "architecture",
      },
      {
        created_at: "2025-01-16T14:00:00Z",
        user_confirmed: false,
        decision: "Add retry logic to network calls",
        decision_type: "implementation",
      },
    ];
    const topicId = "topic-abc-123";
    const result = formatDecisionsForSessionResume(decisions, topicId);
    expect(typeof result).toBe("string");
    expect(result).toContain("topic-abc-123");
    expect(result).toContain("Use SQLite");
    expect(result).toContain("已确认");
  });

  it("test_format_conflict_injection_message_not_repeat", () => {
    const d = {
      decision_type: "architecture",
      created_at: "2025-03-01T12:00:00Z",
      decision: "All modules must use async IO",
    };
    const c = { reason: "User now wants synchronous calls for simplicity" };
    const result = formatConflictInjectionMessage(d, c, false);
    expect(typeof result).toBe("string");
    expect(result).toContain("SEMANTIC CONFLICT DETECTED");
    expect(result).not.toContain("REPEAT CONFLICT");
  });

  it("test_format_conflict_injection_message_repeat", () => {
    const d = {
      decision_type: "architecture",
      created_at: "2025-03-01T12:00:00Z",
      decision: "All modules must use async IO",
    };
    const c = { reason: "Same conflict detected again" };
    const result = formatConflictInjectionMessage(d, c, true);
    expect(typeof result).toBe("string");
    expect(result).toContain("REPEAT CONFLICT");
    expect(result).not.toContain("SEMANTIC CONFLICT DETECTED");
  });

  it("test_format_file_decisions_injection", () => {
    const decisions = [
      { decision: "Never use raw SQL outside DAO layer", decision_type: "" },
      { decision: "All imports must go through lib/dao.py", decision_type: "" },
      { decision: "Tests must mock external dependencies", decision_type: "" },
      { decision: "Fourth decision gets truncated in display", decision_type: "" },
    ];
    const result = formatFileDecisionsInjection("src/dao.py", decisions);
    expect(typeof result).toBe("string");
    expect(result).toContain("src/dao.py");
    expect(result).toContain("4 条");
  });

  it("test_format_write_gate_deny_prompt", () => {
    const result = formatWriteGateDenyPrompt("src/main.py");
    expect(typeof result).toBe("string");
    expect(result).toContain("src/main.py");
    expect(result).toContain("GLOBAL-WRITE-GATE");
  });

  it("test_format_phantom_first_warning", () => {
    const phantomFiles = ["src/module_a.py", "src/module_b.py"];
    const result = formatPhantomFirstWarning(phantomFiles, [
      "write_to_file",
      "replace_file_content",
    ]);
    expect(typeof result).toBe("string");
    expect(result).toContain("module_a.py");
    expect(result).toContain("module_b.py");
    expect(result).toContain("write_to_file");
    expect(result).toContain("replace_file_content");
  });

  it("test_format_phantom_first_warning_generic", () => {
    const phantomFiles = ["src/module_a.py"];
    const result = formatPhantomFirstWarning(phantomFiles);
    expect(typeof result).toBe("string");
    expect(result).toContain("module_a.py");
    expect(result).not.toContain("write_to_file");
    expect(result).not.toContain("replace_file_content");
    expect(result).toContain("file editing tools instead");
  });

  it("test_format_phantom_repeat_warning", () => {
    const phantomFiles = ["test.py"];
    const result = formatPhantomRepeatWarning(phantomFiles);
    expect(typeof result).toBe("string");
    expect(result).toContain("底层检测模块发现了异常");
  });

  it("test_format_strict_recall_reminder", () => {
    const result = formatStrictRecallReminder("remora-recall.py");
    expect(typeof result).toBe("string");
    expect(result).toContain("cross-check");
    expect(result).toContain("remora-recall.py");
  });

  it("test_format_strict_recall_reminder_generic", () => {
    const result = formatStrictRecallReminder();
    expect(typeof result).toBe("string");
    expect(result).toContain("cross-check with the recall tool");
    expect(result).not.toContain("remora-recall.py");
  });

  it("test_format_strict_tone_prompt", () => {
    const result = formatStrictTonePrompt();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("STRICT TONE");
  });

  it("test_make_deny_reason_with_action_tip", () => {
    const result = makeDenyReason(
      "PREFIX",
      "Something went wrong",
      "Please retry with correct args",
    );
    expect(result).toContain("PREFIX");
    expect(result).toContain("Something went wrong");
    expect(result).toContain("ACTION REQUIRED: Please retry with correct args");
  });

  it("test_make_deny_reason_without_action_tip", () => {
    const result = makeDenyReason("PREFIX", "Something went wrong");
    expect(result).toContain("PREFIX");
    expect(result).toContain("Something went wrong");
    expect(result).not.toContain("ACTION REQUIRED:");
  });

  it("test_format_alert_recall_prompt", () => {
    const result = formatAlertRecallPrompt("frustrated", 'python3 scripts/adapter/cli/remora-recall.py "frustrated"');
    expect(typeof result).toBe("string");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("MEMORY DEFENSE TRIGGERED");
    expect(result).toContain("frustrated");
    expect(result).toContain("remora-recall.py");
    expect(result).toContain("STOP GUESSING");
    expect(result).toContain("</system-reminder>");
  });

  it("test_format_heartbeat_timer_injection", () => {
    const result = formatHeartbeatTimerInjection(
      "Remora_ReadOnly_Extractor",
      "abc-123-uuid",
      "python3",
      "/home/agent/.gemini/config/plugins/remora-plugin",
      "conv-456"
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("Remora_ReadOnly_Extractor");
    expect(result).toContain("abc-123-uuid");
    expect(result).toContain("python3");
    expect(result).toContain("subagent-monitor.py");
    expect(result).toContain("conv-456");
    expect(result).toContain("heartbeat timer");
    expect(result).toContain("</system-reminder>");
  });

  it("test_format_cumulative_read_warning", () => {
    const result = formatCumulativeReadWarning(200, 75);
    expect(typeof result).toBe("string");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("SOURCE: 200KB");
    expect(result).toContain("DATA: 75KB");
    expect(result).toContain("CUMULATIVE READ REACHED SOFT LIMIT");
    expect(result).toContain("Remora_ReadOnly_Extractor");
    expect(result).toContain("DurationSeconds=30");
    expect(result).toContain("</system-reminder>");
  });

  it("test_format_cumulative_read_warning_zero", () => {
    const result = formatCumulativeReadWarning(0, 0);
    expect(result).toContain("SOURCE: 0KB");
    expect(result).toContain("DATA: 0KB");
  });
});
