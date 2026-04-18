#!/usr/bin/env python3
"""Test the full test case generation pipeline"""

import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tools'))

# Simulate what the LLM would return
llm_response = {
    "testPlanTitle": "Login Feature Test Plan",
    "selectedTool": "Jira",
    "requirementsProfile": {
        "featureScope": "User login functionality",
        "acceptanceCriteria": ["User can login with valid credentials"],
        "businessRules": [],
        "fieldValidations": [],
        "technicalDependencies": [],
        "errorHandling": []
    },
    "testCases": [
        {
            "testCaseId": "TC-001",
            "toolTicketId": "PROJ-123",
            "module": "Authentication",
            "testCaseTitle": "Verify login with valid credentials",
            "preconditions": "User account exists",
            "testSteps": [
                {"stepNumber": 1, "action": "Open login page", "expected": "Login form displayed", "testData": ""},
                {"stepNumber": 2, "action": "Enter valid email", "expected": "Email accepted", "testData": "user@test.com"}
            ],
            "priority": "High",
            "testType": "Functional"
        }
    ]
}

# Now simulate what happens in test_cases_engine after LLM call
from test_cases_engine import normalize_test_steps, derive_summary_fields

print("=== Testing Pipeline ===\n")

# Normalize and derive for each test case
test_cases = llm_response.get("testCases", [])
print(f"[1] Input test cases count: {len(test_cases)}")

for tc in test_cases:
    # Normalize testSteps
    tc["testSteps"] = normalize_test_steps(tc.get("testSteps", []))
    # Derive summary fields
    derive_summary_fields(tc)

print(f"[2] After processing: {len(test_cases)} test cases")

# Update response
llm_response["testCases"] = test_cases

print(f"[3] Response structure check:")
print(f"    - Has testCases: {'testCases' in llm_response}")
print(f"    - testCases is list: {isinstance(llm_response.get('testCases'), list)}")
print(f"    - testCases length: {len(llm_response.get('testCases', []))}")

if test_cases:
    tc = test_cases[0]
    print(f"[4] First test case:")
    print(f"    - testCaseId: {tc.get('testCaseId')}")
    print(f"    - testSteps type: {type(tc.get('testSteps'))}")
    print(f"    - testSteps length: {len(tc.get('testSteps', []))}")
    print(f"    - Has expectedResult: {'expectedResult' in tc}")
    print(f"    - Has testData: {'testData' in tc}")

# Verify it's JSON serializable
try:
    json_str = json.dumps(llm_response)
    print(f"\n[5] JSON serialization: OK ({len(json_str)} bytes)")
except Exception as e:
    print(f"\n[5] JSON serialization: FAILED - {e}")

print("\n[SUCCESS] Pipeline complete!")
