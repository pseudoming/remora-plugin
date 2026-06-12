import { randomUUID } from "node:crypto";
import { pruneExpiredWatermarks as _prune, setTraceId } from "@remora/core";
import { getBrainDir } from "../bridge/paths";

const BRAIN_DIR = getBrainDir();

export function pruneExpiredWatermarks(brainDir: string = BRAIN_DIR): void {
  _prune(brainDir);
}

export function main(): void {
  setTraceId(`c_${randomUUID().slice(0, 8)}`);
  pruneExpiredWatermarks(BRAIN_DIR);
}
