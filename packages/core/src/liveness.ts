const RELAX_PATTERN: RegExp = new RegExp('(草稿|想法|讨论|draft|brainstorm|discuss)', 'i');

/**
 * 移除消息中的 <system-reminder> 标签及其内容。
 */
export function cleanSystemReminders(text: string): string {
  return text.replace(/<system-reminder>.*?<\/system-reminder>/gs, '');
}

/**
 * 检测消息模式：strict / relax / alert。
 * 返回 [mode, matchedWord] 元组。
 */
export function detectMode(
  cleanMsg: string,
  relaxKeywords?: string[],
  alertKeywords?: string[]
): ['strict' | 'relax' | 'alert', string | null] {
  let mode: 'strict' | 'relax' | 'alert' = 'strict';
  let matchedWord: string | null = null;

  if (relaxKeywords && relaxKeywords.length > 0) {
    const lower = cleanMsg.toLowerCase();
    for (const kw of relaxKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        mode = 'relax';
        break;
      }
    }
  } else if (RELAX_PATTERN.test(cleanMsg)) {
    mode = 'relax';
  }

  if (alertKeywords && alertKeywords.length > 0) {
    const lower = cleanMsg.toLowerCase();
    for (const kw of alertKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        mode = 'alert';
        matchedWord = kw;
        break;
      }
    }
  }

  return [mode, matchedWord];
}

/**
 * 将 SQLite 时间戳（数字 / ISO 字符串 / SQLite 文本）统一转换为 Unix epoch 秒。
 */
export function parseSqliteTimestamp(tsVal: unknown): number {
  if (tsVal == null) return 0.0;
  if (typeof tsVal === 'number') return tsVal;

  const tsStr = String(tsVal).trim();

  // 尝试作为纯数字解析
  const num = Number(tsStr);
  if (!isNaN(num)) return num;

  // 剥离时区后缀 (+HH:MM 或 Z)
  const stripped = tsStr.replace(/[+Z].*$/, '');
  // 将空格分隔转换为 T 分隔以适配 ISO 8601
  const normalized = stripped.replace(' ', 'T');

  const ts = Date.parse(normalized + 'Z');
  if (!isNaN(ts)) return ts / 1000;

  return 0.0;
}

/**
 * 递归遍历任意嵌套结构（字符串/dict/list），提取除 parentId 外的所有 UUID。
 */
export function findAllUuids(val: unknown, parentId: string): Set<string> {
  const uuids = new Set<string>();

  if (typeof val === 'string') {
    const matches = val.match(
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi
    );
    if (matches) {
      for (const m of matches) {
        if (m !== parentId) {
          uuids.add(m);
        }
      }
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      for (const uuid of findAllUuids(item, parentId)) {
        uuids.add(uuid);
      }
    }
  } else if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'conversationId' || k === 'conversation_id') && typeof v === 'string') {
        if (v !== parentId) {
          uuids.add(v);
        }
      } else {
        for (const uuid of findAllUuids(v, parentId)) {
          uuids.add(uuid);
        }
      }
    }
  }

  return uuids;
}

/**
 * 根据空闲时长和工具名判断子代理是否僵死。
 * heavyTools 中的工具阈值为 180 秒，其余为 60 秒。
 * 返回 [isZombie, limit] 元组。
 */
export function judgeZombie(
  idleSeconds: number,
  toolName: string,
  heavyTools?: Set<string>
): [boolean, number] {
  const isHeavy = heavyTools ? heavyTools.has(toolName) : false;
  const limit = isHeavy ? 180 : 60;
  return [idleSeconds > limit, limit];
}

/**
 * 根据重试耗损给出操作建议。
 * retryCount < 2 → "kill_and_retry"，否则 → "escalate_to_human"
 */
export function suggestZombieAction(retryCount: number): string {
  return retryCount < 2 ? 'kill_and_retry' : 'escalate_to_human';
}

/**
 * 将时间戳字符串标准化为 "YYYY-MM-DD HH:MM:SS" 格式。
 */
export function formatTimestamp(tsStr?: string | null): string {
  if (!tsStr) {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }
  const cleaned = tsStr.replace('T', ' ').replace('Z', '');
  return cleaned.slice(0, 19);
}

/**
 * 判断心跳定时器是否被调度事件取消。
 */
export function isTimerCanceled(
  lastSubagentActivityIndex: number,
  latestScheduleIndex: number
): boolean {
  return (
    lastSubagentActivityIndex !== -1 &&
    (latestScheduleIndex === -1 || lastSubagentActivityIndex < latestScheduleIndex)
  );
}
