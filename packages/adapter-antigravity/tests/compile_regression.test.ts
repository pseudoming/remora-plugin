import { test } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { findPluginRoot } from "../src/bridge/paths";

if (process.env.REMORA_STRICT_BUILD_CHECK !== "1") {
  test.skip("TS build check regression", () => {
    // Skipped
  });
} else {
  test("TS build check regression", () => {
    const pluginRoot = findPluginRoot();
    const adapterDir = path.join(pluginRoot, "packages/adapter-antigravity");
    execSync("npm run build", { cwd: adapterDir, stdio: "inherit" });
  });
}
