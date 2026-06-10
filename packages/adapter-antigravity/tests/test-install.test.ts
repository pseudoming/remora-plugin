import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../src/schema/schema-init", () => ({
  initDb: vi.fn(),
}));

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remora-install-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function tmpPath(...parts: string[]): string {
  return path.join(tempRoot, ...parts);
}

import install from "../src/install";

describe("TestRenderString", () => {
  it("test_plugin_root_substitution", () => {
    const result = install.renderString("root={PLUGIN_ROOT}", "/opt/remora");
    expect(result).toBe("root=/opt/remora");
  });

  it("test_python_substitution", () => {
    // {PYTHON} is no longer substituted — TypeScript-only, no Python dependency
    const result = install.renderString("py={PYTHON}", "/opt/remora");
    expect(result).toBe("py={PYTHON}");
  });

  it("test_both_substitutions", () => {
    const result = install.renderString("{PLUGIN_ROOT}/bin {PYTHON}", "/p");
    expect(result).toBe("/p/bin {PYTHON}");
  });

  it("test_no_substitution_needed", () => {
    const result = install.renderString("plain text", "/p");
    expect(result).toBe("plain text");
  });
});

describe("TestDoWrite", () => {
  it("test_writes_file", () => {
    const p = tmpPath("test.json");
    install.dryRun = false;
    install.doWrite(p, "hello");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("hello");
  });

  it("test_creates_parent_dirs", () => {
    const p = tmpPath("deep", "nest", "test.json");
    install.dryRun = false;
    install.doWrite(p, "data");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("test_dry_run_skips_write", () => {
    const p = tmpPath("test.json");
    install.dryRun = true;
    install.doWrite(p, "hello");
    install.dryRun = false;
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe("TestDoCopy", () => {
  it("test_copies_file", () => {
    const src = tmpPath("src.txt");
    fs.writeFileSync(src, "content");
    const dst = tmpPath("dst.txt");
    install.dryRun = false;
    install.doCopy(src, dst);
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, "utf-8")).toBe("content");
  });

  it("test_skip_existing", () => {
    const src = tmpPath("src.txt");
    const dst = tmpPath("dst.txt");
    fs.writeFileSync(src, "new");
    fs.writeFileSync(dst, "old");
    install.dryRun = false;
    install.doCopy(src, dst, true);
    expect(fs.readFileSync(dst, "utf-8")).toBe("old");
  });

  it("test_dry_run_skips_copy", () => {
    const src = tmpPath("src.txt");
    fs.writeFileSync(src, "content");
    const dst = tmpPath("dst.txt");
    install.dryRun = true;
    install.doCopy(src, dst);
    install.dryRun = false;
    expect(fs.existsSync(dst)).toBe(false);
  });
});

describe("TestIdempotency", () => {
  it("test_already_installed_no_force", () => {
    const flagDir = tmpPath(".runtime");
    fs.mkdirSync(flagDir);
    fs.writeFileSync(path.join(flagDir, "installed.flag"), "installed");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    install.mainReal(
      tempRoot,
      tempRoot,
      flagDir,
      false,
      false,
      false,
    );

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("already installed");
    logSpy.mockRestore();
  });

  it("test_already_installed_with_force", () => {
    const flagDir = tmpPath(".runtime");
    fs.mkdirSync(flagDir);
    fs.writeFileSync(path.join(flagDir, "installed.flag"), "installed");

    const mockRender = vi.spyOn(install, "renderAllTemplates").mockImplementation(() => {});
    const mockWf = vi.spyOn(install, "deployWorkflows").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    install.mainReal(
      tempRoot,
      tempRoot,
      flagDir,
      true,
      false,
      false,
    );

    mockRender.mockRestore();
    mockWf.mockRestore();

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).not.toContain("already installed");
    logSpy.mockRestore();
  });
});

describe("TestMainEntry", () => {
  it("test_dry_run_flag", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    install.mainReal(
      tempRoot,
      tempRoot,
      tmpPath(".runtime"),
      false,
      true,
      false,
    );

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("[DRY-RUN]");
    logSpy.mockRestore();
  });
});

describe("TestUninstall", () => {
  it("test_removes_rendered_files", () => {
    const hooks = tmpPath("hooks.json");
    fs.writeFileSync(hooks, "x");

    const agents = tmpPath("agents");
    fs.mkdirSync(agents);
    fs.writeFileSync(path.join(agents, "test.json"), "x");
    fs.writeFileSync(path.join(agents, "test.template.json"), "x");

    const dataDir = tmpPath("data");
    const runtime = path.join(dataDir, ".runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const flag = path.join(runtime, "installed.flag");
    fs.writeFileSync(flag, "x");

    install.dryRun = false;
    install.doUninstall(dataDir, tempRoot);

    expect(fs.existsSync(hooks)).toBe(false);
    expect(fs.existsSync(path.join(agents, "test.json"))).toBe(false);
    expect(fs.existsSync(path.join(agents, "test.template.json"))).toBe(true);
    expect(fs.existsSync(flag)).toBe(false);
  });

  it("test_uninstall_dry_run_preserves_files", () => {
    const hooks = tmpPath("hooks.json");
    fs.writeFileSync(hooks, "x");

    const dataDir = tmpPath("data");
    const runtime = path.join(dataDir, ".runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const flag = path.join(runtime, "installed.flag");
    fs.writeFileSync(flag, "x");

    install.dryRun = true;
    install.doUninstall(dataDir, tempRoot);
    install.dryRun = false;

    expect(fs.existsSync(hooks)).toBe(true);
    expect(fs.existsSync(flag)).toBe(true);
  });
});

describe("TestRenderAllTemplates", () => {
  it("test_renders_hooks_and_sidecars", () => {
    const confTemplates = tmpPath("conf", "templates");
    fs.mkdirSync(confTemplates, { recursive: true });
    fs.writeFileSync(path.join(confTemplates, "hooks.template.json"), '{"root": "{PLUGIN_ROOT}"}');
    const sidecarDir = tmpPath("sidecars", "memory-compactor");
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(confTemplates, "sidecar.template.json"), '{"root": "{PLUGIN_ROOT}"}');
    const skillsDir = tmpPath("skills", "remora-architecture");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(confTemplates, "SKILL.template.md"), "{PLUGIN_ROOT}");
    const agentsDir = tmpPath("agents");
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, "test.template.json"), "{PYTHON}");

    install.dryRun = false;
    install.renderAllTemplates(tempRoot);

    expect(fs.existsSync(tmpPath("hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(sidecarDir, "sidecar.json"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, "test.json"))).toBe(true);

    const content = fs.readFileSync(tmpPath("hooks.json"), "utf-8");
    expect(content).toContain(tempRoot);
  });

  it("test_dry_run_skips_render", () => {
    const confTemplates = tmpPath("conf", "templates");
    fs.mkdirSync(confTemplates, { recursive: true });
    fs.writeFileSync(path.join(confTemplates, "hooks.template.json"), "{}");

    install.dryRun = true;
    install.renderAllTemplates(tempRoot);
    install.dryRun = false;

    expect(fs.existsSync(tmpPath("hooks.json"))).toBe(false);
  });
});
