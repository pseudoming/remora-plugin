<div align="center">

# Remora — Give Your AI Agent a Memory

**[Trading Compute for Cognitive Safety] — Deterministic rules guard the probabilistic core**

![Platform](https://img.shields.io/badge/platform-Antigravity-blue) ![Tests](https://img.shields.io/badge/tests-880%20passed-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh.md)

</div>

---

## Have You Experienced This?

Day 4 of your project. Two days ago you spent an hour explaining why Redis doesn't belong. Today it suggests Redis again. You've corrected the same function signature three times. Every new session, it forgets.

Your subagent says "Done." `git diff` shows nothing. Two minutes later you realize it was lying.

The model isn't getting dumber — it has no memory. Remora gives it one.

---

## What Remora Does

| If your agent… | Remora… |
|---|---|
| Resets to zero every new session | Remembers architectural decisions across sessions — injects them back automatically |
| Suggests solutions you already rejected | Tags rejected decisions so the agent knows *why not*, not just *what* |
| Claims it modified files but didn't | Physically diffs the filesystem — if nothing changed, the claim gets flagged |
| Reads huge logs and bloats the context | Enforces a unified read budget — when it's full, work gets delegated to subagents |
| Spawns subagents that hang or die silently | Heartbeat probes every 60s — dead subagents get killed and retried automatically |
| Pushes code or runs destructive commands | Intercepts high-risk commands and demands your explicit confirmation |
| Forgets behavioral rules you told it | Injects your critical constraints directly into every new context |

All decisions stored in local SQLite + FTS5 trigram. No data leaves your machine. No cloud dependency.

---

## 30 Seconds to Start

```bash
git clone https://github.com/pseudoming/remora-plugin.git
cd remora-plugin
./deploy.sh
```

Keep working. Decisions accumulate automatically. No configuration needed.

> Already have the plugin? `remora-install --force` updates in place.

---

## Architecture

```
Antigravity Hook triggers
    │
    ├─ PreInvocation: session-guardian → cognitive-push → zombie-detector → ...
    ├─ PreToolUse:     safety-check (rule engine + dynamic CoR chain) → cognitive-push (write gate)
    ├─ PostInvocation: action-gate (phantom detection)
    └─ Stop:           compactor → clean-session-stats → check-subagents-liveness
         │
         ▼
    SQLite Warm Storage (remora_memory.db)
    messages · project_topics · topic_decisions · FTS5 trigram
         │
         ▼
    Sidecar: memory-compactor (background LLM decision extraction + GC)
```

`safety-check.ts` uses two defense layers: 10 declarative JSON rules evaluated by a pure RuleEngine (fail-closed on errors), plus 14 dynamic pure-function rules in a Chain of Responsibility pipeline (first DENY wins).

---

## What You Get

- **Decision Memory** — Auto-extraction → SQLite + FTS5 trigram → cold-start injection → `remora-recall` CLI for full-text recall
- **Declarative Rule Engine** · 10 JSON rules + 14 CoR dynamic rules, fail-closed
- **Subagent Governance** · workspace matrix (branch/share/inherit), prompt density limits, 3-minute dedup, 4-turn ReadOnly fuse, high-risk command gate
- **Unified Anti-Rot** · view_file + grep_search joint billing (80KB warn / 160KB deny)
- **Phantom Detection** · claimed file changes vs physical git diff cross-validation
- **Subagent Liveness** · /proc scanning, heartbeat, self-healing SOP (kill → clean → verify)
- **Git MCP** · zero-dependency stdio JSON-RPC 2.0 git server for isolated version control
- **Type-Safe Hooks** · `PreToolUseResponse` / `PreInvocationResponse` prevent protojson crashes at compile time

---

## CLI Tools

```bash
remora-recall "<keywords>"              # Full-text search decisions via FTS5
remora-topic new|switch|close           # Topic management
remora-gate --rollback                   # Emergency safety-check rollback
read-session-log <conv_id>              # Read session logs
```

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict mode) |
| Database | better-sqlite3 + WAL + FTS5 trigram |
| Build | tsc (core) + tsup/esbuild (adapter) |
| Formatting | Biome (Rust, drop-in for Prettier + ESLint) |
| Testing | Vitest · 880 tests · 0 skipped · CI on push/PR (Node 20/22) |

---

## Deployment

```bash
./deploy.sh                          # Build both packages + rsync to runtime dir
remora-install --force               # Reinstall / update
remora-install --uninstall           # Remove plugin, keep database
remora-install --uninstall --purge   # Remove everything
```

Development (`~/wsl_code/remora-plugin`) and runtime (`~/.gemini/config/plugins/remora-plugin`) are physically isolated. The `data/` directory is excluded from rsync — existing databases survive upgrades. Schema changes use try-catch `ALTER TABLE ADD COLUMN` with automatic `.db.bak` cold backup.

---

## What It Doesn't Do

- ❌ Commit code for you
- ❌ Modify your code
- ❌ Upload data — everything stays in local SQLite

---

Full architecture, hook lifecycle, development guide — see [PROJECT.md](docs/PROJECT.md).
