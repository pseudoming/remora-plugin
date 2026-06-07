import json, os, glob, stat

def init_environment():
    """纯 Python 零依赖环境初始化 (Ghost Install)
    
    修复记:：
    - 只在字段不存在时才初始化，已存在则不覆盖
    - 避免用户手动关闭 enabled: false 后被自动改回 true
    """
    plugin_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    config_dir = os.path.join(plugin_dir, '..', '..')
    
    # 1. 检查并创建沙箱项目
    project_id = "11111111-1111-1111-1111-111111111111"
    projects_dir = os.path.join(config_dir, 'projects')
    project_file = os.path.join(projects_dir, f"{project_id}.json")
    
    initialized = False
    if not os.path.exists(project_file):
        os.makedirs(projects_dir, exist_ok=True)
        with open(project_file, 'w') as f:
            json.dump({
                "id": project_id,
                "name": "remora-system",
                "projectResources": {"resources": []}
            }, f, indent=2)
        initialized = True
    
    # 2. 修改 config.json 启用 sidecar
    # 关键修复：只在字段不存在时才初始化，已存在则不覆盖
    config_file = os.path.join(config_dir, 'config.json')
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            config_data = json.load(f)
        
        sidecars = config_data.setdefault("sidecars", {})
        compactor_key = "remora-plugin/memory-compactor"
        
        if compactor_key not in sidecars:
            # 字段组完全不存在，首次install，写入默认值
            sidecars[compactor_key] = {
                "enabled": False,  # 默认不启用，需要用户手动开启
                "projectId": project_id
            }
            with open(config_file, 'w') as f:
                json.dump(config_data, f, indent=2)
            initialized = True
        else:
            # 字段组已存在，不论是 true 还是 false，都不觇，尊重用户选择
            pass
            
    # 3. 赋予执行权限 (+x)
    if initialized:
        for pattern in ["scripts/**/*.py", "scripts/**/*.sh", "sidecars/memory-compactor/*.py"]:
            for file_path in glob.glob(os.path.join(plugin_dir, pattern), recursive=True):
                st = os.stat(file_path)
                os.chmod(file_path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            
    return initialized
