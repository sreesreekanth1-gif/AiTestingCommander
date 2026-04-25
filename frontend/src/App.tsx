import React, { useState, useEffect, useMemo } from 'react';
import {
  Network, Database, FileText,
  Monitor, Shield, Box, Zap, ClipboardList, GitBranch,
  ChevronDown, Settings, Sun, Moon,
  CheckCircle2, XCircle, X, WifiOff, AlertTriangle, Copy, Check, Search,
  RefreshCw, BarChart2, Upload, Link2, Edit3, FileUp, Minus,
  ChevronUp, ListFilter, Play, Pencil, Download, Trash2, Plus,
  ArrowUpFromLine, ArrowDownFromLine, Eraser
} from 'lucide-react';
import './index.css';
import ZephyrUploadModal from './components/ZephyrUploadModal';

const BACKEND_API_BASE = '/api';

interface PlatformConfig {
  label: string;
  placeholder: string;
}

const PLATFORM_ISSUE_ID: Record<string, PlatformConfig> = {
  Jira: { label: 'Jira Issue ID', placeholder: 'e.g. PROJ-1234' },
  ADO: { label: 'ADO Work Item ID', placeholder: 'e.g. 1234' },
  "X-Ray": { label: 'X-Ray Test ID', placeholder: 'e.g. TEST-001' },
  TestRail: { label: 'TestRail Case ID', placeholder: 'e.g. C1234' },
  QTest: { label: 'QTest Requirement ID', placeholder: 'e.g. 12/456  (projectId/reqId)' },
  Zephyr: { label: 'Zephyr Test ID', placeholder: 'e.g. TEST-001' },
};

const TOOL_COLUMN_LABEL: Record<string, string> = {
  Jira: 'Jira ID',
  ADO: 'ADO Work Item ID',
  'X-Ray': 'X-Ray Test ID',
  TestRail: 'TestRail Case ID',
  QTest: 'QTest ID',
  Zephyr: 'Zephyr Test ID',
};

interface ALMToolConfig {
  urlLabel: string;
  urlPlaceholder: string;
  showUsername: boolean;
  usernameLabel: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  hint: string;
}

const ALM_TOOL_CONFIG: Record<string, ALMToolConfig> = {
  Jira: {
    urlLabel:         'Jira Base URL',
    urlPlaceholder:   'https://yourorg.atlassian.net',
    showUsername:     true,
    usernameLabel:    'Email',
    tokenLabel:       'API Token',
    tokenPlaceholder: 'Your Jira API token',
    hint:             'Generate an API token at https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  ADO: {
    urlLabel:         'Organization URL',
    urlPlaceholder:   'https://dev.azure.com/yourorg',
    showUsername:     false,
    usernameLabel:    '',
    tokenLabel:       'Personal Access Token',
    tokenPlaceholder: 'PAT with full permissions',
    hint:             'Create a PAT in Azure DevOps under User Settings → Personal Access Tokens.',
  },
  'X-Ray': {
    urlLabel:         'Jira Base URL',
    urlPlaceholder:   'https://yourorg.atlassian.net',
    showUsername:     true,
    usernameLabel:    'Email',
    tokenLabel:       'API Token',
    tokenPlaceholder: 'Your Jira API token',
    hint:             'X-Ray Cloud uses your Jira credentials. Ensure the account has X-Ray project permissions.',
  },
  TestRail: {
    urlLabel:         'TestRail URL',
    urlPlaceholder:   'https://yourorg.testrail.io',
    showUsername:     true,
    usernameLabel:    'Email / Username',
    tokenLabel:       'API Key / Password',
    tokenPlaceholder: 'TestRail API key or password',
    hint:             'Generate an API key in TestRail under My Settings → API Keys.',
  },
  QTest: {
    urlLabel:         'QTest URL',
    urlPlaceholder:   'https://yourorg.qtestnet.com',
    showUsername:     false,
    usernameLabel:    '',
    tokenLabel:       'Bearer Token',
    tokenPlaceholder: 'Your QTest bearer token',
    hint:             'Find the Bearer Token in QTest Manager under Resources → API & SDK.',
  },
  Zephyr: {
    urlLabel:         'Jira Base URL',
    urlPlaceholder:   'https://yourorg.atlassian.net',
    showUsername:     true,
    usernameLabel:    'Email',
    tokenLabel:       'API Token',
    tokenPlaceholder: 'Your Jira API token',
    hint:             'Zephyr Scale uses your Jira credentials. Ensure your account has Zephyr Scale project permissions.',
  },
};

const getAlmToolConfig = (tool: string): ALMToolConfig =>
  ALM_TOOL_CONFIG[tool] || {
    urlLabel: 'Workspace URL', urlPlaceholder: '', showUsername: true,
    usernameLabel: 'Username', tokenLabel: 'Token', tokenPlaceholder: '',
    hint: '',
  };

const getPlatformIssueId = (tool: string): PlatformConfig =>
  PLATFORM_ISSUE_ID[tool] || { label: `${tool} Issue ID`, placeholder: 'e.g. ISSUE-001' };


const getGapAnalysisSteps = (provider: string, tool: string): string[] => [
  `Fetching ${tool} issue...`,
  'Preparing requirement context...',
  `Verifying ${provider} connection...`,
  `Running ${provider} analysis...`,
  'Waiting for gap analysis response...',
];

const getTestConnectionSteps = (type: string): string[] => [
  `Connecting to ${type}...`,
  `Verifying ${type} credentials...`,
  `Testing ${type} connection...`,
  `Finalizing ${type} verification...`,
];

const getTestPlanSteps = (): string[] => [
  'Validating requirements...',
  'Analyzing test scope...',
  'Generating test plan structure...',
  'Adding test cases...',
  'Finalizing test plan...',
];

const getTestCaseSteps = (): string[] => [
  'Validating requirements...',
  'Analyzing test scenarios...',
  'Generating test case structure...',
  'Adding test steps and expected results...',
  'Finalizing test cases...',
];

const getTestScenariosSteps = (): string[] => [
  'Validating requirements...',
  'Analyzing test scope...',
  'Extracting test scenarios...',
  'Structuring scenario details...',
  'Finalizing Test Scenarios...',
];

const getUploadSteps = (): string[] => [
  'Preparing upload...',
  'Uploading to ALM...',
  'Verifying upload...',
  'Finalizing upload...',
];

interface Step {
  id: string;
  label: string;
  icon: any;
  hasArrow?: boolean;
}

const STEPS: Step[] = [
  { id: 'connection', label: 'Test Connection', icon: Network },
  { id: 'testplan', label: 'Create Test Plan', icon: FileText },
  { id: 'testcases', label: 'Create Test Cases', icon: ClipboardList },
  { id: 'testscenarios', label: 'Create Test Scenarios', icon: Box },
  // { id: 'review', label: 'Review Test Cases', icon: Shield },
  { id: 'automation', label: 'Automation', icon: Zap, hasArrow: true },
  { id: 'github', label: 'GitHub', icon: GitBranch },
  { id: 'githubcicd', label: 'GitHub CICD', icon: GitBranch },
  { id: 'zephyr', label: 'Zephyr Dashboard', icon: Monitor }
];

interface Analysis {
  summary: string;
  recommendation: string;
  strengths: string[];
  gaps: string[];
  sourceContext: string;
}

