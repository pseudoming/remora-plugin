import os
import sys
import base64
import unittest
from unittest.mock import patch

# Ensure plugin root is in sys.path for coverage to track properly
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

scripts_dir = os.path.join(root_dir, "scripts")
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

sys.path.insert(0, os.path.join(root_dir, "scripts", "rules"))
import safety_rules


class TestDecodeBase64Token(unittest.TestCase):
    def test_too_short_returns_none(self):
        self.assertIsNone(safety_rules.decode_base64_token("short"))

    def test_invalid_chars_returns_none(self):
        self.assertIsNone(safety_rules.decode_base64_token("A" * 20 + "!"))

    def test_valid_returns_decoded_string(self):
        msg = "this is a longer message for base64"
        token = base64.b64encode(msg.encode()).decode()
        self.assertEqual(safety_rules.decode_base64_token(token), msg)

    def test_exception_on_bad_utf8_returns_none(self):
        raw = b'\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff'
        token = base64.b64encode(raw).decode()
        self.assertIsNone(safety_rules.decode_base64_token(token))


class TestRecursionDepth(unittest.TestCase):
    def test_depth_over_10_returns_deny_syntax_error(self):
        result = safety_rules._inspect_tokens(["echo"], depth=11)
        self.assertEqual(result, ("deny", "syntax_error"))


class TestDelimiterHandling(unittest.TestCase):
    def test_semicolon_splits_commands_catches_deny(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 ; pytest"),
            ("deny", "test"),
        )

    def test_and_or_delimiters(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 && pytest"),
            ("deny", "test"),
        )
        self.assertEqual(
            safety_rules.inspect_command("echo 1 || pytest"),
            ("deny", "test"),
        )

    def test_pipe_delimiter(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 | pytest"),
            ("deny", "test"),
        )


class TestEnvVarExtraction(unittest.TestCase):
    def test_env_var_extracted_and_skipped_with_no_command(self):
        self.assertEqual(
            safety_rules.inspect_command("VAR=hello"),
            ("allow", ""),
        )

    def test_multiple_env_vars_extracted(self):
        self.assertEqual(
            safety_rules.inspect_command("A=1 B=2 env"),
            ("allow", ""),
        )

    def test_env_var_does_not_consume_flag_like_token(self):
        self.assertEqual(
            safety_rules.inspect_command("-flag=value echo hi"),
            ("allow", ""),
        )


class TestVariableReplacement(unittest.TestCase):
    def test_var_replaced_in_command(self):
        self.assertEqual(
            safety_rules.inspect_command("VAR=sh $VAR -c pytest"),
            ("deny", "test"),
        )

    def test_var_replaced_with_braces(self):
        self.assertEqual(
            safety_rules.inspect_command('VAR=pytest echo ${VAR}'),
            ("allow", ""),
        )

    def test_env_tracker_persists_across_sub_commands(self):
        self.assertEqual(
            safety_rules.inspect_command("A=1 ; echo $A"),
            ("allow", ""),
        )


class TestBase64Audit(unittest.TestCase):
    def test_base64_decoded_dangerous_triggers_deny(self):
        dangerous_cmd = "echo 1 ; pytest xyz"
        b64_token = base64.b64encode(dangerous_cmd.encode()).decode()
        self.assertEqual(
            safety_rules.inspect_command(f"echo {b64_token}"),
            ("deny", "test"),
        )

    def test_base64_whitelisted_token_skipped(self):
        dangerous_cmd = "echo 1 ; pytest xyz"
        b64_token = base64.b64encode(dangerous_cmd.encode()).decode()
        with patch("core.rules.inspector.BASE64_WHITELIST", [b64_token]):
            self.assertEqual(
                safety_rules.inspect_command(f"echo {b64_token}"),
                ("allow", ""),
            )

    def test_base64_decoded_in_whitelist_skips_inspection(self):
        dangerous_cmd = "echo 1 ; pytest xyz"
        b64_token = base64.b64encode(dangerous_cmd.encode()).decode()
        with patch("core.rules.inspector.BASE64_WHITELIST", [dangerous_cmd]):
            self.assertEqual(
                safety_rules.inspect_command(f"echo {b64_token}"),
                ("allow", ""),
            )


