# 🏛️ Project Constitution

## Data Schemas

### 1. UI State Schema (Input Configuration)
```json
{
  "testManagementTool": {
    "toolType": "Jira | ADO | X-Ray | TestRail | QTest",
    "credentials": {
      "baseUrl": "https://...",
      "username": "user@email.com",
      "token": "api_token_here_or_password"
    },
    "ticketId": "PROJ-1234",
    "additionalContextFiles": ["file1.pdf", "context.docx"]
  },
  "llmSettings": {
    "provider": "Ollama | GROQ | Grok | Claude | Anthropic",
    "endpoint": "http://127.0.0.1:11434",
    "modelName": "auto",
    "apiKey": "..."
  }
}
```

### 2. Extracted Requirements Payload (Intermediate)
*(Strict Extracted Context - No Hallucinations)*
```json
{
  "featureScope": "String",
  "acceptanceCriteria": ["AC1", "AC2"],
  "businessRules": ["Rule1", "Rule2"],
  "fieldValidations": ["Field1", "Field2"],
  "technicalDependencies": ["Dep1", "Dep2"],
  "errorHandling": ["Error1", "Error2"]
}
```

### 3. Generated Test Cases Schema (Output)
*(Dynamic Table Output Format — Column 2 label adapts to selected toolType)*
```json
{
  "testPlanTitle": "String",
  "selectedTool": "Jira | ADO | X-Ray | TestRail | QTest",
  "testCases": [
    {
      "testCaseId": "TC-001",
      "toolTicketId": "[Dynamic: Jira ID | ADO Work Item | X-Ray Test | TestRail Case | QTest ID]",
      "module": "String",
      "testCaseTitle": "String",
      "preconditions": "String",
      "testSteps": "1. Step one. 2. Step two.",
      "testData": "Actual concrete values, no placeholders",
      "expectedResult": "Verifiable result",
      "priority": "High | Medium | Low",
      "testType": "Functional | Non-Functional"
    }
  ]
}
```

## Tool ID Column Label Mapping
| toolType  | Column Label         |
|-----------|----------------------|
| Jira      | Jira ID              |
| ADO       | ADO Work Item ID     |
| X-Ray     | X-Ray Test ID        |
| TestRail  | TestRail Case ID     |
| QTest     | QTest ID             |

## Behavioral Rules
- **Zero Hallucination Policy:** Do not invent, assume, or infer requirements, user flows, or edge cases.
- **Strict Extraction:** Extract ONLY Feature Scope, ACs, Business Rules, Field Validations, Technical Dependencies, and Error Handling.
- **Atomic Design:** Every test case must validate strictly ONE behavior and be tied to an AC. Concrete test data only (no placeholders).
- **Dynamic Tool Labels:** The Test Management Tool connector UI and output column headers must dynamically reflect the selected `toolType` — never hardcode "Jira".

## Architectural Invariants
- Must use A.N.T. 3-layer architecture.
- **Frontend Framework:** The UI must be built in **React**.
- Prioritize reliability over speed.
- No guessing at business logic.
- **State Persistence:** UI credentials and session data must be saved to browser cache/cookies.
- **LLM Providers Supported:** Ollama (local), GROQ, Grok (xAI), Claude, Anthropic.
