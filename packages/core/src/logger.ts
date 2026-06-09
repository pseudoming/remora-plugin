/**
 * Structured file logger with trace ID, rotation, and profiling.
 *
 * Python equivalent: scripts/core/logger.py
 * Platform-agnostic — uses node:fs, no adapter dependencies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ── Configuration ────────────────────────────────────────────────

const LOG_DIR = process.env.REMORA_LOG_DIR ?? path.join(os.tmpdir(), "remora", "log");
const MAX_AGE_DAYS = 3;
let traceId = process.env.REMORA_TRACE_ID ?? `s_${randomUUID().slice(0, 8)}`;

const HOOKS_PROFILE_LOG =
  process.env.REMORA_HOOKS_PROFILE_LOG ??
  path.join(os.homedir(), ".remora", "data", "hooks_profile.log");

const LEVEL_ENV = (process.env.REMORA_LOG_LEVEL ?? "INFO").toUpperCase();
const LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, OFF: 4 };
const level = LEVELS[LEVEL_ENV] ?? 1;

let initDone = false;
let logFile: string | null = null;

// ── Public API ───────────────────────────────────────────────────

export function setTraceId(tid: string): void {
  traceId = tid;
  process.env.REMORA_TRACE_ID = tid;
}

export function init(): void {
  if (initDone) return;

  const envTid = process.env.REMORA_TRACE_ID;
  if (envTid) setTraceId(envTid);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const logPath = path.join(LOG_DIR, "system.log");

  if (fs.existsSync(logPath)) {
    const mtime = fs.statSync(logPath).mtime;
    const mtimeDay = mtime.toISOString().slice(0, 10);
    if (mtimeDay !== todayStr) {
      const archivePath = path.join(LOG_DIR, `system.${mtimeDay}.log`);
      fs.renameSync(logPath, archivePath);
    }
  }

  logFile = logPath;
  initDone = true;

  // Cleanup old archived logs
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  try {
    for (const fname of fs.readdirSync(LOG_DIR)) {
      if (fname.startsWith("system.") && fname.endsWith(".log") && fname !== "system.log") {
        const fpath = path.join(LOG_DIR, fname);
        try {
          if (fs.statSync(fpath).mtimeMs < cutoff) {
            fs.unlinkSync(fpath);
          }
        } catch {
          // ignore individual file errors
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
}

export function debug(msg: string): void {
  _log("DEBUG", msg);
}

export function info(msg: string): void {
  _log("INFO", msg);
}

export function warn(msg: string): void {
  _log("WARN", msg);
  process.stderr.write(`[WARN] ${msg}\n`);
}

export function error(msg: string): void {
  _log("ERROR", msg);
  process.stderr.write(`[ERROR] ${msg}\n`);
}

export function profile(msg: string, logPath?: string | null): void {
  if (logPath != null) {
    _writeRaw(logPath, msg);
  } else if (msg.trimStart().startsWith("===")) {
    try {
      _writeRaw(HOOKS_PROFILE_LOG, msg);
    } catch {
      // ignore
    }
  } else {
    _log("PROF", msg);
  }
}

// ── Internal ─────────────────────────────────────────────────────

function _shouldLog(lvl: string): boolean {
  return (LEVELS[lvl] ?? 1) >= level;
}

function _formatCaller(): string {
  const trace = new Error().stack;
  if (!trace) return "unknown:0";
  // stack format: "Error\n    at func (file:line:col)" or "    at file:line:col"
  // We want frame 5: _formatCaller → _log → info/warn/... → caller
  const lines = trace.split("\n");
  const callerLine = lines[5] ?? lines[lines.length - 1] ?? "";
  const match = callerLine.match(/(?:\()?([^:)]+):(\d+)(?::\d+)?\)?$/);
  if (match) {
    return `${path.basename(match[1])}:${match[2]}`;
  }
  return "unknown:0";
}

function _log(lvl: string, msg: string): void {
  if (!_shouldLog(lvl)) return;
  if (!initDone) init();
  if (!logFile) return;

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const caller = _formatCaller();
  const line = `[TID:${traceId}] [${ts}] [${lvl.padEnd(5)}] [${caller}] ${msg}\n`;

  try {
    fs.appendFileSync(logFile, line, "utf-8");
  } catch {
    // ignore write errors
  }
}

function _writeRaw(logPath: string, content: string, maxBytes: number = 1024 * 1024): void {
  try {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > maxBytes) {
        fs.writeFileSync(logPath, `=== Log Rotated at ${new Date().toISOString()} ===\n`, "utf-8");
      }
    }
    fs.appendFileSync(logPath, content, "utf-8");
  } catch {
    // ignore
  }
}
