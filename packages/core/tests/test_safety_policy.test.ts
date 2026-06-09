import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enforcePromptLengthLimit,
  enforceSandboxWorkspace,
  isRotSensitiveFile,
  isRotSensitivePath,
  estimateReadBytes,
  isAccumulatedLimitExceeded,
  isPlanningArtifact,
} from "../src/safety-policy";

describe("enforcePromptLengthLimit", () => {
  it("test_enforce_prompt_length_limit_under", () => {
    const result = enforcePromptLengthLimit("short prompt", 1500);
    expect(result).toEqual([false, null]);
  });

  it("test_enforce_prompt_length_limit_over", () => {
    const longPrompt = "x".repeat(2000);
    const [isOver, reason] = enforcePromptLengthLimit(longPrompt, 1500);
    expect(isOver).toBe(true);
    expect(reason!.prefix).toBe("PAYLOAD ENFORCEMENT");
    expect(reason!.message).toContain("2000");
  });
});

describe("enforceSandboxWorkspace", () => {
  it("test_enforce_sandbox_workspace_remora_branch", () => {
    const result = enforceSandboxWorkspace(
      "Remora_Deep_Diver",
      "branch",
      "Remora_Deep_Diver",
      ["branch", "share"]
    );
    expect(result).toEqual([false, null]);
  });

  it("test_enforce_sandbox_workspace_remora_share", () => {
    const result = enforceSandboxWorkspace(
      "Remora_Deep_Diver",
      "share",
      "Remora_Deep_Diver",
      ["branch", "share"]
    );
    expect(result).toEqual([false, null]);
  });

  it("test_enforce_sandbox_workspace_remora_main", () => {
    const [isViolation, reason] = enforceSandboxWorkspace(
      "Remora_Deep_Diver",
      "main",
      "Remora_Deep_Diver",
      ["branch", "share"]
    );
    expect(isViolation).toBe(true);
    expect(reason!.prefix).toBe("SANDBOX ENFORCEMENT");
  });

  it("test_enforce_sandbox_workspace_other_type", () => {
    const result = enforceSandboxWorkspace(
      "Some_Other_Type",
      "main",
      "Remora_Deep_Diver",
      ["branch", "share"]
    );
    expect(result).toEqual([false, null]);
  });

  it("test_enforce_sandbox_workspace_restricted_type_none", () => {
    const result = enforceSandboxWorkspace("Remora_Deep_Diver", "main");
    expect(result).toEqual([false, null]);
  });

  it("test_enforce_sandbox_workspace_valid_workspaces_none", () => {
    const result = enforceSandboxWorkspace(
      "Remora_Deep_Diver",
      "main",
      "Remora_Deep_Diver"
    );
    expect(result).toEqual([false, null]);
  });
});

describe("isRotSensitiveFile", () => {
  it("test_is_rot_sensitive_file_jsonl", () => {
    expect(isRotSensitiveFile("data/logs.jsonl")).toBe(true);
  });

  it("test_is_rot_sensitive_file_log", () => {
    expect(isRotSensitiveFile("server.log")).toBe(true);
  });

  it("test_is_rot_sensitive_file_sqlite", () => {
    expect(isRotSensitiveFile("mydb.sqlite")).toBe(true);
  });

  it("test_is_rot_sensitive_file_py", () => {
    expect(isRotSensitiveFile("src/main.py")).toBe(false);
  });
});

describe("isRotSensitivePath", () => {
  it("test_is_rot_sensitive_path_system_generated", () => {
    expect(isRotSensitivePath("/home/user/.system_generated/logs")).toBe(true);
  });

  it("test_is_rot_sensitive_path_logs", () => {
    expect(isRotSensitivePath("/var/logs/app")).toBe(true);
  });

  it("test_is_rot_sensitive_path_normal", () => {
    expect(isRotSensitivePath("/home/user/src")).toBe(false);
  });
});

describe("estimateReadBytes", () => {
  let tmpFileWithLines: string;
  let tmpFileSized: string;

  beforeAll(() => {
    tmpFileWithLines = join(tmpdir(), `test-estimate-read-bytes-lines-${Date.now()}.txt`);
    writeFileSync(tmpFileWithLines, "dummy content line\n");

    tmpFileSized = join(tmpdir(), `test-estimate-read-bytes-sized-${Date.now()}.dat`);
    const buf = Buffer.alloc(4096, "x");
    writeFileSync(tmpFileSized, buf);
  });

  afterAll(() => {
    try { unlinkSync(tmpFileWithLines); } catch {}
    try { unlinkSync(tmpFileSized); } catch {}
  });

  it("test_estimate_read_bytes_with_start_end", () => {
    const args = { StartLine: 10, EndLine: 110 };
    const result = estimateReadBytes(args, tmpFileWithLines);
    expect(result).toBe((110 - 10 + 1) * 50);
  });

  it("test_estimate_read_bytes_without_lines", () => {
    const result = estimateReadBytes({}, tmpFileSized);
    expect(result).toBe(4096);
  });

  it("test_estimate_read_bytes_file_not_exists", () => {
    const result = estimateReadBytes({}, "/tmp/nonexistent_y7kr2xm9.ts");
    expect(result).toBe(0);
  });
});

describe("isAccumulatedLimitExceeded", () => {
  it("test_is_accumulated_limit_exceeded_under", () => {
    const stats = {
      accumulated_source_bytes: 100 * 1024,
      accumulated_data_bytes: 50 * 1024,
    };
    expect(isAccumulatedLimitExceeded(stats)).toBe(false);
  });

  it("test_is_accumulated_limit_exceeded_source_over", () => {
    const stats = {
      accumulated_source_bytes: 500 * 1024,
      accumulated_data_bytes: 10 * 1024,
    };
    expect(isAccumulatedLimitExceeded(stats)).toBe(true);
  });

  it("test_is_accumulated_limit_exceeded_data_over", () => {
    const stats = {
      accumulated_source_bytes: 10 * 1024,
      accumulated_data_bytes: 200 * 1024,
    };
    expect(isAccumulatedLimitExceeded(stats)).toBe(true);
  });
});

describe("isPlanningArtifact", () => {
  const artifactSuffixes: readonly string[] = [
    "task.md",
    "implementation_plan.md",
    "walkthrough.md",
  ];

  it("test_is_planning_artifact_artifacts_path", () => {
    expect(
      isPlanningArtifact(
        "/project/artifacts/plan.md",
        "/artifacts/",
        artifactSuffixes
      )
    ).toBe(true);
  });

  it("test_is_planning_artifact_task_md", () => {
    expect(
      isPlanningArtifact("/project/task.md", "/artifacts/", artifactSuffixes)
    ).toBe(true);
  });

  it("test_is_planning_artifact_walkthrough_md", () => {
    expect(
      isPlanningArtifact("walkthrough.md", "/artifacts/", artifactSuffixes)
    ).toBe(true);
  });

  it("test_is_planning_artifact_implementation_plan", () => {
    expect(
      isPlanningArtifact(
        "/home/user/implementation_plan.md",
        "/artifacts/",
        artifactSuffixes
      )
    ).toBe(true);
  });

  it("test_is_planning_artifact_py", () => {
    expect(
      isPlanningArtifact("src/main.py", "/artifacts/", artifactSuffixes)
    ).toBe(false);
  });

  it("test_is_planning_artifact_both_none", () => {
    expect(isPlanningArtifact("task.md")).toBe(false);
  });
});
