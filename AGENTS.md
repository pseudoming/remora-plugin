# Remora Project AI Agent Rules

## LARGE FILE SAFETY
When reading or parsing potentially large log files (`*.jsonl`, etc.) in this project, you **MUST NEVER** use `f.readlines()` or load the entire file into memory at once. You **MUST** prioritize native shell utilities (`tail`, `grep`, `awk`) or use buffered/streaming reads to ensure O(1) memory footprint and minimal I/O latency.

## ARCHITECTURE & REFACTORING DISCIPLINE

### 1. Hook Schema Strictness
When developing Antigravity Hooks (e.g., PreInvocation, PreToolUse), you **MUST NEVER** inject arbitrary/custom keys into the JSON payload. Unrecognized fields will instantly crash the `protojson` unmarshaler and bring down the AgentExecutor.

- ❌ **BAD:**
```python
inject_steps.append({
    "decision": "fallback",
    "error_reason": "Missing initialized variable" # Fatal: causes protojson crash
})
```

- ✅ **GOOD:**
```python
import sys
# Log custom debugging info strictly to stderr
print("[Hook Error] Missing initialized variable", file=sys.stderr)
inject_steps.append({
    "decision": "fallback",
    "decision_reason": "Internal state error" # Standard schema key
})
```

### 2. Zombie State Eradication (幽灵变量消除)
When deleting an initialization or setup function call during refactoring, you **MUST** exhaustively search and remove all downstream conditionals, flags, or state checks that depend on it.

- ❌ **BAD:** Deleting `init_environment()` but leaving `if initialized:` further down the file, which causes a `NameError`.
- ✅ **GOOD:** Performing a full text search for all usages of `initialized` and structurally removing the dead branches before committing.

### 3. Bulk Refactoring Coverage Assertion
When performing global string/path replacements (e.g., migrating `/tmp` to SQLite), you **MUST ALWAYS** follow up with a global `grep_search` across the repository to assert 100% coverage.

- ❌ **BAD:** Running a quick fuzzy python script to replace `/tmp` and assuming it fixed everything.
- ✅ **GOOD:** Running `grep -r "/tmp/" src/` immediately after your script finishes to find and manually patch the edge cases your regex missed.

### 4. Sandbox Verification & Clean Install Preview
For complex scripts, installation orchestrators (`install.py`), or drafts, you MUST write them to the `scratch/` directory and perform static verification. Specifically for installers, you **MUST** mentally walk through or simulate a **clean install** scenario.

- ❌ **BAD:** Assuming `os.listdir("agents")` works because the folder exists in your current development tree, which will crash with `FileNotFoundError` on a brand new machine.
- ✅ **GOOD:** Using guard clauses like `if os.path.exists("agents"):` or `os.makedirs("agents", exist_ok=True)` to handle empty states.

### 5. Commit Message Strictness
When submitting changes to the repository, you **MUST NEVER** use lazy, sparse, or one-liner commit messages for substantive updates or retro additions. 

- ❌ **BAD:**
```bash
git commit -m "docs: update AGENTS.md"
```

- ✅ **GOOD:**
```bash
git commit -m "[Phase X Retro] Update AGENTS.md with Architectural Disciplines

Changelog:
- AGENTS.md:
  * Added Hook Schema Strictness rule to prevent protojson crashes.
  * Added Zombie State Eradication rule for safer refactoring.
  * Added Clean Install Preview rule to enforce empty-state verification."
```
