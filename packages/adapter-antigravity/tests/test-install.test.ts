import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { mockFsState } = vi.hoisted(() => ({
	mockFsState: {
		mockReadFileSync: null as any,
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (path: any, options: any) => {
			if (mockFsState.mockReadFileSync) {
				const res = mockFsState.mockReadFileSync(path, options);
				if (res !== undefined) return res;
			}
			return actual.readFileSync(path, options);
		},
	};
});

let mockGeminiConfigDir = "";

vi.mock("../src/bridge/paths", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/bridge/paths")>();
	return {
		...actual,
		getGeminiConfigDir: () => mockGeminiConfigDir,
	};
});

vi.mock("../src/schema/schema-init", () => ({
	initDb: vi.fn(),
}));

let tempRoot: string;
let geminiConfigRoot: string;
let mockGeminiConfigDirSaved = "";

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remora-install-"));
	geminiConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remora-gemini-"));
	mockGeminiConfigDirSaved = mockGeminiConfigDir;
	mockGeminiConfigDir = geminiConfigRoot;
});

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
	fs.rmSync(geminiConfigRoot, { recursive: true, force: true });
	mockGeminiConfigDir = mockGeminiConfigDirSaved;
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

	it("test_unused_substitution", () => {
		// {UNUSED_MACRO} is not substituted — it's not a supported macro
		const result = install.renderString("py={UNUSED_MACRO}", "/opt/remora");
		expect(result).toBe("py={UNUSED_MACRO}");
	});

	it("test_plugin_root_and_unused_substitutions", () => {
		const result = install.renderString(
			"{PLUGIN_ROOT}/bin {UNUSED_MACRO}",
			"/p",
		);
		expect(result).toBe("/p/bin {UNUSED_MACRO}");
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

		install.mainReal(tempRoot, tempRoot, flagDir, false, false, false);

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("already installed");
		logSpy.mockRestore();
	});

	it("test_already_installed_with_force", () => {
		const flagDir = tmpPath(".runtime");
		fs.mkdirSync(flagDir);
		fs.writeFileSync(path.join(flagDir, "installed.flag"), "installed");

		const mockRender = vi
			.spyOn(install, "renderAllTemplates")
			.mockImplementation(() => {});
		const mockWf = vi
			.spyOn(install, "deployWorkflows")
			.mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		install.mainReal(tempRoot, tempRoot, flagDir, true, false, false);

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

		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-data-"));
		const runtime = path.join(dataDir, ".runtime");
		fs.mkdirSync(runtime, { recursive: true });
		const flag = path.join(runtime, "installed.flag");
		fs.writeFileSync(flag, "x");

		try {
			install.dryRun = false;
			install.doUninstall(dataDir, tempRoot, false);

			expect(fs.existsSync(tempRoot)).toBe(false);
			expect(fs.existsSync(flag)).toBe(false);
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
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
		install.doUninstall(dataDir, tempRoot, false);
		install.dryRun = false;

		expect(fs.existsSync(hooks)).toBe(true);
		expect(fs.existsSync(flag)).toBe(true);
	});

	it("test_uninstall_starts_without_source", () => {
		const spyFind = vi
			.spyOn(install, "findPluginRoot")
			.mockImplementation(() => {
				throw new Error("No source directory found");
			});
		const mockMainReal = vi
			.spyOn(install, "mainReal")
			.mockImplementation(() => {});

		const oldArgv = process.argv;
		process.argv = ["node", "install.js", "--uninstall"];

		try {
			expect(() => install.main()).not.toThrow();
		} finally {
			process.argv = oldArgv;
			spyFind.mockRestore();
			mockMainReal.mockRestore();
		}
	});

	it("test_workflows_dynamic_cleanup", () => {
		const workflowsSrcDir = path.join(
			tempRoot,
			"conf",
			"templates",
			"workflows",
		);
		fs.mkdirSync(workflowsSrcDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsSrcDir, "custom_flow.md"), "content");
		fs.writeFileSync(path.join(workflowsSrcDir, "retro.md"), "content");

		const globalWorkflowsDir = path.join(
			mockGeminiConfigDir,
			"global_workflows",
		);
		fs.mkdirSync(globalWorkflowsDir, { recursive: true });
		fs.writeFileSync(path.join(globalWorkflowsDir, "custom_flow.md"), "old");
		fs.writeFileSync(path.join(globalWorkflowsDir, "retro.md"), "old");

		const dataDir = tmpPath("data");
		install.dryRun = false;
		install.doUninstall(dataDir, tempRoot, false);

		expect(fs.existsSync(path.join(globalWorkflowsDir, "custom_flow.md"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(globalWorkflowsDir, "retro.md"))).toBe(
			false,
		);
	});

	it("test_workflows_static_cleanup_fallback", () => {
		const globalWorkflowsDir = path.join(
			mockGeminiConfigDir,
			"global_workflows",
		);
		fs.mkdirSync(globalWorkflowsDir, { recursive: true });
		fs.writeFileSync(path.join(globalWorkflowsDir, "confirm.md"), "old");
		fs.writeFileSync(path.join(globalWorkflowsDir, "retro.md"), "old");
		fs.writeFileSync(path.join(globalWorkflowsDir, "some_other.md"), "old");

		const dataDir = tmpPath("data");
		install.dryRun = false;
		install.doUninstall(dataDir, tempRoot, false);

		expect(fs.existsSync(path.join(globalWorkflowsDir, "confirm.md"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(globalWorkflowsDir, "retro.md"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(globalWorkflowsDir, "some_other.md"))).toBe(
			true,
		);
	});

	it("test_project_config_cleanup", () => {
		const projectDir = path.join(mockGeminiConfigDir, "projects");
		fs.mkdirSync(projectDir, { recursive: true });
		const projectFile = path.join(
			projectDir,
			"11111111-1111-1111-1111-111111111111.json",
		);
		fs.writeFileSync(projectFile, "{}");

		const dataDir = tmpPath("data");
		install.dryRun = false;
		install.doUninstall(dataDir, tempRoot, false);

		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("test_compactor_termination_match", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-data-"));
		const lockFile = path.join(dataDir, "compactor.lock");
		fs.writeFileSync(lockFile, "99999");

		mockFsState.mockReadFileSync = (file: any, options: any) => {
			if (typeof file === "string" && file.startsWith("/proc/99999/cmdline")) {
				return "node /path/to/compactor.js";
			}
			return undefined;
		};

		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("process ended");
		});

		try {
			install.dryRun = false;
			install.doUninstall(dataDir, tempRoot, false);

			expect(killSpy).toHaveBeenCalledWith(99999, "SIGTERM");
			expect(fs.existsSync(lockFile)).toBe(false);
		} finally {
			mockFsState.mockReadFileSync = null;
			killSpy.mockRestore();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("test_compactor_termination_no_match", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-data-"));
		const lockFile = path.join(dataDir, "compactor.lock");
		fs.writeFileSync(lockFile, "99999");

		mockFsState.mockReadFileSync = (file: any, options: any) => {
			if (typeof file === "string" && file.startsWith("/proc/99999/cmdline")) {
				return "python3 other_script.py";
			}
			return undefined;
		};

		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			return true as any;
		});

		try {
			install.dryRun = false;
			install.doUninstall(dataDir, tempRoot, false);

			expect(killSpy).not.toHaveBeenCalled();
			expect(fs.existsSync(lockFile)).toBe(true);
		} finally {
			mockFsState.mockReadFileSync = null;
			killSpy.mockRestore();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("test_purge_data_directory", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-data-"));
		fs.writeFileSync(path.join(dataDir, "some_db.db"), "db data");

		try {
			install.dryRun = false;
			install.doUninstall(dataDir, tempRoot, true);

			expect(fs.existsSync(dataDir)).toBe(false);
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("test_no_purge_preserves_data_directory", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-data-"));
		fs.writeFileSync(path.join(dataDir, "some_db.db"), "db data");

		try {
			install.dryRun = false;
			install.doUninstall(dataDir, tempRoot, false);

			expect(fs.existsSync(dataDir)).toBe(true);
			expect(fs.existsSync(path.join(dataDir, "some_db.db"))).toBe(true);
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe("TestRenderAllTemplates", () => {
	it("test_renders_hooks_and_sidecars", () => {
		const confTemplates = tmpPath("conf", "templates");
		fs.mkdirSync(confTemplates, { recursive: true });
		fs.writeFileSync(
			path.join(confTemplates, "hooks.template.json"),
			'{"root": "{PLUGIN_ROOT}"}',
		);
		const sidecarDir = tmpPath("sidecars", "memory-compactor");
		fs.mkdirSync(sidecarDir, { recursive: true });
		fs.writeFileSync(
			path.join(confTemplates, "sidecar.template.json"),
			'{"root": "{PLUGIN_ROOT}"}',
		);
		const skillsDir = tmpPath("skills", "remora-architecture");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(
			path.join(confTemplates, "SKILL.template.md"),
			"{PLUGIN_ROOT}",
		);
		const agentsTemplates = tmpPath("conf", "templates", "agents");
		fs.mkdirSync(agentsTemplates, { recursive: true });
		fs.writeFileSync(
			path.join(agentsTemplates, "test.template.json"),
			"{UNUSED_MACRO}",
		);
		const agentsDir = tmpPath("agents");
		fs.mkdirSync(agentsDir);

		install.dryRun = false;
		install.renderAllTemplates(tempRoot, tempRoot);

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
		install.renderAllTemplates(tempRoot, tempRoot);
		install.dryRun = false;

		expect(fs.existsSync(tmpPath("hooks.json"))).toBe(false);
	});
});
