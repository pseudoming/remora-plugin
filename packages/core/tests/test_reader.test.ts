import { describe, it, expect } from "vitest";
import { filterUserAiRounds, MAX_CONTENT_CHARS } from "../src/reader";

/** Convert list to lazy iterable for testing. */
function* _generator<T>(items: T[]): Generator<T> {
  for (const item of items) {
    yield item;
  }
}

describe("TestFilterUserAiRounds", () => {
  it("test_empty_iterable", () => {
    const result = filterUserAiRounds([]);
    expect(result).toEqual([]);
  });

  it("test_no_matching_types", () => {
    const steps = [
      { type: "TOOL_USE", content: "ls" },
      { type: "TOOL_RESULT", content: "file" },
      { type: "SYSTEM_MESSAGE", content: "hello" },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result).toEqual([]);
  });

  it("test_empty_content_skipped", () => {
    const steps = [
      { type: "USER_INPUT", content: "" },
      { type: "USER_INPUT", content: "hello" },
      { type: "PLANNER_RESPONSE", content: "" },
      { type: "PLANNER_RESPONSE", content: "world" },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  it("test_role_mapping", () => {
    const steps = [
      { type: "USER_INPUT", content: "u" },
      { type: "PLANNER_RESPONSE", content: "a" },
      { type: "USER_INPUT", content: "u2" },
      { type: "PLANNER_RESPONSE", content: "a2" },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("test_content_truncation", () => {
    const longContent = "x".repeat(1500);
    const steps = [
      { type: "USER_INPUT", content: longContent },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("x".repeat(MAX_CONTENT_CHARS));
  });

  it("test_rounds_limit", () => {
    const steps = [
      { type: "USER_INPUT", content: "u1" },
      { type: "PLANNER_RESPONSE", content: "a1" },
      { type: "USER_INPUT", content: "u2" },
      { type: "PLANNER_RESPONSE", content: "a2" },
      { type: "USER_INPUT", content: "u3" },
      { type: "PLANNER_RESPONSE", content: "a3" },
    ];
    const result = filterUserAiRounds(_generator(steps), 2);
    expect(result.length).toBe(4);
    expect(result).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("test_exception_during_iteration", () => {
    function* brokenGen() {
      yield { type: "USER_INPUT", content: "first" };
      yield { type: "PLANNER_RESPONSE", content: "second" };
      throw new Error("boom");
    }

    const result = filterUserAiRounds(brokenGen());
    expect(result).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("test_role_field_does_not_override_type", () => {
    const steps = [
      { type: "USER_INPUT", content: "hi", role: "assistant" },
      { type: "PLANNER_RESPONSE", content: "hey", role: "user" },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ]);
  });

  it("test_no_content_key_defaults_to_empty", () => {
    const steps = [
      { type: "USER_INPUT" },
      { type: "USER_INPUT", content: "real" },
    ];
    const result = filterUserAiRounds(_generator(steps));
    expect(result).toEqual([
      { role: "user", content: "real" },
    ]);
  });
});
