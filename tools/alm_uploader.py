"""
ALM Uploader Strategy Pattern — Uploads test cases to Jira/Zephyr, ADO, TestRail, QTest, XRay
Handles deduplication by exact title match, structured step transformation per tool.
"""

import requests
import base64
import json
from typing import Optional, List, Dict, Any
from urllib.parse import quote


class ALMUploader:
    """Base class for ALM uploaders."""

    def __init__(self, config: dict):
        self.config = config
        self.base_url = config.get("baseUrl", "").rstrip("/")
        self.username = config.get("username", "")
        self.token = config.get("token", "")

    def _build_auth(self) -> tuple:
        """Return (username, token) tuple for requests.auth."""
        return (self.username, self.token)

    def check_exists(self, title: str) -> Optional[str]:
        """Check if a test case with this exact title already exists. Return ID or None."""
        raise NotImplementedError

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """
        Create a test case. Return {status: 'uploaded'|'failed', id: 'ID', message: 'msg'}.
        """
        raise NotImplementedError

    def upload_all(self, test_cases: List[dict], context: dict) -> List[dict]:
        """
        Upload all test cases with deduplication. Return per-TC results:
        [{'testCaseId': 'TC-001', 'title': '...', 'status': 'uploaded'|'skipped'|'failed', 'almId': 'ID', 'message': '...'}]
        """
        results = []
        for tc in test_cases:
            title = tc.get("testCaseTitle", "")
            existing_id = self.check_exists(title)
            if existing_id:
                results.append({
                    "testCaseId": tc.get("testCaseId", ""),
                    "title": title,
                    "status": "skipped",
                    "message": f"Already exists (ID: {existing_id})"
                })
            else:
                result = self.create_test_case(tc, context)
                results.append({
                    "testCaseId": tc.get("testCaseId", ""),
                    "title": title,
                    "status": result.get("status", "failed"),
                    "almId": result.get("id"),
                    "message": result.get("message", "")
                })
        return results


