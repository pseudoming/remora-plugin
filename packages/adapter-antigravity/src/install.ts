import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initDb } from "./schema/schema-init";

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
  throw new Error("FATAL: Cannot find plugin.json to anchor PLUGIN_ROOT. Are you running outside the plugin directory?");
}

function renderString(content: string, pluginRoot: string): string {
  return content.replace(/\{PLUGIN_ROOT\}/g, pluginRoot);
}

function renderTemplate(src: string, dst: string, pluginRoot: string): void {
  if (!fs.existsSync(src)) return;
  const content = renderString(fs.readFileSync(src, "utf-8"), pluginRoot);
  doWrite(dst, content);
}

function renderAllTemplates(pluginRoot: string): void {
  const templateDir = path.join(pluginRoot, "conf", "templates");
  const templates: [string, string][] = [
    [path.join(templateDir, "hooks.template.json"), path.join(pluginRoot, "hooks.json")],
    [path.join(templateDir, "sidecar.template.json"), path.join(pluginRoot, "sidecars", "memory-compactor", "sidecar.json")],
    [path.join(templateDir, "SKILL.template.md"), path.join(pluginRoot, "skills", "remora-architecture", "SKILL.md")],
  ];

  const agentsSrc = path.join(templateDir, "agents");
  const agentsDst = path.join(pluginRoot, "agents");
  if (fs.existsSync(agentsSrc)) {
    for (const f of fs.readdirSync(agentsSrc).sort()) {
      if (f.endsWith(".template.json")) {
        const src = path.join(agentsSrc, f);
        const dst = path.join(agentsDst, f.replace(".template.json", ".json"));
        const content = renderString(fs.readFileSync(src, "utf-8"), pluginRoot);
        doWrite(dst, content);
      }
    }
  }

  log("\n[1/3] Rendering templates...");
  for (const [src, dst] of templates) {
    renderTemplate(src, dst, pluginRoot);
  }
}

function deployWorkflows(pluginRoot: string): void {
  const workflowsSrc = path.join(pluginRoot, "conf", "templates", "workflows");
  const workflowsDst = path.join(os.homedir(), ".gemini", "config", "global_workflows");

  if (!fs.existsSync(workflowsSrc)) return;

  log("\n[2/3] Deploying workflows...");
  for (const f of fs.readdirSync(workflowsSrc).sort()) {
    if (!f.endsWith(".md")) continue;
    const src = path.join(workflowsSrc, f);
    const dst = path.join(workflowsDst, f);
    const content = renderString(fs.readFileSync(src, "utf-8"), pluginRoot);
    doWrite(dst, content);
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

function doUninstall(dataDir: string, pluginRoot: string): void {
  log("Uninstalling Remora Plugin...");

  const flag = path.join(dataDir, ".runtime", "installed.flag");
  doRemove(flag);

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

  log("Uninstall complete. Database and workflows preserved.");
}

function mainReal(
  pluginRoot: string,
  dataDir: string,
  runtimeDir: string,
  force = false,
  dryRunParam = false,
  uninstall = false,
): void {
  const flagPath = path.join(runtimeDir, "installed.flag");

  if (uninstall) {
    doUninstall(dataDir, pluginRoot);
    return;
  }

  _dryRun = dryRunParam;

  if (fs.existsSync(flagPath) && !force && !_dryRun) {
    log("Remora is already installed. Use --force to reinstall.");
    return;
  }

  renderAllTemplates(pluginRoot);
  deployWorkflows(pluginRoot);

  log("\n[3/3] Initializing database...");
  const dbPath = path.join(dataDir, "remora_memory.db");
  process.env.REMORA_DB_PATH = dbPath;
  fs.mkdirSync(dataDir, { recursive: true });
  if (!_dryRun) {
    initDb();
    log(`  DB initialized: ${dbPath}`);
  } else {
    log(`[DRY-RUN] Would init DB at: ${dbPath}`);
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

  for (const arg of argv) {
    if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRunFlag = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("remora-install [--force] [--dry-run] [--uninstall]");
      console.log("  --force      Reinstall (skip idempotent check)");
      console.log("  --dry-run    Preview (no writes)");
      console.log("  --uninstall  Uninstall");
      return;
    }
  }

  const devPluginRoot = findPluginRoot();
  const targetPluginRoot = path.join(os.homedir(), ".gemini", "config", "plugins", "remora-plugin");

  let actualPluginRoot = devPluginRoot;
  const isTest = !!(process.env.VITEST || process.env.NODE_ENV === "test");

  if (!isTest && path.resolve(devPluginRoot) !== path.resolve(targetPluginRoot)) {
    log(`\nDeploying from source: ${devPluginRoot} → target: ${targetPluginRoot}`);
    
    if (uninstall) {
      actualPluginRoot = targetPluginRoot;
    } else {
      if (dryRunFlag) {
        log(`[DRY-RUN] Would check and remove symlink at ${targetPluginRoot}`);
        log(`[DRY-RUN] Would sync files via rsync from ${devPluginRoot} to ${targetPluginRoot}`);
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

        // 3. 物理文件同步 (rsync)
        const rsyncCmd = `rsync -a --exclude='.git' --exclude='scratch' --exclude='.pytest_cache' --exclude='data' --exclude='.runtime' "${devPluginRoot}/" "${targetPluginRoot}/"`;
        log(`  Syncing files: ${rsyncCmd}`);
        try {
          const { execSync } = require("node:child_process");
          execSync(rsyncCmd, { stdio: "inherit" });
          log(`  Files synchronized successfully.`);
        } catch (err) {
          log(`  [WARNING] Sync via rsync failed: ${err}`);
          throw err;
        }
      }
      actualPluginRoot = targetPluginRoot;
    }
  }

  const [dataDir, runtimeDir] = resolvePaths(actualPluginRoot);
  mainReal(actualPluginRoot, dataDir, runtimeDir, force, dryRunFlag, uninstall);
}


export default {
  get dryRun(): boolean { return _dryRun; },
  set dryRun(v: boolean) { _dryRun = v; },
  log, doWrite, doCopy, renderString, renderTemplate,
  renderAllTemplates, deployWorkflows, resolvePaths,
  doRemove, doUninstall, mainReal, main, findPluginRoot,
};