const GapAnalysisPreview: React.FC<{ analysis: Analysis }> = ({ analysis }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const plain = [
      `Summary: ${analysis.summary}`,
      `Recommendation: ${analysis.recommendation}`,
      '',
      'Strengths:',
      ...analysis.strengths.map((s) => `  • ${s}`),
      '',
      'Detected Gaps:',
      ...analysis.gaps.map((g) => `  • ${g}`),
      '',
      'Source Context:',
      analysis.sourceContext,
    ].join('\n');

    const toHtmlList = (items: string[]) =>
      `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

    const html = `
      <h3>${analysis.summary}</h3>
      <p><em>${analysis.recommendation}</em></p>
      <h4>Strengths</h4>${toHtmlList(analysis.strengths)}
      <h4>Detected Gaps</h4>${toHtmlList(analysis.gaps)}
      <h4>Source Context</h4>
      <pre>${analysis.sourceContext}</pre>
    `;

    try {
      (navigator.clipboard as any).write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } catch {
      navigator.clipboard.writeText(plain).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button className="preview-copy-btn" onClick={handleCopy} title="Copy to clipboard">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <h3 style={{ fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-main)', paddingRight: '5rem' }}>{analysis.summary}</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>{analysis.recommendation}</p>
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-main)' }}>Strengths</div>
        <ul style={{ paddingLeft: '1.25rem', color: 'var(--text-main)' }}>
          {analysis.strengths.map((item, i) => (
            <li key={i} style={{ marginBottom: '0.4rem', fontSize: '0.88rem' }}>{item}</li>
          ))}
        </ul>
      </div>
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-main)' }}>Detected Gaps</div>
        <ul style={{ paddingLeft: '1.25rem', color: 'var(--text-main)' }}>
          {analysis.gaps.map((item, i) => (
            <li key={i} style={{ marginBottom: '0.4rem', fontSize: '0.88rem' }}>{item}</li>
          ))}
        </ul>
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-main)' }}>Source Context</div>
        <p style={{ fontSize: '0.82rem', whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{analysis.sourceContext}</p>
      </div>
    </div>
  );
};

interface TestStep {
  stepNumber: number;
  action: string;
  expected: string;
  testData: string;
}

interface TestCase {
  testCaseId: string;
  testCaseTitle: string;
  module: string;
  preconditions: string;
  testSteps: TestStep[];
  testData: string;
  expectedResult: string;
  priority: string;
  testType: string;
  toolTicketId?: string;
  toolId?: string;
}

interface TestData {
  testPlanTitle: string;
  testCases: TestCase[];
}

interface UploadConfig {
  projectKey: string;
  projectName: string;
  testPlanId: string;
  testSuiteId: string;
  projectId: string;
  suiteId: string;
  sectionId: string;
  moduleId: string;
}

const TcCopyButton: React.FC<{ data: TestData }> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  const cases = (data?.testCases || []).filter(tc => !!tc);
  const plainText = [
    data?.testPlanTitle || 'Generated Test Cases',
    '',
    ...cases.map((tc, i) => {
      const stepsText = Array.isArray(tc.testSteps)
        ? tc.testSteps.map(s => s && typeof s === 'object' ? `${s.stepNumber}. ${s.action} | Expected: ${s.expected}` : String(s)).join('\n      ')
        : tc.testSteps;
      return [
        `${i + 1}. [${tc.testCaseId}] ${tc.testCaseTitle}`,
        `   Module: ${tc.module}`,
        `   Preconditions: ${tc.preconditions}`,
        `   Steps:\n      ${stepsText}`,
        `   Test Data: ${tc.testData}`,
        `   Expected: ${tc.expectedResult}`,
        `   Priority: ${tc.priority} | Type: ${tc.testType}`,
      ].join('\n');
    }),
  ].join('\n');
  const handleCopy = () => {
    navigator.clipboard.writeText(plainText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className="preview-copy-btn" onClick={handleCopy} title="Copy to clipboard" style={{ position: 'static' }}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
};


const TestCasesPreview: React.FC<{
  data: TestData;
  tool: string;
  selectedIndices?: number[];
  onToggleSelect?: (index: number) => void;
  onSelectAll?: (all: boolean) => void;
  onEdit?: (tc: TestCase, index: number) => void;
  onDelete?: (index: number) => void;
}> = ({ data, tool, selectedIndices = [], onToggleSelect, onSelectAll, onEdit, onDelete }) => {
  const [isFilterVisible, setIsFilterVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');

  const cases = (data?.testCases || []).filter((tc): tc is TestCase => !!tc);

  const filteredItems = useMemo(() => {
    return cases.map((tc, idx) => ({ tc, originalIndex: idx }))
      .filter(({ tc }) => {
        const lowerSearch = searchText.toLowerCase();
        const titleMatch = (tc.testCaseTitle || "").toLowerCase().includes(lowerSearch);
        const precondMatch = (tc.preconditions || "").toLowerCase().includes(lowerSearch);
        const stepsMatch = Array.isArray(tc.testSteps) && tc.testSteps.some(s => (s?.action || "").toLowerCase().includes(lowerSearch));

        const matchesSearch = !searchText || titleMatch || precondMatch || stepsMatch;
        const matchesPriority = priorityFilter === 'All' || tc.priority === priorityFilter;
        const matchesType = typeFilter === 'All' || tc.testType === typeFilter;

        return matchesSearch && matchesPriority && matchesType;
      });
  }, [cases, searchText, priorityFilter, typeFilter]);

  const allSelected = filteredItems.length > 0 &&
    filteredItems.every(({ originalIndex }) => selectedIndices.includes(originalIndex));

  const handleClearFilters = () => {
    setSearchText('');
    setPriorityFilter('All');
    setTypeFilter('All');
  };

  const hasActiveFilters = searchText !== '' || priorityFilter !== 'All' || typeFilter !== 'All';

  return (
    <div className="test-cases-preview-wrapper" style={{ width: '100%' }}>
      {cases.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No test cases returned.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="filter-controls-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', minHeight: '40px', width: '100%' }}>
            {onSelectAll ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onSelectAll(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                  Select All ({filteredItems.length} cases)
                </span>
              </div>
            ) : <div />}

            <div className="filter-controls-right" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {hasActiveFilters && (
                <button className="filter-clear-btn" onClick={handleClearFilters}>
                  <Eraser size={14} /> Clear
                </button>
              )}
              <button
                className={`filter-toggle-btn ${isFilterVisible ? 'active' : ''}`}
                onClick={() => setIsFilterVisible(!isFilterVisible)}
                style={{ whiteSpace: 'nowrap' }}
              >
                <ListFilter size={14} /> Filter
              </button>
            </div>
          </div>

          {isFilterVisible && (
            <div className="filter-expand-panel" style={{ width: '100%', boxSizing: 'border-box' }}>
              <div className="filter-input-wrapper">
                <Search size={14} className="filter-input-icon" />
                <input
                  type="text"
                  placeholder="Search cases..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="filter-input-field"
                />
              </div>

              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="filter-select-field"
              >
                <option value="All">All Priorities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="filter-select-field"
              >
                <option value="All">All Types</option>
                <option value="Functional">Functional</option>
                <option value="Non-Functional">Non-Functional</option>
                <option value="Regression">Regression</option>
                <option value="Smoke">Smoke</option>
                <option value="Sanity">Sanity</option>
                <option value="API">API</option>
              </select>
            </div>
          )}

          <div className="test-cases-scroll-container" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto', maxHeight: '550px', paddingRight: '0.5rem', paddingBottom: '0.5rem' }}>
            {filteredItems.map(({ tc, originalIndex }) => (
              <div key={originalIndex} style={{
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                padding: '0.85rem',
                background: 'var(--bg-main)',
                position: 'relative'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {onToggleSelect && (
                      <input
                        type="checkbox"
                        checked={selectedIndices.includes(originalIndex)}
                        onChange={() => onToggleSelect(originalIndex)}
                        style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                      />
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {onEdit && (
                        <button
                          onClick={() => onEdit(tc, originalIndex)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', padding: '2px' }}
                          title="Edit Test Case"
                        >
                          <Pencil size={16} />
                        </button>
                      )}
                      {onDelete && (
                        <button
                          onClick={() => onDelete(originalIndex)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px' }}
                          title="Delete Test Case"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                    <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-main)' }}>
                      [{tc.testCaseId}] {tc.testCaseTitle}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <span className={`tc-badge tc-badge--${(tc.priority || '').toLowerCase()}`}>{tc.priority}</span>
                    <span className="tc-badge tc-badge--type">{tc.testType}</span>
                  </div>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem 1rem', paddingLeft: '2.5rem' }}>
                  <span><strong>Module:</strong> {tc.module}</span>
                  <span><strong>{TOOL_COLUMN_LABEL[tool] || `${tool} ID`}:</strong> {tc.toolTicketId || tc.toolId}</span>
                  <span style={{ gridColumn: '1/-1' }}><strong>Preconditions:</strong> {tc.preconditions}</span>
                  <div style={{ gridColumn: '1/-1' }}>
                    <strong>Steps:</strong>
                    {Array.isArray(tc.testSteps) ? (
                      <div style={{ marginLeft: '0.5rem', marginTop: '0.25rem' }}>
                        {tc.testSteps.map((s, idx) => (
                          s && typeof s === 'object' ? (
                            <div key={idx} style={{ marginBottom: '0.15rem' }}>
                              <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{s.stepNumber || idx + 1}.</span> {s.action || 'No Action'}
                              {s.testData && s.testData !== 'N/A' && (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}> (Data: {s.testData})</span>
                              )}
                            </div>
                          ) : <div key={idx}>{String(s)}</div>
                        ))}
                      </div>
                    ) : (
                      <span> {String(tc.testSteps || '')}</span>
                    )}
                  </div>
                  <span style={{ gridColumn: '1/-1' }}><strong>Test Data:</strong> {tc.testData}</span>
                  <span style={{ gridColumn: '1/-1' }}><strong>Expected Result:</strong> {tc.expectedResult}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};


const EditTestCaseModal: React.FC<{
  tc: TestCase;
  onSave: (updatedTc: TestCase) => void;
  onClose: () => void;
}> = ({ tc, onSave, onClose }) => {
  const [edited, setEdited] = useState<TestCase>({ ...tc });
  const [error, setError] = useState<string | null>(null);
  const [collapsedSteps, setCollapsedSteps] = useState<Set<number>>(() => {
    const s = new Set<number>();
    tc.testSteps.forEach((_, i) => s.add(i));
    return s;
  });

  const toggleStep = (index: number) => {
    let isExpanding = false;
    setCollapsedSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
        isExpanding = true;
      } else {
        next.add(index);
      }
      return next;
    });

    if (isExpanding) {
      setTimeout(() => {
        const el = document.getElementById(`step-card-${index}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  };

  const handleFieldChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setEdited({ ...edited, [e.target.name]: e.target.value });
  };

  const handleStepChange = (index: number, field: keyof TestStep, value: string | number) => {
    const newSteps = [...edited.testSteps];
    newSteps[index] = { ...newSteps[index], [field]: value };
    setEdited({ ...edited, testSteps: newSteps });
    if (error && field === 'action' && value) setError(null);
  };

  const insertStepAfter = (index: number) => {
    const newSteps = [...edited.testSteps];
    const newStep: TestStep = {
      stepNumber: 0,
      action: '',
      expected: '',
      testData: 'N/A'
    };
    newSteps.splice(index + 1, 0, newStep);
    const renumbered = newSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    setEdited({ ...edited, testSteps: renumbered });
    setCollapsedSteps(prev => {
      const next = new Set(prev);
      next.delete(index + 1);
      return next;
    });
  };

  const insertStepBefore = (index: number) => {
    const newSteps = [...edited.testSteps];
    const newStep: TestStep = {
      stepNumber: 0,
      action: '',
      expected: '',
      testData: 'N/A'
    };
    newSteps.splice(index, 0, newStep);
    const renumbered = newSteps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    setEdited({ ...edited, testSteps: renumbered });
    setCollapsedSteps(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  };

  const removeStep = (index: number) => {
    const newSteps = edited.testSteps.filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, stepNumber: i + 1 }));
    setEdited({ ...edited, testSteps: newSteps });
  };

  const validateAndSave = () => {
    const emptySteps = edited.testSteps.filter(s => !s.action.trim());
    if (emptySteps.length > 0) {
      setError(`Cannot save with ${emptySteps.length} empty step(s). Please provide step actions.`);
      return;
    }
    onSave(edited);
  };

  const handleCloseAttempt = () => {
    const isDirty = JSON.stringify(edited) !== JSON.stringify(tc);
    if (isDirty) {
      if (window.confirm("You have unsaved changes. Do you want to discard them?")) {
        onClose();
      }
    } else {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleCloseAttempt}>
      <div className="modal-content tc-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ padding: '0.6rem 1.25rem' }}>
          <h2 style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-main)', fontWeight: 800 }}>Edit {tc.testCaseId}</h2>

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--text-main)', textTransform: 'uppercase' }}>Priority</span>
              <select
                name="priority"
                value={edited.priority}
                onChange={handleFieldChange}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  height: '22px',
                  fontSize: '0.6rem',
                  fontWeight: 800,
                  padding: '0 0.3rem',
                  textTransform: 'uppercase',
                  background: 'var(--bg-main)',
                  color: edited.priority === 'High' ? '#e11d48' : edited.priority === 'Medium' ? '#d97706' : '#059669'
                }}
              >
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.6rem', fontWeight: 800, color: 'var(--text-main)', textTransform: 'uppercase' }}>Type</span>
              <select
                name="testType"
                value={edited.testType}
                onChange={handleFieldChange}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  height: '22px',
                  fontSize: '0.6rem',
                  fontWeight: 800,
                  padding: '0 0.3rem',
                  textTransform: 'uppercase',
                  background: 'var(--bg-main)',
                  color: 'var(--text-main)'
                }}
              >
                <option value="Functional">Functional</option>
                <option value="Non-Functional">Non-Functional</option>
                <option value="Regression">Regression</option>
                <option value="Smoke">Smoke</option>
                <option value="Sanity">Sanity</option>
                <option value="API">API</option>
              </select>
            </div>
          </div>

          <button onClick={handleCloseAttempt} className="modal-close-btn" style={{ marginLeft: 'auto' }}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-subheader" style={{ padding: '0.5rem 1.25rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.62rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>Title</label>
              <input
                name="testCaseTitle"
                value={edited.testCaseTitle}
                onChange={handleFieldChange}
                className="form-control"
                style={{ height: '30px', fontSize: '0.82rem', padding: '0.35rem 0.65rem' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label style={{ fontSize: '0.62rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>Module</label>
              <input
                name="module"
                value={edited.module}
                onChange={handleFieldChange}
                className="form-control"
                style={{ height: '30px', fontSize: '0.82rem', padding: '0.35rem 0.65rem' }}
              />
            </div>
          </div>
        </div>

        <div className="modal-body" style={{ maxHeight: '78vh', paddingTop: '0.75rem' }}>
          {error && (
            <div className="validation-error-banner" style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem' }}>
              <AlertTriangle size={14} />
              <span style={{ fontSize: '0.75rem' }}>{error}</span>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.62rem', color: 'var(--text-main)', marginBottom: '0.25rem' }}>Preconditions</label>
            <textarea
              name="preconditions"
              value={edited.preconditions}
              onChange={handleFieldChange}
              className="form-control"
              rows={2}
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.65rem' }}
            />
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <label style={{ marginBottom: 0, fontSize: '0.62rem', color: 'var(--text-main)' }}>Test Steps</label>
              <button onClick={() => insertStepBefore(0)} className="btn btn-primary compact" style={{ height: '32px' }}>
                <Plus size={14} /> Add First Step
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
              {edited.testSteps.map((step, idx) => (
                <React.Fragment key={idx}>
                  <div className={`tc-step-card ${collapsedSteps.has(idx) ? 'tc-step-card--collapsed' : ''}`} id={`step-card-${idx}`}>
                    <div className="tc-step-header" onClick={() => toggleStep(idx)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                        <div style={{ width: '18px', height: '18px', background: 'var(--primary)', color: 'white', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 800 }}>
                          {step.stepNumber}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {step.action || 'New Step'}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '0.15rem', background: 'var(--bg-main)', padding: '2px', borderRadius: '4px' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); insertStepBefore(idx); }}
                            className="btn-glossy-green"
                            title="Add Step Above"
                          >
                            <ArrowUpFromLine size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); insertStepAfter(idx); }}
                            className="btn-glossy-green"
                            title="Add Step Below"
                          >
                            <ArrowDownFromLine size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeStep(idx); }}
                            className="btn-glossy-red"
                            title="Remove Step"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <div style={{ width: '1px', height: '12px', background: 'var(--border-color)' }}></div>
                        <button onClick={(e) => { e.stopPropagation(); toggleStep(idx); }} className="tc-step-toggle-btn" title={collapsedSteps.has(idx) ? "Expand" : "Collapse"}>
                          {collapsedSteps.has(idx) ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                        </button>
                      </div>
                    </div>

                    {!collapsedSteps.has(idx) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', animation: 'fadeIn 0.2s ease-out' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ fontSize: '0.6rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>Action</label>
                            <textarea
                              placeholder="Step action..."
                              value={step.action}
                              onChange={(e) => handleStepChange(idx, 'action', e.target.value)}
                              className="form-control"
                              rows={2}
                              style={{ fontSize: '0.78rem', padding: '0.35rem 0.6rem' }}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label style={{ fontSize: '0.6rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>Expected Result</label>
                            <textarea
                              placeholder="Expected result..."
                              value={step.expected}
                              onChange={(e) => handleStepChange(idx, 'expected', e.target.value)}
                              className="form-control"
                              rows={2}
                              style={{ fontSize: '0.78rem', padding: '0.35rem 0.6rem' }}
                            />
                          </div>
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: '0.6rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>Step Test Data</label>
                          <input
                            placeholder="Step specific data..."
                            value={step.testData}
                            onChange={(e) => handleStepChange(idx, 'testData', e.target.value)}
                            className="form-control"
                            style={{ height: '28px', fontSize: '0.78rem' }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>


          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.75rem' }}>
            <div className="form-group">
              <label style={{ fontSize: '0.62rem', color: 'var(--text-main)', marginBottom: '0.3rem' }}>Overall Test Data</label>
              <textarea
                name="testData"
                value={edited.testData}
                onChange={handleFieldChange}
                className="form-control"
                rows={4}
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.65rem' }}
              />
            </div>
            <div className="form-group">
              <label style={{ fontSize: '0.62rem', color: 'var(--text-main)', marginBottom: '0.3rem' }}>Overall Expected Result</label>
              <textarea
                name="expectedResult"
                value={edited.expectedResult}
                onChange={handleFieldChange}
                className="form-control"
                rows={4}
                style={{ fontSize: '0.8rem', padding: '0.4rem 0.65rem' }}
              />
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ padding: '0.65rem 1.25rem' }}>
          <button className="btn btn-outline" onClick={handleCloseAttempt} style={{ height: '30px', padding: '0 0.85rem', fontSize: '0.78rem' }}>Cancel</button>
          <button className="btn btn-primary" onClick={validateAndSave} style={{ height: '30px', padding: '0 1.15rem', fontSize: '0.78rem' }}>Save and Close</button>
        </div>
      </div>
    </div>
  );
};

const TestCasesResultsSection: React.FC<{
  data: TestData;
  tool: string;
  selectedIndices: number[];
  onToggleSelect: (index: number) => void;
  onSelectAll: (all: boolean) => void;
  onEdit: (tc: TestCase, index: number) => void;
  onDelete: (index: number) => void;
  onDeleteSelected: () => void;
  title?: string;
}> = ({ data, tool, selectedIndices, onToggleSelect, onSelectAll, onEdit, onDelete, onDeleteSelected, title = "Generated Test Cases" }) => {
  return (
    <div className="test-results-container">
      <div className="test-results-header">
        <h2 className="test-results-title">{title}</h2>

        <div className="test-results-controls">
          {selectedIndices.length > 0 && (
            <button className="btn btn-outline red compact" onClick={onDeleteSelected} style={{ height: '32px' }}>
              <Trash2 size={14} /> Delete Selected ({selectedIndices.length})
            </button>
          )}
          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 0.5rem' }}></div>
          <TcCopyButton data={data} />
        </div>
      </div>

      <div className="test-results-card">
        <TestCasesPreview
          data={data}
          tool={tool}
          selectedIndices={selectedIndices}
          onToggleSelect={onToggleSelect}
          onSelectAll={onSelectAll}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
};


const IssueDetailsPreview: React.FC<{ details: IssueDetails; issueId: string; tool: string }> = ({ details, issueId, tool }) => {
  const fieldsOrder = ['Issue ID', 'Title', 'Issue Type', 'Priority', 'State', 'Status', 'Description', 'Labels', 'Components', 'Type', 'Summary', 'Acceptance Criteria', 'Steps', 'Preconditions', 'Expected Result', 'Test Type'];

  const orderedDetails = fieldsOrder
    .filter(key => key in details)
    .reduce((acc, key) => ({ ...acc, [key]: details[key] }), {} as IssueDetails);

  const remainingDetails = Object.keys(details)
    .filter(key => !fieldsOrder.includes(key))
    .reduce((acc, key) => ({ ...acc, [key]: details[key] }), {} as IssueDetails);

  const allDetails = { ...orderedDetails, ...remainingDetails };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <h3 style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '0.95rem', margin: '0 0 1rem 0' }}>
        {issueId}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        {Object.entries(allDetails).map(([key, value]) => (
          <div key={key}>
            <div style={{ fontWeight: 600, marginBottom: '0.3rem', color: 'var(--text-main)', fontSize: '0.8rem' }}>
              {key}
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface FormData {
  llmProvider: string;
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  selectedTool: string;
  baseUrl: string;
  username: string;
  token: string;
  issueId: string;
}

type AIConfig  = { llmApiKey: string; llmModel: string; llmEndpoint: string };
type ALMConfig = { baseUrl: string; username: string; token: string; issueId: string };

interface TcFormData {
  manualRequirements: string;
  customInstructions: string;
  sharedPrerequisites: string;
  businessRules: string;
  widgetsSections: string;
  additionalContext: string;
}

interface IssueDetails {
  [key: string]: string;
}

const App: React.FC = () => {
  const [theme, setTheme] = useState('light');
  const [currentView, setCurrentView] = useState('connection');
  const [aiStatus, setAiStatus] = useState('Not Connected!');
  const [almStatus, setAlmStatus] = useState('Not Connected!');
  const [aiTesting, setAiTesting] = useState(false);
  const [almTesting, setAlmTesting] = useState(false);
  const [aiStepIndex, setAiStepIndex] = useState(0);
  const [almStepIndex, setAlmStepIndex] = useState(0);
  const [issueDetails, setIssueDetails] = useState<IssueDetails | null>(null);
  const [issueFetching, setIssueFetching] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'save' | 'error' } | null>(null);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // ── Test Plan state ──────────────────────────────────────────────────────
  const [tpStatus, setTpStatus] = useState('');
  const [tpDocPath, setTpDocPath] = useState('');
  const [tpGapAnalysis, setTpGapAnalysis] = useState<Analysis | null>(null);
  const [tpGapRunning, setTpGapRunning] = useState(false);
  const [tpGapStepIndex, setTpGapStepIndex] = useState(0);
  const [tpGenerating, setTpGenerating] = useState(false);
  const [tpGenerateStepIndex, setTpGenerateStepIndex] = useState(0);

  // ── Test Cases state ─────────────────────────────────────────────────────
  const [tcFormData, setTcFormData] = useState<TcFormData>({
    manualRequirements: '',
    customInstructions: '',
    sharedPrerequisites: '',
    businessRules: '',
    widgetsSections: '',
    additionalContext: '',
  });

  // ── Conversation State Management ────────────────────────────────────────
  const clearConversationState = () => {
    // Clear all state related to conversation and generation
    setTcFormData({
      manualRequirements: '',
      customInstructions: '',
      sharedPrerequisites: '',
      businessRules: '',
      widgetsSections: '',
      additionalContext: '',
    });
    setTcStatus('');
    setTcDocPath('');
    setTcMdPath('');
    setTcResults(null);
    setSelectedTcIndices([]);
    setEditingTcIndex(null);
    setEditingTc(null);
    setTcGapAnalysis(null);
    setTcGapRunning(false);
    setTcGapStepIndex(0);
    setTcGenerating(false);
    setTcGenerateStepIndex(0);
    setTcCoverageScore(null);
    setTcSaveRunning(false);
    setShowTcInsights(false);
    setUploadTargetTool(null);

    // Clear Test Plan state
    setTpStatus('');
    setTpDocPath('');
    setTpGapAnalysis(null);
    setTpGapRunning(false);
    setTpGapStepIndex(0);
    setTpGenerating(false);
    setTpGenerateStepIndex(0);
    setTpScenarios(null);
    setSelectedTsIndices([]);

    // Clear issue details and status
    setIssueDetails(null);
    setIssueFetching(false);

    // Clear upload state
    setUploadModalOpen(false);
    setUploadConfig({
      projectKey: '',
      projectName: '',
      testPlanId: '',
      testSuiteId: '',
      projectId: '',
      suiteId: '',
      sectionId: '',
      moduleId: ''
    });
    setUploadResults([]);
    setUploadRunning(false);
    setUploadMessage(null);
    setAvailableProjects([]);
    setFetchingProjects(false);

    // Clear connection status
    setAiStatus('Not Connected!');
    setAlmStatus('Not Connected!');
    setAiTesting(false);
    setAlmTesting(false);
    setAiStepIndex(0);
    setAlmStepIndex(0);

    // Clear any active editing
    setEditingTc(null);

    setToast({ message: 'Conversation state cleared successfully.', type: 'success' });
  };
  const [showTCOptional, setShowTCOptional] = useState(false);
  const [tcStatus, setTcStatus] = useState('');
  const [tcPostError, setTcPostError] = useState('');
  const [tcDocPath, setTcDocPath] = useState('');
  const [tcResults, setTcResults] = useState<TestData | null>(null);
  const [selectedTcIndices, setSelectedTcIndices] = useState<number[]>([]);
  const [editingTcIndex, setEditingTcIndex] = useState<number | null>(null);
  const [editingTc, setEditingTc] = useState<TestCase | null>(null);
  const [tcGapAnalysis, setTcGapAnalysis] = useState<Analysis | null>(null);
  const [tcGapRunning, setTcGapRunning] = useState(false);
  const [tcGapStepIndex, setTcGapStepIndex] = useState(0);
  const [tcGenerating, setTcGenerating] = useState(false);
  const [tcGenerateStepIndex, setTcGenerateStepIndex] = useState(0);
  const [tcMdPath, setTcMdPath] = useState('');
  const [tcCoverageScore, setTcCoverageScore] = useState<number | null>(null);
  const [tcSaveRunning, setTcSaveRunning] = useState(false);
  const [showTcInsights, setShowTcInsights] = useState(false);
  const [uploadTargetTool, setUploadTargetTool] = useState<string | null>(null);
  const [zephyrModalOpen, setZephyrModalOpen] = useState(false);

  // ── Test Scenarios state ──────────────────────────────────────────────────
  const [tpScenarios, setTpScenarios] = useState<TestData | null>(null);
  const [selectedTsIndices, setSelectedTsIndices] = useState<number[]>([]);

  // ── Upload to ALM state ────────────────────────────────────────────────────
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadConfig, setUploadConfig] = useState<UploadConfig>({
    projectKey: '',
    projectName: '',
    testPlanId: '',
    testSuiteId: '',
    projectId: '',
    suiteId: '',
    sectionId: '',
    moduleId: ''
  });
  const [uploadResults, setUploadResults] = useState<any[]>([]);
  const [uploadRunning, setUploadRunning] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ type: 'error' | 'success', text: string } | null>(null);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);
  const [fetchingProjects, setFetchingProjects] = useState(false);

  const [formData, setFormData] = useState<FormData>({
    llmProvider: 'GROQ',
    llmEndpoint: 'http://127.0.0.1:11434',
    llmModel: '',
    llmApiKey: '',
    selectedTool: 'Jira',
    baseUrl: '',
    username: '',
    token: '',
    issueId: ''
  });

  const getPendingStatus = (type: 'AI' | 'ALM', provider: string) =>
    type === 'AI' && provider === 'Ollama'
      ? 'Checking provider endpoint...'
      : 'Pinging API server...';

  const isNeutralStatus = (s: string) =>
    ['Pinging API server...', 'Checking provider endpoint...', 'Generating test plan...',
      'Analyzing requirement gaps...', 'Generating test cases...'].includes(s) ||
    getGapAnalysisSteps(formData.llmProvider, formData.selectedTool).includes(s);

  const getStatusClass = (status: string) => {
    if (!status) return '';
    if (['Connection Successful!', 'Gap analysis completed.'].includes(status) ||
      status.startsWith('Test Plan generated:') || status.startsWith('Test cases generated:') ||
      status.startsWith('Test Scenarios generated:'))
      return 'status-indicator success';
    if (status.startsWith('Error:')) return 'status-indicator error';
    if (isNeutralStatus(status)) return 'status-indicator neutral';
    return 'status-indicator error';
  };

  const renderStatusIcon = (status: string) => {
    if (status === 'Connection Successful!') return <CheckCircle2 size={18} />;
    if (status === 'Not Connected!') return <WifiOff size={18} />;
    if (['Gap analysis completed.'].includes(status) ||
      status.startsWith('Test Plan generated:') || status.startsWith('Test cases generated:') ||
      status.startsWith('Test Scenarios generated:'))
      return <CheckCircle2 size={18} />;
    if (status.startsWith('Error:')) return <AlertTriangle size={18} />;
    return <Zap size={18} />;
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Test Plan gap analysis step ticker
  useEffect(() => {
    if (!tpGapRunning) return undefined;
    const steps = getGapAnalysisSteps(formData.llmProvider, formData.selectedTool);
    setTpGapStepIndex(0);
    setTpStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setTpGapStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setTpStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1800);
    return () => window.clearInterval(id);
  }, [tpGapRunning, formData.llmProvider, formData.selectedTool]);

  // Test Cases gap analysis step ticker
  useEffect(() => {
    if (!tcGapRunning) return undefined;
    const steps = getGapAnalysisSteps(formData.llmProvider, formData.selectedTool);
    setTcGapStepIndex(0);
    setTcStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setTcGapStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setTcStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1800);
    return () => window.clearInterval(id);
  }, [tcGapRunning, formData.llmProvider, formData.selectedTool]);

  // Test Plan generation step ticker
  useEffect(() => {
    if (!tpGenerating) return undefined;
    const steps = currentView === 'testscenarios' ? getTestScenariosSteps() : getTestPlanSteps();
    setTpGenerateStepIndex(0);
    setTpStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setTpGenerateStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setTpStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1500);
    return () => window.clearInterval(id);
  }, [tpGenerating, currentView]);

  // Test Cases generation step ticker
  useEffect(() => {
    if (!tcGenerating) return undefined;
    const steps = getTestCaseSteps();
    setTcGenerateStepIndex(0);
    setTcStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setTcGenerateStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setTcStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1500);
    return () => window.clearInterval(id);
  }, [tcGenerating]);

  // AI connection test step ticker
  useEffect(() => {
    if (!aiTesting) return undefined;
    const steps = getTestConnectionSteps('AI');
    setAiStepIndex(0);
    setAiStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setAiStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setAiStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1200);
    return () => window.clearInterval(id);
  }, [aiTesting]);

  // ALM connection test step ticker
  useEffect(() => {
    if (!almTesting) return undefined;
    const steps = getTestConnectionSteps('ALM');
    setAlmStepIndex(0);
    setAlmStatus(`Step 1/${steps.length}: ${steps[0]}`);
    const id = window.setInterval(() => {
      setAlmStepIndex(prev => {
        const next = Math.min(prev + 1, steps.length - 1);
        setAlmStatus(`Step ${next + 1}/${steps.length}: ${steps[next]}`);
        return next;
      });
    }, 1200);
    return () => window.clearInterval(id);
  }, [almTesting]);

  // Load persistence
  useEffect(() => {
    const aiConfigs:  Record<string, AIConfig>  = JSON.parse(localStorage.getItem('ai_configs')  || '{}');
    const almConfigs: Record<string, ALMConfig> = JSON.parse(localStorage.getItem('alm_configs') || '{}');

    // One-time migration from legacy flat key
    if (!Object.keys(aiConfigs).length && !Object.keys(almConfigs).length) {
      const legacy = localStorage.getItem('agent_config');
      if (legacy) {
        const d = JSON.parse(legacy);
        if (d.llmProvider)  aiConfigs[d.llmProvider]   = { llmApiKey: d.llmApiKey || '', llmModel: d.llmModel || '', llmEndpoint: d.llmEndpoint || 'http://127.0.0.1:11434' };
        if (d.selectedTool) almConfigs[d.selectedTool] = { baseUrl: d.baseUrl || '', username: d.username || '', token: d.token || '', issueId: d.issueId || '' };
      }
    }

    const provider = localStorage.getItem('last_provider') || 'GROQ';
    const tool     = localStorage.getItem('last_tool')     || 'Jira';
    const ai  = aiConfigs[provider]  || { llmApiKey: '', llmModel: '', llmEndpoint: 'http://127.0.0.1:11434' };
    const alm = almConfigs[tool]     || { baseUrl: '', username: '', token: '', issueId: '' };

    setFormData(prev => ({ ...prev, llmProvider: provider, selectedTool: tool, ...ai, ...alm }));
  }, []);

  useEffect(() => {
    if (uploadModalOpen) {
      setUploadMessage(null);
      setAvailableProjects([]);
    }
  }, [uploadModalOpen]);

  const AI_FIELDS = new Set(['llmProvider', 'llmEndpoint', 'llmModel', 'llmApiKey']);
  const ALM_FIELDS = new Set(['selectedTool', 'baseUrl', 'username', 'token']);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    if (name === 'llmProvider') {
      const aiConfigs: Record<string, AIConfig> = JSON.parse(localStorage.getItem('ai_configs') || '{}');
      const saved = aiConfigs[value] || { llmApiKey: '', llmModel: '', llmEndpoint: 'http://127.0.0.1:11434' };
      setFormData(prev => ({ ...prev, llmProvider: value, ...saved }));
      setAiStatus('Not Connected!');
      return;
    }

    if (name === 'selectedTool') {
      const almConfigs: Record<string, ALMConfig> = JSON.parse(localStorage.getItem('alm_configs') || '{}');
      const saved = almConfigs[value] || { baseUrl: '', username: '', token: '', issueId: '' };
      setFormData(prev => ({ ...prev, selectedTool: value, ...saved }));
      setAlmStatus('Not Connected!');
      setIssueDetails(null);
      return;
    }

    setFormData(prev => ({ ...prev, [name]: value }));
    if (AI_FIELDS.has(name))  setAiStatus('Not Connected!');
    if (ALM_FIELDS.has(name)) setAlmStatus('Not Connected!');
    if (name === 'issueId')   setIssueDetails(null);
  };

  const handleSave = (type: 'AI' | 'ALM') => {
    if (type === 'AI') {
      const aiConfigs: Record<string, AIConfig> = JSON.parse(localStorage.getItem('ai_configs') || '{}');
      aiConfigs[formData.llmProvider] = {
        llmApiKey:   formData.llmApiKey,
        llmModel:    formData.llmModel,
        llmEndpoint: formData.llmEndpoint,
      };
      localStorage.setItem('ai_configs',    JSON.stringify(aiConfigs));
      localStorage.setItem('last_provider', formData.llmProvider);
    } else {
      const almConfigs: Record<string, ALMConfig> = JSON.parse(localStorage.getItem('alm_configs') || '{}');
      almConfigs[formData.selectedTool] = {
        baseUrl:  formData.baseUrl,
        username: formData.username,
        token:    formData.token,
        issueId:  formData.issueId,
      };
      localStorage.setItem('alm_configs', JSON.stringify(almConfigs));
      localStorage.setItem('last_tool',   formData.selectedTool);
    }
    setToast({ message: `${type} Configuration Saved!`, type: 'save' });
  };

  const handleFetchIssue = async () => {
    setIssueFetching(true);
    setIssueDetails(null);
    try {
      const res = await fetch(`${BACKEND_API_BASE}/fetch-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.details) {
        setIssueDetails(d.details);
        setToast({ message: `Successfully fetched details for ${formData.issueId}`, type: 'success' });
      } else {
        const err = d.detail || 'Could not fetch issue details.';
        setTpStatus(`Error: ${err}`);
        setToast({ message: `Fetch Error: ${err}`, type: 'error' });
      }
    } catch {
      setTpStatus('Error: Failed to fetch issue details.');
      setToast({ message: 'Network Error: Failed to fetch issue details.', type: 'error' });
    } finally {
      setIssueFetching(false);
    }
  };

  const readErrorDetail = async (res: Response) => {
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      return data.detail || data.message || `Request failed with status ${res.status}.`;
    }

    const text = await res.text().catch(() => '');
    if (!text) return `Request failed with status ${res.status}.`;

    return text.length > 180 ? `${text.slice(0, 180).trim()}...` : text;
  };

  const handleTestBackend = async (type: 'AI' | 'ALM') => {
    const setStatus = type === 'AI' ? setAiStatus : setAlmStatus;
    const setTesting = type === 'AI' ? setAiTesting : setAlmTesting;
    setTesting(true);

    try {
      const res = await fetch(`${BACKEND_API_BASE}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...formData })
      });
      if (res.ok) {
        setStatus('Connection Successful!');
        setToast({ message: `${type} Connection Successful!`, type: 'success' });
      } else {
        const err = await readErrorDetail(res);
        setStatus(`Error: ${err}`);
        setToast({ message: `Connection Failed: ${err}`, type: 'error' });
      }
    } catch (err) {
      setStatus('Failed to reach verification service.');
      setToast({ message: 'Network Error: Backend unreachable.', type: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const TopHeader: React.FC = () => (
    <header className="top-header">
      <div className="header-left">
        <div className="header-title">AI TEST COMMAND CENTER</div>
        <div className="badge-ai">Powered by OTSI</div>
      </div>
      <div className="header-right">
        <div className="user-profile">
          <div className="user-text" style={{ textAlign: 'right' }}>
            <span className="user-name">OTSI - Smart QA</span>
            <span className="user-role">AI-DRIVEN</span>
          </div>
          <div className="avatar">OS</div>
        </div>
      </div>
    </header>
  );

  const renderConnectionView = () => (
    <>
      <h1 className="page-title">Connection Settings</h1>
      <p className="page-subtitle">Configure your ALM integration and AI engine endpoints to establish the data linkage.</p>

      <div className="card-grid">
        {/* AI Engine Card */}
        <div className="card">
          <div className="card-header">
            <div className="icon-circle"><Network size={20} /></div>
            <div className="card-title">AI Engine Settings</div>
            <div className={aiStatus === 'Connection Successful!' ? 'badge-connected' : 'badge-config'}>
              {aiStatus === 'Connection Successful!' ? 'CONNECTED' : 'CONFIG REQUIRED'}
            </div>
          </div>

          <div className="form-group">
            <label>Provider</label>
            <select name="llmProvider" value={formData.llmProvider} onChange={handleChange} className="form-control">
              <option value="GROQ">GROQ (Cloud)</option>
              <option value="Claude">Claude (Anthropic)</option>
              <option value="OpenRouter">OpenRouter (All Models)</option>
              <option value="Grok">Grok (xAI)</option>
              <option value="Anthropic">Anthropic (Direct)</option>
              <option value="Ollama">Ollama (Local)</option>
            </select>
          </div>

          {formData.llmProvider === 'Ollama' ? (
            <div className="form-group">
              <label>Endpoint URL</label>
              <input type="url" name="llmEndpoint" value={formData.llmEndpoint} onChange={handleChange} className="form-control" />
            </div>
          ) : (
            <div className="form-group">
              <label>API Key</label>
              <input type="password" name="llmApiKey" value={formData.llmApiKey} onChange={handleChange} className="form-control" />
            </div>
          )}

          <div className="form-group">
            <label>Model Name</label>
            <input
              type="text"
              name="llmModel"
              value={formData.llmModel}
              onChange={handleChange}
              className="form-control"
              placeholder={formData.llmProvider === 'Ollama' ? 'e.g. llama3.2:latest' : formData.llmProvider === 'OpenRouter' ? 'e.g. google/gemini-pro-1.5' : 'e.g. claude-3-5-sonnet-latest'}
            />
          </div>

          {aiStatus && aiStatus !== 'Connection Successful!' && (
            <div className={getStatusClass(aiStatus)} style={{ marginBottom: '1rem', marginTop: 0 }}>
              {renderStatusIcon(aiStatus)} {aiStatus}
            </div>
          )}
          <div className="actions-row">
            <button className="btn btn-primary" disabled={aiTesting} onClick={() => handleTestBackend('AI')}>{aiTesting ? <><RefreshCw size={16} className="spin" /> Testing...</> : <>Test Connection</>}</button>
            <button className="btn btn-primary" onClick={() => handleSave('AI')}>Save Connection</button>
          </div>
        </div>

        {/* ALM Card */}
        <div className="card">
          <div className="card-header">
            <div className="icon-circle"><Database size={20} /></div>
            <div className="card-title">Test Management Setup</div>
            <div className={almStatus === 'Connection Successful!' ? 'badge-connected' : 'badge-config'}>
              {almStatus === 'Connection Successful!' ? 'CONNECTED' : 'CONFIG REQUIRED'}
            </div>
          </div>

          <div className="form-group">
            <label>Test Management Tool</label>
            <select name="selectedTool" value={formData.selectedTool} onChange={handleChange} className="form-control">
              <option value="Jira">Jira Cloud</option>
              <option value="ADO">Azure DevOps (ADO)</option>
              <option value="X-Ray">X-Ray (Cloud)</option>
              <option value="TestRail">TestRail</option>
              <option value="QTest">QTest</option>
              <option value="Zephyr">Zephyr Scale</option>
            </select>
          </div>

          {(() => {
            const almCfg = getAlmToolConfig(formData.selectedTool);
            return (
              <>
                <div className="form-group">
                  <label>{almCfg.urlLabel}</label>
                  <input type="url" name="baseUrl" value={formData.baseUrl} onChange={handleChange}
                    className="form-control" placeholder={almCfg.urlPlaceholder} />
                </div>

                {almCfg.showUsername && (
                  <div className="form-group">
                    <label>{almCfg.usernameLabel}</label>
                    <input type="text" name="username" value={formData.username} onChange={handleChange}
                      className="form-control" placeholder={almCfg.usernameLabel} />
                  </div>
                )}

                <div className="form-group">
                  <label>{almCfg.tokenLabel}</label>
                  <input type="password" name="token" value={formData.token} onChange={handleChange}
                    className="form-control" placeholder={almCfg.tokenPlaceholder} />
                </div>

                {almCfg.hint && (
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted, #888)', marginTop: '-0.5rem', marginBottom: '0.75rem', lineHeight: 1.4 }}>
                    {almCfg.hint}
                  </p>
                )}
              </>
            );
          })()}

          {almStatus && almStatus !== 'Connection Successful!' && (
            <div className={getStatusClass(almStatus)} style={{ marginBottom: '1rem', marginTop: 0 }}>
              {renderStatusIcon(almStatus)} {almStatus}
            </div>
          )}
          <div className="actions-row">
            <button className="btn btn-primary" disabled={almTesting} onClick={() => handleTestBackend('ALM')}>{almTesting ? <><RefreshCw size={16} className="spin" /> Testing...</> : <>Test Connection</>}</button>
            <button className="btn btn-primary" onClick={() => handleSave('ALM')}>Save Connection</button>
          </div>
        </div>
      </div>
    </>
  );

  const handleSaveEditedTc = async (updatedTc: TestCase) => {
    if (!tcResults || editingTcIndex === null) return;
    const newCases = [...tcResults.testCases];
    newCases[editingTcIndex] = updatedTc;
    const newResults = { ...tcResults, testCases: newCases };
    setTcResults(newResults);
    setEditingTcIndex(null);
    setEditingTc(null);

    // Sync with backend
    try {
      const res = await fetch(`${BACKEND_API_BASE}/update-test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_cases: newCases,
          issueId: formData.issueId,
          selectedTool: formData.selectedTool
        })
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.document_path) {
        setTcDocPath(d.document_path);
        setToast({ message: 'Test case updated and synced.', type: 'success' });
      }
    } catch {
      setToast({ message: 'Saved locally, but sync failed.', type: 'error' });
    }
  };

  const handleDeleteTc = async (index: number) => {
    if (!tcResults) return;
    const newCases = tcResults.testCases.filter((_, i) => i !== index);
    const newResults = { ...tcResults, testCases: newCases };
    setTcResults(newResults);
    setSelectedTcIndices(prev => prev.filter(i => i !== index).map(i => i > index ? i - 1 : i));

    // Sync with backend
    try {
      await fetch(`${BACKEND_API_BASE}/update-test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_cases: newCases,
          issueId: formData.issueId,
          selectedTool: formData.selectedTool
        })
      });
      setToast({ message: 'Test case deleted.', type: 'success' });
    } catch {
      setToast({ message: 'Deleted locally, sync failed.', type: 'error' });
    }
  };

  const handleDeleteSelected = async () => {
    if (!tcResults || selectedTcIndices.length === 0) return;
    const newCases = tcResults.testCases.filter((_, i) => !selectedTcIndices.includes(i));
    const newResults = { ...tcResults, testCases: newCases };
    setTcResults(newResults);
    setSelectedTcIndices([]);

    // Sync with backend
    try {
      await fetch(`${BACKEND_API_BASE}/update-test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_cases: newCases,
          issueId: formData.issueId,
          selectedTool: formData.selectedTool
        })
      });
      setToast({ message: 'Selected cases deleted.', type: 'success' });
    } catch {
      setToast({ message: 'Deleted locally, sync failed.', type: 'error' });
    }
  };

  const handleRunGapAnalysis = async (postGeneration = false) => {
    setTcGapRunning(true);
    setTcGapAnalysis(null);
    setTcCoverageScore(null);
    try {
      const res = await fetch(`${BACKEND_API_BASE}/analyze-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, ...tcFormData }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === 'success' && data.analysis) {
        setTcGapAnalysis(data.analysis);
        const s = data.analysis.strengths?.length ?? 0;
        const g = data.analysis.gaps?.length ?? 0;
        const raw = Math.round((s / Math.max(s + g, 1)) * 100);
        setTcCoverageScore(Math.min(raw, 95));
        setTcStatus('Gap analysis completed.');
        setToast({ message: 'Gap analysis completed successfully.', type: 'success' });
      } else {
        const err = data.detail || data.message || 'Gap analysis failed.';
        if (postGeneration) {
          setTcPostError(`Error: ${err}`);
        } else {
          setTcStatus(`Error: ${err}`);
        }
        setToast({ message: `Analysis Failed: ${err}`, type: 'error' });
      }
    } catch {
      if (postGeneration) {
        setTcPostError('Error: Unable to analyze requirement gaps.');
      } else {
        setTcStatus('Error: Unable to analyze requirement gaps.');
      }
      setToast({ message: 'Network Error: Analysis failed.', type: 'error' });
    } finally {
      setTcGapRunning(false);
    }
  };

  const handleSaveToLibrary = async () => {
    if (!tcResults) return;
    setTcSaveRunning(true);
    try {
      const res = await fetch(`${BACKEND_API_BASE}/save-library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: tcResults.testPlanTitle,
          testCases: tcResults.testCases,
          issueId: formData.issueId,
          savedAt: new Date().toISOString(),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.status === 'success') {
        setToast({ message: 'Test cases saved to library.', type: 'success' });
      } else {
        setToast({ message: `Save failed: ${d.detail || 'Unknown error'}`, type: 'error' });
      }
    } catch {
      setToast({ message: 'Network Error: Could not reach save-library endpoint.', type: 'error' });
    } finally {
      setTcSaveRunning(false);
    }
  };

  const handleFetchAvailableProjects = async () => {
    setFetchingProjects(true);
    setAvailableProjects([]);

    const tool = uploadTargetTool === 'Zephyr' ? 'Jira' : uploadTargetTool || formData.selectedTool;
    const payload = {
      type: 'list-projects',
      selectedTool: tool,
      baseUrl: formData.baseUrl,
      username: formData.username,
      token: formData.token,
    };

    try {
      const res = await fetch(`${BACKEND_API_BASE}/list-projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Handle HTTP error responses
        const errorMsg = d.detail || d.message || `HTTP ${res.status}: Unable to fetch projects for ${tool}`;
        setUploadMessage({ type: 'error', text: errorMsg });
      } else if (d.status === 'success' && d.projects) {
        setAvailableProjects(d.projects);
        setUploadMessage({ type: 'success', text: `Found ${d.projects.length} project(s)` });
      } else {
        setUploadMessage({
          type: 'error',
          text: d.detail || d.message || `Unable to fetch projects for ${tool}. Check your credentials.`
        });
      }
    } catch {
      setUploadMessage({ type: 'error', text: 'Unable to fetch projects. Is the backend running?' });
    } finally {
      setFetchingProjects(false);
    }
  };

  const handleUploadToALM = async (config: UploadConfig) => {
    setUploadRunning(true);
    setUploadResults([]);
    setUploadMessage(null);

    const toUpload = tcResults?.testCases || [];
    const payload = {
      ...formData,
      testCases: toUpload,
      ...config,
      // Use Jira as selectedTool when uploading to Zephyr (Zephyr Scale is a Jira plugin)
      selectedTool: uploadTargetTool === 'Zephyr' ? 'Jira' : uploadTargetTool || formData.selectedTool,
    };

    try {
      const res = await fetch(`${BACKEND_API_BASE}/upload-to-alm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorMsg = d.detail || d.message || `HTTP ${res.status}: Upload failed`;
        setUploadMessage({ type: 'error', text: errorMsg });
        setToast({ message: `Error: ${errorMsg}`, type: 'error' });
      } else if (d.status === 'success') {
        setUploadResults(d.results || []);
        setUploadMessage({ type: 'success', text: d.message || 'Upload complete successfully!' });
        setToast({ message: d.message || 'Upload complete.', type: 'save' });
        // Auto-close on success after 2 seconds
        setTimeout(() => {
          setUploadModalOpen(false);
        }, 2000);
      } else {
        const errorMsg = d.detail || d.message || 'Upload failed.';
        setUploadMessage({ type: 'error', text: errorMsg });
        setToast({ message: `Error: ${errorMsg}`, type: 'error' });
      }
    } catch (err) {
      const errorMsg = 'Unable to upload. Is the backend running?';
      setUploadMessage({ type: 'error', text: errorMsg });
      setToast({ message: `Error: ${errorMsg}`, type: 'error' });
    } finally {
      setUploadRunning(false);
    }
  };



  const renderGeneratorView = (title: string) => (
    <>
      <h1 className="page-title">{title}</h1>
      <p className="page-subtitle">Fetch User Story dynamically from {formData.selectedTool} or define explicit generation parameters.</p>

      <div className="twin-col">
        {/* Left Side -> Controls */}
        <div className="left-controls" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div className="card-header" style={{ margin: '0 0 1rem 0' }}>
              <div className="card-title" style={{ fontSize: '0.95rem' }}>Requirement Source</div>
            </div>

            <div className="form-group">
              <label>{getPlatformIssueId(formData.selectedTool).label}</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input type="text" name="issueId" value={formData.issueId} onChange={handleChange} className="form-control" placeholder={getPlatformIssueId(formData.selectedTool).placeholder} style={{ flex: 1 }} />
                <button
                  className="btn btn-primary"
                  title="Fetch issue details"
                  style={{ width: '2.4rem', height: '2.4rem', padding: '0', flexShrink: 0, borderRadius: '6px' }}
                  disabled={!formData.issueId.trim() || issueFetching}
                  onClick={handleFetchIssue}
                >
                  {issueFetching ? <RefreshCw size={18} className="spin" /> : <Search size={18} />}
                </button>
              </div>
            </div>
            <div className="tc-or-divider">OR PASTE BELOW</div>
            <div className="form-group">
              <label>Manual Requirements</label>
              <textarea className="form-control" rows={5} placeholder="Paste your requirements, user stories, acceptance criteria, or condition details here..." style={{ marginBottom: 0 }} />
            </div>
          </div>

          <div className="card" style={{ padding: '1.5rem', borderColor: 'var(--primary)' }}>
            <div className="card-header" style={{ margin: '0 0 1rem 0' }}>
              <div className="card-title" style={{ fontSize: '0.95rem' }}>Generation Instructions</div>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Agent will utilize {formData.llmProvider} to execute zero-hallucination extraction mapping to the Test Plan structure.
            </p>
          </div>
        </div>

        {/* Right Side -> Preview Pane (Gap Analysis / Issue Details) */}
        <div className="preview-pane" style={(tpGapAnalysis || issueDetails) ? { alignItems: 'stretch', justifyContent: 'flex-start', textAlign: 'left', padding: '1.25rem', overflowY: 'auto' } : {}}>
          {tpGapAnalysis ? (
            <GapAnalysisPreview analysis={tpGapAnalysis} />
          ) : issueDetails ? (
            <IssueDetailsPreview details={issueDetails} issueId={formData.issueId} tool={formData.selectedTool} />
          ) : (
            <>
              <ClipboardList size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
              <h3 style={{ fontWeight: '600', marginBottom: '0.5rem' }}>No analysis available</h3>
              <p style={{ fontSize: '0.85rem', maxWidth: '250px' }}>Run Analyze Gaps First to review missing requirement details before generation.</p>
            </>
          )}
        </div>
      </div>

      {currentView === 'review' && tcResults && (
        <TestCasesResultsSection
          data={tcResults}
          tool={formData.selectedTool}
          selectedIndices={selectedTcIndices}
          onToggleSelect={(index) => {
            setSelectedTcIndices(prev =>
              prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
            );
          }}
          onSelectAll={(all) => {
            setSelectedTcIndices(all ? (tcResults?.testCases?.map((_, i) => i) || []) : []);
          }}
          onEdit={(tc, index) => {
            setEditingTcIndex(index);
            setEditingTc(tc);
          }}
          onDelete={handleDeleteTc}
          onDeleteSelected={handleDeleteSelected}
        />
      )}

      {currentView === 'testscenarios' && tpScenarios && (
        <div className="card" style={{ padding: '1.25rem', marginTop: '1rem' }}>
          <div className="card-header" style={{ margin: '0 0 1.5rem 0' }}>
            <div className="card-title">Generated Test Scenarios</div>
          </div>
          <TestCasesPreview
            data={tpScenarios}
            tool={formData.selectedTool}
            selectedIndices={selectedTsIndices}
            onToggleSelect={(index) => {
              setSelectedTsIndices(prev =>
                prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
              );
            }}
            onSelectAll={(all) => {
              setSelectedTsIndices(all ? (tpScenarios?.testCases?.map((_, i) => i) || []) : []);
            }}
          />
        </div>
      )}

      {tpStatus ? (
        <div style={{
          marginTop: '1rem',
          marginBottom: 0,
          borderRadius: '8px',
          animation: 'slideIn 0.3s ease-out',
        }}>
          {tpDocPath && !tpStatus.startsWith('Error:') ? (
            // Completion state: show filename and download button
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: '8px',
              padding: '1rem',
              gap: '1rem',
              flexWrap: 'wrap',
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1, minWidth: '200px' }}>
                <CheckCircle2 size={20} style={{ color: '#10b981', flexShrink: 0 }} />
                <span style={{
                  color: '#10b981',
                  fontWeight: 700,
                  fontSize: '0.92rem',
                  letterSpacing: '0.01em',
                  wordBreak: 'break-all',
                }}>
                  {tpDocPath.split(/[\\/]/).pop() || 'document'}
                </span>
              </span>
              <a
                className="btn"
                href={`${BACKEND_API_BASE}/artifact?path=${encodeURIComponent(tpDocPath)}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  padding: '0.65rem 1.5rem',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  textDecoration: 'none',
                  boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                  transition: 'all 0.2s ease',
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Download size={16} />
                {currentView === 'review' ? 'Download Test Cases' : currentView === 'testscenarios' ? 'Download Test Scenarios' : 'Download Test Plan'}
              </a>
            </div>
          ) : (
            // Progress state: show step indicator
            <div className={getStatusClass(tpStatus)} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '1rem',
              borderRadius: '8px',
            }}>
              {renderStatusIcon(tpStatus)}
              <span style={{ fontWeight: 500 }}>{tpStatus}</span>
            </div>
          )}
        </div>
      ) : null}

      <div className="actions-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.875rem', marginTop: '0.875rem', justifyContent: 'flex-start' }}>
        <button className="btn btn-salmon" disabled={tpGapRunning} onClick={async () => {
          setTpGapAnalysis(null);
          setTpDocPath('');
          setTpGapRunning(true);
          try {
            const res = await fetch(`${BACKEND_API_BASE}/analyze-gaps`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(formData),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.status === 'success' && data.analysis) {
              setTpGapAnalysis(data.analysis);
              setTpStatus('Gap analysis completed.');
              setToast({ message: 'Gap analysis completed successfully.', type: 'success' });
            } else {
              const err = data.detail || data.message || 'Gap analysis failed.';
              setTpStatus(`Error: ${err}`);
              setToast({ message: `Analysis Failed: ${err}`, type: 'error' });
            }
          } catch {
            setTpStatus('Error: Unable to analyze requirement gaps.');
            setToast({ message: 'Network Error: Analysis failed.', type: 'error' });
          } finally {
            setTpGapRunning(false);
          }
        }}>{tpGapRunning ? <><RefreshCw size={16} className="spin" /> Analyzing...</> : <>Analyze Gaps First</>}</button>
        <button className="btn btn-outline red" disabled={tpGenerating} onClick={async () => {
          // Action mapping remains same as before
          const isScenarios = currentView === 'testscenarios';
          const isReview = currentView === 'review';
          const isTestPlan = currentView === 'testplan';

          setTpDocPath('');
          if (isScenarios) setTpScenarios(null);
          setTpGenerating(true);
          try {
            const apiEndpoint = isScenarios ? '/generate-scenarios' : isReview ? '/generate-test-cases' : '/generate';
            const res = await fetch(`${BACKEND_API_BASE}${apiEndpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(isReview ? { ...formData, ...tcFormData } : formData),
            });
            const d = await res.json().catch(() => ({}));
            if (d.status === 'success') {
              const parts = (d.document_path || '').split(/[\\/]/);
              const filename = parts[parts.length - 1] || 'document';
              if (!isScenarios) setTpDocPath(d.document_path || '');
              if (isReview && d.test_cases) {
                setTcResults(d.test_cases);
                setTcMdPath(d.md_path || '');
                setTcDocPath(d.document_path || '');
              }
              if (isScenarios && d.test_cases) setTpScenarios(d.test_cases);
              const statusMsg = isScenarios ? 'Test Scenarios' : isReview ? 'Test Cases' : 'Test Plan';
              const tcCount = isReview && d.test_cases ? d.test_cases.testCases?.length || 0 : 0;
              const detailedMsg = isReview
                ? `Test cases generated: ${filename} (${tcCount} cases)`
                : `${statusMsg} generated: ${filename}`;
              setTpStatus(detailedMsg);
              setToast({ message: `${statusMsg} Generated Successfully`, type: 'success' });
            } else {
              const err = d.detail || d.message || 'Execution error.';
              setTpStatus(`Error: ${err}`);
              setToast({ message: `Generation Error: ${err}`, type: 'error' });
            }
          } catch {
            setTpStatus('Error: Backend exception. Is API server running?');
            setToast({ message: 'Network Error: Generation failed.', type: 'error' });
          } finally {
            setTpGenerating(false);
          }
        }}>{tpGenerating
          ? <><RefreshCw size={16} className="spin" /> Generating...</>
          : <>
            {currentView === 'testplan' ? 'Generate Test Plan' :
              currentView === 'testscenarios' ? 'Generate Test Scenarios' :
                currentView === 'review' ? 'Review Test Cases Plan' :
                  'Generate Directly'}
          </>
          }</button>

        {currentView === 'review' && tcResults && (
          <button className="btn btn-primary" onClick={() => setUploadModalOpen(true)} style={{ marginLeft: '1rem' }}>
            Upload to {uploadTargetTool ?? formData.selectedTool}
          </button>
        )}
      </div>
    </>
  );

  const handleTcChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => setTcFormData({ ...tcFormData, [e.target.name]: e.target.value });

  const tcStatusClass = (s: string) => {
    if (!s) return '';
    const lower = s.toLowerCase();
    if (lower.includes('generated') || lower.includes('completed')) return 'status-indicator success';
    if (lower.includes('error') || lower.includes('failed')) return 'status-indicator error';
    return 'status-indicator neutral';
  };

  const tcStatusIcon = (s: string) => {
    if (s === 'Test cases generated.' || s.startsWith('Test cases generated:') || s === 'Gap analysis completed.') return <CheckCircle2 size={18} />;
    if (s.startsWith('Error:')) return <AlertTriangle size={18} />;
    return <Zap size={18} />;
  };

  const TcActionPanel: React.FC<{
    tcResults: TestData;
    tcDocPath: string;
    tcMdPath: string;
    coverageScore: number | null;
    gapAnalysis: Analysis | null;
    gapRunning: boolean;
    saveRunning: boolean;
    selectedTool: string;
    showInsights: boolean;
    onPushToZephyr: () => void;
    onSaveToLibrary: () => void;
    onSendToReview: () => void;
    onShowInsights: (show: boolean) => void;
  }> = (props) => {
    const {
      tcDocPath,
      tcMdPath,
      coverageScore,
      gapAnalysis,
      gapRunning,
      saveRunning,
      showInsights,
      onPushToZephyr,
      onSaveToLibrary,
      onSendToReview,
      onShowInsights,
    } = props;

    return (
      <div className="tc-action-panel">
        {/* Push to Zephyr */}
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={onPushToZephyr}>
          <ArrowUpFromLine size={16} /> Push to Zephyr
        </button>

        {/* Divider */}
        <div className="tc-action-panel__divider">Downloads</div>

        {/* Download .md File */}
        <a
          className="tc-action-panel__list-item"
          href={tcMdPath ? `${BACKEND_API_BASE}/artifact?path=${encodeURIComponent(tcMdPath)}` : '#'}
          aria-disabled={!tcMdPath}
          style={!tcMdPath ? { opacity: 0.4, pointerEvents: 'none', cursor: 'not-allowed' } : {}}
        >
          <FileText size={16} /> Download .md File
        </a>

        {/* Download Excel File */}
        <a
          className="tc-action-panel__list-item"
          href={tcDocPath ? `${BACKEND_API_BASE}/artifact?path=${encodeURIComponent(tcDocPath)}` : '#'}
          aria-disabled={!tcDocPath}
          style={!tcDocPath ? { opacity: 0.4, pointerEvents: 'none', cursor: 'not-allowed' } : {}}
        >
          <Download size={16} /> Download Excel File
        </a>

        {/* Save to Library */}
        <button
          className="btn"
          onClick={onSaveToLibrary}
          disabled={saveRunning}
          style={{ width: '100%', background: '#10b981', color: 'white', marginTop: '0.25rem' }}
        >
          {saveRunning ? (
            <>
              <RefreshCw size={14} className="spin" /> Saving...
            </>
          ) : (
            <>
              <Database size={16} /> Save to Library
            </>
          )}
        </button>

        {/* AI Insights Card - Only show on right-click */}
        {showTcInsights && (
          <div className="tc-action-panel__insights">
            <div className="tc-action-panel__insights-title">AI INSIGHTS</div>
            {gapRunning ? (
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <RefreshCw size={14} className="spin" /> Calculating coverage...
              </div>
            ) : coverageScore !== null ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <svg width="64" height="64" viewBox="0 0 64 64" style={{ marginBottom: '0.25rem' }}>
                    <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="5" />
                    <circle
                      cx="32"
                      cy="32"
                      r="26"
                      fill="none"
                      stroke={coverageScore >= 80 ? '#10b981' : coverageScore >= 60 ? '#f59e0b' : '#ef4444'}
                      strokeWidth="5"
                      strokeDasharray={`${2 * Math.PI * 26}`}
                      strokeDashoffset={`${2 * Math.PI * 26 * (1 - coverageScore / 100)}`}
                      strokeLinecap="round"
                      transform="rotate(-90 32 32)"
                    />
                  </svg>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'white', position: 'relative', top: '-3rem' }}>
                    {coverageScore}%
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'rgba(255,255,255,0.7)', position: 'relative', top: '-3rem' }}>
                    Coverage
                  </div>
                </div>
                {gapAnalysis?.summary && (
                  <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)', marginTop: '0.5rem', lineHeight: 1.4 }}>
                    {gapAnalysis.summary}
                  </p>
                )}
                {gapAnalysis && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)' }}>
                    {gapAnalysis.strengths?.length ?? 0} strengths · {gapAnalysis.gaps?.length ?? 0} gaps
                  </div>
                )}
              </>
            ) : (
              <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', margin: 0 }}>
                Run gap analysis to see coverage.
              </p>
            )}
          </div>
        )}

        {/* Send to AI Review - HIDDEN */}
        {/* <button
          className="btn btn-outline"
          onClick={onSendToReview}
          onContextMenu={(e) => {
            e.preventDefault();
            onShowInsights(true);
          }}
          style={{ width: '100%', borderColor: 'var(--primary)', color: 'var(--primary)' }}
        >
          <Shield size={16} /> Send to AI Review
        </button> */}
      </div>
    );
  };

  const renderTestCasesView = () => (
    <>
      <h1 className="page-title">Test Case Architect</h1>
      <p className="page-subtitle">
        Generate detailed, structured test cases from {formData.selectedTool} tickets or manual requirements using a powerful
        AI hallucination-proof and context-aware generation process.
      </p>

      {/* Two-column: Requirement Source | Requirement Preview */}
      <div className="tc-twin-col">
        {/* Left — Requirement Source */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <div className="card-header" style={{ margin: '0 0 1.25rem 0' }}>
            <div className="card-title" style={{ fontSize: '0.95rem' }}>Requirement Source</div>
          </div>

          <div className="form-group">
            <label>{getPlatformIssueId(formData.selectedTool).label}</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                name="issueId"
                value={formData.issueId}
                onChange={handleChange}
                className="form-control"
                placeholder={getPlatformIssueId(formData.selectedTool).placeholder}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-primary"
                title="Fetch issue details"
                style={{ width: '2.4rem', height: '2.4rem', padding: '0', flexShrink: 0, borderRadius: '6px' }}
                disabled={!formData.issueId.trim() || issueFetching}
                onClick={handleFetchIssue}
              >
                {issueFetching ? <Zap size={18} /> : <Search size={18} />}
              </button>
            </div>
          </div>

          <div className="tc-or-divider">OR PASTE BELOW</div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Manual Requirements</label>
            <textarea
              name="manualRequirements"
              value={tcFormData.manualRequirements}
              onChange={handleTcChange}
              className="form-control"
              rows={5}
              placeholder="Paste your requirements, user stories, acceptance criteria, or condition details here..."
            />
          </div>
        </div>

        {/* Right — Requirement Preview / Gap Analysis */}
        <div className="preview-pane" style={(tcGapAnalysis || tcResults || issueDetails) ? { alignItems: 'stretch', justifyContent: 'flex-start', textAlign: 'left', padding: '1.25rem', overflowY: 'auto' } : {}}>
          {tcGapAnalysis ? (
            <GapAnalysisPreview analysis={tcGapAnalysis} />
          ) : tcResults ? (
            <>
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '0.95rem', marginBottom: '0.4rem' }}>Requirement Context</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>{formData.issueId || 'Manual Input'}</div>
                </div>
              </div>
              <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '1rem', background: 'var(--bg-main)', overflowY: 'auto', maxHeight: '400px', width: '100%' }}>
                {issueDetails ? (
                  <IssueDetailsPreview details={issueDetails} issueId={formData.issueId} tool={formData.selectedTool} />
                ) : (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{tcFormData.manualRequirements || 'No requirements provided.'}</p>
                )}
              </div>
            </>
          ) : issueDetails ? (
            <IssueDetailsPreview details={issueDetails} issueId={formData.issueId} tool={formData.selectedTool} />
          ) : (
            <>
              <ClipboardList size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
              <h3 style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.95rem' }}>Requirement Preview</h3>
              <p style={{ fontSize: '0.82rem', maxWidth: '220px' }}>
                Click "Analyze Gaps First" to review gaps or "Generate Test Cases" to create test cases.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Generation Preference */}
      <div className="card" style={{ padding: '1.25rem', marginTop: '1rem' }}>
        <div className="card-header" style={{ margin: '0 0 1rem 0' }}>
          <div className="card-title" style={{ fontSize: '0.95rem' }}>Generation Preference</div>
          <span className="badge-config" style={{ marginLeft: 'auto' }}>Customize Instructions</span>
        </div>
        <textarea
          name="customInstructions"
          value={tcFormData.customInstructions}
          onChange={handleTcChange}
          className="form-control"
          rows={4}
          placeholder={
            'e.g. Generate functional test cases covering happy path and edge cases\n' +
            'e.g. Create 15 test cases with boundary value analysis\n' +
            'e.g. Focus on API integration and negative scenarios\n' +
            'e.g. Include preconditions, steps, expected results for each test case'
          }
        />
      </div>

      {/* Optional Fields Toggle */}
      <div
        className="tc-optional-toggle"
        onClick={() => setShowTCOptional(!showTCOptional)}
      >
        <ChevronDown
          size={16}
          style={{ transform: showTCOptional ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        />
        <span>Show Optional Fields</span>
        <span className="tc-optional-hint">Prerequisites, Rules, Widgets, Context</span>
      </div>

      {showTCOptional && (
        <div className="card" style={{ padding: '1.5rem', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>

            <div className="tc-opt-field">
              <div className="tc-opt-field__header">
                <span className="tc-opt-field__icon tc-opt-field__icon--prereq">⇌</span>
                <div>
                  <div className="tc-opt-field__title">Shared Prerequisites</div>
                  <div className="tc-opt-field__sub">Referenced in all Pre-conditions</div>
                </div>
              </div>
              <textarea
                name="sharedPrerequisites"
                value={tcFormData.sharedPrerequisites}
                onChange={handleTcChange}
                className="form-control"
                rows={3}
                placeholder="e.g. User logged in → Settings page"
              />
            </div>

            <div className="tc-opt-field">
              <div className="tc-opt-field__header">
                <span className="tc-opt-field__icon tc-opt-field__icon--rules">⊘</span>
                <div>
                  <div className="tc-opt-field__title">Business Rules</div>
                  <div className="tc-opt-field__sub">Validation rules, constraints</div>
                </div>
              </div>
              <textarea
                name="businessRules"
                value={tcFormData.businessRules}
                onChange={handleTcChange}
                className="form-control"
                rows={3}
                placeholder="e.g. Email must be valid format, Age ≥ 18, Password min 8 chars"
              />
            </div>

            <div className="tc-opt-field">
              <div className="tc-opt-field__header">
                <span className="tc-opt-field__icon tc-opt-field__icon--widgets">⊞</span>
                <div>
                  <div className="tc-opt-field__title">Widgets / UI Sections</div>
                  <div className="tc-opt-field__sub">Test cases per widget</div>
                </div>
              </div>
              <textarea
                name="widgetsSections"
                value={tcFormData.widgetsSections}
                onChange={handleTcChange}
                className="form-control"
                rows={3}
                placeholder="e.g. Login Form (editable), Dashboard Cards"
              />
            </div>

            <div className="tc-opt-field">
              <div className="tc-opt-field__header">
                <span className="tc-opt-field__icon tc-opt-field__icon--context">⊕</span>
                <div>
                  <div className="tc-opt-field__title">Additional Context</div>
                  <div className="tc-opt-field__sub">Edge cases, special notes</div>
                </div>
              </div>
              <textarea
                name="additionalContext"
                value={tcFormData.additionalContext}
                onChange={handleTcChange}
                className="form-control"
                rows={3}
                placeholder="Extra context or focus areas..."
              />
            </div>

          </div>
        </div>
      )}

      {/* Test Case Results + Action Panel */}
      {tcResults && (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', marginTop: '1rem' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TestCasesResultsSection
              data={tcResults}
              tool={formData.selectedTool}
              selectedIndices={selectedTcIndices}
              onToggleSelect={(index) => {
                setSelectedTcIndices(prev =>
                  prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
                );
              }}
              onSelectAll={(all) => {
                setSelectedTcIndices(all ? (tcResults?.testCases?.map((_, i) => i) || []) : []);
              }}
              onEdit={(tc, index) => {
                setEditingTcIndex(index);
                setEditingTc(tc);
              }}
              onDelete={handleDeleteTc}
              onDeleteSelected={handleDeleteSelected}
            />
          </div>
          <TcActionPanel
            tcResults={tcResults}
            tcDocPath={tcDocPath}
            tcMdPath={tcMdPath}
            coverageScore={tcCoverageScore}
            gapAnalysis={tcGapAnalysis}
            gapRunning={tcGapRunning}
            saveRunning={tcSaveRunning}
            selectedTool={formData.selectedTool}
            showInsights={showTcInsights}
            onPushToZephyr={() => {
              if (selectedTcIndices.length === 0) {
                setToast({ message: 'No test cases selected. Please select at least one test case to push to Zephyr.', type: 'error' });
                return;
              }
              setUploadTargetTool('Zephyr');
              setZephyrModalOpen(true);
            }}
            onSaveToLibrary={handleSaveToLibrary}
            onSendToReview={() => setCurrentView('review')}
            onShowInsights={setShowTcInsights}
          />
        </div>
      )}

      {/* Status bar */}
      {tcStatus ? (
        <div style={{
          marginTop: '1rem',
          marginBottom: 0,
          borderRadius: '8px',
          animation: 'slideIn 0.3s ease-out',
        }}>
          {tcDocPath && !tcStatus.startsWith('Error:') && (tcStatus.includes('generated') || tcStatus.includes('completed')) ? (
            // Completion state: show filename with count and download button
            (() => {
              // Extract count from status message like "Test cases generated: filename (15 cases)"
              const countMatch = tcStatus.match(/\((\d+)\s+cases?\)/);
              const count = countMatch ? countMatch[1] : '';
              const filename = tcDocPath.split(/[\\/]/).pop() || 'test_cases.xlsx';
              return (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  borderRadius: '8px',
                  padding: '1rem',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', flex: 1, minWidth: '200px' }}>
                    <CheckCircle2 size={20} style={{ color: '#10b981', flexShrink: 0, marginTop: '0.1rem' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      <span style={{
                        color: '#10b981',
                        fontWeight: 700,
                        fontSize: '0.92rem',
                        letterSpacing: '0.01em',
                        wordBreak: 'break-all',
                      }}>
                        {filename}
                      </span>
                      {count && (
                        <span style={{
                          color: '#059669',
                          fontWeight: 600,
                          fontSize: '0.8rem',
                          letterSpacing: '0.01em',
                        }}>
                          {count} test cases generated
                        </span>
                      )}
                    </div>
                  </div>
                  <a
                    className="btn"
                    href={`${BACKEND_API_BASE}/artifact?path=${encodeURIComponent(tcDocPath)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      background: 'linear-gradient(135deg, #10b981, #059669)',
                      color: '#fff',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      padding: '0.65rem 1.5rem',
                      borderRadius: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      textDecoration: 'none',
                      boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                      transition: 'all 0.2s ease',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Download size={16} />
                    Download Excel
                  </a>
                </div>
              );
            })()
          ) : tcStatus.startsWith('Error:') ? (
            // Pre-generation error: show prominently in red
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              padding: '1rem',
              borderRadius: '8px',
              background: 'rgba(225, 29, 72, 0.1)',
              border: '1px solid rgba(225, 29, 72, 0.35)',
              color: '#E11D48',
              fontWeight: 500,
              animation: 'slideIn 0.3s ease-out',
            }}>
              <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{tcStatus}</span>
            </div>
          ) : (
            // Progress / neutral state
            <div className={tcStatusClass(tcStatus)} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '1rem',
              borderRadius: '8px',
            }}>
              {tcStatusIcon(tcStatus)}
              <span style={{ fontWeight: 500 }}>{tcStatus}</span>
            </div>
          )}
        </div>
      ) : null}

      {/* Post-generation error: appended below the success bar */}
      {tcPostError && (
        <div style={{
          marginTop: '0.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          background: 'rgba(225, 29, 72, 0.1)',
          border: '1px solid rgba(225, 29, 72, 0.35)',
          color: '#E11D48',
          fontWeight: 500,
          fontSize: '0.875rem',
          animation: 'slideIn 0.3s ease-out',
        }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{tcPostError}</span>
        </div>
      )}


      {/* Actions */}
      <div className="actions-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.875rem', marginTop: '0.875rem', justifyContent: 'flex-start' }}>
        <button className="btn btn-salmon" disabled={tcGapRunning} onClick={() => {
          setTcDocPath('');
          setTcResults(null);
          setTcPostError('');
          handleRunGapAnalysis();
        }}>
          {tcGapRunning ? <><RefreshCw size={16} className="spin" /> Analyzing...</> : <><ClipboardList size={16} /> Analyze Gaps First</>}
        </button>

        <button className="btn btn-outline red" disabled={tcGenerating} onClick={async () => {
          setTcDocPath('');
          setTcMdPath('');
          setTcResults(null);
          setTcGapAnalysis(null);
          setTcPostError('');
          setTcGenerating(true);
          try {
            const res = await fetch(`${BACKEND_API_BASE}/generate-test-cases`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...formData,
                ...tcFormData,
                coverageInstructions: 'Ensure 100% requirement coverage: cover happy path, negative, boundary, and edge cases for every stated acceptance criterion.'
              }),
            });
            const d = await res.json().catch(() => ({}));
            if (d.status === 'success' && d.test_cases) {
              const parts = (d.document_path || '').split(/[\\/]/);
              const filename = parts[parts.length - 1] || 'test_cases.xlsx';
              setTcDocPath(d.document_path || '');
              setTcMdPath(d.md_path || '');
              setTcResults(d.test_cases);
              const tcCount = d.test_cases?.testCases?.length || 0;
              setTcStatus(`Test cases generated: ${filename} (${tcCount} cases)`);
              setToast({ message: `Test Cases Generated: ${filename}`, type: 'success' });
              setTimeout(() => handleRunGapAnalysis(true), 300);
            } else if (d.status === 'success' && !d.test_cases) {
              setTcStatus('Error: API returned success but no test cases were generated. Check requirements and try again.');
              setToast({ message: 'Error: No test cases generated', type: 'error' });
            } else {
              const err = d.detail || d.message || 'Generation failed.';
              setTcStatus(`Error: ${err}`);
              setToast({ message: `Generation Error: ${err}`, type: 'error' });
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : 'Unknown error';
            setTcStatus(`Error: ${errMsg}. Is the API server running?`);
            setToast({ message: `Network Error: ${errMsg}`, type: 'error' });
          } finally {
            setTcGenerating(false);
          }
        }}>
          {tcGenerating ? <><RefreshCw size={16} className="spin" /> Generating...</> : <><Zap size={16} /> Generate Test Cases</>}
        </button>
      </div>

      {/* QA Note */}
      <div className="tc-qa-note">
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
        <span>
          <strong>Quality Assurance Note:</strong> Autonomous confirmation methods need to be tagged. Autonomous coverage
          limits need to be managed appropriately to avoid incomplete requirement traceability. Always review generated
          test cases against source requirements before sign-off.
        </span>
      </div>
    </>
  );

  return (
    <>
      <TopHeader />
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-header">
            COMMAND CENTER
            <ChevronDown size={14} />
          </div>
          <div className="nav-links">
            {STEPS.map((step) => (
              <div
                key={step.id}
                className={`nav-item ${currentView === step.id ? 'active' : ''}`}
                onClick={() => setCurrentView(step.id)}
              >
                <step.icon size={18} />
                {step.label}
                {step.hasArrow && <ChevronDown size={14} style={{ marginLeft: 'auto' }} />}
              </div>
            ))}
          </div>

          <div className="sidebar-bottom">
            <div className="nav-item">
              <span style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}><Settings size={18} /> Settings</span>
            </div>
            <div className="nav-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <span style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              </span>
            </div>
            <div className="nav-item" onClick={clearConversationState} style={{ color: '#ef4444' }}>
              <span style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <Eraser size={18} />
                Clear Conversation
              </span>
            </div>
          </div>
        </aside>

        <main className="main-content">
          {currentView === 'connection' ? renderConnectionView()
            : currentView === 'testcases' ? renderTestCasesView()
              : renderGeneratorView(STEPS.find(s => s.id === currentView)?.label || 'Generator')}
        </main>
      </div>
      {uploadModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000
        }} onClick={() => setUploadModalOpen(false)}>
          <div style={{
            backgroundColor: 'var(--bg-main)',
            borderRadius: '8px',
            padding: '2rem',
            maxWidth: '500px',
            width: '90%'
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Upload to {uploadTargetTool ?? formData.selectedTool}</h2>

            {(uploadTargetTool === 'Zephyr' || formData.selectedTool === 'Jira') && uploadTargetTool !== 'ADO' && uploadTargetTool !== 'TestRail' && uploadTargetTool !== 'QTest' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Jira Project Key * {uploadTargetTool === 'Zephyr' && <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>(for Zephyr Scale)</span>}</label>
                <input
                  type="text"
                  placeholder="e.g., PROJ"
                  value={uploadConfig.projectKey}
                  onChange={e => setUploadConfig(p => ({ ...p, projectKey: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)'
                  }}
                />
              </div>
            )}
            {(uploadTargetTool === 'ADO' || formData.selectedTool === 'ADO') && uploadTargetTool !== 'Zephyr' && uploadTargetTool !== 'TestRail' && uploadTargetTool !== 'QTest' && (
              <>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Project Name *</label>
                  <input
                    type="text"
                    value={uploadConfig.projectName}
                    onChange={e => setUploadConfig(p => ({ ...p, projectName: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)'
                    }}
                  />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Test Plan ID *</label>
                  <input
                    type="text"
                    value={uploadConfig.testPlanId}
                    onChange={e => setUploadConfig(p => ({ ...p, testPlanId: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--border-color)'
                    }}
                  />
                </div>
              </>
            )}
            {(uploadTargetTool === 'TestRail' || formData.selectedTool === 'TestRail') && uploadTargetTool !== 'Zephyr' && uploadTargetTool !== 'ADO' && uploadTargetTool !== 'QTest' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Project ID *</label>
                <input
                  type="text"
                  value={uploadConfig.projectId}
                  onChange={e => setUploadConfig(p => ({ ...p, projectId: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)'
                  }}
                />
              </div>
            )}
            {(uploadTargetTool === 'QTest' || formData.selectedTool === 'QTest') && uploadTargetTool !== 'Zephyr' && uploadTargetTool !== 'ADO' && uploadTargetTool !== 'TestRail' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>Project ID *</label>
                <input
                  type="text"
                  value={uploadConfig.projectId}
                  onChange={e => setUploadConfig(p => ({ ...p, projectId: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)'
                  }}
                />
              </div>
            )}

            {/* Upload Status Message */}
            {uploadMessage && (
              <div style={{
                padding: '1rem',
                marginBottom: '1rem',
                borderRadius: '4px',
                backgroundColor: uploadMessage.type === 'error' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                border: `1px solid ${uploadMessage.type === 'error' ? '#ef4444' : '#22c55e'}`,
                color: uploadMessage.type === 'error' ? '#dc2626' : '#16a34a',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem'
              }}>
                {uploadMessage.type === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                <span>{uploadMessage.text}</span>
              </div>
            )}

            {/* List Projects Button */}
            <button
              className="btn btn-outline"
              onClick={handleFetchAvailableProjects}
              disabled={fetchingProjects || uploadRunning}
              style={{ width: '100%', marginBottom: '1rem' }}
            >
              {fetchingProjects ? <><RefreshCw size={16} className="spin" /> Fetching Projects...</> : <>📋 List Available Projects</>}
            </button>

            {/* Available Projects Display */}
            {availableProjects.length > 0 && (
              <div style={{
                marginBottom: '1rem',
                padding: '1rem',
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: '4px',
                maxHeight: '200px',
                overflowY: 'auto',
                border: '1px solid var(--border-color)'
              }}>
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.9rem' }}>Available Projects:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {availableProjects.map((project: any, idx: number) => (
                    <div key={idx} style={{
                      padding: '0.5rem',
                      backgroundColor: 'var(--bg-main)',
                      borderRadius: '3px',
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      border: '1px solid var(--border-color)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'all 0.2s'
                    }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--primary)';
                        e.currentTarget.style.color = 'white';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--bg-main)';
                        e.currentTarget.style.color = 'inherit';
                      }}
                      onClick={() => {
                        const key = project.key || project.id || project.name;
                        navigator.clipboard.writeText(key);
                        setUploadMessage({ type: 'success', text: `Copied: ${key}` });
                        setTimeout(() => setUploadMessage(null), 2000);
                      }}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{project.name || project.title || project.key}</div>
                        {project.key && <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Key: {project.key}</div>}
                      </div>
                      <Copy size={14} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '2rem' }}>
              <button
                className="btn btn-outline"
                onClick={() => setUploadModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleUploadToALM(uploadConfig)}
                disabled={uploadRunning}
              >
                {uploadRunning ? <><RefreshCw size={16} className="spin" /> Uploading...</> : <>Upload</>}
              </button>
            </div>
          </div>
        </div>
      )}
      <ZephyrUploadModal
        isOpen={zephyrModalOpen}
        onClose={() => setZephyrModalOpen(false)}
        tcResults={tcResults}
        selectedIndices={selectedTcIndices}
      />
      {toast && (
        <div className={`toast-notification toast-notification--${toast.type}`}>
          {toast.type === 'error' ? <XCircle size={18} /> :
            toast.type === 'save' ? <Database size={18} /> :
              <CheckCircle2 size={18} />}
          <span>{toast.message}</span>
        </div>
      )}
      {editingTc && (
        <EditTestCaseModal
          tc={editingTc}
          onSave={handleSaveEditedTc}
          onClose={() => { setEditingTc(null); setEditingTcIndex(null); }}
        />
      )}
    </>
  );
};

export default App;
