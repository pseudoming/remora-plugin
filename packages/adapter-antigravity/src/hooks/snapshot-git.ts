import * as fs from "node:fs";
import * as path from "node:path";
import { getSnapshot } from "../bridge/filesystem";

export function main(context: Record<string, string>): { injectSteps: never[] } {
  try {
    return _main(context);
  } catch {
    return { injectSteps: [] };
  }
}

function _main(context: Record<string, string>): { injectSteps: never[] } {
  const transcriptPath = context["transcriptPath"] ?? "";
  const cwd = context["cwd"] ?? process.cwd();

  if (!transcriptPath) {
    return { injectSteps: [] };
  }

  try {
    const convDir = path.dirname(path.dirname(path.dirname(transcriptPath)));
    const scratchDir = path.join(convDir, "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const snapshotFile = path.join(scratchDir, "remora_pre_snapshot.json");

    const snapshot = getSnapshot(cwd);
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot), "utf-8");
  } catch {
    // pass
  }

  return { injectSteps: [] };
}
