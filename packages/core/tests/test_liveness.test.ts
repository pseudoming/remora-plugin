import { describe, it, expect } from "vitest";
import {
  RELAX_PATTERN,
  cleanSystemReminders,
  detectMode,
  parseSqliteTimestamp,
  findAllUuids,
  judgeZombie,
  suggestZombieAction,
  formatTimestamp,
  isTimerCanceled,
} from "../src/liveness";


it("cleanSystemReminders no tags", () => {
  expect(cleanSystemReminders("hello world")).toBe("hello world");
});

it("cleanSystemReminders with tags", () => {
  expect(cleanSystemReminders("hello <system-reminder>foo</system-reminder> world")).toBe("hello  world");
});

it("cleanSystemReminders multiple tags", () => {
  expect(cleanSystemReminders(
    "<system-reminder>a</system-reminder> b <system-reminder>c</system-reminder>"
  )).toBe(" b ");
});

it("cleanSystemReminders nested tags", () => {
  const text = "start <system-reminder>outer<system-reminder>inner</system-reminder></system-reminder> end";
  const result = cleanSystemReminders(text);
  expect(result).toBe("start </system-reminder> end");
});

it("cleanSystemReminders multiline", () => {
  const text = "before\n<system-reminder>\nmultiline\ncontent\n</system-reminder>\nafter";
  const result = cleanSystemReminders(text);
  expect(result).toBe("before\n\nafter");
});

it("detectMode strict default", () => {
  expect(detectMode("run this command")).toEqual(["strict", null]);
  expect(detectMode("")).toEqual(["strict", null]);
});

it("detectMode relax keywords trigger", () => {
  expect(detectMode("这是一个草稿")).toEqual(["relax", null]);
  expect(detectMode("some brainstorm ideas")).toEqual(["relax", null]);
  expect(detectMode("讨论这个方案")).toEqual(["relax", null]);
  expect(detectMode("let's brainstorm this")).toEqual(["relax", null]);
});

it("detectMode alert keyword override", () => {
  const alert = ["delete", "rm"];
  expect(detectMode("delete this 草稿", [], alert)).toEqual(["alert", "delete"]);
  expect(detectMode("this is a draft", undefined, ["delete"])).toEqual(["relax", null]);
});

it("detectMode both keyword sets", () => {
  const alert = ["delete"];
  expect(detectMode("delete everything", undefined, alert)).toEqual(["alert", "delete"]);
});

it("detectMode default params", () => {
  expect(detectMode("draft idea")).toEqual(["relax", null]);
  expect(detectMode("run test")).toEqual(["strict", null]);
});

describe("TestDetectMode", () => {
  it("alert keyword returns alert with word", () => {
    expect(detectMode("你清醒一点", undefined, ["你清醒一点"])).toEqual(["alert", "你清醒一点"]);
  });

  it("alert overrides relax", () => {
    expect(detectMode("讨论方案，你清醒一点", ["讨论"], ["你清醒一点"])).toEqual(["alert", "你清醒一点"]);
  });

  it("no match returns strict none", () => {
    expect(detectMode("hello world")).toEqual(["strict", null]);
  });

  it("relax keyword returns relax none", () => {
    expect(detectMode("草案讨论", ["草案"])).toEqual(["relax", null]);
  });

  it("relax no keywords", () => {
    expect(detectMode("这是一个草稿")).toEqual(["relax", null]);
  });

  it("empty relax fallsback to regex", () => {
    expect(detectMode("draft idea", [])).toEqual(["relax", null]);
  });

  it("multiple alert returns first match", () => {
    expect(detectMode("你好 再见", undefined, ["你好", "再见"])).toEqual(["alert", "你好"]);
  });

  it("case insensitive alert", () => {
    expect(detectMode("UPPERCASE DELETE", undefined, ["delete"])).toEqual(["alert", "delete"]);
  });

  it("case insensitive relax", () => {
    expect(detectMode("UPPERCASE DRAFT", ["draft"])).toEqual(["relax", null]);
  });

  it("alert word none for strict", () => {
    const [mode, word] = detectMode("hello world");
    expect(mode).toBe("strict");
    expect(word).toBeNull();
  });

  it("alert word none for relax", () => {
    const [mode, word] = detectMode("draft idea");
    expect(mode).toBe("relax");
    expect(word).toBeNull();
  });
});

