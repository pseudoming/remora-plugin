#!/usr/bin/env python3
import os
import sys
import subprocess
import json
import shutil
import argparse

DRY_RUN = False

def log(msg):
    print(msg)

def do_write(path, content):
    if DRY_RUN:
        log(f"[DRY-RUN] Would write: {path}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    log(f"  Wrote: {path}")

def do_copy(src, dst, skip_existing=False):
    if skip_existing and os.path.exists(dst):
        log(f"  Skip: {dst} (already exists)")
        return
    if DRY_RUN:
        log(f"[DRY-RUN] Would copy: {src} → {dst}")
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    log(f"  Copied: {src} → {dst}")

def render_string(content, plugin_root):
    content = content.replace('{PLUGIN_ROOT}', plugin_root)
    content = content.replace('{PYTHON}', sys.executable)
    return content

def render_template(src, dst, plugin_root):
    if not os.path.exists(src):
        return
    with open(src, 'r', encoding='utf-8') as f:
        content = render_string(f.read(), plugin_root)
    do_write(dst, content)

def render_all_templates(plugin_root):
    """Render all .template files in the plugin tree."""

    templates = [
        (f"{plugin_root}/hooks.template.json", f"{plugin_root}/hooks.json"),
        (f"{plugin_root}/sidecars/memory-compactor/sidecar.template.json",
         f"{plugin_root}/sidecars/memory-compactor/sidecar.json"),
        (f"{plugin_root}/skills/remora-architecture/SKILL.template.md",
         f"{plugin_root}/skills/remora-architecture/SKILL.md"),
    ]

    agents_dir = os.path.join(plugin_root, "agents")
    if os.path.exists(agents_dir):
        for f in os.listdir(agents_dir):
            if f.endswith(".template.json"):
                templates.append(
                    (os.path.join(agents_dir, f),
                     os.path.join(agents_dir, f.replace(".template.json", ".json")))
                )

    log("\n[1/4] Rendering templates...")
    for src, dst in templates:
        render_template(src, dst, plugin_root)

def deploy_workflows(plugin_root):
    config_dir = os.path.expanduser("~/.gemini/config")
    workflows_src = os.path.join(plugin_root, "global_workflows")
    workflows_dst = os.path.join(config_dir, "global_workflows")

    if not os.path.exists(workflows_src):
        return

    log("\n[2/4] Deploying workflows...")
    for f in sorted(os.listdir(workflows_src)):
        if not f.endswith(".md"):
            continue
        src = os.path.join(workflows_src, f)
        dst = os.path.join(workflows_dst, f)
        with open(src, 'r', encoding='utf-8') as sf:
            content = render_string(sf.read(), plugin_root)
        do_write(dst, content)

def init_database(plugin_root, data_dir):
    log("\n[3/4] Initializing database schema...")
    schema_script = os.path.join(plugin_root, "scripts", "schema", "schema_init.py")
    db_path = os.path.join(data_dir, "remora_memory.db")

    os.makedirs(data_dir, exist_ok=True)

    if DRY_RUN:
        log(f"[DRY-RUN] Would run: {schema_script} with REMORA_DB_PATH={db_path}")
        return

    env = os.environ.copy()
    env["REMORA_DB_PATH"] = db_path
    subprocess.check_call([sys.executable, schema_script], env=env)
    log(f"  DB initialized: {db_path}")

def run_quality_gate(plugin_root):
    log("Running quality gate...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "unittest", "scripts.tests.test_quality_gate"],
            cwd=plugin_root
        )
    except subprocess.CalledProcessError:
        log("FATAL: Quality gate failed. Installation aborted.")
        sys.exit(1)

def resolve_paths(plugin_root):
    if os.access(plugin_root, os.W_OK):
        data_dir = os.path.join(plugin_root, "data")
    else:
        data_dir = os.path.expanduser("~/.remora/data")
    runtime_dir = os.path.join(data_dir, ".runtime")
    return data_dir, runtime_dir

def do_remove(path):
    if DRY_RUN:
        log(f"[DRY-RUN] Would remove: {path}")
        return
    if os.path.exists(path):
        os.remove(path)
        log(f"  Removed: {path}")


def do_uninstall(data_dir, plugin_root):
    log("Uninstalling Remora Plugin...")

    flag = os.path.join(data_dir, ".runtime", "installed.flag")
    do_remove(flag)

    rendered = [
        "hooks.json",
        "sidecars/memory-compactor/sidecar.json",
        "skills/remora-architecture/SKILL.md",
    ]
    for rel in rendered:
        target = os.path.join(plugin_root, rel)
        do_remove(target)

    agents_dir = os.path.join(plugin_root, "agents")
    if os.path.exists(agents_dir):
        for f in os.listdir(agents_dir):
            if f.endswith(".json") and not f.endswith(".template.json"):
                do_remove(os.path.join(agents_dir, f))

    log("Uninstall complete. Database and workflows preserved.")

def main_real(plugin_root, data_dir, runtime_dir, force=False, dry_run=False, uninstall=False):
    global DRY_RUN

    flag_path = os.path.join(runtime_dir, "installed.flag")

    if uninstall:
        do_uninstall(data_dir, plugin_root)
        return

    DRY_RUN = dry_run

    if os.path.exists(flag_path) and not force and not DRY_RUN:
        log("Remora is already installed. Use --force to reinstall.")
        return

    run_quality_gate(plugin_root)
    render_all_templates(plugin_root)
    deploy_workflows(plugin_root)
    init_database(plugin_root, data_dir)

    log("\n[4/4] Finalizing...")
    do_write(flag_path, "installed")

    log("\nInstallation complete.")
    log("Set REMORA_DB_PATH env var to customize database location.")
    log(f"Current DB path: {os.path.join(data_dir, 'remora_memory.db')}")

def main():
    parser = argparse.ArgumentParser(description="Remora Plugin Installer")
    parser.add_argument("--force", action="store_true",
                        help="Reinstall even if already installed")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview actions without making changes")
    parser.add_argument("--uninstall", action="store_true",
                        help="Remove installed plugin artifacts")
    args = parser.parse_args()

    plugin_root = os.path.abspath(os.path.dirname(__file__))
    data_dir, runtime_dir = resolve_paths(plugin_root)

    main_real(plugin_root, data_dir, runtime_dir,
              force=args.force, dry_run=args.dry_run, uninstall=args.uninstall)

if __name__ == "__main__":
    main()
