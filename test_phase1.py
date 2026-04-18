#!/usr/bin/env python3
"""Quick test of Phase 1 changes - normalize_test_steps and derive_summary_fields"""

import sys
import os

# Add tools to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tools'))

from test_cases_engine import normalize_test_steps, derive_summary_fields, format_steps_for_excel

def test_normalize_structured():
    """Test normalization of already-structured array"""
    raw = [
        {"stepNumber": 1, "action": "Open login page", "expected": "Login form appears", "testData": ""},
        {"stepNumber": 2, "action": "Enter credentials", "expected": "User logged in", "testData": "user@test.com / P@ss1"}
    ]
    result = normalize_test_steps(raw)
    status = "PASS" if (len(result) == 2 and result[0]["stepNumber"] == 1) else "FAIL"
    print("[%s] Test 1 (structured array)" % status)
    print("  Result: %s" % result)

def test_normalize_flat_string():
    """Test fallback parsing of flat string"""
    raw = "1. Open login page\n2. Enter credentials\n3. Click submit"
    result = normalize_test_steps(raw)
    status = "PASS" if (len(result) == 3 and result[0]["action"] == "Open login page") else "FAIL"
    print("[%s] Test 2 (flat string)" % status)
    print("  Result: %s" % result)

def test_derive_summaries():
    """Test deriving summary fields from steps"""
    tc = {
        "testCaseId": "TC-001",
        "testSteps": [
            {"stepNumber": 1, "action": "Do X", "expected": "X happens", "testData": ""},
            {"stepNumber": 2, "action": "Do Y", "expected": "Y happens", "testData": "value123"}
        ]
    }
    result = derive_summary_fields(tc)
    status = "PASS" if ("expectedResult" in result and "testData" in result) else "FAIL"
    print("[%s] Test 3 (derive summaries)" % status)
    print("  Expected Result: %s" % result.get('expectedResult'))
    print("  Test Data: %s" % result.get('testData'))

def test_format_for_excel():
    """Test Excel formatting"""
    steps = [
        {"stepNumber": 1, "action": "Do X", "expected": "X happens", "testData": ""},
        {"stepNumber": 2, "action": "Do Y", "expected": "Y happens", "testData": "data123"}
    ]
    result = format_steps_for_excel(steps)
    status = "PASS" if ("1. Do X" in result and "Expected:" in result) else "FAIL"
    print("[%s] Test 4 (Excel format)" % status)
    print("  Result:\n%s" % result)

if __name__ == "__main__":
    print("=== Phase 1 Test Suite ===\n")
    test_normalize_structured()
    print()
    test_normalize_flat_string()
    print()
    test_derive_summaries()
    print()
    test_format_for_excel()
    print("\n[DONE] All tests completed!")
