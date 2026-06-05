# Project: Remora Documentation and Testing

## Architecture
Remora is a cognitive architecture helper that manages context, intercepts actions (Hooks), tracks subagents liveness/zombie state, and manages structured storage in SQLite.
Key components:
- **Hooks (Interception)**: `action-gate.py` (PreInvocation), `safety-check.py` / `safety_rules.py` (PreToolUse), `Stop` Hook (cleanup).
- **Daemons / Sidecars**: `check-subagents-liveness.py`, `zombie-detector.py`, `session_gc.py`, `topic_gc.py`.
- **Data Management**: `schema_init.py` / `schema.sql` (schema structure, triggers, FTS5), `remora-recall.py` (FTS recall), `remora-topic.py` (topic management), `cleanup_ghost_records.py` (data cleanup).
- **Core Library**: `scripts/lib/` containing DAO, context, conversation, filesystem, paths, etc.

## Milestones
| # | Name | Scope | Dependencies | Status | Conversation ID |
|---|------|-------|--------------|--------|-----------------|
| 1 | Exploration | Codebase exploration and flow mapping | None | DONE | fe30e2fe-cc56-4330-bc0e-b966c6637198 |
| 2 | Documentation | Create `docs/business_flows.md` and update `README.md` | M1 | DONE | a3842452-07f8-4968-9c95-fcadca3a9795 |
| 3 | Testing | Implement unit tests for core modules, achieve 80%+ overall coverage | M1 | DONE | 8b374273-f676-4f80-9a87-3d530e121a89 |
| 4 | Verification | Run Forensic Auditor and complete final check | M2, M3 | DONE | 1c29df57-1f02-474a-8b42-514c8d821be4 |

## Code Layout
- `scripts/`: Main execution entrypoints.
- `scripts/lib/`: Internal modules (DAO, context, etc.).
- `scripts/tests/`: Unit test suite.
- `docs/`: Project documentation (including `business_flows.md`).
- `README.md`: System documentation.

## Interface Contracts
- **remora-recall.py ↔ SQLite**: Interacts with the `remora_memory.db` FTS5 tables to retrieve memory blocks.
- **check-subagents-liveness.py ↔ progress.json**: Decodes progress tracking records and detects timeouts.