it("parseSqliteTimestamp None", () => {
  expect(parseSqliteTimestamp(null)).toBe(0.0);
});

it("parseSqliteTimestamp int", () => {
  expect(parseSqliteTimestamp(1700000000)).toBe(1700000000.0);
});

it("parseSqliteTimestamp float", () => {
  expect(parseSqliteTimestamp(1700000000.5)).toBe(1700000000.5);
});

it("parseSqliteTimestamp valid string", () => {
  const ts = parseSqliteTimestamp("2024-05-29 16:26:40");
  expect(ts).toBeGreaterThan(0);
});

it("parseSqliteTimestamp iso Z", () => {
  const ts = parseSqliteTimestamp("2024-05-29T16:26:40Z");
  expect(ts).toBeGreaterThan(0);
});

it("parseSqliteTimestamp iso no Z", () => {
  const ts = parseSqliteTimestamp("2024-05-29T16:26:40");
  expect(ts).toBeGreaterThan(0);
});

it("parseSqliteTimestamp garbage", () => {
  expect(parseSqliteTimestamp("garbage")).toBe(0.0);
});

it("findAllUuids string with uuid", () => {
  const parent = "00000000-0000-0000-0000-000000000000";
  const result = findAllUuids("abc123 e8c7f1a2-3b4d-5e6f-7890-abcdef123456 xyz", parent);
  expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
});

it("findAllUuids excludes parent", () => {
  const parent = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456";
  const result = findAllUuids("id is " + parent, parent);
  expect(result.has(parent)).toBe(false);
  expect(result.size).toBe(0);
});

it("findAllUuids dict with conversationId", () => {
  const parent = "00000000-0000-0000-0000-000000000000";
  const d = { conversationId: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456", name: "test" };
  const result = findAllUuids(d, parent);
  expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
});

it("findAllUuids dict with conversation_id key", () => {
  const parent = "00000000-0000-0000-0000-000000000000";
  const d = { conversation_id: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456", name: "test" };
  const result = findAllUuids(d, parent);
  expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
});

it("findAllUuids dict excludes parent conversationId", () => {
  const parent = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456";
  const d = { conversationId: parent, name: "test" };
  const result = findAllUuids(d, parent);
  expect(result.has(parent)).toBe(false);
});

it("findAllUuids nested dict", () => {
  const parent = "00000000-0000-0000-0000-000000000000";
  const d = { foo: { conversationId: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" } };
  const result = findAllUuids(d, parent);
  expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
});

it("findAllUuids list", () => {
  const parent = "00000000-0000-0000-0000-000000000000";
  const data = ["e8c7f1a2-3b4d-5e6f-7890-abcdef123456", "another string"];
  const result = findAllUuids(data, parent);
  expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
});

it("judgeZombie normal tool under 60", () => {
  const [isZombie, limit] = judgeZombie(30, "view_file", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(false);
  expect(limit).toBe(60);
});

it("judgeZombie heavy tool under 180", () => {
  const [isZombie, limit] = judgeZombie(120, "run_command", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(false);
  expect(limit).toBe(180);
});

it("judgeZombie normal tool over 60", () => {
  const [isZombie, limit] = judgeZombie(61, "view_file", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(true);
  expect(limit).toBe(60);
});

it("judgeZombie heavy tool over 180", () => {
  const [isZombie, limit] = judgeZombie(181, "grep_search", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(true);
  expect(limit).toBe(180);
});

it("judgeZombie exact boundary normal", () => {
  const [isZombie, limit] = judgeZombie(60, "view_file", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(false);
});

it("judgeZombie exact boundary heavy", () => {
  const [isZombie, limit] = judgeZombie(180, "run_command", new Set(["run_command", "grep_search"]));
  expect(isZombie).toBe(false);
});