class JiraZephyrUploader(ALMUploader):
    """Jira with Zephyr Scale plugin."""

    def check_exists(self, title: str) -> Optional[str]:
        """Check if test case exists by title in the project."""
        try:
            project_key = self.config.get("projectKey", "")
            if not project_key:
                return None
            url = f"{self.base_url}/rest/atm/1.0/testcase/search"
            query = f'projectKey = "{project_key}" AND name = "{title}"'
            response = requests.get(
                url,
                params={"query": query},
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, dict) and data.get("values"):
                    # Return first matching ID
                    return data["values"][0].get("id")
            return None
        except Exception:
            return None

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """Create a test case in Jira/Zephyr Scale."""
        try:
            project_key = context.get("projectKey", "")
            if not project_key:
                return {"status": "failed", "message": "Project key not provided"}

            steps = tc.get("testSteps", [])
            step_list = []
            for s in steps:
                step_list.append({
                    "description": s.get("action", ""),
                    "expectedResult": s.get("expected", ""),
                    "testData": s.get("testData", "N/A")
                })

            payload = {
                "projectKey": project_key,
                "name": tc.get("testCaseTitle", ""),
                "precondition": tc.get("preconditions", ""),
                "steps": step_list,
                "priority": tc.get("priority", "Medium"),
            }

            url = f"{self.base_url}/rest/atm/1.0/testcase"
            response = requests.post(
                url,
                json=payload,
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code in [200, 201]:
                data = response.json()
                tc_id = data.get("id", "")
                return {"status": "uploaded", "id": tc_id, "message": f"Created as ID {tc_id}"}
            else:
                return {"status": "failed", "message": f"HTTP {response.status_code}: {response.text[:200]}"}
        except Exception as e:
            return {"status": "failed", "message": str(e)[:200]}


class XRayUploader(ALMUploader):
    """Jira with XRay plugin."""

    def check_exists(self, title: str) -> Optional[str]:
        """Check if test case exists by title."""
        try:
            project_key = self.config.get("projectKey", "")
            if not project_key:
                return None
            # XRay doesn't have direct search, use Jira JQL
            url = f"{self.base_url}/rest/api/3/search"
            jql = f'project = "{project_key}" AND summary ~ "{title}" AND type = "Test"'
            response = requests.get(
                url,
                params={"jql": jql, "maxResults": 1},
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("issues"):
                    return data["issues"][0].get("key")
            return None
        except Exception:
            return None

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """Create a test case as a Jira Test issue with XRay steps."""
        try:
            project_key = context.get("projectKey", "")
            if not project_key:
                return {"status": "failed", "message": "Project key not provided"}

            steps = tc.get("testSteps", [])
            step_list = []
            for s in steps:
                step_list.append({
                    "action": s.get("action", ""),
                    "result": s.get("expected", ""),
                    "data": s.get("testData", "")
                })

            payload = {
                "fields": {
                    "project": {"key": project_key},
                    "summary": tc.get("testCaseTitle", ""),
                    "issuetype": {"name": "Test"},
                    "description": f"Precondition: {tc.get('preconditions', '')}\n\nPriority: {tc.get('priority', 'Medium')}",
                }
            }

            url = f"{self.base_url}/rest/api/3/issue"
            response = requests.post(
                url,
                json=payload,
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code in [200, 201]:
                data = response.json()
                issue_key = data.get("key", "")
                # Now add XRay steps via /rest/raven/1.0/import/test
                steps_payload = {
                    "testKey": issue_key,
                    "steps": step_list
                }
                requests.post(
                    f"{self.base_url}/rest/raven/1.0/import/test",
                    json=steps_payload,
                    auth=self._build_auth(),
                    timeout=10
                )
                return {"status": "uploaded", "id": issue_key, "message": f"Created as {issue_key}"}
            else:
                return {"status": "failed", "message": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"status": "failed", "message": str(e)[:200]}


class ADOUploader(ALMUploader):
    """Azure DevOps Test Cases."""

    def check_exists(self, title: str) -> Optional[str]:
        """Check if test case exists by title using WIQL."""
        try:
            project = self.config.get("projectName", "")
            if not project:
                return None

            url = f"{self.base_url}/{project}/_apis/wit/wiql?api-version=7.0"
            wiql = f'SELECT [Id] FROM WorkItems WHERE [System.WorkItemType] = "Test Case" AND [System.Title] = "{title}"'
            auth_str = base64.b64encode(f":{self.token}".encode()).decode()
            headers = {"Authorization": f"Basic {auth_str}", "Content-Type": "application/json"}
            response = requests.post(
                url,
                json={"query": wiql},
                headers=headers,
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("workItems"):
                    return str(data["workItems"][0].get("id"))
            return None
        except Exception:
            return None

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """Create a test case in ADO."""
        try:
            project = context.get("projectName", "")
            test_plan_id = context.get("testPlanId", "")
            if not project or not test_plan_id:
                return {"status": "failed", "message": "Project name and test plan ID required"}

            # Build steps XML
            steps_xml = "<steps>"
            for i, s in enumerate(tc.get("testSteps", []), 1):
                steps_xml += (
                    f'<step id="{i}" type="ActionStep">'
                    f'<action>{s.get("action", "")}</action>'
                    f'<expectedresult>{s.get("expected", "")}</expectedresult>'
                    f'</step>'
                )
            steps_xml += "</steps>"

            url = f"{self.base_url}/{project}/_apis/wit/workitems/$Test%20Case?api-version=7.0"
            auth_str = base64.b64encode(f":{self.token}".encode()).decode()
            headers = {"Authorization": f"Basic {auth_str}", "Content-Type": "application/json-patch+json"}

            # Build patch document
            patch = [
                {"op": "add", "path": "/fields/System.Title", "value": tc.get("testCaseTitle", "")},
                {"op": "add", "path": "/fields/System.Description", "value": tc.get("preconditions", "")},
                {"op": "add", "path": "/fields/Microsoft.VSTS.TCM.Steps", "value": steps_xml},
            ]

            response = requests.patch(
                url,
                json=patch,
                headers=headers,
                timeout=10
            )
            if response.status_code in [200, 201]:
                data = response.json()
                tc_id = str(data.get("id", ""))
                return {"status": "uploaded", "id": tc_id, "message": f"Created as ID {tc_id}"}
            else:
                return {"status": "failed", "message": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"status": "failed", "message": str(e)[:200]}


class TestRailUploader(ALMUploader):
    """TestRail test case upload."""

    def check_exists(self, title: str) -> Optional[str]:
        """Check if test case exists by title in the project."""
        try:
            project_id = self.config.get("projectId", "")
            if not project_id:
                return None

            url = f"{self.base_url}/index.php?/api/v2/get_cases/{project_id}"
            response = requests.get(
                url,
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                for case in data.get("cases", []):
                    if case.get("title") == title:
                        return str(case.get("id"))
            return None
        except Exception:
            return None

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """Create a test case in TestRail."""
        try:
            project_id = context.get("projectId", "")
            section_id = context.get("sectionId", "")
            if not project_id:
                return {"status": "failed", "message": "Project ID required"}
            # If no section ID, use default section (typically ID 1 in TestRail)
            if not section_id:
                section_id = 1

            steps = tc.get("testSteps", [])
            step_list = []
            for s in steps:
                step_data = {
                    "content": s.get("action", ""),
                    "expected": s.get("expected", "")
                }
                if s.get("testData") and s.get("testData") != "N/A":
                    step_data["additional_info"] = s.get("testData", "")
                step_list.append(step_data)

            payload = {
                "title": tc.get("testCaseTitle", ""),
                "section_id": section_id,
                "priority_id": {"High": 4, "Medium": 3, "Low": 2}.get(tc.get("priority", "Medium"), 3),
                "custom_steps_separated": step_list,
            }

            url = f"{self.base_url}/index.php?/api/v2/add_case/{section_id}"
            response = requests.post(
                url,
                json=payload,
                auth=self._build_auth(),
                timeout=10
            )
            if response.status_code in [200, 201]:
                data = response.json()
                tc_id = str(data.get("id", ""))
                return {"status": "uploaded", "id": tc_id, "message": f"Created as ID {tc_id}"}
            else:
                return {"status": "failed", "message": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"status": "failed", "message": str(e)[:200]}


class QTestUploader(ALMUploader):
    """qTest (qTest Manager) test case upload."""

    def check_exists(self, title: str) -> Optional[str]:
        """Check if test case exists by name."""
        try:
            project_id = self.config.get("projectId", "")
            if not project_id:
                return None

            url = f"{self.base_url}/api/v3/projects/{project_id}/test-cases"
            # URL encode the title for query
            query = quote(f'name:"{title}"')
            response = requests.get(
                url,
                params={"q": query},
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("items"):
                    return str(data["items"][0].get("id"))
            return None
        except Exception:
            return None

    def create_test_case(self, tc: dict, context: dict) -> dict:
        """Create a test case in qTest."""
        try:
            project_id = context.get("projectId", "")
            if not project_id:
                return {"status": "failed", "message": "Project ID required"}

            steps = tc.get("testSteps", [])
            step_list = []
            for i, s in enumerate(steps, 1):
                step_data = {
                    "description": s.get("action", ""),
                    "expected": s.get("expected", ""),
                    "order": i
                }
                step_list.append(step_data)

            payload = {
                "name": tc.get("testCaseTitle", ""),
                "description": tc.get("preconditions", ""),
                "test_steps": step_list,
                "priority": {"High": 1, "Medium": 2, "Low": 3}.get(tc.get("priority", "Medium"), 2),
            }

            url = f"{self.base_url}/api/v3/projects/{project_id}/test-cases"
            headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=10
            )
            if response.status_code in [200, 201]:
                data = response.json()
                tc_id = str(data.get("id", ""))
                return {"status": "uploaded", "id": tc_id, "message": f"Created as ID {tc_id}"}
            else:
                return {"status": "failed", "message": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"status": "failed", "message": str(e)[:200]}


def get_uploader(config: dict) -> ALMUploader:
    """Factory function to get the correct uploader based on selectedTool."""
    tool = config.get("selectedTool", "Jira")
    uploaders = {
        "Jira": JiraZephyrUploader,
        "XRay": XRayUploader,
        "ADO": ADOUploader,
        "TestRail": TestRailUploader,
        "QTest": QTestUploader,
    }
    uploader_class = uploaders.get(tool, JiraZephyrUploader)
    return uploader_class(config)