class TestNestedShellCheck(unittest.TestCase):
    def test_sh_c_denies_dangerous_command(self):
        self.assertEqual(
            safety_rules.inspect_command('sh -c pytest'),
            ("deny", "test"),
        )

    def test_bash_c_denies_dangerous_command(self):
        self.assertEqual(
            safety_rules.inspect_command('bash -c "pytest"'),
            ("deny", "test"),
        )

    def test_zsh_c_denies_dangerous_command(self):
        self.assertEqual(
            safety_rules.inspect_command('zsh -c "pytest"'),
            ("deny", "test"),
        )

    def test_dash_c_denies_dangerous_command(self):
        self.assertEqual(
            safety_rules.inspect_command('dash -c "pytest"'),
            ("deny", "test"),
        )

    def test_shell_c_allows_safe_command(self):
        self.assertEqual(
            safety_rules.inspect_command('sh -c "echo hello"'),
            ("allow", ""),
        )

    def test_shell_c_with_no_code_after_flag(self):
        self.assertEqual(
            safety_rules.inspect_command("sh -c"),
            ("allow", ""),
        )


class TestEvalCheck(unittest.TestCase):
    def test_eval_denies_dangerous(self):
        self.assertEqual(
            safety_rules.inspect_command('eval "pytest"'),
            ("deny", "test"),
        )

    def test_eval_allows_safe(self):
        self.assertEqual(
            safety_rules.inspect_command('eval "echo hello"'),
            ("allow", ""),
        )


class TestPythonCheck(unittest.TestCase):
    def test_python_c_with_pytest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('python -c "import pytest"'),
            ("deny", "test"),
        )

    def test_python_c_with_unittest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('python -c "import unittest"'),
            ("deny", "test"),
        )

    def test_python3_c_with_pytest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('python3 -c "import pytest"'),
            ("deny", "test"),
        )

    def test_python_c_safe_code_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command('python -c "print(\'hello\')"'),
            ("allow", ""),
        )

    def test_python_m_pytest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("python -m pytest"),
            ("deny", "test"),
        )

    def test_python3_m_pytest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("python3 -m pytest"),
            ("deny", "test"),
        )

    def test_python_c_no_code_after(self):
        self.assertEqual(
            safety_rules.inspect_command("python -c"),
            ("allow", ""),
        )


class TestNodeCheck(unittest.TestCase):
    def test_node_e_with_jest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('node -e "const jest = require(\'jest\')"'),
            ("deny", "test"),
        )

    def test_node_e_with_vitest_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('node -e "const vitest = require(\'vitest\')"'),
            ("deny", "test"),
        )

    def test_node_e_with_mocha_denied(self):
        self.assertEqual(
            safety_rules.inspect_command('node -e "const mocha = require(\'mocha\')"'),
            ("deny", "test"),
        )

    def test_node_e_safe_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command('node -e "console.log(\'hi\')"'),
            ("allow", ""),
        )

    def test_node_e_no_code_after(self):
        self.assertEqual(
            safety_rules.inspect_command("node -e"),
            ("allow", ""),
        )


class TestStandardTestRules(unittest.TestCase):
    def test_pytest_direct(self):
        self.assertEqual(
            safety_rules.inspect_command("pytest"),
            ("deny", "test"),
        )

    def test_pytest3_direct(self):
        self.assertEqual(
            safety_rules.inspect_command("pytest3"),
            ("deny", "test"),
        )

    def test_jest_direct(self):
        self.assertEqual(
            safety_rules.inspect_command("jest"),
            ("deny", "test"),
        )

    def test_vitest_direct(self):
        self.assertEqual(
            safety_rules.inspect_command("vitest"),
            ("deny", "test"),
        )

    def test_gradlew_test(self):
        self.assertEqual(
            safety_rules.inspect_command("gradlew test"),
            ("deny", "test"),
        )

    def test_mvn_test(self):
        self.assertEqual(
            safety_rules.inspect_command("mvn test"),
            ("deny", "test"),
        )

    def test_npm_test(self):
        self.assertEqual(
            safety_rules.inspect_command("npm test"),
            ("deny", "test"),
        )

    def test_npm_t(self):
        self.assertEqual(
            safety_rules.inspect_command("npm t"),
            ("deny", "test"),
        )

    def test_npm_run_test(self):
        self.assertEqual(
            safety_rules.inspect_command("npm run test"),
            ("deny", "test"),
        )

    def test_yarn_test(self):
        self.assertEqual(
            safety_rules.inspect_command("yarn test"),
            ("deny", "test"),
        )

    def test_yarn_t(self):
        self.assertEqual(
            safety_rules.inspect_command("yarn t"),
            ("deny", "test"),
        )


