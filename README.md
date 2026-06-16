<div align="center">

# Remora — Antigravity Cognitive Architecture Plugin

**[Trading Compute for Cognitive Safety] — Deterministic rules guard the probabilistic core, so AI Agents never forget**

![Platform](https://img.shields.io/badge/platform-Antigravity-blue) ![Tests](https://img.shields.io/badge/tests-755%20passed-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

---

[English](README.md) | [简体中文](README.zh.md)

</div>

---

## Your AI Agent Is Slowly Losing Its Memory

The real-world pain of AI Coding Agents:

- **Starts making mistakes after 20 turns** — The context window gets saturated with chat history, diluting earlier architectural decisions
- **Cross-day collaboration resets to zero** — Every new session requires re-explaining project background and technical conventions
- **Phantom writes** — The model claims it modified a file, but actually did nothing
- **Subagent deadlock** — Background tasks are abandoned, the main Agent waits idly for a timeout
- **Dirty environment** — Unmanaged zombie processes pile up, logs flood temp directories

---

## Why Not Just Tell the Model to Remember?

Tacking "please remember previous conversations" onto the System Prompt doesn't help. A bigger context window is just "a bigger desk" — it doesn't solve the "attention scatter" problem. Even with a 2M-token-window model, after 50+ turns it still ignores early architectural decisions.

Remora's approach: **Proactive harvesting → Structured storage → On-demand injection** — only the truly relevant historical decisions get pushed back into context, adding no meaningless tokens.

---

## The Solution: A 700x ROI Cognitive Defense Line

Leveraging Antigravity's Hook protocol to inject interceptors at key nodes in the Agent lifecycle, combined with SQLite warm storage for fully automated memory management. The design has survived 15 rounds of cross-model review (Claude / ChatGPT / Gemini / DeepSeek / Doubao / Qwen).

| Defense Line | What It Does | ROI |
|---|---|---|
| 🪝 **8 Lifecycle Hooks** | Write gating, phantom detection, decision override, safety audit, zombie cleanup | Blocking one bad write ≈ saves 1h of rework |
| 📓 **Warm Storage** | SQLite + FTS5 trigram Chinese full-text index, automatic recall of historical architecture decisions | Recalling one forgotten decision ≈ averting one directional mistake |
| 💀 **Subagent Liveness Self-Healing** | Heartbeat probe → kill_and_retry → escalate_to_human | Auto-recovery, zero manual intervention |
| 🧹 **Garbage Collection** | 72h auto-clean irrelevant topics, 30-day eviction of stale sessions | Database footprint stays under control |

```
Spending an extra 1M tokens on memory management (≈ $0.10) to avoid 1h of rework (≈ $70)
                                                              ≈ 700x ROI
```

---

## What It Does

- 📓 **Decision Memory Network** — Fully automatic extraction of architectural decisions from conversations. FTS5 trigram Chinese full-text index, three-channel hybrid recall (keyword + vector + semantic), automatic step-distance recall every N turns in strict mode, and alert-keyword forced recall. User-confirmed decisions are promoted to `manual` tier, permanently exempt from GC
- 🛡️ **Phantom File Detection** — 7 groups of Chinese/English regex matching model-claimed filenames, physical snapshot diff cross-validation. Phantom write detected → inject warning + `force_continue`
- 💀 **Subagent Liveness Self-Healing** — Heartbeat probing (60s/180s tiered timeout). `completed` → alive, `blocked` → dead, `timeout` → kill_and_retry. After 2 retries → escalate to human
- 🚧 **Global Write Gate** — First write to core code → deny + require explanation of intent. Second retry → allow. On write retry, also injects historical decisions associated with the target file for conflict awareness. Three-tier mode (strict/relax/alert) adaptively gates write access
- 🔬 **Line C Semantic Conflict Detection** — Cross-reference historical architecture decisions against current file write targets to detect semantic drift before code lands
- 🔒 **Safety Audit & Isolation** — `run_command` / `view_file` / `grep_search` pre-interception. Recursive Base64 audit, log large-file read circuit breaker, test/compile mandatory delegation to subagent sandbox. Integrates Stdio Git MCP Service for isolated and safe version control.
- 👻 **Zombie Cleanup & Governance** — Scans `/proc` for unmanaged background processes (>15s). Features `CLI Rollback`, Compile Self-Healing, and cross-session scratch sharing defenses to strictly govern subagent behavior.
- ⚙️ **Declarative Safety Engine** — `safety-check` utilizes a pure Chain of Responsibility (CoR) pattern, supporting Glob Bypass static defenses and a unified magic numbers policy. Strict TypeScript interfaces (e.g., `PreToolUseResponse`) prevent fatal host-environment `protojson crash` at compile-time.

---

## What It Doesn't Do

- ❌ **No automatic commits** · Git operations are explicitly triggered by the user via sandbox-merge
- ❌ **Does not replace model reasoning** · The Hook layer provides defensive validation, never modifies model output content
- ❌ **No data uploads** · All data stored in local SQLite, database path controlled by `REMORA_DB_PATH`

---

## 30-Second Quick Start

```bash
git clone https://github.com/pseudoming/remora-antigravity-plugin.git \
  ~/.gemini/config/plugins/remora-plugin
cd ~/.gemini/config/plugins/remora-plugin
npm install -g @remora/antigravity-plugin && remora-install
```

```bash
export REMORA_DB_PATH=/path/to/remora_memory.db   # Database path
export REMORA_LOG_LEVEL=DEBUG                      # DEBUG | INFO | WARN | ERROR
```

---

## CLI Tools

```bash
npx tsx packages/adapter-antigravity/src/cli/remora-recall.ts "<keywords>"          # Recall historical architecture decisions
npx tsx packages/adapter-antigravity/src/cli/remora-topic.ts new|switch|close|confirm  # Topic management
npx tsx packages/adapter-antigravity/src/cli/read-session-log.ts <conv_id> [rounds]    # Read session logs
```

### Debugging

```bash
npx tsx packages/adapter-antigravity/src/debug/tail.ts    # Real-time log viewer
npx tsx packages/adapter-antigravity/src/debug/inspect.ts # Database status inspection
npx tsx packages/adapter-antigravity/src/debug/env.ts     # System environment info
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Antigravity Engine — Triggers Hooks                             │
└───┬──────┬──────┬──────┬────────┬────────┬───────────────────────┘
    │      │      │      │        │        │
    ▼      ▼      ▼      ▼        ▼        ▼
  ┌────────────────────┐ ┌────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │   PreInvocation    │ │ PreToolUse │ │      Stop        │ │  PostInvocation  │
  │                    │ │            │ │                  │ │                  │
  │ session-guardian ─►│ │ safety-    │ │ compactor        │ │ action-gate      │
  │   (mode, decision) │ │  check     │ │   (artifact MD5) │ │   (phantom       │
  │                    │ │   (cmd     │ │                  │ │    detection)    │
  │ cognitive-push ───►│ │   safety)  │ │ clean-session-   │ └──────────────────┘
  │   (decision        │ │            │ │  stats           │
  │    injection)      │ │ cognitive- │ │                  │
  │                    │ │  push      │ │ check-subagents- │
  │ zombie-detector ─► │ │   (write   │ │  liveness        │
  │   (process scan)   │ │   gate +   │ │   (subagent      │
  │                    │ │   file-touch│ │    probe)        │
  │ tone-injector      │ │   injection)│ └──────────┬───────┘
  │   (tone discipline)│ │            │            │
  │                    │ │ zombie-    │            │
  │ snapshot-git       │ │  detector  │            │
  │                    │ │   (pre-tool│            │
  │ check-subagents-   │ │   block)   │            │
  │  liveness          │ └────────────┘            │
  └──────────┬─────────┘                           │
             │                                     │
             ▼                                     ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                SQLite Warm Storage (remora_memory.db)          │
  │  messages · project_topics · topic_decisions · watermarks      │
  │  session_state · runtime_hook_state · file_changes             │
  │  messages_fts (FTS5 trigram) · artifact_hashes                 │
  └────────────────────────────────────────────────────────────────┘
              ▲                                        │
              │           ┌────────────────────────────┘
              │           ▼
  ┌───────────┴────────────────────────────────────────────────────┐
  │  Sidecar: memory-compactor (daemon)                            │
  │  LLM incremental decision extraction → confidence scoring →    │
  │  GC cleanup → UUID lineage verification                        │
  └────────────────────────────────────────────────────────────────┘
```

```
packages/
├── core/               ← Portable core (zero AG dependencies)
│   ├── src/storage/    ← SQLite DAO — 11 modules
│   ├── src/rules/      ← Command safety audit engine
│   ├── schema/         ← DDL + dynamic migration
│   ├── conf/           ← Configuration
│   └── tests/          ← 331 tests
├── adapter-antigravity/ ← Antigravity binding layer
│   ├── src/hooks/      ← Lifecycle hooks
│   ├── src/bridge/     ← Agent API bridge
│   ├── src/cli/        ← CLI tools
│   ├── src/debug/      ← Debug tools
│   ├── src/sandbox/    ← Sandbox
│   ├── src/sidecar/    ← Sidecar daemons
│   ├── src/maintenance/ ← Maintenance
│   └── tests/          ← 424 tests
```

---

## Development

```bash
# Run tests
cd packages/core && npm test                    # 331 core tests
cd packages/adapter-antigravity && npm test     # 424 adapter tests

# Add a new Hook
1. Write a TypeScript hook module in packages/adapter-antigravity/src/hooks/
2. Edit conf/templates/hooks.template.json
3. Run remora-install
```

**Architecture Boundaries**

- `core/` must not import from `adapter-antigravity/` (enforced by `test_architecture.ts`)
- All database reads/writes go through `packages/core/src/dao.ts` unified entry point
- Source code must not hardcode absolute paths; use `findPluginRoot()`, environment variables, or `getDataDir()`

---

### Build, Physical Isolated Deployment, and Database Migration

This project uses a physically isolated, self-contained deployment approach. The development directory (e.g., `~/wsl_code/remora-plugin`) acts as the source code repository, while the global runtime plugin directory (`~/.gemini/config/plugins/remora-plugin`) serves as the physically isolated execution environment.

#### 1. One-Click Build & Physical Deployment
Directly run the deployment script in the development directory:
```bash
./deploy.sh
```
This script automatically:
- Recursively cleans Python compilation caches in the development folder.
- Executes TypeScript compilation (outputs to respective `dist/` directories).
- Physically severs old symbolic links and incrementally synchronizes files to the global deployment directory via `rsync`.
- **Physical Obsolete Purging**: Forces removal of development-only source files (`src/`), unit tests (`tests/`), and config files (`tsconfig.json`) in the runtime directory. It also **recursively purges all `.d.ts` type declaration files** and the **`node_modules/.vite` build cache** to achieve minimal package size and clean execution.

#### 2. Database Safe Migration
- **Data Preservation**: The `data/` directory is explicitly excluded during `rsync`. Existing user database `remora_memory.db` will never be overwritten or deleted during deployments.
- **Automated Cold Backup**: Every installation/upgrade automatically creates a cold backup (`remora_memory.db.bak`) in the same directory before schema updates.
- **Incremental Column Upgrades**: When adding columns or extending table schemas:
  1. Append the new column to the table definition inside `packages/core/schema/schema.sql` (for clean installations).
  2. Implement an incremental `try-catch` probe and `ALTER TABLE ADD COLUMN` statement in `packages/adapter-antigravity/src/schema/schema-init.ts`'s `initDb()` function (for seamless hot upgrading of existing databases).


---

## Contributing

PRs welcome, especially for:

- New language keywords (`conf/keywords.json` — currently Chinese only; English/Japanese/Korean welcome)
- New Hook interception rules (PreInvocation / PreToolUse / Stop)
- New CLI management tools
- New Sidecar daemons

Ensure both npm test suites are all green before submitting.

---

## Documentation

| Document | Content |
|---|---|
| [Project Overview](docs/PROJECT.md) | Architecture, phases, quality gates |
| [Core Business Flows](docs/business_flows.md) | 10 flows + Mermaid diagrams |
| [Subagent Collaboration](docs/subagent_collaboration.md) | Collaboration design, Timer Rollover, physical deploy, SQLite hot upgrade |
| [Antigravity Integration](.agents/skills/antigravity-integration/SKILL.md) | Hook / Sidecar / Plugin protocol |
| [Memory Mechanics](.agents/skills/antigravity-memory-mechanics/SKILL.md) | Checkpoint / Compaction / SQLite warm storage |
| [Debug Tools](packages/adapter-antigravity/src/debug/README.md) | tail / inspect / env |
