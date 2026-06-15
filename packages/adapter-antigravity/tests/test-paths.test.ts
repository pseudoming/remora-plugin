import { describe, it, expect } from "vitest";
import { isExemptedPath } from "../src/bridge/paths";

describe("paths isExemptedPath", () => {
  it("identifies exempted paths properly", () => {
    expect(isExemptedPath("/some/path/artifacts/task.md")).toBe(true);
    expect(isExemptedPath("/some/scratch/parent_shared/result.json")).toBe(true);
    expect(isExemptedPath("/home/agent/.gemini/config/projects/settings.json")).toBe(true);
    expect(isExemptedPath("/home/agent/.gemini/config/plugins/remora/config.json")).toBe(true);
    expect(isExemptedPath("/home/agent/src/index.ts")).toBe(false);
  });
});
