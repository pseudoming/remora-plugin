import { describe, it, expect } from "vitest";
import { inspectCommand, decodeBase64Token } from "../src/rules/inspector";

describe("DecodeBase64Token", () => {
    it("too short returns null", () => {
        expect(decodeBase64Token("short")).toBeNull();
    });

    it("invalid chars returns null", () => {
        expect(decodeBase64Token("A".repeat(20) + "!")).toBeNull();
    });

    it("valid returns decoded string", () => {
        const msg = "this is a longer message for base64";
        const token = Buffer.from(msg).toString("base64");
        expect(decodeBase64Token(token)).toBe(msg);
    });

    it("exception on bad utf-8 returns null", () => {
        const raw = Buffer.alloc(22, 0xff);
        const token = raw.toString("base64");
        expect(decodeBase64Token(token)).toBeNull();
    });
});

describe("RecursionDepth", () => {
    it("depth over 10 returns deny syntax_error", () => {
        const result = inspectCommand("echo", 11);
        expect(result).toEqual(["deny", "syntax_error"]);
    });
});

describe("DelimiterHandling", () => {
    it("semicolon splits commands catches deny", () => {
        expect(inspectCommand("echo 1 ; pytest")).toEqual(["deny", "test"]);
    });

    it("and or delimiters", () => {
        expect(inspectCommand("echo 1 && pytest")).toEqual(["deny", "test"]);
        expect(inspectCommand("echo 1 || pytest")).toEqual(["deny", "test"]);
    });

    it("pipe delimiter", () => {
        expect(inspectCommand("echo 1 | pytest")).toEqual(["deny", "test"]);
    });
});

describe("EnvVarExtraction", () => {
    it("env var extracted and skipped with no command", () => {
        expect(inspectCommand("VAR=hello")).toEqual(["allow", ""]);
    });

    it("multiple env vars extracted", () => {
        expect(inspectCommand("A=1 B=2 env")).toEqual(["allow", ""]);
    });

    it("env var does not consume flag like token", () => {
        expect(inspectCommand("-flag=value echo hi")).toEqual(["allow", ""]);
    });
});

describe("VariableReplacement", () => {
    it("var replaced in command", () => {
        expect(inspectCommand("VAR=sh $VAR -c pytest")).toEqual(["deny", "test"]);
    });

    it("var replaced with braces", () => {
        expect(inspectCommand('VAR=pytest echo ${VAR}')).toEqual(["allow", ""]);
    });

    it("env tracker persists across sub commands", () => {
        expect(inspectCommand("A=1 ; echo $A")).toEqual(["allow", ""]);
    });
});

describe("Base64Audit", () => {
    it("base64 decoded dangerous triggers deny", () => {
        const dangerousCmd = "echo 1 ; pytest xyz";
        const b64Token = Buffer.from(dangerousCmd).toString("base64");
        expect(inspectCommand(`echo ${b64Token}`)).toEqual(["deny", "test"]);
    });

    it.skip("base64 whitelisted token skipped", () => {
        // BASE64_WHITELIST is a non-exported module const — cannot patch in TS.
        // Original Python test used unittest.mock.patch("core.rules.inspector.BASE64_WHITELIST", [b64_token]).
        const dangerousCmd = "echo 1 ; pytest xyz";
        const b64Token = Buffer.from(dangerousCmd).toString("base64");
        // expect(inspectCommand(`echo ${b64Token}`)).toEqual(["allow", ""]);
    });

    it.skip("base64 decoded in whitelist skips inspection", () => {
        // BASE64_WHITELIST is a non-exported module const — cannot patch in TS.
        // Original Python test used unittest.mock.patch("core.rules.inspector.BASE64_WHITELIST", [dangerous_cmd]).
        const dangerousCmd = "echo 1 ; pytest xyz";
        const b64Token = Buffer.from(dangerousCmd).toString("base64");
        // expect(inspectCommand(`echo ${b64Token}`)).toEqual(["allow", ""]);
    });
});

describe("NestedShellCheck", () => {
    it("sh -c denies dangerous command", () => {
        expect(inspectCommand("sh -c pytest")).toEqual(["deny", "test"]);
    });

    it("bash -c denies dangerous command", () => {
        expect(inspectCommand('bash -c "pytest"')).toEqual(["deny", "test"]);
    });

    it("zsh -c denies dangerous command", () => {
        expect(inspectCommand('zsh -c "pytest"')).toEqual(["deny", "test"]);
    });

    it("dash -c denies dangerous command", () => {
        expect(inspectCommand('dash -c "pytest"')).toEqual(["deny", "test"]);
    });

    it("shell -c allows safe command", () => {
        expect(inspectCommand('sh -c "echo hello"')).toEqual(["allow", ""]);
    });

    it("shell -c with no code after flag", () => {
        expect(inspectCommand("sh -c")).toEqual(["allow", ""]);
    });
});

describe("EvalCheck", () => {
    it("eval denies dangerous", () => {
        expect(inspectCommand('eval "pytest"')).toEqual(["deny", "test"]);
    });

    it("eval allows safe", () => {
        expect(inspectCommand('eval "echo hello"')).toEqual(["allow", ""]);
    });
});

