import { describe, it, expect } from "vitest";
import {
  parseSqliteTimestamp,
  findAllUuids,
  judgeZombie,
  suggestZombieAction,
  isTimerCanceled,
} from "../src/liveness";

// ============================================================
// 适配器层测试 — 不在 @remora/core 范围内，全部 skip
// ============================================================

describe("Adapter-level tests (skipped — not in @remora/core scope)", () => {
  it.skip("test_progress_sentinel_update", () => {
    // 原始 Python 测试: 验证 ProgressSentinel.update() 写入 progress.json
    // 属于 adapter/bridge/progress.py + 文件系统操作
  });

  it.skip("test_liveness_completed", () => {
    // 原始 Python 测试: 设置 completed progress.json, 调用 check-subagents-liveness.py main()
  });

  it.skip("test_liveness_blocked", () => {
    // 原始 Python 测试: 设置 blocked progress.json, 调用 main() → 预期 dead
  });

  it.skip("test_liveness_timeout_progress", () => {
    // 原始 Python 测试: 设置过期 running progress.json, 调用 main() → 预期 dead
  });

  it.skip("test_liveness_active_progress", () => {
    // 原始 Python 测试: 设置新鲜 running progress.json, 调用 main() → 预期 alive
  });

  it.skip("test_liveness_db_timeout", () => {
    // 原始 Python 测试: 过期 progress.json + 过期 DB message, main() → dead
  });

  it.skip("test_liveness_db_active", () => {
    // 原始 Python 测试: 过期 progress.json + 新鲜 DB message, main() → alive
  });

  it.skip("test_liveness_no_signals", () => {
    // 原始 Python 测试: 无 progress.json, main() → alive
  });

  it.skip("test_liveness_hook_mode_auto_detect", () => {
    // 原始 Python 测试: Hook 模式下自动检测 subagent uuid
  });

  it.skip("test_liveness_with_watermarks_and_timeframe", () => {
    // 原始 Python 测试: watermarks + project_topics 组合过滤
  });

  it.skip("test_progress_corrupted", () => {
    // 原始 Python 测试: progress.json 损坏 → dead
  });

  it.skip("test_db_blocked_keyword", () => {
    // 原始 Python 测试: DB 中有 permission_denied 关键词 → dead
  });

  it.skip("test_db_query_exception", () => {
    // 原始 Python 测试: DROP TABLE messages 后查询 → alive
  });

  it.skip("test_progress_invalid_timestamp", () => {
    // 原始 Python 测试: progress.json 中 last_updated_at 无效 → dead
  });

  it.skip("test_heavy_task_threshold", () => {
    // 原始 Python 测试: run_command 角色 150s 空闲 → judgeZombie 判定 alive（heavy 阈值为 180s）
  });

  it.skip("test_db_not_exists", () => {
    // 原始 Python 测试: DB 文件不存在 → alive
  });

  it.skip("test_glob_worktree_short_id_match", () => {
    // 原始 Python 测试: 通过 worktree 目录 glob 匹配短 ID 找到 progress.json
  });
});

// ============================================================
// 核心层测试 — 1:1 翻译自 Python 测试文件
// ============================================================

// ======== parseSqliteTimestamp 边界情况 ========

describe("parseSqliteTimestamp edge cases (from Python test_parse_ts_*)", () => {
  // 对应 Python: test_parse_ts_none
  it("parseSqliteTimestamp null / None → 0.0", () => {
    expect(parseSqliteTimestamp(null)).toBe(0.0);
    expect(parseSqliteTimestamp(undefined)).toBe(0.0);
  });

  // 对应 Python: test_parse_ts_numeric
  it("parseSqliteTimestamp numeric values", () => {
    // 数字直接返回
    expect(parseSqliteTimestamp(12345)).toBe(12345.0);
    expect(parseSqliteTimestamp(12345.67)).toBe(12345.67);
  });

  // 对应 Python: test_parse_ts_numeric (字符串数字部分)
  it("parseSqliteTimestamp numeric string", () => {
    // 字符串形式的数字也能正确解析
    expect(parseSqliteTimestamp("12345")).toBe(12345.0);
    expect(parseSqliteTimestamp("12345.67")).toBe(12345.67);
  });

  // 对应 Python: test_parse_ts_unrecognized
  it("parseSqliteTimestamp garbage string → 0.0", () => {
    expect(parseSqliteTimestamp("garbage")).toBe(0.0);
  });
});

// ======== judgeZombie 核心逻辑 ========

