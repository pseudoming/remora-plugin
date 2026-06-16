[English](PROJECT.md) | [简体中文](PROJECT.zh.md)

# Project: Remora Plugin

Remora — an Antigravity cognitive architecture plugin. Fully automated memory management for AI Agents via Hook interceptors + SQLite warm storage.

## Architecture

### Layers

```
packages/
├── core/          @remora/core
│   ├── src/       Pure logic (storage, rules, injection, etc.)
│   ├── tests/     331 tests (vitest)
├── adapter-antigravity/  @remora/antigravity-plugin
│   ├── src/       hooks/ bridge/ sidecar/ sandbox/ cli/ debug/
│   ├── bin/       install.js
│   ├── tests/     424 tests (vitest)
```

### Data Flow

```
Antigravity Hook triggers
    → adapter-antigravity/src/hooks/ (interception, mode detection, memory reload, write gate + file-touch injection, safety check)
    → adapter-antigravity/src/sidecar/compactor/ (background LLM incremental decision extraction)
    → core/src/storage/ ← @remora/core DAO (unified SQLite read/write)
```

## Phases

| Phase | Content | Status |
|---|---|---|
| 44 | Architecture separation: core/adapter split, unified logger, debug tools | ✅ |
| 45 | Tech debt: DAO architecture convergence, import hygiene, test engineering | ✅ |
| 46 | install.py rewrite (idempotent, dry-run, uninstall), README v2, DB path unification | ✅ |
| 47 | README v2 narrative rewrite, conf/ directory standardization, tracking hygiene | ✅ |
| 48 | Sidecar refactor: AgentAPI bridge, pure functions extracted to core, moved to adapter/sidecar/ | ✅ |
| 49 | Bilingual documentation rewrite | ✅ |
| 50 | Three-tier mode (relax/strict/alert), step-distance recall, keyword pruning | ✅ |
| 51 | uc=0 snapshot system, file_changes write-tracking, supersede_unconfirmed | ✅ |
| 52 | File-touch injection, sidecar DAO refactoring, dead code cleanup, platform extraction | ✅ |
| 53 | Cold-start fix (uc=0+uc=1), liveness unification, core cleanup | ✅ |
| 54 | Line C semantic conflict detection (BM25 + flash-lite), features.json gate, core/gate.py | ✅ |
| 55 | Unified Gate System, Documentation Sync & Injection Config Consolidation | ✅ |
| 56 | Agent Hardening & Config Sync | ✅ |
| 57 | C1 Injection Tracking, Cross-Project Bug Fixes & SQL Determinism Audit | ✅ |
| 58 | Core Extraction (24 functions to core, adapter slimming, Antigravity leakage remediation) | ✅ |
| 59 | Core → TypeScript (25 modules + 17 test files, strict 1:1 translation) | ✅ |
| 60 | Adapter Rewrite (29 src + 17 test files, 755 pass) | ✅ |
| 61 | Hook Entrypoint Switch + Prompt Injection + Agent Hardening | ✅ |
| 62 | Python Removal — TypeScript is the sole source | ✅ |
| 63 | npm Installer + tsup Build Pipeline | ✅ |
| 64-65 | Physically Isolated Deployment with auto-cleanup, Sidecar Dynamic Activation, Cross-Session Scratch Sharing | ✅ |
| 66-68 | ConversationDataAccessLayer (CDAL) Refactor, Sidecar Self-Recovery, Generic Rule Engine Core | ✅ |
| 69-72 | Subagent Governance Defenses (CLI Rollback, Zombie Warning, Compile Self-Healing, Symlink Security) | ✅ |
| 73-77 | Declarative Rule Engine Switch, Glob Bypass static defense, SQLite DDL Hot Upgrades Tracking | ✅ |
| 78-80 | Stdio Git MCP Integration & Handshake, CoR-based Defense Pipeline Refactoring | ✅ |
| 81-84 | Unified Magic Numbers Policy, Test Engineering Hardening (Zero Skipped Policy), Strict HookPayload Typing Defense | ✅ |

## Quality Gates

- `core/` forbidden from importing `adapter-antigravity/` (enforced by `test_architecture.ts`)
- All DB reads/writes go through `@remora/core` DAO layer
- 755 tests, `npm test`
- Bare `sqlite3.connect()` forbidden outside `core/src/storage/`

## Quick Start

```bash
git clone https://github.com/pseudoming/remora-antigravity-plugin.git \
  ~/.gemini/config/plugins/remora-plugin
cd ~/.gemini/config/plugins/remora-plugin
npm install
node packages/adapter-antigravity/bin/install.js
npm test  # 755 tests
```

---

## Deployment & Database Evolution

This project adopts a physically isolated deployment strategy and dynamic column migration to ensure a clean runtime environment and user data safety.

### 1. Physically Isolated Deployment & Obsolete Purging
The development directory is physically isolated from the global runtime plugin directory.
- **One-Click Build & Deploy**: Run `./deploy.sh` in the development directory. The script automatically cleans Python caches, builds TypeScript files, and incrementally syncs files to the global deployment directory via `rsync`.
- **Post-Sync Obsolete Purging**: To keep the bundle size minimal, the installer `install.ts` automatically purges TypeScript source files (`src/`), test suites (`tests/`), and compilation settings (`tsconfig.json`). It also **recursively removes all `.d.ts` type declaration files** and the **`node_modules/.vite` build cache**.

### 2. Database Safe Migration
SQLite database `remora_memory.db` uses multi-layered protection when schemas undergo upgrades:
- **Physical Overwrite Prevention**: The `data/` folder is explicitly excluded during `rsync` syncs. Before DDL checks, a cold backup copy (`remora_memory.db.bak`) is automatically created in the same folder.
- **Try-Catch Incremental DDL Hot Upgrades**: Instead of wiping databases to rebuild tables, the database initialization (`schema-init.ts`'s `initDb()`) queries columns incrementally. If a column is missing, the `catch` block performs an `ALTER TABLE table ADD COLUMN` migration without data loss.