describe("PythonCheck", () => {
    it("python -c with pytest denied", () => {
        expect(inspectCommand('python -c "import pytest"')).toEqual(["deny", "test"]);
    });

    it("python -c with unittest denied", () => {
        expect(inspectCommand('python -c "import unittest"')).toEqual(["deny", "test"]);
    });

    it("python3 -c with pytest denied", () => {
        expect(inspectCommand('python3 -c "import pytest"')).toEqual(["deny", "test"]);
    });

    it("python -c safe code allowed", () => {
        expect(inspectCommand('python -c "print(\'hello\')"')).toEqual(["allow", ""]);
    });

    it("python -m pytest denied", () => {
        expect(inspectCommand("python -m pytest")).toEqual(["deny", "test"]);
    });

    it("python3 -m pytest denied", () => {
        expect(inspectCommand("python3 -m pytest")).toEqual(["deny", "test"]);
    });

    it("python -c no code after", () => {
        expect(inspectCommand("python -c")).toEqual(["allow", ""]);
    });
});

describe("NodeCheck", () => {
    it("node -e with jest denied", () => {
        expect(inspectCommand('node -e "const jest = require(\'jest\')"')).toEqual(["deny", "test"]);
    });

    it("node -e with vitest denied", () => {
        expect(inspectCommand('node -e "const vitest = require(\'vitest\')"')).toEqual(["deny", "test"]);
    });

    it("node -e with mocha denied", () => {
        expect(inspectCommand('node -e "const mocha = require(\'mocha\')"')).toEqual(["deny", "test"]);
    });

    it("node -e safe allowed", () => {
        expect(inspectCommand('node -e "console.log(\'hi\')"')).toEqual(["allow", ""]);
    });

    it("node -e no code after", () => {
        expect(inspectCommand("node -e")).toEqual(["allow", ""]);
    });
});

describe("StandardTestRules", () => {
    it("pytest direct", () => {
        expect(inspectCommand("pytest")).toEqual(["deny", "test"]);
    });

    it("pytest3 direct", () => {
        expect(inspectCommand("pytest3")).toEqual(["deny", "test"]);
    });

    it("jest direct", () => {
        expect(inspectCommand("jest")).toEqual(["deny", "test"]);
    });

    it("vitest direct", () => {
        expect(inspectCommand("vitest")).toEqual(["deny", "test"]);
    });

    it("gradlew test", () => {
        expect(inspectCommand("gradlew test")).toEqual(["deny", "test"]);
    });

    it("mvn test", () => {
        expect(inspectCommand("mvn test")).toEqual(["deny", "test"]);
    });

    it("npm test", () => {
        expect(inspectCommand("npm test")).toEqual(["deny", "test"]);
    });

    it("npm t", () => {
        expect(inspectCommand("npm t")).toEqual(["deny", "test"]);
    });

    it("npm run test", () => {
        expect(inspectCommand("npm run test")).toEqual(["deny", "test"]);
    });

    it("yarn test", () => {
        expect(inspectCommand("yarn test")).toEqual(["deny", "test"]);
    });

    it("yarn t", () => {
        expect(inspectCommand("yarn t")).toEqual(["deny", "test"]);
    });
});

describe("MonitoringAndDangerousCommands", () => {
    it("tail -f denied", () => {
        expect(inspectCommand("tail -f /var/log/syslog")).toEqual(["deny", "test"]);
    });

    it("journalctl denied", () => {
        expect(inspectCommand("journalctl -xe")).toEqual(["deny", "test"]);
    });

    it("find -exec denied", () => {
        expect(inspectCommand("find . -exec rm {} +")).toEqual(["deny", "test"]);
    });

    it("grep -r denied", () => {
        expect(inspectCommand("grep -r pattern .")).toEqual(["deny", "test"]);
    });

    it("grep -R denied", () => {
        expect(inspectCommand("grep -R pattern .")).toEqual(["deny", "test"]);
    });

    it("grep without recursive allowed", () => {
        expect(inspectCommand("grep pattern file")).toEqual(["allow", ""]);
    });

    it("grep multiple flags with r denied", () => {
        expect(inspectCommand("grep -nrl pattern .")).toEqual(["deny", "test"]);
    });

    it("sed -i denied", () => {
        expect(inspectCommand("sed -i s/foo/bar/g file")).toEqual(["deny", "test"]);
    });

    it("sed without -i allowed", () => {
        expect(inspectCommand("sed s/foo/bar/g file")).toEqual(["allow", ""]);
    });
});

describe("BuildRules", () => {
    it("npm run build denied", () => {
        expect(inspectCommand("npm run build")).toEqual(["deny", "build"]);
    });

    it("gradlew build denied", () => {
        expect(inspectCommand("gradlew build")).toEqual(["deny", "build"]);
    });

    it("mvn package denied", () => {
        expect(inspectCommand("mvn package")).toEqual(["deny", "build"]);
    });

    it("mvn install denied", () => {
        expect(inspectCommand("mvn install")).toEqual(["deny", "build"]);
    });
});

