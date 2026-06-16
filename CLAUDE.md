# CLAUDE.md

## What This Is

**remora-plugin** — a cognitive safety plugin for the Antigravity AI agent runtime. It injects lifecycle interceptors (hooks) at key agent execution phases, backed by a SQLite warm-storage layer. The goal: prevent context rot, phantom file writes, subagent deadlock, zombie process accumulation, and cross-session memory loss.

Two packages in a monorepo:

```
packages/
├── core/                    @remora/core — pure logic, no platform deps
│   ├── src/storage/         SQLite DAO (11 modules: sessions, messages, topics,
│   │                        decisions, recall, watermarks, artifacts, file-changes,
│   │                        runtime-state, maintenance, connection)
│   ├── src/rules/           Declarative safety rule engine (types, facts, engine, inspector)
│   └── schema/              DDL + FTS5 trigram triggers
│
└── adapter-antigravity/     @remora/antigravity-plugin — Antigravity binding layer
    ├── src/hooks/           8 lifecycle hooks (session-guardian, cognitive-push,
    │                        safety-check, action-gate, zombie-detector, snapshot-git,
    │                        tone-injector, rule-runner)
    ├── src/sidecar/         8 daemon modules (compactor, warm-storage-sync,
    │                        extract-decisions, consume-events, check-approval,
    │                        sync-artifacts, scan-sessions, sidecar-lock)
    ├── src/sandbox/         4 modules (check-subagents-liveness, subagent-monitor,
    │                        sandbox-merge, zombie-linux)
    ├── src/bridge/          11 modules bridging Antigravity APIs
    ├── src/cli/             6 CLI tools (recall, topic, gate, init, read-session-log, git-squash)
    ├── src/debug/           3 debug tools (tail, inspect, env)
    ├── src/maintenance/     4 GC/cleanup modules
    └── src/mcp/             1 MCP server (git-mcp, stdio JSON-RPC 2.0)
```

## Build & Test

```bash
# Build both packages
cd packages/core && npm run build                # tsc → dist/
cd packages/adapter-antigravity && npm run build # tsup (esbuild) → dist/
./deploy.sh                                      # Build both + install to runtime dir

# Run tests (880 pass, zero skipped)
cd packages/core && npm test                    # vitest — 21 files, 381 tests
cd packages/adapter-antigravity && npm test      # vitest — 22 files, 499 tests

# Format/lint
npx biome format --write .
npx biome lint .
```

## Architecture Rules (enforced by tests)

### 1. Core MUST NEVER import from adapter-antigravity
`test_architecture.test.ts` in the core package statically scans all `core/src/*.ts` files for imports referencing `adapter-antigravity`. Any violation fails the build. Adapter → core is the only allowed direction.

### 2. All DB access through the DAO facade
`packages/core/src/dao.ts` is the single entry point re-exporting all storage modules. Direct `better-sqlite3` connections outside `core/src/storage/connection.ts` are forbidden.

### 3. No hardcoded paths
Use `findPluginRoot()`, `getDataDir()`, or the `REMORA_DB_PATH` env var. Never assume `{PLUGIN_ROOT}` or `/tmp/` directly.

### 4. Hook payloads use standard schema keys only
Unrecognized JSON keys in hook responses crash the Antigravity `protojson` unmarshaler. Debug output goes to `stderr` (via `console.error` or `console.debug`), never into the payload. See `PreToolUseResponse` type in `adapter-antigravity/src/types.ts`.

### 5. Which side for new code?

| If it depends on... | Put it in... |
|---|---|
| `conversation.db`, agentapi, hook protocol, `/proc` scanning, Antigravity APIs | `packages/adapter-antigravity/src/` |
| Pure data structures, algorithms, SQLite DAO, rule engine, prompt templates | `packages/core/src/` |

## Hook Lifecycle

Hooks are registered in `hooks.json` (rendered from `conf/templates/hooks.template.json` by `install.ts`). They fire in order within each phase:

| Phase | Hooks (in order) |
|---|---|
| **PreInvocation** | zombie-detector → snapshot-git → session-guardian → tone-injector → cognitive-push (pre-invoke) → check-subagents-liveness |
| **PreToolUse** | zombie-detector (all tools), safety-check (run_command/view_file/grep_search/write ops), cognitive-push (write ops only) |
| **PostInvocation** | action-gate (phantom detection) |
| **Stop** | compactor (event-driven), clean-session-stats, check-subagents-liveness |

### safety-check.ts — Two-Layer Defense

The central security hook. Runs in two layers:

1. **Rule engine layer** (declarative): JSON rules from `conf/remora-rules.json` evaluated by `RuleEngine`. Fail-closed on any exception — if the engine throws, the operation is denied.
2. **Dynamic rule chain** (imperative): 13 pure functions run in sequence, first non-undefined result wins (CoR short-circuit). Covers: read-limit accumulation, duplicate spawn detection, prompt syntax validation, JIT injection, subagent permission override prevention, path traversal checks, Git MCP write gating, and per-subagent-type command auditing.

## Database

SQLite with WAL mode + FTS5 trigram tokenizer (for Chinese full-text search). Schema at `packages/core/schema/schema.sql`.

Key tables: `project_topics`, `topic_decisions`, `messages` + `messages_fts` (FTS5), `watermarks`, `artifact_hashes`, `session_state`, `runtime_hook_state`, `file_changes`, `remora_event_queue`.

Migrations are incremental: `schema-init.ts` probes for missing columns via try-catch `ALTER TABLE ADD COLUMN`. Cold backups (`.db.bak`) are created automatically before schema changes. The `data/` directory is excluded from rsync during deploys — user databases are never overwritten.

## Deployment

Dev (`~/wsl_code/remora-plugin`) and runtime (`{PLUGIN_ROOT}`) are physically separate directories.

`./deploy.sh` builds both packages then runs `install.js --force`, which uses rsync to sync files then purges source-only artifacts (`src/`, `tests/`, `tsconfig*.json`, `*.d.ts`, `node_modules/.vite/`) from the runtime directory.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `REMORA_DB_PATH` | `~/.remora/data/remora_memory.db` | SQLite database path |
| `REMORA_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `REMORA_LOG_DIR` | `$TMPDIR/remora/log` | Log directory |
| `REMORA_TRACE_ID` | auto-generated `s_<8-hex>` | Trace correlation |
| `REMORA_HOOKS_PROFILE_LOG` | `~/.remora/data/hooks_profile.log` | Profiling log path |

## Key Patterns

- **DAO facade** (`core/src/dao.ts`): single barrel re-export of all storage modules + gate + connection. Every DB operation flows through here.
- **Barrel export** (`core/src/index.ts`): the complete public API surface of `@remora/core`.
- **CoR (Chain of Responsibility)**: the `dynamicRules` array in `safety-check.ts` — each function receives a `DynamicRuleContext`, returns `PreToolUseResponse | undefined`. First non-undefined result wins.
- **JIT injection**: one-shot ephemeral messages injected into the model context when it performs a specific action (e.g., launching a subagent), suppressed on subsequent turns via `runtime_hook_state` DB flags.
- **Feature flags**: `conf/features.json` gates injection behaviors. Most are ON; `semantic_conflict_detection` is OFF (experimental).
- **Adapter test setup**: `vitest.setup.ts` backs up and restores `conf/keywords.json` around each test run.

## Commit Convention

Commit messages use the Phase Report format:

```
[Phase XX Report] <Brief Title>

Changelog:
- <file_path>:
  * <detailed itemized change>
  * ...
```

End each commit with: `Co-Authored-By: Claude <noreply@anthropic.com>`
