import os
import sys
import pytest
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import install


class TestRenderString:
    def test_plugin_root_substitution(self):
        result = install.render_string("root={PLUGIN_ROOT}", "/opt/remora")
        assert result == "root=/opt/remora"

    def test_python_substitution(self):
        result = install.render_string("py={PYTHON}", "/opt/remora")
        assert result == f"py={sys.executable}"

    def test_both_substitutions(self):
        result = install.render_string("{PLUGIN_ROOT}/bin {PYTHON}", "/p")
        assert result == f"/p/bin {sys.executable}"

    def test_no_substitution_needed(self):
        result = install.render_string("plain text", "/p")
        assert result == "plain text"


class TestDoWrite:
    def test_writes_file(self, tmp_path):
        p = str(tmp_path / "test.json")
        install.DRY_RUN = False
        install.do_write(p, "hello")
        assert os.path.exists(p)
        with open(p) as f:
            assert f.read() == "hello"

    def test_creates_parent_dirs(self, tmp_path):
        p = str(tmp_path / "deep" / "nest" / "test.json")
        install.DRY_RUN = False
        install.do_write(p, "data")
        assert os.path.exists(p)

    def test_dry_run_skips_write(self, tmp_path):
        p = str(tmp_path / "test.json")
        install.DRY_RUN = True
        install.do_write(p, "hello")
        install.DRY_RUN = False
        assert not os.path.exists(p)


class TestDoCopy:
    def test_copies_file(self, tmp_path):
        src = tmp_path / "src.txt"
        src.write_text("content")
        dst = str(tmp_path / "dst.txt")
        install.DRY_RUN = False
        install.do_copy(str(src), dst)
        assert os.path.exists(dst)
        with open(dst) as f:
            assert f.read() == "content"

    def test_skip_existing(self, tmp_path):
        src = tmp_path / "src.txt"
        dst = tmp_path / "dst.txt"
        src.write_text("new")
        dst.write_text("old")
        install.DRY_RUN = False
        install.do_copy(str(src), str(dst), skip_existing=True)
        with open(dst) as f:
            assert f.read() == "old"

    def test_dry_run_skips_copy(self, tmp_path):
        src = tmp_path / "src.txt"
        src.write_text("content")
        dst = str(tmp_path / "dst.txt")
        install.DRY_RUN = True
        install.do_copy(str(src), dst)
        install.DRY_RUN = False
        assert not os.path.exists(dst)


class TestIdempotency:
    def test_already_installed_no_force(self, tmp_path, capsys):
        flag_dir = tmp_path / ".runtime"
        flag_dir.mkdir()
        (flag_dir / "installed.flag").write_text("installed")

        with patch.object(install, "run_quality_gate") as mock_qg:
            install.main_real(
                plugin_root=str(tmp_path),
                data_dir=str(tmp_path),
                runtime_dir=str(flag_dir),
                force=False,
                dry_run=False,
                uninstall=False,
            )
            mock_qg.assert_not_called()

        captured = capsys.readouterr()
        assert "already installed" in captured.out

    def test_already_installed_with_force(self, tmp_path, capsys):
        flag_dir = tmp_path / ".runtime"
        flag_dir.mkdir()
        (flag_dir / "installed.flag").write_text("installed")

        with patch.object(install, "run_quality_gate") as mock_qg, \
             patch.object(install, "render_all_templates") as mock_render, \
             patch.object(install, "deploy_workflows") as mock_wf, \
             patch.object(install, "init_database") as mock_db:
            install.main_real(
                plugin_root=str(tmp_path),
                data_dir=str(tmp_path),
                runtime_dir=str(flag_dir),
                force=True,
                dry_run=False,
                uninstall=False,
            )
            mock_qg.assert_called_once()

        captured = capsys.readouterr()
        assert "already installed" not in captured.out


class TestMainEntry:
    def test_dry_run_flag(self, tmp_path, capsys):
        with patch.object(install, "run_quality_gate"), \
             patch.object(install, "init_database"):
            install.main_real(
                plugin_root=str(tmp_path),
                data_dir=str(tmp_path),
                runtime_dir=str(tmp_path / ".runtime"),
                force=False,
                dry_run=True,
                uninstall=False,
            )
        captured = capsys.readouterr()
        assert "[DRY-RUN]" in captured.out


class TestUninstall:
    def test_removes_rendered_files(self, tmp_path):
        # Setup fake rendered files
        hooks = tmp_path / "hooks.json"
        hooks.write_text("x")

        agents = tmp_path / "agents"
        agents.mkdir()
        (agents / "test.json").write_text("x")
        (agents / "test.template.json").write_text("x")

        data_dir = tmp_path / "data"
        runtime = data_dir / ".runtime"
        runtime.mkdir(parents=True)
        flag = runtime / "installed.flag"
        flag.write_text("x")

        install.DRY_RUN = False
        install.do_uninstall(str(data_dir), str(tmp_path))

        assert not hooks.exists()
        assert not (agents / "test.json").exists()
        assert (agents / "test.template.json").exists()  # template preserved
        assert not flag.exists()

    def test_uninstall_dry_run_preserves_files(self, tmp_path):
        hooks = tmp_path / "hooks.json"
        hooks.write_text("x")

        data_dir = tmp_path / "data"
        runtime = data_dir / ".runtime"
        runtime.mkdir(parents=True)
        flag = runtime / "installed.flag"
        flag.write_text("x")

        install.DRY_RUN = True
        install.do_uninstall(str(data_dir), str(tmp_path))
        install.DRY_RUN = False

        assert hooks.exists()
        assert flag.exists()


class TestRenderAllTemplates:
    def test_renders_hooks_and_sidecars(self, tmp_path):
        # Create template files
        (tmp_path / "hooks.template.json").write_text('{"root": "{PLUGIN_ROOT}"}')
        sidecar_dir = tmp_path / "sidecars" / "memory-compactor"
        sidecar_dir.mkdir(parents=True)
        (sidecar_dir / "sidecar.template.json").write_text('{"root": "{PLUGIN_ROOT}"}')
        skills_dir = tmp_path / "skills" / "remora-architecture"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.template.md").write_text('{PLUGIN_ROOT}')
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        (agents_dir / "test.template.json").write_text('{PYTHON}')

        install.DRY_RUN = False
        install.render_all_templates(str(tmp_path))

        assert os.path.exists(tmp_path / "hooks.json")
        assert os.path.exists(sidecar_dir / "sidecar.json")
        assert os.path.exists(skills_dir / "SKILL.md")
        assert os.path.exists(agents_dir / "test.json")

        with open(tmp_path / "hooks.json") as f:
            assert str(tmp_path) in f.read()

    def test_dry_run_skips_render(self, tmp_path):
        (tmp_path / "hooks.template.json").write_text('{}')

        install.DRY_RUN = True
        install.render_all_templates(str(tmp_path))
        install.DRY_RUN = False

        assert not os.path.exists(tmp_path / "hooks.json")
