import { describe, it, expect, vi, beforeEach } from "vitest";

const { getRuntimeHookValue, setRuntimeHookValue, trimRuntimeHookStates } = vi.hoisted(() => ({
  getRuntimeHookValue: vi.fn(),
  setRuntimeHookValue: vi.fn(),
  trimRuntimeHookStates: vi.fn(),
}));

vi.mock("../src/storage/runtime-state", () => ({
  getRuntimeHookValue,
  setRuntimeHookValue,
  trimRuntimeHookStates,
}));

import { trimStaleHookStates } from "../src/state-trim";

const mockConn = {} as any;

describe("trimStaleHookStates", () => {
  beforeEach(() => {
    getRuntimeHookValue.mockClear();
    setRuntimeHookValue.mockClear();
    trimRuntimeHookStates.mockClear();
  });

  it("test_first_call_last_seen_none", () => {
    getRuntimeHookValue.mockReturnValue(null);
    trimStaleHookStates(mockConn, "conv-001", 5);
    expect(trimRuntimeHookStates).toHaveBeenCalledTimes(1);
    expect(trimRuntimeHookStates).toHaveBeenCalledWith(mockConn, "conv-001", 5);
    expect(setRuntimeHookValue).toHaveBeenCalledTimes(1);
    expect(setRuntimeHookValue).toHaveBeenCalledWith(mockConn, "conv-001", -1, "last_seen_turn", "5");
  });

  it("test_same_turn_noop", () => {
    getRuntimeHookValue.mockReturnValue("3");
    trimStaleHookStates(mockConn, "conv-001", 3);
    expect(trimRuntimeHookStates).not.toHaveBeenCalled();
    expect(setRuntimeHookValue).not.toHaveBeenCalled();
  });

  it("test_different_turn_trims_and_sets", () => {
    getRuntimeHookValue.mockReturnValue("2");
    trimStaleHookStates(mockConn, "conv-001", 7);
    expect(trimRuntimeHookStates).toHaveBeenCalledTimes(1);
    expect(trimRuntimeHookStates).toHaveBeenCalledWith(mockConn, "conv-001", 7);
    expect(setRuntimeHookValue).toHaveBeenCalledTimes(1);
    expect(setRuntimeHookValue).toHaveBeenCalledWith(mockConn, "conv-001", -1, "last_seen_turn", "7");
  });

  it("test_unparseable_last_seen_noop", () => {
    getRuntimeHookValue.mockReturnValue("abc");
    trimStaleHookStates(mockConn, "conv-001", 5);
    expect(trimRuntimeHookStates).not.toHaveBeenCalled();
    expect(setRuntimeHookValue).not.toHaveBeenCalled();
  });
});
