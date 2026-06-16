import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initDb } from "./schema/schema-init";
import { getGeminiConfigDir } from "./bridge/paths";

let _dryRun = false;

function log(msg: string): void {
	console.log(msg);
}

function doWrite(filePath: string, content: string): void {
	if (_dryRun) {
		log(`[DRY-RUN] Would write: ${filePath}`);
		return;
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
	log(`  Wrote: ${filePath}`);
}

function doCopy(src: string, dst: string, skipExisting = false): void {
	if (skipExisting && fs.existsSync(dst)) {
		log(`  Skip: ${dst} (already exists)`);
		return;
	}
	if (_dryRun) {
		log(`[DRY-RUN] Would copy: ${src} → ${dst}`);
		return;
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
	log(`  Copied: ${src} → ${dst}`);
}

function findPluginRoot(): string {
	let dir = path.resolve(__dirname);
	while (dir !== "/" && dir !== "") {
		if (fs.existsSync(path.join(dir, "plugin.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(
		"FATAL: Cannot find plugin.json to anchor PLUGIN_ROOT. Are you running outside the plugin directory?",
	);
}

function renderString(content: string, pluginRoot: string): string {
	return content.replace(/\{PLUGIN_ROOT\}/g, pluginRoot);
}

function renderTemplate(src: string, dst: string, pluginRoot: string): void {
	if (!fs.existsSync(src)) return;
	const content = renderString(fs.readFileSync(src, "utf-8"), pluginRoot);
	doWrite(dst, content);
}

function renderAllTemplates(sourceRoot: string, targetRoot: string): void {
	const templateDir = path.join(sourceRoot, "conf", "templates");
	const templates: [string, string][] = [
		[
			path.join(templateDir, "hooks.template.json"),
			path.join(targetRoot, "hooks.json"),
		],
		[
			path.join(templateDir, "sidecar.template.json"),
			path.join(targetRoot, "sidecars", "memory-compactor", "sidecar.json"),
		],
		[
			path.join(templateDir, "SKILL.template.md"),
			path.join(targetRoot, "skills", "remora-architecture", "SKILL.md"),
		],
		[
			path.join(templateDir, "mcp_config.template.json"),
			path.join(targetRoot, "mcp_config.json"),
		],
	];

	const agentsSrc = path.join(templateDir, "agents");
	const agentsDst = path.join(targetRoot, "agents");
	if (fs.existsSync(agentsSrc)) {
		for (const f of fs.readdirSync(agentsSrc).sort()) {
			if (f.endsWith(".template.json")) {
				const src = path.join(agentsSrc, f);
				const dst = path.join(agentsDst, f.replace(".template.json", ".json"));
				const content = renderString(fs.readFileSync(src, "utf-8"), targetRoot);
				doWrite(dst, content);
			}
		}
	}

	log("\n[1/3] Rendering templates...");
	for (const [src, dst] of templates) {
		renderTemplate(src, dst, targetRoot);
	}
}

function deployWorkflows(sourceRoot: string, targetRoot: string): void {
	const workflowsSrc = path.join(sourceRoot, "conf", "templates", "workflows");
	const workflowsDst = path.join(getGeminiConfigDir(), "global_workflows");

	if (!fs.existsSync(workflowsSrc)) return;

	log("\n[2/3] Deploying workflows...");
	for (const f of fs.readdirSync(workflowsSrc).sort()) {
		if (!f.endsWith(".md")) continue;
		const src = path.join(workflowsSrc, f);
		const dst = path.join(workflowsDst, f);
		const content = renderString(fs.readFileSync(src, "utf-8"), targetRoot);
		doWrite(dst, content);
	}
}

function mergeMcpConfig(pluginRoot: string): void {
	const serverConfig = {
		command: "node",
		args: [
			path.join(pluginRoot, "packages/adapter-antigravity/dist/mcp/git-mcp.js"),
		],
	};

	const globalConfigs = [
		path.join(getGeminiConfigDir(), "mcp_config.json"),
		path.join(
			path.dirname(getGeminiConfigDir()),
			"antigravity-ide",
			"mcp_config.json",
		),
	];

	log("\n[2.5/3] Merging MCP configuration...");
	for (const configPath of globalConfigs) {
		if (!fs.existsSync(configPath)) {
			log(`  Config file not found, skipping: ${configPath}`);
			continue;
		}
		try {
			const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			if (!data.mcpServers) {
				data.mcpServers = {};
			}
			data.mcpServers["remora-git-mcp"] = serverConfig;

			if (_dryRun) {
				log(`[DRY-RUN] Would merge remora-git-mcp into ${configPath}`);
			} else {
				fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
				log(`  Merged remora-git-mcp into: ${configPath}`);
			}
		} catch (err: any) {
			log(
				`[WARNING] Failed to merge MCP config into ${configPath}: ${err.message}`,
			);
		}
	}
}

function unmergeMcpConfig(): void {
	const globalConfigs = [
		path.join(getGeminiConfigDir(), "mcp_config.json"),
		path.join(
			path.dirname(getGeminiConfigDir()),
			"antigravity-ide",
			"mcp_config.json",
		),
	];

	log("\nRemoving remora-git-mcp from global MCP configurations...");
	for (const configPath of globalConfigs) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			if (data.mcpServers && data.mcpServers["remora-git-mcp"]) {
				delete data.mcpServers["remora-git-mcp"];
				if (_dryRun) {
					log(`[DRY-RUN] Would remove remora-git-mcp from ${configPath}`);
				} else {
					fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
					log(`  Removed remora-git-mcp from: ${configPath}`);
				}
			}
		} catch (err: any) {
			log(
				`[WARNING] Failed to remove MCP config from ${configPath}: ${err.message}`,
			);
		}
	}
}

function resolvePaths(pluginRoot: string): [string, string] {
	let dataDir: string;
	try {
		fs.accessSync(pluginRoot, fs.constants.W_OK);
		dataDir = path.join(pluginRoot, "data");
	} catch {
		dataDir = path.join(os.homedir(), ".remora", "data");
	}
	const runtimeDir = path.join(dataDir, ".runtime");
	return [dataDir, runtimeDir];
}

function doRemove(filePath: string): void {
	if (_dryRun) {
		log(`[DRY-RUN] Would remove: ${filePath}`);
		return;
	}
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
		log(`  Removed: ${filePath}`);
	}
}

function doUninstall(
	dataDir: string,
	pluginRoot: string,
	purge: boolean,
): void {
	log("Uninstalling Remora Plugin...");

	unmergeMcpConfig();

	const flag = path.join(dataDir, ".runtime", "installed.flag");
	doRemove(flag);

	// 1. Terminate compactor process
	const lockFile = path.join(dataDir, "compactor.lock");
	if (fs.existsSync(lockFile)) {
		const pidStr = fs.readFileSync(lockFile, "utf-8").trim();
		const pid = parseInt(pidStr, 10);
		if (!isNaN(pid)) {
			let cmdline = "";
			let exists = false;
			try {
				cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
				exists = true;
			} catch (err) {
				log(`[WARNING] Process with PID ${pid} cmdline read failed: ${err}`);
			}
			if (
				exists &&
				cmdline &&
				cmdline.includes("node") &&
				(cmdline.includes("compactor") || cmdline.includes("remora-plugin"))
			) {
				log(`Terminating background compactor (PID: ${pid})...`);
				if (_dryRun) {
					log(`[DRY-RUN] Would terminate background compactor (PID: ${pid})`);
				} else {
					try {
						process.kill(pid, "SIGTERM");
						let alive = true;
						for (let i = 0; i < 6; i++) {
							try {
								process.kill(pid, 0);
							} catch {
								alive = false;
								break;
							}
							try {
								require("node:child_process").execSync("sleep 0.5");
							} catch {}
						}
						if (alive) {
							log(
								`Compactor process ${pid} did not exit in 3s. Sending SIGKILL...`,
							);
							try {
								process.kill(pid, "SIGKILL");
							} catch {}
						}
					} catch (err) {
						log(`[WARNING] Error trying to kill compactor PID ${pid}: ${err}`);
					}
				}
				doRemove(lockFile);
			} else {
				log(
					`[WARNING] PID ${pid} in lock file does not match compactor process. Skipping termination.`,
				);
			}
		}
	}

	// 2. Remove workflows
	const workflowsDir = path.join(pluginRoot, "conf", "templates", "workflows");
	let workflowsList: string[] = [];
	try {
		if (fs.existsSync(workflowsDir)) {
			workflowsList = fs
				.readdirSync(workflowsDir)
				.filter((f) => f.endsWith(".md"));
		}
	} catch (err) {
		log(
			`[WARNING] Failed to read workflows directory: ${err}. Falling back to static list.`,
		);
	}

	if (workflowsList.length === 0) {
		workflowsList = [
			"confirm.md",
			"remora_coordinator.md",
			"topic.md",
			"retro.md",
		];
	}

	const globalWorkflowsDir = path.join(
		getGeminiConfigDir(),
		"global_workflows",
	);
	for (const wf of workflowsList) {
		const p = path.join(globalWorkflowsDir, wf);
		doRemove(p);
	}

	// 3. Remove virtual project config
	const projectConfig = path.join(
		getGeminiConfigDir(),
		"projects",
		"11111111-1111-1111-1111-111111111111.json",
	);
	doRemove(projectConfig);

	const rendered = [
		"hooks.json",
		"sidecars/memory-compactor/sidecar.json",
		"skills/remora-architecture/SKILL.md",
	];
	for (const rel of rendered) {
		doRemove(path.join(pluginRoot, rel));
	}

	const agentsDir = path.join(pluginRoot, "agents");
	if (fs.existsSync(agentsDir)) {
		for (const f of fs.readdirSync(agentsDir)) {
			if (f.endsWith(".json") && !f.endsWith(".template.json")) {
				doRemove(path.join(agentsDir, f));
			}
		}
	}

	// 4. Data directory --purge
	if (purge) {
		if (_dryRun) {
			log(`[DRY-RUN] Would purge data directory: ${dataDir}`);
		} else {
			if (fs.existsSync(dataDir)) {
				fs.rmSync(dataDir, { recursive: true, force: true });
				log(`  Purged data directory: ${dataDir}`);
			}
		}
	}

	// 5. Target directory self-cleaning
	if (_dryRun) {
		log(`[DRY-RUN] Would remove plugin root directory: ${pluginRoot}`);
	} else {
		if (fs.existsSync(pluginRoot)) {
			fs.rmSync(pluginRoot, { recursive: true, force: true });
			log(`  Removed plugin root directory: ${pluginRoot}`);
		}
	}

	log("Uninstall complete.");
}

function mainReal(
	pluginRoot: string,
	dataDir: string,
	runtimeDir: string,
	force = false,
	dryRunParam = false,
	uninstall = false,
	sourcePluginRoot?: string,
	purge = false,
): void {
	const flagPath = path.join(runtimeDir, "installed.flag");

	if (uninstall) {
		doUninstall(dataDir, pluginRoot, purge);
		return;
	}

	_dryRun = dryRunParam;

	if (fs.existsSync(flagPath) && !force && !_dryRun) {
		log("Remora is already installed. Use --force to reinstall.");
		return;
	}

	const srcRoot = sourcePluginRoot ?? pluginRoot;
	renderAllTemplates(srcRoot, pluginRoot);
	deployWorkflows(srcRoot, pluginRoot);
	mergeMcpConfig(pluginRoot);

	log("\n[3/3] Initializing database...");
	const dbPath = path.join(dataDir, "remora_memory.db");
	process.env.REMORA_DB_PATH = dbPath;
	fs.mkdirSync(dataDir, { recursive: true });
	if (!_dryRun) {
		if (fs.existsSync(dbPath)) {
			const backupPath = `${dbPath}.bak`;
			try {
				fs.copyFileSync(dbPath, backupPath);
				log(`  Created database backup at: ${backupPath}`);
			} catch (err) {
				log(`  [WARNING] Failed to create database backup: ${err}`);
			}
			log(
				`  Existing database found: ${dbPath} (Preserving data & applying migrations)`,
			);
		} else {
			log(`  Initializing new database at: ${dbPath}`);
		}
		initDb();
		log(`  DB initialized successfully.`);
	} else {
		log(`[DRY-RUN] Would init DB at: ${dbPath}`);
	}

	const isTest = !!(process.env.VITEST || process.env.NODE_ENV === "test");
	if (!isTest) {
		const coreDistPath = path.join(pluginRoot, "packages", "core", "dist");
		if (!fs.existsSync(coreDistPath)) {
			log(
				`  packages/core/dist not found. Building workspace packages/core...`,
			);
			try {
				const { execSync } = require("node:child_process");
				execSync("npm run build --workspace=packages/core", {
					cwd: pluginRoot,
					stdio: "inherit",
					env: process.env,
				});
				log(`  packages/core built successfully.`);
			} catch (err) {
				log(`  [ERROR] Failed to build packages/core: ${err}`);
				throw err;
			}
		}
	}

	doWrite(flagPath, "installed");

	log("\nInstallation complete.");
	log("Set REMORA_DB_PATH env var to customize database location.");
	log(`Current DB path: ${dbPath}`);
}

export function main(): void {
	const argv = process.argv.slice(2);
	let force = false;
	let dryRunFlag = false;
	let uninstall = false;
	let purge = false;

	for (const arg of argv) {
		if (arg === "--force") force = true;
		else if (arg === "--dry-run") dryRunFlag = true;
		else if (arg === "--uninstall") uninstall = true;
		else if (arg === "--purge") purge = true;
		else if (arg === "--help" || arg === "-h") {
			console.log(
				"remora-install [--force] [--dry-run] [--uninstall] [--purge]",
			);
			console.log("  --force      Reinstall (skip idempotent check)");
			console.log("  --dry-run    Preview (no writes)");
			console.log("  --uninstall  Uninstall");
			console.log(
				"  --purge      Purge database and data directory during uninstall",
			);
			return;
		}
	}

	const targetPluginRoot = path.join(
		getGeminiConfigDir(),
		"plugins",
		"remora-plugin",
	);
	let actualPluginRoot = targetPluginRoot;
	let devPluginRoot: string | undefined = undefined;

	if (!uninstall) {
		devPluginRoot = findPluginRoot();
		actualPluginRoot = devPluginRoot;
	}

	const isTest = !!(process.env.VITEST || process.env.NODE_ENV === "test");

	if (
		!uninstall &&
		!isTest &&
		devPluginRoot &&
		path.resolve(devPluginRoot) !== path.resolve(targetPluginRoot)
	) {
		log(
			`\nDeploying from source: ${devPluginRoot} → target: ${targetPluginRoot}`,
		);

		if (dryRunFlag) {
			log(`[DRY-RUN] Would check and remove symlink at ${targetPluginRoot}`);
			log(
				`[DRY-RUN] Would sync files via rsync from ${devPluginRoot} to ${targetPluginRoot}`,
			);
		} else {
			// 1. 检查并切断符号链接
			try {
				const stats = fs.lstatSync(targetPluginRoot);
				if (stats.isSymbolicLink()) {
					log(`  Removing existing symbolic link at ${targetPluginRoot}`);
					fs.unlinkSync(targetPluginRoot);
				}
			} catch (err) {
				// 忽略不存在的错误
			}

			// 2. 确保目录存在
			fs.mkdirSync(targetPluginRoot, { recursive: true });

			const rsyncCmd = `rsync -a --delete --exclude='.git' --exclude='scratch' --exclude='.pytest_cache' --exclude='data' --exclude='.runtime' --exclude='__pycache__/' --exclude='*.md' --exclude='docs/' --exclude='.agents/' --exclude='tests/' --exclude='src/' --exclude='tsconfig*.json' --exclude='tsconfig.build.json' --exclude='vitest.config.ts' --exclude='build.js' --exclude='conf/templates/' --exclude='.gitignore' --exclude='deploy.sh' --exclude='**/*.d.ts' --exclude='node_modules/.vite/' --exclude='node_modules/.vitest/' "${devPluginRoot}/" "${targetPluginRoot}/"`;

			log(`  Syncing files: ${rsyncCmd}`);
			try {
				const { execSync } = require("node:child_process");
				execSync(rsyncCmd, { stdio: "inherit" });
				log(`  Files synchronized successfully.`);

				// 物理清除目标运行目录中的开发期多余文件与源码
				const obsoleteItems = [
					"packages/adapter-antigravity/src",
					"packages/adapter-antigravity/tests",
					"packages/core/src",
					"packages/core/tests",
					"packages/adapter-antigravity/tsconfig.json",
					"packages/adapter-antigravity/tsconfig.build.json",
					"packages/adapter-antigravity/vitest.config.ts",
					"packages/adapter-antigravity/build.js",
					"packages/core/tsconfig.json",
					"packages/core/vitest.config.ts",
					"node_modules/.vite",
				];
				for (const rel of obsoleteItems) {
					const p = path.join(targetPluginRoot, rel);
					if (fs.existsSync(p)) {
						fs.rmSync(p, { recursive: true, force: true });
						log(`  Cleaned obsolete deployment asset: ${rel}`);
					}
				}

				// 递归清理 packages 内的类型声明 .d.ts 文件 (排除 node_modules)
				const cleanDts = (dir: string): void => {
					if (!fs.existsSync(dir)) return;
					for (const f of fs.readdirSync(dir)) {
						const p = path.join(dir, f);
						if (fs.statSync(p).isDirectory()) {
							if (f !== "node_modules") {
								cleanDts(p);
							}
						} else if (f.endsWith(".d.ts")) {
							fs.unlinkSync(p);
							log(
								`  Cleaned obsolete type declaration: ${p.slice(targetPluginRoot.length + 1)}`,
							);
						}
					}
				};
				cleanDts(path.join(targetPluginRoot, "packages"));
			} catch (err) {
				log(`  [WARNING] Sync via rsync failed: ${err}`);
				throw err;
			}
		}

		actualPluginRoot = targetPluginRoot;
	}

	const [dataDir, runtimeDir] = resolvePaths(actualPluginRoot);
	mainReal(
		actualPluginRoot,
		dataDir,
		runtimeDir,
		force,
		dryRunFlag,
		uninstall,
		devPluginRoot,
		purge,
	);
}

export default {
	get dryRun(): boolean {
		return _dryRun;
	},
	set dryRun(v: boolean) {
		_dryRun = v;
	},
	log,
	doWrite,
	doCopy,
	renderString,
	renderTemplate,
	renderAllTemplates,
	deployWorkflows,
	resolvePaths,
	doRemove,
	doUninstall,
	mainReal,
	main,
	findPluginRoot,
};
