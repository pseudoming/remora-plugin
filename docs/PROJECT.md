[English](PROJECT.md) | [简体中文](PROJECT.zh.md)

# Project: Remora Plugin

Remora — an Antigravity cognitive architecture plugin. Fully automated memory management for AI Agents via Hook interceptors + SQLite warm storage.

## Architecture

### Layers

```
scripts/
├── core/          ← Portable core (zero Antigravity dependencies)
│   ├── storage/   ← SQLite DAO (10 modules: sessions, topics, decisions, recall, etc.)
│   ├── rules/     ← Command safety inspection engine (inspector)
│   ├── liveness.py, phantom.py, injector.py, zombie.py, reader.py, coverage.py, gate.py, text_analysis.py
│   ├── filesystem.py, logger.py
├── adapter/       ← Antigravity binding layer
│   ├── hooks/     ← 8 lifecycle interceptors
│   ├── bridge/    ← CDAL, agentapi, paths, session, subagent, stats, profiler
│   ├── cli/       ← remora-recall, remora-topic, read-session-log
│   ├── sandbox/   ← sandbox-merge, subagent-monitor, check-subagents-liveness
│   ├── sidecar/   ← compactor daemon (8 modules: compactor, extract_decisions, warm_storage_sync, etc.)
│   └── maintenance/ ← GC, ghost data cleanup
├── lib/           ← DAO re-export facade (30 lines)
├── schema/        ← DDL + dynamic migration
├── tests/         ← 674 tests
└── debug/         ← tail, inspect, env
```

### Data Flow

```
Antigravity Hook triggers
    → adapter/hooks/ (interception, mode detection, memory reload (uc=0 + uc=1 decisions), write gate + file-touch injection, safety check)
    → adapter/sidecar/compactor/ (background LLM incremental decision extraction)
    → core/storage/ ← lib/dao.py (unified SQLite read/write)
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

## Quality Gates

- `core/` forbidden from importing `adapter/` (enforced by `test_architecture.py`)
- All DB reads/writes go through `lib/dao.py`
- 674 tests, `pytest scripts/tests/ -q`
- Bare `sqlite3.connect()` forbidden in `adapter/`

## Quick Start

```bash
git clone https://github.com/pseudoming/remora-antigravity-plugin.git \
  ~/.gemini/config/plugins/remora-plugin
cd ~/.gemini/config/plugins/remora-plugin
python3 install.py
pytest scripts/tests/ -q  # 674 tests
```
