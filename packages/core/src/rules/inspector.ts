/**
 * Shell command inspection for deny/allow rules.
 *
 * Extracted from scripts/core/rules/inspector.py.
 * Pure business logic — no platform dependencies beyond Node.js stdlib.
 *
 * 审计 Shell 命令字符串，返回 ("deny", category) 或 ("allow", "").
 */

const BASE64_WHITELIST: string[] = [];

/**
 * Try to decode a token as base64. Returns the decoded string or null.
 * 尝试将 token 解码为 base64。成功返回解码字符串，否则返回 null。
 */
export function decodeBase64Token(token: string): string | null {
  if (
    token.length > 16 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(token)
  ) {
    try {
      const buf = Buffer.from(token, "base64");
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Simple shell tokeniser — splits a command string into tokens respecting
 * single/double quotes, backslash escapes, and whitespace.
 *
 * 简单 shell 分词器 — 按引号和空格将命令字符串拆分为 token 列表。
 */
function shellSplit(cmdStr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = cmdStr.length;

  while (i < n) {
    // 跳过空白
    if (/\s/.test(cmdStr[i])) {
      i++;
      continue;
    }

    // 注释：忽略行尾
    if (cmdStr[i] === "#") {
      break;
    }

    let token = "";
    // 引号内
    if (cmdStr[i] === '"' || cmdStr[i] === "'") {
      const quote = cmdStr[i];
      i++; // 跳过开始引号
      while (i < n && cmdStr[i] !== quote) {
        if (cmdStr[i] === "\\" && quote === '"' && i + 1 < n) {
          token += cmdStr[i + 1];
          i += 2;
        } else {
          token += cmdStr[i];
          i++;
        }
      }
      if (i >= n) throw new Error("No closing quotation");
      i++; // 跳过结束引号
    } else {
      // 无引号 token
      while (i < n && !/\s/.test(cmdStr[i])) {
        if (cmdStr[i] === "\\" && i + 1 < n) {
          token += cmdStr[i + 1];
          i += 2;
        } else {
          token += cmdStr[i];
          i++;
        }
      }
    }
    tokens.push(token);
  }

  return tokens;
}

/**
 * Reject certain deny commands (test/build) and nested interpreters.
 * 拒绝规则：拦截测试/构建命令以及嵌套执行。
 */
export type InspectionResult = ["deny", string] | ["allow", ""];

function inspectTokens(tokens: string[], depth: number = 0): InspectionResult {
  if (depth > 10) {
    return ["deny", "syntax_error"];
  }

  const subCommands: string[][] = [];
  let currentSub: string[] = [];
  const delimiters = new Set([";", "&&", "||", "|"]);

  for (const t of tokens) {
    if (delimiters.has(t)) {
      if (currentSub.length > 0) {
        subCommands.push(currentSub);
        currentSub = [];
      }
    } else {
      currentSub.push(t);
    }
  }
  if (currentSub.length > 0) {
    subCommands.push(currentSub);
  }

  const envTracker: Record<string, string> = {};

  for (let sub of subCommands) {
    if (sub.length === 0) continue;

    // 提取环境变量赋值
    while (
      sub.length > 0 &&
      sub[0].includes("=") &&
      !sub[0].startsWith("-")
    ) {
      const varPart = sub.shift()!;
      const eqIdx = varPart.indexOf("=");
      if (eqIdx !== -1) {
        const k = varPart.slice(0, eqIdx);
        const v = varPart.slice(eqIdx + 1);
        envTracker[k] = v;
      }
    }
    if (sub.length === 0) continue;

    // 替换变量
    const processedSub = sub.map((token) => {
      let replaced = token;
      for (const [k, v] of Object.entries(envTracker)) {
        replaced = replaced.replace("$" + k, v).replace("${" + k + "}", v);
      }
      return replaced;
    });

    const exe = processedSub[0];
    const args = processedSub.slice(1);

    // Base64 审计
    for (const token of processedSub) {
      if (BASE64_WHITELIST.includes(token)) continue;
      const decoded = decodeBase64Token(token);
      if (decoded && !BASE64_WHITELIST.includes(decoded)) {
        const [decision, cat] = inspectCommand(decoded, depth + 1);
        if (decision === "deny") {
          return [decision, cat];
        }
      }
    }

    // 嵌套解释器审计
    if (["sh", "bash", "zsh", "dash"].includes(exe)) {
      if (args.includes("-c")) {
        const idx = args.indexOf("-c");
        if (idx + 1 < args.length) {
          const innerCmd = args[idx + 1];
          const [decision, cat] = inspectCommand(innerCmd, depth + 1);
          if (decision === "deny") {
            return [decision, cat];
          }
        }
      }
    } else if (exe === "eval") {
      const innerCmd = args.join(" ");
      const [decision, cat] = inspectCommand(innerCmd, depth + 1);
      if (decision === "deny") {
        return [decision, cat];
      }
    } else if (exe === "python" || exe === "python3") {
      if (args.includes("-c")) {
        const idx = args.indexOf("-c");
        if (idx + 1 < args.length) {
          const code = args[idx + 1];
          if (/\b(pytest|unittest)\b/.test(code)) {
            return ["deny", "test"];
          }
        }
      }
      if (args.includes("-m") && args.includes("pytest")) {
        return ["deny", "test"];
      }
    } else if (exe === "node") {
      if (args.includes("-e")) {
        const idx = args.indexOf("-e");
        if (idx + 1 < args.length) {
          const code = args[idx + 1];
          if (/\b(jest|vitest|mocha)\b/.test(code)) {
            return ["deny", "test"];
          }
        }
      }
    }

    // 标准规则审计
    if (["pytest", "pytest3", "jest", "vitest"].includes(exe)) {
      return ["deny", "test"];
    }
    if (exe === "gradlew" && args.includes("test")) {
      return ["deny", "test"];
    }
    if (exe === "mvn" && args.includes("test")) {
      return ["deny", "test"];
    }
    if (exe === "npm" || exe === "yarn") {
      if (args.includes("test") || args.includes("t")) {
        return ["deny", "test"];
      }
      if (args.includes("run") && (args.includes("test") || args.includes("t"))) {
        return ["deny", "test"];
      }
    }

    if (exe === "tail" && args.includes("-f")) {
      return ["deny", "test"];
    }
    if (exe === "journalctl") {
      return ["deny", "test"];
    }
    if (exe === "find" && args.includes("-exec")) {
      return ["deny", "test"];
    }
    if (exe === "grep") {
      for (const flag of args) {
        if (flag.startsWith("-") && (flag.includes("r") || flag.includes("R"))) {
          return ["deny", "test"];
        }
      }
    }
    if (exe === "sed" && args.includes("-i")) {
      return ["deny", "test"];
    }

    if (exe === "npm" && args.includes("run") && args.includes("build")) {
      return ["deny", "build"];
    }
    if (["tsc", "tsup"].includes(exe)) {
      return ["deny", "build"];
    }
    if (exe === "gradlew" && args.includes("build")) {
      return ["deny", "build"];
    }
    if (exe === "mvn" && (args.includes("package") || args.includes("install"))) {
      return ["deny", "build"];
    }
  }

  return ["allow", ""];
}

/**
 * Inspect a shell command string and return a deny/allow decision.
 *
 * 审计 shell 命令字符串。返回 ["deny", category] 表示拦截，或 ["allow", ""] 表示放行。
 *
 * @param cmdStr - The raw shell command string to inspect.
 * @param depth  - Recursion depth guard (default 0, max 10).
 * @returns Tuple of [decision, category].
 */
export function inspectCommand(
  cmdStr: string,
  depth: number = 0
): InspectionResult {
  let tokens: string[];

  try {
    tokens = shellSplit(cmdStr);
  } catch {
    // shlex 失败时，回退到 regex
    const fallbackTest =
      /\b(pytest|jest|vitest|gradlew\s+test|mvn\s+test|npm\s+test|npm\s+run\s+test)\b/;
    const fallbackBuild =
      /\b(npm\s+run\s+build|gradlew\s+build|mvn\s+package|mvn\s+install|tsc|tsup)\b/;

    if (fallbackTest.test(cmdStr)) {
      return ["deny", "test"];
    }
    if (fallbackBuild.test(cmdStr)) {
      return ["deny", "build"];
    }
    return ["deny", "syntax_error"];
  }

  if (tokens.length === 0) {
    return ["allow", ""];
  }

  return inspectTokens(tokens, depth);
}