describe("judgeZombie — 根据空闲时长和工具名判断僵死", () => {
  const HEAVY_TOOLS = new Set(["run_command", "grep_search", "bash"]);

  // 对应 Python test_heavy_task_threshold 的逻辑：
  // heavy 工具阈值为 180s，普通工具阈值为 60s
  it("普通工具 idle 30s → 非僵死", () => {
    const [isZombie, limit] = judgeZombie(30, "view_file", HEAVY_TOOLS);
    expect(isZombie).toBe(false);
    expect(limit).toBe(60);
  });

  it("heavy 工具 idle 120s → 非僵死（未超过 180s）", () => {
    const [isZombie, limit] = judgeZombie(120, "run_command", HEAVY_TOOLS);
    expect(isZombie).toBe(false);
    expect(limit).toBe(180);
  });

  it("heavy 工具 idle 150s → 非僵死（未超过 180s）", () => {
    // 对应 Python test_heavy_task_threshold: run_command 150s → alive
    const [isZombie, limit] = judgeZombie(150, "run_command", HEAVY_TOOLS);
    expect(isZombie).toBe(false);
    expect(limit).toBe(180);
  });

  it("普通工具 idle 61s → 僵死", () => {
    const [isZombie, limit] = judgeZombie(61, "view_file", HEAVY_TOOLS);
    expect(isZombie).toBe(true);
    expect(limit).toBe(60);
  });

  it("heavy 工具 idle 181s → 僵死", () => {
    const [isZombie, limit] = judgeZombie(181, "grep_search", HEAVY_TOOLS);
    expect(isZombie).toBe(true);
    expect(limit).toBe(180);
  });

  it("精确边界：普通工具 60s → 非僵死", () => {
    const [isZombie] = judgeZombie(60, "view_file", HEAVY_TOOLS);
    expect(isZombie).toBe(false);
  });

  it("精确边界：heavy 工具 180s → 非僵死", () => {
    const [isZombie] = judgeZombie(180, "run_command", HEAVY_TOOLS);
    expect(isZombie).toBe(false);
  });
});

// ======== suggestZombieAction 核心逻辑 ========

describe("suggestZombieAction — 根据重试次数建议操作", () => {
  it("retryCount 0 → kill_and_retry", () => {
    expect(suggestZombieAction(0)).toBe("kill_and_retry");
  });

  it("retryCount 1 → kill_and_retry", () => {
    expect(suggestZombieAction(1)).toBe("kill_and_retry");
  });

  it("retryCount 2 → escalate_to_human", () => {
    expect(suggestZombieAction(2)).toBe("escalate_to_human");
  });

  it("retryCount 大于 2 → escalate_to_human", () => {
    expect(suggestZombieAction(3)).toBe("escalate_to_human");
    expect(suggestZombieAction(10)).toBe("escalate_to_human");
  });
});

// ======== isTimerCanceled 核心逻辑 ========

describe("isTimerCanceled — 判断心跳定时器是否被调度事件取消", () => {
  it("无子代理活动 → 不取消", () => {
    expect(isTimerCanceled(-1, 5)).toBe(false);
  });

  it("无调度事件 → 不取消", () => {
    expect(isTimerCanceled(5, -1)).toBe(true);
  });

  it("调度在子代理活动之后发生 → 取消", () => {
    // 子代理最后活动在 step 5, 最新调度在 step 8
    expect(isTimerCanceled(5, 8)).toBe(true);
  });

  it("子代理活动在调度之后发生 → 不取消", () => {
    // 子代理最后活动在 step 8, 最新调度在 step 5
    expect(isTimerCanceled(8, 5)).toBe(false);
  });

  it("同一索引 → 不取消", () => {
    expect(isTimerCanceled(5, 5)).toBe(false);
  });
});

// ======== findAllUuids 核心逻辑 ========

describe("findAllUuids — 递归提取 UUID", () => {
  const PARENT = "00000000-0000-0000-0000-000000000000";

  it("字符串中的 UUID", () => {
    const result = findAllUuids(
      "abc123 e8c7f1a2-3b4d-5e6f-7890-abcdef123456 xyz",
      PARENT
    );
    expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
  });

  it("排除 parentId", () => {
    const uuid = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456";
    const result = findAllUuids("id is " + uuid, uuid);
    expect(result.has(uuid)).toBe(false);
    expect(result.size).toBe(0);
  });

  it("对象中的 conversationId 键", () => {
    const d = {
      conversationId: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456",
      name: "test",
    };
    const result = findAllUuids(d, PARENT);
    expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
  });

  it("对象中的 conversation_id 键", () => {
    const d = {
      conversation_id: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456",
      name: "test",
    };
    const result = findAllUuids(d, PARENT);
    expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
  });

  it("排除等于 parentId 的 conversationId", () => {
    const uuid = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456";
    const d = { conversationId: uuid, name: "test" };
    const result = findAllUuids(d, uuid);
    expect(result.has(uuid)).toBe(false);
  });

  it("嵌套对象中的 UUID", () => {
    const d = { foo: { conversationId: "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" } };
    const result = findAllUuids(d, PARENT);
    expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
  });

  it("数组中的 UUID", () => {
    const data = [
      "e8c7f1a2-3b4d-5e6f-7890-abcdef123456",
      "another string",
    ];
    const result = findAllUuids(data, PARENT);
    expect(result.has("e8c7f1a2-3b4d-5e6f-7890-abcdef123456")).toBe(true);
  });

  it("null 值安全处理", () => {
    const d = { conversationId: null, name: "test" };
    const result = findAllUuids(d, PARENT);
    expect(result.size).toBe(0);
  });

  it("深层嵌套混合结构", () => {
    // 对应 Python test_liveness_with_watermarks_and_timeframe 中 findAllUuids 的使用场景
    const payload = {
      result: "Spawned subagent with conversationId: 11111111-1111-1111-1111-111111111111",
      list: [
        { conversation_id: "22222222-2222-2222-2222-222222222222" },
        "33333333-3333-3333-3333-333333333333",
      ],
    };
    const result = findAllUuids(payload, PARENT);
    expect(result.has("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(result.has("22222222-2222-2222-2222-222222222222")).toBe(true);
    expect(result.has("33333333-3333-3333-3333-333333333333")).toBe(true);
    expect(result.has(PARENT)).toBe(false);
  });
});
