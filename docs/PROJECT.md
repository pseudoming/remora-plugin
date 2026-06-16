[English](PROJECT.md) | [简体中文](PROJECT.zh.md)

# Remora Plugin — Project Overview

Remora — an Antigravity cognitive architecture plugin. Fully automated memory management for AI Agents via Hook interceptors + SQLite warm storage. 880 tests, 0 skipped.

## Architecture

```
packages/
├── core/                        @remora/core — pure logic, zero platform deps
│   ├── src/storage/             SQLite DAO (11 modules)
│   ├── src/rules/               Declarative safety rule engine
│   ├── src/                     injection-formatting, safety-policy, etc.
│   ├── schema/schema.sql        DDL + FTS5 trigram
│   └── tests/                   381 tests
│
└── adapter-antigravity/         @remora/antigravity-plugin — Antigravity binding
    ├── src/hooks/               8 lifecycle hooks
    │   ├── post-filters/        9 dynamic CoR rules
    │   └── command-auditors/    5 command audit rules
    ├── src/sidecar/             8 daemons (compactor, warm-storage-sync, etc.)
    ├── src/sandbox/             4 modules (liveness, monitor, merge, zombie-linux)
    ├── src/bridge/              11 modules (agentapi, conversation, paths, etc.)
    ├── src/cli/                 6 tools (recall, topic, init, gate, read-log, squash)
    ├── src/mcp/                 1 server (git-mcp stdio JSON-RPC 2.0)
    ├── src/maintenance/         4 modules (session-gc, topic-gc, etc.)
    ├── src/schema/              schema-init + migration logic
    └── tests/                   499 tests
```

## Hook Lifecycle

Hooks are registered in `hooks.json` (rendered by `install.ts` from `conf/templates/hooks.template.json`).

| Phase | Hooks (in order) |
|-------|-----------------|
| **PreInvocation** | zombie-detector → snapshot-git → session-guardian → tone-injector → cognitive-push (pre-invoke) → check-subagents-liveness |
| **PreToolUse** | zombie-detector (all tools), safety-check (run_command/view_file/grep_search/write ops), cognitive-push (write ops) |
| **PostInvocation** | action-gate (phantom detection) |
| **Stop** | compactor (event-driven), clean-session-stats, check-subagents-liveness |

### safety-check.ts — Two-Layer Defense

1. **Rule engine layer**: 10 JSON rules from `conf/remora-rules.json` evaluated by `RuleEngine` from core. Fail-closed on errors.
2. **Dynamic rule chain**: 14 pure-function rules in `post-filters/` and `command-auditors/`, executed short-circuit (first DENY wins).

## Key Features

- **Decision Memory**: Auto-extraction → SQLite + FTS5 trigram → cold-start injection → `remora-recall` CLI
- **Declarative Rule Engine**: 10 JSON rules + 14 CoR dynamic rules, fail-closed
- **Subagent Governance**: workspace matrix (branch/share/inherit), prompt density limits, 3-minute dedup, 4-turn ReadOnly fuse, high-risk command gate
- **Unified Anti-Rot**: view_file + grep_search joint billing (80KB warn / 160KB deny)
- **Phantom Detection**: claimed file changes vs physical git diff cross-validation
- **Subagent Liveness**: /proc scanning, heartbeat, self-healing SOP (kill → clean → verify)
- **Git MCP**: zero-dependency stdio JSON-RPC 2.0 git server for isolated version control
- **Strict Hook Types**: `PreToolUseResponse` / `PreInvocationResponse` prevent protojson crashes
- **C5 Worktree Pruning**: automated dead subagent branch + worktree cleanup

## CLI Tools

```bash
remora-recall "<keywords>"                      # Recall decisions via FTS5 full-text search
remora-topic new|switch|close                   # Topic management
remora-gate --rollback                           # Emergency safety-check rollback
read-session-log <conv_id>                       # Read session logs
git-squash                                       # Squash incremental commits
```

## Quality Gates

- `core/` forbidden from importing `adapter-antigravity/` (enforced by `test_architecture.ts`)
- All DB reads/writes through `@remora/core` DAO
- 880 tests, 0 skipped, CI on push/PR (Node 20/22)
- Strict TypeScript (`strict: true`) + Biome formatting
- `data/` excluded from rsync deploys — user databases survive upgrades

## Deployment

```bash
./deploy.sh                          # Build both packages + rsync to runtime dir
remora-install --force               # Reinstall
remora-install --uninstall           # Remove plugin, keep database
remora-install --uninstall --purge   # Remove plugin + database
```

Development (`~/wsl_code/remora-plugin`) and runtime (`~/.gemini/config/plugins/remora-plugin`) are physically isolated. The `data/` directory is excluded from rsync — existing databases survive deployments. Schema changes use try-catch `ALTER TABLE ADD COLUMN` migration with automatic `.db.bak` cold backup.

## Phases

| Phase | Content | Status |
|---|---|---|
| 44-63 | Core/adapter split, Python→TypeScript migration, npm installer, tsup build, deploy pipeline, bilingual docs | ✅ |
| 64-68 | Physically isolated deployment, Sidecar dynamic activation, CDAL refactor, Generic Rule Engine (dark launch) | ✅ |
| 69-72 | Subagent governance: CLI Rollback, TS Build Assertion, Scaffolder Symlink, Zombie Warning, Path Normalization | ✅ |
| 73-77 | Rule Engine switch + Glob Bypass + Route C1 schema migration + uninstall purge + unified anti-rot defense | ✅ |
| 78-80 | Stdio Git MCP + High-Risk Command Gate + CoR Defense Pipeline Refactoring | ✅ |
| 81-84 | Magic Numbers Policy + Test Hardening (0 skipped) + Strict HookPayload Typing | ✅ |
| 85-88 | Strict Fail-Safe (eradicate silent catches) + C5 Worktree Pruning + C6 Test Decoupling + C7 Modularization | ✅ |
| 89-90 | Type-Safe Hook Interfaces + High-Risk Command Gate + Behavioral Constraint Injection | ✅ |
