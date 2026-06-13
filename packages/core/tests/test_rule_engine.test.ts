import { describe, it, expect } from "vitest";
import { RuleEngine } from "../src/rules/engine";
import { Rule, Fact } from "../src/rules/types";

describe("RuleEngine", () => {
  const engine = new RuleEngine();

  it("evaluates empty rules to ALLOW", () => {
    const fact: Fact = { toolName: "view_file" };
    const result = engine.evaluate(fact, []);
    expect(result.status).toBe("ALLOW");
  });

  it("handles eq operator match", () => {
    const rules: Rule[] = [
      {
        id: "r1",
        priority: 10,
        hookType: "PreToolUse",
        conditions: [{ fact: "toolName", op: "eq", value: "run_command" }],
        action: { type: "deny", reasonCode: "BLOCKED" }
      }
    ];

    const factMatch: Fact = { toolName: "run_command" };
    const factNoMatch: Fact = { toolName: "view_file" };

    expect(engine.evaluate(factMatch, rules).status).toBe("DENY");
    expect(engine.evaluate(factNoMatch, rules).status).toBe("ALLOW");
  });

  it("handles neq operator match", () => {
    const rules: Rule[] = [
      {
        id: "r1_neq",
        priority: 10,
        hookType: "PreToolUse",
        conditions: [{ fact: "toolName", op: "neq", value: "view_file" }],
        action: { type: "deny", reasonCode: "BLOCKED" }
      }
    ];

    expect(engine.evaluate({ toolName: "run_command" }, rules).status).toBe("DENY");
    expect(engine.evaluate({ toolName: "view_file" }, rules).status).toBe("ALLOW");
  });

  it("handles contains operator match", () => {
    const rules: Rule[] = [
      {
        id: "r2",
        priority: 10,
        hookType: "PreToolUse",
        conditions: [{ fact: "commandLine", op: "contains", value: "rm -rf" }],
        action: { type: "deny", reasonCode: "DANGEROUS" }
      }
    ];

    expect(engine.evaluate({ commandLine: "sudo rm -rf /" }, rules).status).toBe("DENY");
    expect(engine.evaluate({ commandLine: "echo hello" }, rules).status).toBe("ALLOW");
  });

  it("handles regex operator match", () => {
    const rules: Rule[] = [
      {
        id: "r3",
        priority: 10,
        hookType: "PreToolUse",
        conditions: [{ fact: "path", op: "regex", value: "\\.sqlite$" }],
        action: { type: "deny", reasonCode: "SQLITE" }
      }
    ];

    expect(engine.evaluate({ path: "/brain/conv1/db.sqlite" }, rules).status).toBe("DENY");
    expect(engine.evaluate({ path: "/brain/conv1/db.json" }, rules).status).toBe("ALLOW");
  });

  it("handles gt and lt operator match", () => {
    const rules: Rule[] = [
      {
        id: "r_gt",
        priority: 10,
        hookType: "PreToolUse",
        conditions: [{ fact: "size", op: "gt", value: 100 }],
        action: { type: "deny", reasonCode: "TOO_LARGE" }
      },
      {
        id: "r_lt",
        priority: 5,
        hookType: "PreToolUse",
        conditions: [{ fact: "size", op: "lt", value: 10 }],
        action: { type: "deny", reasonCode: "TOO_SMALL" }
      }
    ];

    expect(engine.evaluate({ size: 150 }, rules).reasonCode).toBe("TOO_LARGE");
    expect(engine.evaluate({ size: 5 }, rules).reasonCode).toBe("TOO_SMALL");
    expect(engine.evaluate({ size: 50 }, rules).status).toBe("ALLOW");
  });

  it("evaluates rules based on priority", () => {
    const rules: Rule[] = [
      {
        id: "r_low",
        priority: 1,
        hookType: "PreToolUse",
        conditions: [{ fact: "val", op: "gt", value: 5 }],
        action: { type: "deny", reasonCode: "LOW" }
      },
      {
        id: "r_high",
        priority: 100,
        hookType: "PreToolUse",
        conditions: [{ fact: "val", op: "gt", value: 10 }],
        action: { type: "deny", reasonCode: "HIGH" }
      }
    ];

    expect(engine.evaluate({ val: 15 }, rules).reasonCode).toBe("HIGH");
  });
});
