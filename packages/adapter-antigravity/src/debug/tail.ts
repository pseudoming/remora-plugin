import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

export const LOG_DIR = process.env.REMORA_LOG_DIR ?? "/tmp/remora/log";
export const BASE_LOG = path.join(LOG_DIR, "system.log");
export const ARCHIVE_GLOB = path.join(LOG_DIR, "system.*.log");

export const COLORS: Record<string, string> = {
  ERROR: "\x1b[31m",
  WARN: "\x1b[33m",
  INFO: "\x1b[37m",
  DEBUG: "\x1b[2m",
};
export const RESET = "\x1b[0m";

const LINE_RE = new RegExp(
  "\\[TID:([^\\]]+)\\]\\s+\\[([^\\]]+)\\]\\s+\\[([^\\]]+)\\]\\s+\\[([^\\]]+)\\]\\s+(.*)"
);

interface ParsedLine {
  tid: string;
  timestamp: string;
  level: string;
  source: string;
  message: string;
  raw: string;
}

export function parseLine(line: string): ParsedLine | null {
  const m = line.trim().match(LINE_RE);
  if (!m) {
    return null;
  }
  return {
    tid: m[1].trim(),
    timestamp: m[2].trim(),
    level: m[3].trim(),
    source: m[4].trim(),
    message: m[5].trim(),
    raw: line.replace(/\n+$/, ""),
  };
}

function expandGlob(dir: string, pattern: string): string[] {
  const base = path.basename(pattern);
  const regex = new RegExp(
    "^" + base.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => regex.test(f))
      .map((f) => path.join(dir, f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function getLogFiles(todayOnly: boolean = false): string[] {
  const logDir = LOG_DIR;
  const baseLog = BASE_LOG;
  const archiveGlob = ARCHIVE_GLOB;
  const files: string[] = [];
  if (fs.existsSync(baseLog)) {
    files.push(baseLog);
  }
  if (!todayOnly) {
    const archives = expandGlob(logDir, archiveGlob);
    files.push(...archives.filter((a) => a !== baseLog));
  }
  return files;
}

export function main(): void {
  const args = parseArgs({
    options: {
      level: { type: "string" },
      grep: { type: "string" },
      lines: { type: "string", default: "20" },
      asc: { type: "boolean", default: false },
      today: { type: "boolean", default: false },
    },
    strict: false,
  });

  const level = typeof args.values.level === "string" ? args.values.level.toUpperCase() : undefined;
  const grep = typeof args.values.grep === "string" ? args.values.grep : undefined;
  const linesVal = parseInt(typeof args.values.lines === "string" ? args.values.lines : "20", 10);
  const asc = !!args.values.asc;
  const today = !!args.values.today;

  const logFiles = getLogFiles(today);
  if (logFiles.length === 0) {
    process.stderr.write("No log files found.\n");
    process.exit(1);
  }

  const matched: [string, ParsedLine][] = [];
  for (const fp of logFiles) {
    try {
      const content = fs.readFileSync(fp, "utf-8");
      for (const raw of content.split("\n")) {
        if (raw.length === 0) {
          continue;
        }
        const parsed = parseLine(raw);
        if (parsed === null) {
          continue;
        }
        if (level && parsed.level !== level) {
          continue;
        }
        if (grep && !raw.toLowerCase().includes(grep.toLowerCase())) {
          continue;
        }
        matched.push([fp, parsed]);
      }
    } catch (exc) {
      process.stderr.write(`[WARN] Cannot read ${fp}: ${exc}\n`);
    }
  }

  if (matched.length === 0) {
    process.exit(0);
  }

  matched.sort((a, b) => a[1].timestamp.localeCompare(b[1].timestamp));

  const sliced = matched.slice(-linesVal);

  const ordered = asc ? sliced : [...sliced].reverse();

  for (const [_fp, entry] of ordered) {
    const levelEntry = entry.level;
    const color = COLORS[levelEntry] || "";
    const ts = entry.timestamp;
    const src = entry.source;
    const msg = entry.message;
    const tid = entry.tid;
    const text = `[TID:${tid}] [${ts}] [${levelEntry}] [${src}] ${msg}`;
    if (color) {
      process.stdout.write(`${color}${text}${RESET}\n`);
    } else {
      process.stdout.write(`${text}\n`);
    }
  }
}
