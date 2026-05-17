"""Unit tests for testscript_generator normalization fallbacks.

Run from project root:
    python -m unittest tests.test_testscript_generator
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.abspath(os.path.join(HERE, "..", "tools"))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from testscript_generator import _normalize_plan


def _base_schema():
    return {
        "tech_stack": {"language": "python"},
        "directory_layout": {"test_root": "tests"},
    }


def _base_group():
    return {"module": "Checkout", "test_cases": [{"testCaseId": "TC-1"}]}


class TestNormalizePlanFallbacks(unittest.TestCase):

    def test_promotes_impacted_test_when_primary_test_file_content_missing(self):
        raw = json.dumps(
            {
                "test_file": {"path": "tests/test_checkout.py", "content": ""},
                "impacted_test_files": [
                    {
                        "path": "tests/test_checkout.py",
                        "content": "def test_checkout():\n    assert True\n",
                    }
                ],
            }
        )
        plan = _normalize_plan(_base_schema(), _base_group(), raw)
        self.assertEqual(plan["test_file"]["path"], "tests/test_checkout.py")
        self.assertIn("def test_checkout()", plan["test_file"]["content"])
        self.assertTrue(
            any("promoted from impacted_test_files" in w for w in plan["warnings"])
        )

    def test_uses_alternate_test_file_fields_for_content(self):
        raw = json.dumps(
            {
                "test_file": {
                    "path": "tests/test_checkout.py",
                    "generated_code": "def test_alt_field():\n    assert 1\n",
                }
            }
        )
        plan = _normalize_plan(_base_schema(), _base_group(), raw)
        self.assertIn("def test_alt_field()", plan["test_file"]["content"])

    def test_uses_root_level_generated_code_when_test_file_missing(self):
        raw = json.dumps(
            {
                "generated_code": "def test_root_field():\n    assert 'ok'\n",
                "page_files": [],
            }
        )
        plan = _normalize_plan(_base_schema(), _base_group(), raw)
        self.assertIn("def test_root_field()", plan["test_file"]["content"])
        self.assertTrue(any("fallback output field/raw output" in w for w in plan["warnings"]))


if __name__ == "__main__":
    unittest.main()
