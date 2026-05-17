"""Unit tests for additive-only page save behavior in save-generated-script."""

import os
import sys
import types
import unittest
from unittest.mock import mock_open, patch

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.abspath(os.path.join(HERE, "..", "tools"))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import api_server


class TestPageAdditiveGuard(unittest.TestCase):
    def _patch_framework_resolver(self):
        original = sys.modules.get("framework_analyzer")
        stub = types.SimpleNamespace(
            safe_resolve_under_root=lambda root, rel: os.path.realpath(os.path.join(root, rel))
        )
        sys.modules["framework_analyzer"] = stub
        return original

    def _restore_framework_resolver(self, original):
        if original is None:
            sys.modules.pop("framework_analyzer", None)
        else:
            sys.modules["framework_analyzer"] = original

    def _save_payload(self, changed_content: str):
        return api_server.SaveGeneratedScriptPayload(
            framework_path="C:/fw",
            target_file_path="tests/test_login.py",
            generated_code="def test_login():\n    assert True\n",
            overwrite=True,
            changed_files=[
                {
                    "path": "pages/LoginPage.py",
                    "file_kind": "page",
                    "content": changed_content,
                }
            ],
        )

    def test_page_line_removal_is_detected(self):
        old_content = "def a():\n    pass\n\ndef b():\n    pass\n"
        new_content = "def a():\n    pass\n"
        info = api_server._analyze_page_line_removals("LoginPage.py", old_content, new_content)
        self.assertGreater(info.get("removed_lines", 0), 0)
        self.assertIn("b", info.get("removed_methods") or [])

    def test_page_pure_addition_is_allowed(self):
        old_content = "def a():\n    pass\n"
        new_content = "def a():\n    pass\n\ndef b():\n    pass\n"
        info = api_server._analyze_page_line_removals("LoginPage.py", old_content, new_content)
        self.assertEqual(info.get("removed_lines"), 0)
        self.assertEqual(info.get("removed_methods"), [])

    def test_save_preserves_existing_page_when_generated_removes_lines(self):
        old_page = "def a():\n    pass\n\ndef b():\n    pass\n"
        payload = self._save_payload("def a():\n    pass\n")
        original_framework_analyzer = self._patch_framework_resolver()
        m_open = mock_open()
        try:
            with patch("api_server.os.path.isdir", return_value=True), \
                 patch("api_server.os.path.exists", return_value=True), \
                 patch("api_server.os.path.isfile", return_value=True), \
                 patch("api_server.os.makedirs"), \
                 patch("api_server._read_existing_text", return_value=old_page), \
                 patch("builtins.open", m_open):
                result = api_server.save_generated_script(payload)

            warnings = result.get("page_preservation_warnings") or []
            self.assertEqual(len(warnings), 1)
            self.assertEqual(warnings[0].get("path"), "pages/LoginPage.py")

            handle = m_open()
            handle.write.assert_called_once_with(old_page)
        finally:
            self._restore_framework_resolver(original_framework_analyzer)

    def test_save_writes_additive_page_update(self):
        old_page = "def a():\n    pass\n"
        new_page = "def a():\n    pass\n\ndef b():\n    pass\n"
        payload = self._save_payload(new_page)
        original_framework_analyzer = self._patch_framework_resolver()
        m_open = mock_open()
        try:
            with patch("api_server.os.path.isdir", return_value=True), \
                 patch("api_server.os.path.exists", return_value=True), \
                 patch("api_server.os.path.isfile", return_value=True), \
                 patch("api_server.os.makedirs"), \
                 patch("api_server._read_existing_text", return_value=old_page), \
                 patch("builtins.open", m_open):
                result = api_server.save_generated_script(payload)

            self.assertEqual(result.get("page_preservation_warnings"), [])
            handle = m_open()
            handle.write.assert_called_once_with(new_page)
        finally:
            self._restore_framework_resolver(original_framework_analyzer)


if __name__ == "__main__":
    unittest.main()
