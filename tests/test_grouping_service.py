"""Unit tests for test_grouping_service.

Run from project root:
    python -m unittest tests.test_grouping_service
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.abspath(os.path.join(HERE, "..", "tools"))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from test_grouping_service import (
    FALLBACK_GROUP_NAME,
    group_test_cases_by_module,
    grouping_preview,
)


def tc(tcid, module):
    return {"testCaseId": tcid, "module": module, "testCaseTitle": f"T {tcid}"}


class TestGroupingByModule(unittest.TestCase):

    def test_empty_list_returns_empty(self):
        self.assertEqual(group_test_cases_by_module([]), [])

    def test_none_input_returns_empty(self):
        self.assertEqual(group_test_cases_by_module(None), [])

    def test_single_case_single_group(self):
        result = group_test_cases_by_module([tc("TC-001", "Login")])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["module"], "Login")
        self.assertEqual(len(result[0]["test_cases"]), 1)

    def test_two_cases_same_module_one_group(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Homepage Load & Hero Section"),
            tc("TC-002", "Homepage Load & Hero Section"),
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]["test_cases"]), 2)

    def test_two_cases_different_modules_two_groups(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Login"),
            tc("TC-002", "Checkout"),
        ])
        self.assertEqual(len(result), 2)
        modules = [g["module"] for g in result]
        self.assertEqual(modules, ["Login", "Checkout"])

    def test_case_insensitive_module_merge(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Login"),
            tc("TC-002", "login"),
            tc("TC-003", "LOGIN"),
        ])
        self.assertEqual(len(result), 1)
        # Display name preserves first-seen casing
        self.assertEqual(result[0]["module"], "Login")
        self.assertEqual(len(result[0]["test_cases"]), 3)

    def test_whitespace_module_merge(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Checkout"),
            tc("TC-002", "  Checkout  "),
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]["test_cases"]), 2)

    def test_missing_module_goes_to_ungrouped(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Login"),
            {"testCaseId": "TC-002"},  # no module key at all
        ])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[-1]["module"], FALLBACK_GROUP_NAME)
        self.assertEqual(len(result[-1]["test_cases"]), 1)

    def test_none_module_goes_to_ungrouped(self):
        result = group_test_cases_by_module([tc("TC-001", None)])
        self.assertEqual(result[0]["module"], FALLBACK_GROUP_NAME)

    def test_empty_string_module_goes_to_ungrouped(self):
        result = group_test_cases_by_module([
            tc("TC-001", ""),
            tc("TC-002", "   "),
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["module"], FALLBACK_GROUP_NAME)
        self.assertEqual(len(result[0]["test_cases"]), 2)

    def test_na_token_goes_to_ungrouped(self):
        for token in ["N/A", "n/a", "None", "TBD", "-"]:
            result = group_test_cases_by_module([tc("TC-001", token)])
            self.assertEqual(
                result[0]["module"], FALLBACK_GROUP_NAME,
                msg=f"Token '{token}' should fall into Ungrouped"
            )

    def test_ungrouped_always_last(self):
        result = group_test_cases_by_module([
            tc("TC-001", ""),                # ungrouped first
            tc("TC-002", "Login"),
            tc("TC-003", "Checkout"),
        ])
        self.assertEqual([g["module"] for g in result],
                         ["Login", "Checkout", FALLBACK_GROUP_NAME])

    def test_group_insertion_order_preserved(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Checkout"),
            tc("TC-002", "Login"),
            tc("TC-003", "Reports"),
            tc("TC-004", "Login"),
        ])
        self.assertEqual([g["module"] for g in result],
                         ["Checkout", "Login", "Reports"])

    def test_non_dict_entries_skipped(self):
        result = group_test_cases_by_module([
            tc("TC-001", "Login"),
            "not a dict",
            None,
            42,
            tc("TC-002", "Login"),
        ])
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]["test_cases"]), 2)

    def test_test_case_objects_preserved_unmodified(self):
        original = tc("TC-001", "Login")
        original["priority"] = "High"
        original["testSteps"] = [{"stepNumber": 1, "action": "x"}]
        result = group_test_cases_by_module([original])
        self.assertIs(result[0]["test_cases"][0], original)


class TestGroupingPreview(unittest.TestCase):

    def test_preview_shape(self):
        preview = grouping_preview([
            tc("TC-001", "Login"),
            tc("TC-002", "Login"),
            tc("TC-003", "Checkout"),
        ])
        self.assertEqual(preview["total_cases"], 3)
        self.assertEqual(preview["total_groups"], 2)
        self.assertEqual(len(preview["groups"]), 2)
        self.assertEqual(preview["groups"][0]["module"], "Login")
        self.assertEqual(preview["groups"][0]["case_count"], 2)
        self.assertEqual(preview["groups"][0]["case_ids"], ["TC-001", "TC-002"])

    def test_preview_empty(self):
        preview = grouping_preview([])
        self.assertEqual(preview, {"total_cases": 0, "total_groups": 0, "groups": []})

    def test_preview_none(self):
        preview = grouping_preview(None)
        self.assertEqual(preview["total_cases"], 0)
        self.assertEqual(preview["total_groups"], 0)


if __name__ == "__main__":
    unittest.main()
