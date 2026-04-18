"""
╔══════════════════════════════════════════════════════════╗
║   A.N.T. Layer 3 — Test Scenarios Engine v1              ║
║   Orchestrates: IssuerFetcher → LLMRouter                ║
╚══════════════════════════════════════════════════════════╝
"""

import json
import os
import sys

# Ensure tools/ is on the path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from issue_fetcher import fetch_issue
from llm_router import route_scenarios

class TestScenariosEngine:
    """
    Dedicated engine for generating high-level test scenarios.
    """

    def __init__(self, payload):
        # Handle both dict payload and file path string
        if isinstance(payload, str):
            # Try to load from file path first
            if os.path.isfile(payload):
                try:
                    with open(payload, "r", encoding="utf-8") as f:
                        self.config = json.load(f)
                except Exception as e:
                    raise RuntimeError(f"TestScenariosEngine: Could not load payload from file. {e}")
            else:
                # Try parsing as JSON string
                try:
                    self.config = json.loads(payload)
                except json.JSONDecodeError as e:
                    raise RuntimeError(f"TestScenariosEngine: Invalid payload (not a file path or JSON). {e}")
        elif isinstance(payload, dict):
            self.config = payload
        else:
            raise RuntimeError(f"TestScenariosEngine: Payload must be dict, file path, or JSON string.")

    def fetch_issue_context(self) -> str:
        manual = self.config.get("manualRequirements", "").strip()
        if manual:
            print(f"[TS-Engine] Using manual requirements context ({len(manual)} chars).")
            # Build an enriched context if optional fields are present
            enriched = [f"MANUAL REQUIREMENTS:\n{manual}"]
            # Use same optional fields as Test Cases for consistency if they exist
            for field in ["sharedPrerequisites", "businessRules", "widgetsSections", "additionalContext"]:
                val = self.config.get(field, "").strip()
                if val:
                    enriched.append(f"{field.replace('Sections', '').title()}:\n{val}")
            return "\n\n".join(enriched)
        
        return fetch_issue(self.config)

    def generate_scenarios(self, context_text: str) -> dict:
        print("[TS-Engine] Routing to LLM for scenarios...")
        # We use route_scenarios for high-level scenarios
        return route_scenarios(self.config, context_text)

    def run_pipeline(self) -> dict:
        """Entry point for scenario generation."""
        print("=== B.L.A.S.T Test Scenarios Engine Pipeline ===")
        context = self.fetch_issue_context()
        scenarios_data = self.generate_scenarios(context)
        return scenarios_data
