#!/usr/bin/env python3
import os
import sys
import subprocess
import shutil
import json
import glob
import stat
import urllib.parse

def render_template(src_path, dst_path, plugin_root):
    if not os.path.exists(src_path):
        return
    with open(src_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    content = content.replace('{PLUGIN_ROOT}', plugin_root)
    content = content.replace('{PLUGIN_ROOT_URI}', urllib.parse.quote(plugin_root, safe='/'))
    content = content.replace('{PYTHON}', sys.executable)
    
    with open(dst_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Rendered template: {dst_path}")

def main():
    plugin_root = os.path.abspath(os.path.dirname(__file__))
    if os.access(plugin_root, os.W_OK):
        data_dir = os.path.join(plugin_root, "data")
    else:
        data_dir = os.path.expanduser("~/.remora/data")
    runtime_dir = os.path.join(data_dir, ".runtime")
    config_dir = os.path.expanduser("~/.gemini/config")

    print(f"Installing Remora Plugin at {plugin_root}...")

    # 0. 质量门禁校验 (Quality Gate)
    print("Running Quality Gate static checks...")
    try:
        subprocess.check_call([sys.executable, "-m", "unittest", "scripts.tests.test_quality_gate"], cwd=plugin_root)
    except subprocess.CalledProcessError:
        print("❌ [FATAL] Quality Gate failed! The plugin codebase violates architecture rules (e.g., hardcoded absolute paths, unsafe reads).", file=sys.stderr)
        print("Installation aborted.", file=sys.stderr)
        sys.exit(1)

    # 1. 建立数据与运行时目录
    os.makedirs(runtime_dir, exist_ok=True)
    
    # 2. 模板渲染: agents, workflows, hooks.json, SKILL.md, mcp_config.json
    render_template(os.path.join(plugin_root, "hooks.template.json"), os.path.join(plugin_root, "hooks.json"), plugin_root)
    render_template(os.path.join(plugin_root, "sidecars", "memory-compactor", "sidecar.template.json"), os.path.join(plugin_root, "sidecars", "memory-compactor", "sidecar.json"), plugin_root)
    render_template(os.path.join(plugin_root, "skills", "remora-architecture", "SKILL.template.md"), os.path.join(plugin_root, "skills", "remora-architecture", "SKILL.md"), plugin_root)
    render_template(os.path.join(plugin_root, "mcp_config.template.json"), os.path.join(plugin_root, "mcp_config.json"), plugin_root)

    # ⚠️ 底座加载机制限制：
    # 底座（Antigravity）只会读取全局配置目录中的 `~/.gemini/config/mcp_config.json` 来加载 MCP 服务进程。
    # 插件局部目录下的 `mcp_config.json` 并不会被底座识别。
    # 因此，在此处必须将本插件生成的局部 MCP 配置，合并追加至全局配置文件中，以实现工具无感注册。
    global_mcp_config_path = os.path.join(config_dir, "mcp_config.json")
    local_mcp_config_path = os.path.join(plugin_root, "mcp_config.json")
    if os.path.exists(local_mcp_config_path):
        try:
            with open(local_mcp_config_path, 'r', encoding='utf-8') as lf:
                local_data = json.load(lf)
            
            global_data = {"mcpServers": {}}
            if os.path.exists(global_mcp_config_path):
                with open(global_mcp_config_path, 'r', encoding='utf-8') as gf:
                    global_data = json.load(gf)
            
            local_servers = local_data.get("mcpServers", {})
            global_servers = global_data.setdefault("mcpServers", {})
            for server_name, server_config in local_servers.items():
                global_servers[server_name] = server_config
            
            with open(global_mcp_config_path, 'w', encoding='utf-8') as gf:
                json.dump(global_data, gf, indent=2)
            print(f"Merged local MCP config into global: {global_mcp_config_path}")
        except Exception as e:
            print(f"⚠️ Failed to merge MCP config: {str(e)}", file=sys.stderr)
    
    agents_dir = os.path.join(plugin_root, "agents")
    if os.path.exists(agents_dir):
        for agent_file in os.listdir(agents_dir):
            if agent_file.endswith(".template.json"):
                dst_file = agent_file.replace(".template.json", ".json")
                render_template(os.path.join(agents_dir, agent_file), os.path.join(agents_dir, dst_file), plugin_root)
                
    workflows_dir = os.path.join(plugin_root, "global_workflows")
    if os.path.exists(workflows_dir):
        target_wf_dir = os.path.join(config_dir, "global_workflows")
        os.makedirs(target_wf_dir, exist_ok=True)
        for f in os.listdir(workflows_dir):
            if f.endswith(".md"):
                src_path = os.path.join(workflows_dir, f)
                dst_path = os.path.join(target_wf_dir, f)
                if not os.path.exists(dst_path):
                    # 工作流支持内存渲染，防污染源文件
                    with open(src_path, 'r', encoding='utf-8') as sf:
                        wf_content = sf.read()
                    wf_content = wf_content.replace('{PLUGIN_ROOT}', plugin_root)
                    if '{PLUGIN_ROOT_URI}' in wf_content:
                        import urllib.parse
                        wf_content = wf_content.replace('{PLUGIN_ROOT_URI}', urllib.parse.quote(plugin_root, safe='/'))
                    if '{PYTHON}' in wf_content:
                        wf_content = wf_content.replace('{PYTHON}', sys.executable)
                    with open(dst_path, 'w', encoding='utf-8') as df:
                        df.write(wf_content)
                    print(f"Deployed workflow: {dst_path}")
                else:
                    print(f"Workflow {dst_path} exists, skipping overwrite.")

    # 3. 迁移旧的 remora_memory.db (如果存在) 到 data 目录，防御占用
    old_db = os.path.expanduser("~/.gemini/sidecar_data/remora-plugin/memory-compactor/data/remora_memory.db")
    new_db = os.path.join(data_dir, "remora_memory.db")
    if os.path.exists(old_db) and not os.path.exists(new_db):
        wal_file = old_db + "-wal"
        shm_file = old_db + "-shm"
        if os.path.exists(wal_file) or os.path.exists(shm_file):
            print(f"⚠️ [WARNING] Old DB WAL/SHM files exist at {old_db}.", file=sys.stderr)
            print("If a sidecar is actively running, data corruption may occur during move. Please ensure processes are stopped.", file=sys.stderr)
        
        print(f"Migrating old database from {old_db} to {new_db}...")
        os.makedirs(os.path.dirname(new_db), exist_ok=True)
        for suffix in ["", "-wal", "-shm"]:
            old_f = old_db + suffix
            new_f = new_db + suffix
            if os.path.exists(old_f):
                shutil.move(old_f, new_f)
                
    # 清理 0 字节幽灵库（全量执行，防全新安装残留）
    root_db = os.path.join(plugin_root, "remora.db")
    if os.path.exists(root_db) and os.path.getsize(root_db) == 0:
        os.remove(root_db)

    # 4. 调用 schema_init.py 初始化数据库
    # 清理旧时代 init 脚本
    init_script = os.path.join(plugin_root, "remora_init.py")
    if os.path.exists(init_script):
        os.remove(init_script)

    schema_script = os.path.join(plugin_root, "scripts", "schema", "schema_init.py")
    if os.path.exists(schema_script):
        print("Initializing SQLite Database Schema...")
        subprocess.check_call([sys.executable, schema_script])

    # 5. 更新 config.json，注册 Sidecar，并生成默认沙箱项目
    project_id = "11111111-1111-1111-1111-111111111111"
    projects_dir = os.path.join(config_dir, 'projects')
    project_file = os.path.join(projects_dir, f"{project_id}.json")
    if not os.path.exists(project_file):
        os.makedirs(projects_dir, exist_ok=True)
        with open(project_file, 'w') as f:
            json.dump({
                "id": project_id,
                "name": "remora-system",
                "projectResources": {"resources": []}
            }, f, indent=2)
            
    config_file = os.path.join(config_dir, 'config.json')
    if os.path.exists(config_file):
        try:
            import fcntl
        except ImportError:
            fcntl = None
        with open(config_file, 'r+') as f:
            if fcntl:
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    print("config.json is locked by another process, skipping sidecar registration.")
                    return
            config_data = json.load(f)
            sidecars = config_data.setdefault("sidecars", {})
            compactor_key = "remora-plugin/memory-compactor"
            if compactor_key not in sidecars:
                sidecars[compactor_key] = {
                    "enabled": False,
                    "projectId": project_id
                }
                f.seek(0)
                json.dump(config_data, f, indent=2)
                f.truncate()
                print(f"Registered sidecar {compactor_key} into config.json")
            
    # 6. 赋予执行权限

        
    for pattern in ["scripts/**/*.py", "scripts/**/*.sh", "sidecars/memory-compactor/*.py", "install.py", "mcp_config.json"]:
        for file_path in glob.glob(os.path.join(plugin_root, pattern), recursive=True):
            if os.path.exists(file_path):
                st = os.stat(file_path)
                os.chmod(file_path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # 7. 写入运行时安装标志位
    flag_path = os.path.join(runtime_dir, "installed.flag")
    with open(flag_path, "w") as f:
        f.write("installed")

    print("Installation Complete.")
    print("\n[Setup Note] If running outside Antigravity, ensure REMORA_BRAIN_DIR and REMORA_PROJECT_ID are exported in your environment.")

if __name__ == "__main__":
    main()
