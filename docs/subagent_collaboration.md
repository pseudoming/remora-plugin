# Subagent Collaboration & Liveness Monitoring Guide

This guide documents the architectural design and technical specifications of the Remora plugin concerning master-subagent collaboration, runtime liveness monitoring, and heartbeat timer extensions.

---

## 1. Master-Subagent Collaboration & Liveness Monitoring

To handle long-chain debugging and high-risk operations safely, Remora adopts a master-subagent isolated collaboration design:
- **Master Agent (Coordinator)**: Acts as the orchestrator and decision approver, never directly running high-risk write or test commands.
- **Subagent (Diver / Extractor)**: Executes specific tasks inside isolated workspace branches and reports progress back to the master agent.

### 1.1 Dynamic Guidance & Safety Anchors Preservation (Strong Payload)
- When dispatching tasks, the Master Agent must enforce constraints via a **Strong Payload**:
  1. Mandate **physical file inspections** before attempting edits (preventing hallucinated edits or assumptions).
  2. Define **immutable safety anchors** (e.g., constants in `safety-policy.ts` are absolute system anchors; any conflicts must result in a fast-fail `[ANCHOR_VIOLATION]`).
  3. **Environment Dependency Fail-Fast**: If essential CLI tools (e.g., `npm`, `node`) are missing, the subagent must fail fast instead of attempting global reinstalls in the sandbox.

### 1.2 Heartbeat Timer Rollover Protocol (Liveness Management)
To prevent master agent lockup or silence when a subagent hangs or deadlocks in the background, the Master Agent manages a **Timer Rollover** lifecycle:

1. **Register**:
   Upon launching a subagent via `invoke_subagent`, the Master Agent **simultaneously** schedules a 180s one-shot timeout timer via the `schedule` tool, storing the Timer's `TaskId` in `~/.gemini/config/plugins/remora-plugin/data/.runtime/active_timer_task_id.txt`.
2. **Rollover on Progress Report**:
   When a `progress_report` from the subagent reactive-wakes the Master Agent:
   - Read the stored `TaskId` and call `manage_task` (Action: 'kill') to **physically cancel** the preceding timeout timer.
   - Schedule a fresh 180s one-shot timer and overwrite the `TaskId` in the status file. This resets the 3-minute grace period buffer.
3. **Eviction on Completion**:
   When the `final_report` or final success/fail receipt is received, the Master Agent kills the active heartbeat timer via `manage_task` and deletes the status file, closing the loop.