class TestMonitoringAndDangerousCommands(unittest.TestCase):
    def test_tail_f_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("tail -f /var/log/syslog"),
            ("deny", "test"),
        )

    def test_journalctl_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("journalctl -xe"),
            ("deny", "test"),
        )

    def test_find_exec_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("find . -exec rm {} +"),
            ("deny", "test"),
        )

    def test_grep_r_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("grep -r pattern ."),
            ("deny", "test"),
        )

    def test_grep_R_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("grep -R pattern ."),
            ("deny", "test"),
        )

    def test_grep_without_recursive_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("grep pattern file"),
            ("allow", ""),
        )

    def test_grep_multiple_flags_with_r_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("grep -nrl pattern ."),
            ("deny", "test"),
        )

    def test_sed_i_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("sed -i s/foo/bar/g file"),
            ("deny", "test"),
        )

    def test_sed_without_i_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("sed s/foo/bar/g file"),
            ("allow", ""),
        )


class TestBuildRules(unittest.TestCase):
    def test_npm_run_build_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("npm run build"),
            ("deny", "build"),
        )

    def test_gradlew_build_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("gradlew build"),
            ("deny", "build"),
        )

    def test_mvn_package_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("mvn package"),
            ("deny", "build"),
        )

    def test_mvn_install_denied(self):
        self.assertEqual(
            safety_rules.inspect_command("mvn install"),
            ("deny", "build"),
        )


class TestInspectCommandEdgeCases(unittest.TestCase):
    def test_empty_tokens_returns_allow(self):
        self.assertEqual(
            safety_rules.inspect_command(""),
            ("allow", ""),
        )

    def test_shlex_failure_fallback_test_match(self):
        self.assertEqual(
            safety_rules.inspect_command('pytest "unclosed'),
            ("deny", "test"),
        )

    def test_shlex_failure_fallback_build_match(self):
        self.assertEqual(
            safety_rules.inspect_command('npm run build "unclosed'),
            ("deny", "build"),
        )

    def test_shlex_failure_fallback_no_match(self):
        self.assertEqual(
            safety_rules.inspect_command('echo "unclosed'),
            ("deny", "syntax_error"),
        )


class TestAllowSafeCommands(unittest.TestCase):
    def test_simple_echo_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("echo hello"),
            ("allow", ""),
        )

    def test_ls_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("ls -la"),
            ("allow", ""),
        )

    def test_multiple_allowed_commands(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 ; echo 2 ; echo 3"),
            ("allow", ""),
        )

    def test_env_var_with_safe_command_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("MODE=production python script.py"),
            ("allow", ""),
        )

    def test_yarn_run_build_allowed(self):
        self.assertEqual(
            safety_rules.inspect_command("yarn run build"),
            ("allow", ""),
        )


class TestDelimiterEdgeCases(unittest.TestCase):
    def test_multiple_delimiters_sequential(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 ; ; echo 2"),
            ("allow", ""),
        )

    def test_leading_semicolon(self):
        self.assertEqual(
            safety_rules.inspect_command("; pytest"),
            ("deny", "test"),
        )

    def test_trailing_semicolon(self):
        self.assertEqual(
            safety_rules.inspect_command("echo 1 ;"),
            ("allow", ""),
        )


if __name__ == "__main__":
    unittest.main()