describe("InspectCommandEdgeCases", () => {
    it("empty tokens returns allow", () => {
        expect(inspectCommand("")).toEqual(["allow", ""]);
    });

    it("shlex failure fallback test match", () => {
        expect(inspectCommand('pytest "unclosed')).toEqual(["deny", "test"]);
    });

    it("shlex failure fallback build match", () => {
        expect(inspectCommand('npm run build "unclosed')).toEqual(["deny", "build"]);
    });

    it("shlex failure fallback no match", () => {
        expect(inspectCommand('echo "unclosed')).toEqual(["deny", "syntax_error"]);
    });
});

describe("AllowSafeCommands", () => {
    it("simple echo allowed", () => {
        expect(inspectCommand("echo hello")).toEqual(["allow", ""]);
    });

    it("ls allowed", () => {
        expect(inspectCommand("ls -la")).toEqual(["allow", ""]);
    });

    it("multiple allowed commands", () => {
        expect(inspectCommand("echo 1 ; echo 2 ; echo 3")).toEqual(["allow", ""]);
    });

    it("env var with safe command allowed", () => {
        expect(inspectCommand("MODE=production python script.py")).toEqual(["allow", ""]);
    });

    it("yarn run build allowed", () => {
        expect(inspectCommand("yarn run build")).toEqual(["allow", ""]);
    });
});

describe("DelimiterEdgeCases", () => {
    it("multiple delimiters sequential", () => {
        expect(inspectCommand("echo 1 ; ; echo 2")).toEqual(["allow", ""]);
    });

    it("leading semicolon", () => {
        expect(inspectCommand("; pytest")).toEqual(["deny", "test"]);
    });

    it("trailing semicolon", () => {
        expect(inspectCommand("echo 1 ;")).toEqual(["allow", ""]);
    });
});

describe("NpxCheck", () => {
    it("npx vitest denied", () => {
        expect(inspectCommand("npx vitest")).toEqual(["deny", "test"]);
    });

    it("npx jest@latest denied", () => {
        expect(inspectCommand("npx jest@latest")).toEqual(["deny", "test"]);
    });

    it("npx tsup denied", () => {
        expect(inspectCommand("npx tsup")).toEqual(["deny", "build"]);
    });

    it("npx run test denied", () => {
        expect(inspectCommand("npx run test")).toEqual(["deny", "test"]);
    });

    it("npx run build denied", () => {
        expect(inspectCommand("npx run build")).toEqual(["deny", "build"]);
    });

    it("npx tsc -w denied", () => {
        expect(inspectCommand("npx tsc -w")).toEqual(["deny", "build"]);
    });

    it("npx prettier allowed", () => {
        expect(inspectCommand("npx prettier --write .")).toEqual(["allow", ""]);
    });
});

describe("PnpmAndBunCheck", () => {
    it("pnpm vitest denied", () => {
        expect(inspectCommand("pnpm vitest")).toEqual(["deny", "test"]);
    });

    it("pnpm run test denied", () => {
        expect(inspectCommand("pnpm run test")).toEqual(["deny", "test"]);
    });

    it("pnpm tsup denied", () => {
        expect(inspectCommand("pnpm tsup")).toEqual(["deny", "build"]);
    });

    it("pnpm run build denied", () => {
        expect(inspectCommand("pnpm run build")).toEqual(["deny", "build"]);
    });

    it("pnpm prettier allowed", () => {
        expect(inspectCommand("pnpm prettier --write .")).toEqual(["allow", ""]);
    });

    it("bun test denied", () => {
        expect(inspectCommand("bun test")).toEqual(["deny", "test"]);
    });

    it("bun run build denied", () => {
        expect(inspectCommand("bun run build")).toEqual(["deny", "build"]);
    });

    it("bun vitest denied", () => {
        expect(inspectCommand("bun vitest")).toEqual(["deny", "test"]);
    });

    it("bun prettier allowed", () => {
        expect(inspectCommand("bun prettier --write .")).toEqual(["allow", ""]);
    });
});

describe("PbFileCheck", () => {
    it("denies command with .pb in tokens", () => {
        expect(inspectCommand("cat data.pb")).toEqual(["deny", "pb_read"]);
        expect(inspectCommand("python unpack.py --file=my_model.pb")).toEqual(["deny", "pb_read"]);
    });

    it("denies command with .pb in fallback regex", () => {
        expect(inspectCommand('cat "my_data.pb')).toEqual(["deny", "pb_read"]);
    });
});
describe("GitCommitEscapeCheck", () => {
    it("allows normal git commit", () => {
        expect(inspectCommand('git commit -m "feat: login functionality"')).toEqual(["allow", ""]);
    });

    it("denies git commit with newline escape", () => {
        expect(inspectCommand('git commit -m "feat: login\\nbreak"')).toEqual(["deny", "git_escape"]);
    });

    it("denies git commit with real newline", () => {
        expect(inspectCommand('git commit -m "feat: login\nbreak"')).toEqual(["deny", "git_escape"]);
    });

    it("denies git commit with consecutive asterisks", () => {
        expect(inspectCommand('git commit -m "feat: login ** critical"')).toEqual(["deny", "git_escape"]);
    });
});
