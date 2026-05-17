import React, { useState, useMemo, useEffect, useRef, ReactNode } from 'react';
import {
  CheckCircle2, XCircle, Loader, FileCode2, Copy, Check,
  Download, Save, Wand2, AlertCircle, ChevronDown, ChevronRight,
  RefreshCw, AlertTriangle, StopCircle, Circle,
} from 'lucide-react';
import type { FrameworkConfig } from './FrameworkSettingsModal';

const API_BASE = 'http://127.0.0.1:8000';
const FALLBACK_GROUP_NAME = 'Ungrouped';
const EMPTY_TOKENS = new Set(['', 'n/a', 'na', 'none', 'null', 'tbd', '-']);

// Mirrors tools/test_grouping_service.py — exact same fallback rules.
function groupByModule<T extends { module?: string; testCaseId?: string; testCaseTitle?: string }>(
  testCases: T[],
): { module: string; testCases: T[] }[] {
  const buckets = new Map<string, { module: string; testCases: T[] }>();
  const order: string[] = [];
  for (const tc of testCases) {
    const raw = (tc?.module ?? '').toString().trim();
    const norm = raw.toLowerCase();
    const isEmpty = EMPTY_TOKENS.has(norm);
    const key = isEmpty ? FALLBACK_GROUP_NAME : norm;
    const display = isEmpty ? FALLBACK_GROUP_NAME : raw;
    if (!buckets.has(key)) {
      buckets.set(key, { module: display, testCases: [] });
      order.push(key);
    }
    buckets.get(key)!.testCases.push(tc);
  }
  const result: { module: string; testCases: T[] }[] = [];
  for (const k of order) if (k !== FALLBACK_GROUP_NAME) result.push(buckets.get(k)!);
  if (buckets.has(FALLBACK_GROUP_NAME)) result.push(buckets.get(FALLBACK_GROUP_NAME)!);
  return result;
}

export interface GeneratedGroup {
  module: string;
  generated_code?: string;
  target_file_path?: string;
  language?: string;
  source_test_case_ids?: string[];
  changed_files?: Array<{
    path: string;
    content?: string;
    file_kind?: string;
    change_type?: string;
    diff_unified?: string;
    diff_summary?: string;
  }>;
  validation_report?: {
    passed?: boolean;
    violations?: Array<{ code?: string; file?: string; message?: string; severity?: string }>;
    warnings?: string[];
  };
  error?: string;
  retryable?: boolean;
  warning?: string | null;
}

type GroupStatus = 'queued' | 'running' | 'done' | 'failed';

interface ProgressItem {
  module: string;
  case_count: number;
  status: GroupStatus;
  error?: string;
  retryable?: boolean;
}

interface PagePreservationWarning {
  path: string;
  removed_methods?: string[];
  removed_lines?: number;
}

// Server emits `: keepalive` comment frames every 15s. We treat any byte arriving from the
// reader (parseable event or not) as a freshness signal, so this only trips when the socket
// truly goes idle.
const STALE_STREAM_MS = 90_000;

interface GenericTestCase {
  testCaseId: string;
  testCaseTitle: string;
  module: string;
  [k: string]: any;
}

type ToastKind = 'success' | 'error' | 'save';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  frameworkConfig: FrameworkConfig;
  testCases: GenericTestCase[];
  onToast?: (message: string, type: ToastKind) => void;
}

type View = 'preview' | 'generating' | 'results';

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ScriptGenerationModal({ isOpen, onClose, frameworkConfig, testCases, onToast }: Props): ReactNode {
  const [view, setView] = useState<View>('preview');
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<GeneratedGroup[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [totalGroups, setTotalGroups] = useState(0);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [streamDone, setStreamDone] = useState(false);
  const [retryingModule, setRetryingModule] = useState<string | null>(null);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [copiedModule, setCopiedModule] = useState<string | null>(null);
  const [refineText, setRefineText] = useState<Record<string, string>>({});
  const [refiningModule, setRefiningModule] = useState<string | null>(null);
  const [savingModule, setSavingModule] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ module: string; message: string; ok: boolean } | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ module: string; targetPath: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastEventAtRef = useRef<number>(Date.now());
  const staleTimerRef = useRef<number | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const notify = (message: string, type: ToastKind) => {
    if (onToast) onToast(message, type);
  };

  const groups = useMemo(() => groupByModule(testCases), [testCases]);
  const testCaseById = useMemo(() => {
    const map = new Map<string, GenericTestCase>();
    for (const tc of testCases) {
      if (tc?.testCaseId) map.set(String(tc.testCaseId), tc);
    }
    return map;
  }, [testCases]);

  const collectWarnings = (group: GeneratedGroup): string[] => {
    const out: string[] = [];
    if (group.warning) out.push(group.warning);
    const vr = group.validation_report;
    if (vr?.warnings?.length) out.push(...vr.warnings);
    if (vr?.violations?.length) {
      out.push(...vr.violations.map(v => `[${v.code || 'VIOLATION'}] ${v.file || ''} ${v.message || ''}`.trim()));
    }
    return out.filter(Boolean);
  };

  useEffect(() => {
    if (!isOpen) return;
    setView('preview');
    setError(null);
    setResults([]);
    setCompletedCount(0);
    setTotalGroups(0);
    setProgress([]);
    setStreamDone(false);
    setRetryingModule(null);
    setExpandedGroups(new Set());
    setCopiedModule(null);
    setRefineText({});
    setRefiningModule(null);
    setSavingModule(null);
    setSaveFeedback(null);
    setPendingOverwrite(null);
    abortRef.current?.abort();
    abortRef.current = null;
    if (staleTimerRef.current !== null) {
      window.clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (staleTimerRef.current !== null) window.clearInterval(staleTimerRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const markStale = () => {
    setProgress(prev => {
      const next = prev.map(p =>
        p.status === 'queued' || p.status === 'running'
          ? { ...p, status: 'failed' as GroupStatus, error: 'Stream lost (no events for 60s)', retryable: true }
          : p,
      );
      return next;
    });
    setResults(prev => {
      const existing = new Set(prev.map(r => r.module));
      const lost: GeneratedGroup[] = [];
      setProgress(curr => {
        for (const p of curr) {
          if (!existing.has(p.module) && p.status === 'failed' && p.error?.startsWith('Stream lost')) {
            lost.push({ module: p.module, error: p.error, retryable: true });
          }
        }
        return curr;
      });
      return lost.length ? [...prev, ...lost] : prev;
    });
    setStreamDone(true);
    setError('Stream lost (no server events for 60s). Use Retry on failed groups.');
    setGenerating(false);
    if (staleTimerRef.current !== null) {
      window.clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  };

  const handleStartGenerate = async () => {
    setView('generating');
    setError(null);
    setResults([]);
    setGenerating(true);
    setStreamDone(false);
    setCompletedCount(0);
    setTotalGroups(groups.length);
    setProgress(groups.map(g => ({
      module: g.module,
      case_count: g.testCases.length,
      status: 'queued' as GroupStatus,
    })));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = newRequestId();
    requestIdRef.current = requestId;
    let serverStarted = false;
    let fallbackHandled = false;

    lastEventAtRef.current = Date.now();
    if (staleTimerRef.current !== null) window.clearInterval(staleTimerRef.current);
    staleTimerRef.current = window.setInterval(() => {
      if (Date.now() - lastEventAtRef.current > STALE_STREAM_MS) {
        controller.abort();
        markStale();
      }
    }, 5000);

    try {
      const applyJsonResult = (data: any) => {
        const returnedGroups: any[] = Array.isArray(data?.groups) ? data.groups : [];
        if (!returnedGroups.length) return false;

        const caseCountByModule = new Map(groups.map(g => [g.module, g.testCases.length]));
        const mapped: GeneratedGroup[] = returnedGroups.map(g => ({
          module: g?.module || 'Unknown',
          generated_code: g?.generated_code,
          target_file_path: g?.target_file_path,
          language: g?.language,
          source_test_case_ids: g?.source_test_case_ids,
          changed_files: Array.isArray(g?.changed_files) ? g.changed_files : [],
          validation_report: g?.validation_report || undefined,
          warning: g?.warning ?? null,
          error: g?.error,
          retryable: !!g?.error,
        }));
        const nextProgress: ProgressItem[] = mapped.map(g => ({
          module: g.module,
          case_count: caseCountByModule.get(g.module)
            ?? (Array.isArray(g.source_test_case_ids) ? g.source_test_case_ids.length : 0),
          status: g.error ? 'failed' : 'done',
          error: g.error,
          retryable: g.retryable,
        }));
        const successN = mapped.filter(g => !g.error && g.generated_code).length;
        const failedN = mapped.filter(g => !!g.error).length;
        const totalN = typeof data?.total_groups === 'number' ? data.total_groups : mapped.length;

        setResults(mapped);
        setProgress(nextProgress);
        setCompletedCount(successN);
        setTotalGroups(totalN);
        setStreamDone(true);
        setView('results');
        if (failedN > 0) {
          setError(`${failedN} of ${totalN} group${totalN === 1 ? '' : 's'} failed.`);
          notify(`${failedN} of ${totalN} script${totalN === 1 ? '' : 's'} failed to generate.`, 'error');
        } else {
          setError(null);
          notify(`Generated ${successN} of ${totalN} test class${totalN === 1 ? '' : 'es'}.`, 'success');
        }
        serverStarted = true;
        fallbackHandled = true;
        return true;
      };

      const res = await fetch(`${API_BASE}/generate-test-scripts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          framework_path: frameworkConfig.frameworkPath,
          llmProvider: frameworkConfig.llmProvider,
          llmApiKey: frameworkConfig.llmApiKey,
          llmModel: frameworkConfig.llmModel,
          llmEndpoint: frameworkConfig.llmEndpoint,
          selectedTestCases: testCases,
          refinement_instruction: '',
          request_id: requestId,
          config_context: frameworkConfig.schemaPreview?.config_context,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.detail || `Generation failed (HTTP ${res.status})`);
        setView('results');
        return;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (applyJsonResult(data)) return;
      }

      if (!res.body) {
        setError('Streaming not supported by this response.');
        setView('results');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let firstResultModule: string | null = null;

      const handleEvent = (event: string, payload: any) => {
        lastEventAtRef.current = Date.now();
        switch (event) {
          case 'request_id':
            // Backend emits this before `start`. Treat as proof the worker is alive so the
            // `finally` reconciler keeps the local progress rows visible instead of wiping them.
            serverStarted = true;
            break;
          case 'start':
            serverStarted = true;
            if (Array.isArray(payload?.groups)) {
              setProgress(payload.groups.map((g: { module: string; case_count: number }) => ({
                module: g.module,
                case_count: g.case_count,
                status: 'queued' as GroupStatus,
              })));
            }
            if (typeof payload?.total_groups === 'number') {
              setTotalGroups(payload.total_groups);
            }
            // Transition to results view as soon as start arrives so user sees live progress
            setView('results');
            break;
          case 'group_start':
            setProgress(prev => prev.map(p =>
              p.module === payload.module ? { ...p, status: 'running' as GroupStatus } : p,
            ));
            break;
          case 'group_complete': {
            const result: GeneratedGroup = {
              module: payload.module,
              generated_code: payload.generated_code,
              target_file_path: payload.target_file_path,
              language: payload.language,
              source_test_case_ids: payload.source_test_case_ids,
              changed_files: Array.isArray(payload?.changed_files) ? payload.changed_files : [],
              validation_report: payload?.validation_report || undefined,
              warning: payload.warning ?? null,
            };
            setResults(prev => [...prev.filter(r => r.module !== result.module), result]);
            setProgress(prev => prev.map(p =>
              p.module === payload.module ? { ...p, status: 'done' as GroupStatus, error: undefined } : p,
            ));
            setCompletedCount(c => c + 1);
            if (!firstResultModule) {
              firstResultModule = result.module;
              setExpandedGroups(prev => {
                const n = new Set(prev);
                n.add(result.module);
                return n;
              });
            }
            break;
          }
          case 'group_error': {
            const failed: GeneratedGroup = {
              module: payload.module,
              error: payload.error,
              retryable: payload.retryable,
              source_test_case_ids: payload.source_test_case_ids,
            };
            setResults(prev => [...prev.filter(r => r.module !== failed.module), failed]);
            setProgress(prev => prev.map(p =>
              p.module === payload.module
                ? { ...p, status: 'failed' as GroupStatus, error: payload.error, retryable: payload.retryable }
                : p,
            ));
            break;
          }
          case 'done': {
            setStreamDone(true);
            const total = typeof payload?.total === 'number' ? payload.total : totalGroups;
            const failedN = typeof payload?.failed === 'number' ? payload.failed : 0;
            const completedN = typeof payload?.completed === 'number' ? payload.completed : completedCount;
            if (payload?.cancelled) {
              setError('Generation cancelled.');
              notify('Script generation cancelled.', 'error');
            } else if (failedN > 0) {
              setError(`${failedN} of ${total} group${total === 1 ? '' : 's'} failed.`);
              notify(`${failedN} of ${total} script${total === 1 ? '' : 's'} failed to generate.`, 'error');
            } else if (total > 0) {
              notify(`Generated ${completedN} of ${total} test class${total === 1 ? '' : 'es'}.`, 'success');
            }
            break;
          }
          case 'error':
            setError(payload?.detail || 'Generation failed.');
            setStreamDone(true);
            notify(payload?.detail || 'Generation failed.', 'error');
            break;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Any chunk — even an SSE comment heartbeat (": keepalive") — counts as the stream
        // being alive. Otherwise long LLM calls inside a single group would trip STALE_STREAM_MS
        // before any parseable event arrives.
        lastEventAtRef.current = Date.now();
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Parse one complete SSE frame at a time. This handles LF/CRLF and multiline data fields.
        while (true) {
          const sep = buf.indexOf('\n\n');
          if (sep === -1) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!frame.trim()) continue;

          let eventName = 'message';
          const dataLines: string[] = [];
          for (const rawLine of frame.split('\n')) {
            const line = rawLine.trimEnd();
            if (!line || line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (dataLines.length === 0) continue;

          let parsed: any = null;
          try { parsed = JSON.parse(dataLines.join('\n')); } catch { parsed = {}; }
          handleEvent(eventName, parsed);
        }
      }

      // Some proxies can return JSON while still claiming stream-ish behavior.
      if (!serverStarted) {
        const leftover = buf.trim();
        if (leftover.startsWith('{') || leftover.startsWith('[')) {
          try {
            const data = JSON.parse(leftover);
            if (applyJsonResult(data)) return;
          } catch {
            // leave generic fallback handling to finally
          }
        }
      }

      setView('results');
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // user cancel or stale-stream abort — message already set
      } else {
        const msg = `Cannot reach backend: ${e?.message || e}`;
        setError(msg);
        notify(msg, 'error');
      }
      setView('results');
    } finally {
      setGenerating(false);
      setStreamDone(true);
      if (fallbackHandled) {
        if (staleTimerRef.current !== null) {
          window.clearInterval(staleTimerRef.current);
          staleTimerRef.current = null;
        }
        requestIdRef.current = null;
        return;
      }
      // Reconcile any non-terminal modules: if stream ended without group_complete/group_error
      // for a module, mark it failed+retryable so the UI never leaves stale "queued"/"running" rows.
      //
      // Only reconcile when the server emitted `start` — otherwise the progress rows are still
      // the speculative local pre-population from before fetch began, and the real failure
      // (HTTP 4xx/5xx, network, etc.) is already shown via the error banner. Marking every
      // local row "Connection dropped before this module was reached" stacks a misleading
      // per-module error on top of the real one.
      if (!serverStarted) {
        setProgress([]);
        setTotalGroups(0);
        // If nothing else surfaced an error, tell the user explicitly — silent blank screen is the worst UX.
        setError(prev => prev || 'Backend closed the connection before any progress event arrived. Check that the API server is running and try again.');
      } else {
        let reconciled: ProgressItem[] = [];
        setProgress(prev => {
          reconciled = prev.map(p => {
            if (p.status !== 'queued' && p.status !== 'running') return p;
            const reason = p.error
              || (p.status === 'running'
                  ? 'Connection dropped while this module was generating. The LLM may still be running server-side; click Retry to try again.'
                  : 'Connection dropped before this module was reached.');
            return {
              ...p,
              status: 'failed' as GroupStatus,
              error: reason,
              retryable: true,
            };
          });
          return reconciled;
        });
        setResults(rprev => {
          const existing = new Set(rprev.map(r => r.module));
          const orphans: GeneratedGroup[] = reconciled
            .filter(p => p.status === 'failed' && !existing.has(p.module))
            .map(p => ({ module: p.module, error: p.error, retryable: true }));
          return orphans.length ? [...rprev, ...orphans] : rprev;
        });
      }
      if (staleTimerRef.current !== null) {
        window.clearInterval(staleTimerRef.current);
        staleTimerRef.current = null;
      }
      requestIdRef.current = null;
    }
  };

  const handleCancelGenerate = async () => {
    const rid = requestIdRef.current;
    abortRef.current?.abort();
    setError('Generation cancelled. In-flight group on the server will still finish, but no further groups will run.');
    setProgress(prev => prev.map(p =>
      p.status === 'queued' ? { ...p, status: 'failed' as GroupStatus, error: 'Cancelled', retryable: true } : p,
    ));
    if (rid) {
      try {
        await fetch(`${API_BASE}/generate-test-scripts/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: rid }),
        });
      } catch {
        // best-effort: client abort already stopped local reader
      }
    }
    notify('Script generation cancelled.', 'error');
  };

  const handleRetryGroup = async (module: string) => {
    setRetryingModule(module);
    setError(null);
    setProgress(prev => prev.map(p =>
      p.module === module ? { ...p, status: 'running' as GroupStatus, error: undefined } : p,
    ));
    try {
      const res = await fetch(`${API_BASE}/generate-test-scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          framework_path: frameworkConfig.frameworkPath,
          llmProvider: frameworkConfig.llmProvider,
          llmApiKey: frameworkConfig.llmApiKey,
          llmModel: frameworkConfig.llmModel,
          llmEndpoint: frameworkConfig.llmEndpoint,
          selectedTestCases: testCases,
          refinement_instruction: '',
          target_module: module,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = data?.detail || `Retry failed (HTTP ${res.status})`;
        setProgress(prev => prev.map(p =>
          p.module === module ? { ...p, status: 'failed' as GroupStatus, error: err, retryable: true } : p,
        ));
        setResults(prev => prev.map(r => r.module === module ? { ...r, error: err, retryable: true } : r));
        return;
      }
      const refreshed: GeneratedGroup | undefined = (data?.groups || [])[0];
      if (refreshed) {
        if (refreshed.error) {
          setProgress(prev => prev.map(p =>
            p.module === module ? { ...p, status: 'failed' as GroupStatus, error: refreshed.error, retryable: true } : p,
          ));
          setResults(prev => prev.map(r => r.module === module ? refreshed : r));
          setCompletedCount(c => Math.max(c - 1, 0));
        } else {
          setProgress(prev => prev.map(p =>
            p.module === module ? { ...p, status: 'done' as GroupStatus, error: undefined } : p,
          ));
          setResults(prev => prev.map(r => r.module === module ? refreshed : r));
          setCompletedCount(c => c + 1);
        }
      }
    } catch (e: any) {
      const err = `Cannot reach backend: ${e?.message || e}`;
      setProgress(prev => prev.map(p =>
        p.module === module ? { ...p, status: 'failed' as GroupStatus, error: err, retryable: true } : p,
      ));
      setResults(prev => prev.map(r => r.module === module ? { ...r, error: err, retryable: true } : r));
    } finally {
      setRetryingModule(null);
    }
  };

  const handleRefine = async (module: string) => {
    const instruction = (refineText[module] || '').trim();
    if (!instruction) return;
    setRefiningModule(module);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/generate-test-scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          framework_path: frameworkConfig.frameworkPath,
          llmProvider: frameworkConfig.llmProvider,
          llmApiKey: frameworkConfig.llmApiKey,
          llmModel: frameworkConfig.llmModel,
          llmEndpoint: frameworkConfig.llmEndpoint,
          selectedTestCases: testCases,
          refinement_instruction: instruction,
          target_module: module,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.detail || `Refine failed (HTTP ${res.status})`);
        return;
      }
      const refreshed: GeneratedGroup | undefined = (data?.groups || [])[0];
      if (refreshed) {
        setResults(prev => prev.map(g => g.module === module ? refreshed : g));
        setRefineText(prev => ({ ...prev, [module]: '' }));
      }
    } catch (e: any) {
      setError(`Cannot reach backend: ${e?.message || e}`);
    } finally {
      setRefiningModule(null);
    }
  };

  const handleRegenerateCase = async (module: string, testCaseId: string) => {
    const tc = testCaseById.get(testCaseId);
    if (!tc) {
      setError(`Test case ${testCaseId} is not available in current selection.`);
      return;
    }
    setRefiningModule(module);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/generate-test-scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          framework_path: frameworkConfig.frameworkPath,
          llmProvider: frameworkConfig.llmProvider,
          llmApiKey: frameworkConfig.llmApiKey,
          llmModel: frameworkConfig.llmModel,
          llmEndpoint: frameworkConfig.llmEndpoint,
          selectedTestCases: testCases,
          refinement_instruction: `Regenerate only test case ${testCaseId}. Update impacted page methods and dependent tests automatically.`,
          target_module: module,
          target_test_case_id: testCaseId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.detail || `Regenerate failed (HTTP ${res.status})`);
        return;
      }
      const refreshed: GeneratedGroup | undefined = (data?.groups || [])[0];
      if (refreshed) {
        setResults(prev => prev.map(g => g.module === module ? refreshed : g));
      }
    } catch (e: any) {
      setError(`Cannot reach backend: ${e?.message || e}`);
    } finally {
      setRefiningModule(null);
    }
  };

  const handleCopy = async (group: GeneratedGroup) => {
    if (!group.generated_code) return;
    try {
      await navigator.clipboard.writeText(group.generated_code);
      setCopiedModule(group.module);
      setTimeout(() => setCopiedModule(null), 1500);
    } catch {
      // fallback ignored
    }
  };

  const handleDownload = (group: GeneratedGroup) => {
    if (!group.generated_code || !group.target_file_path) return;
    const blob = new Blob([group.generated_code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = group.target_file_path.split('/').pop() || 'generated_script.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSave = async (
    group: GeneratedGroup,
    overwrite = false,
    forceSave = false,
  ) => {
    if (!group.generated_code || !group.target_file_path) return;
    setSavingModule(group.module);
    setSaveFeedback(null);
    const warningList = collectWarnings(group);
    try {
      const res = await fetch(`${API_BASE}/save-generated-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          framework_path: frameworkConfig.frameworkPath,
          target_file_path: group.target_file_path,
          generated_code: group.generated_code,
          changed_files: group.changed_files || [],
          warnings: warningList,
          force_save: forceSave,
          overwrite,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && String(data?.detail || '').includes('File already exists at')) {
        setPendingOverwrite({ module: group.module, targetPath: group.target_file_path });
        return;
      }
      if (!res.ok) {
        const errMsg = data?.detail || `HTTP ${res.status}`;
        setSaveFeedback({ module: group.module, message: errMsg, ok: false });
        notify(`Save failed for ${group.module}: ${errMsg}`, 'error');
        return;
      }
      const savedPath = data?.relative_path || group.target_file_path;
      const writtenCount = Array.isArray(data?.written_files) ? data.written_files.length : 1;
      const pageWarnings: PagePreservationWarning[] = Array.isArray(data?.page_preservation_warnings)
        ? data.page_preservation_warnings
        : [];
      const warningSuffix = pageWarnings.length
        ? `; ${pageWarnings.length} page file(s) kept unchanged to prevent deletions`
        : '';
      setSaveFeedback({ module: group.module, message: `Saved ${writtenCount} file(s); primary path ${savedPath}${warningSuffix}`, ok: true });
      setPendingOverwrite(null);
      setTimeout(() => setSaveFeedback(null), 3500);
      if (pageWarnings.length) {
        const files = pageWarnings.map(w => w.path).filter(Boolean).slice(0, 3).join(', ');
        notify(`Saved ${group.module} with page-preservation warnings: ${files}${pageWarnings.length > 3 ? ', ...' : ''}`, 'save');
      } else {
        notify(`Saved ${group.module}: ${writtenCount} file(s)`, 'save');
      }
    } catch (e: any) {
      const msg = `Cannot reach backend: ${e?.message || e}`;
      setSaveFeedback({ module: group.module, message: msg, ok: false });
      notify(msg, 'error');
    } finally {
      setSavingModule(null);
    }
  };

  const toggleExpand = (module: string) => {
    setExpandedGroups(prev => {
      const n = new Set(prev);
      if (n.has(module)) n.delete(module); else n.add(module);
      return n;
    });
  };

  // ── styles (match other modals) ────────────────────────────────────────────
  const S = {
    overlay: {
      position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
      zIndex: 1001,
    },
    dialog: {
      backgroundColor: 'var(--bg-main)',
      borderRadius: '12px',
      maxWidth: view === 'results' ? '960px' : '720px',
      width: '95%',
      maxHeight: '90vh',
      display: 'flex' as const, flexDirection: 'column' as const,
      overflow: 'hidden' as const,
      boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
      transition: 'max-width 0.2s ease',
    },
    header: {
      padding: '1.1rem 1.5rem',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const,
      flexShrink: 0,
    },
    headerTitle: {
      display: 'flex' as const, alignItems: 'center' as const, gap: '0.5rem',
      fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-main)',
    },
    closeBtn: {
      background: 'none', border: 'none', cursor: 'pointer' as const,
      color: 'var(--text-muted)', padding: '4px', borderRadius: '4px',
      display: 'flex' as const, alignItems: 'center' as const,
    },
    body: { flex: 1, overflowY: 'auto' as const, padding: '1.25rem 1.5rem' },
    btnPrimary: (disabled: boolean) => ({
      padding: '0.55rem 1rem',
      backgroundColor: disabled ? 'var(--text-muted)' : 'var(--primary)',
      color: 'white', border: 'none', borderRadius: '6px',
      cursor: disabled ? 'not-allowed' : 'pointer' as const,
      fontWeight: 600, fontSize: '0.85rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
      opacity: disabled ? 0.6 : 1,
    }),
    btnOutline: {
      padding: '0.45rem 0.85rem',
      backgroundColor: 'transparent',
      border: '1px solid var(--border-color)',
      color: 'var(--text-main)', borderRadius: '6px', cursor: 'pointer' as const,
      fontWeight: 600, fontSize: '0.8rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.35rem',
    },
    chip: {
      display: 'inline-block' as const, padding: '2px 8px',
      borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
      backgroundColor: 'rgba(37,99,235,0.1)', color: '#2563eb',
      border: '1px solid rgba(37,99,235,0.2)',
    },
    banner: (kind: 'ok' | 'err' | 'info') => {
      const map = {
        ok: { bg: 'rgba(22,163,74,0.1)', border: '#bbf7d0', color: '#16a34a' },
        err: { bg: 'rgba(220,38,38,0.1)', border: '#fecaca', color: '#dc2626' },
        info: { bg: 'rgba(37,99,235,0.08)', border: 'rgba(37,99,235,0.25)', color: '#2563eb' },
      } as const;
      const c = map[kind];
      return {
        display: 'flex' as const, alignItems: 'center' as const, gap: '0.5rem',
        padding: '0.55rem 0.75rem', borderRadius: '6px',
        backgroundColor: c.bg, border: `1px solid ${c.border}`, color: c.color,
        marginBottom: '0.85rem', fontSize: '0.82rem', fontWeight: 600,
      };
    },
  };

  // ─── Preview view ─────────────────────────────────────────────────────────
  const renderPreview = () => (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
          Framework: <code style={{ color: 'var(--text-main)' }}>{frameworkConfig.frameworkPath}</code>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={S.chip}>{frameworkConfig.schemaPreview?.tech_stack?.language || 'unknown'}</span>
          <span style={S.chip}>{frameworkConfig.schemaPreview?.tech_stack?.test_framework || 'unknown'}</span>
          <span style={S.chip}>{frameworkConfig.llmProvider}{frameworkConfig.llmModel ? ` · ${frameworkConfig.llmModel}` : ''}</span>
        </div>
      </div>

      <div style={{ marginBottom: '1rem', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-main)' }}>
        {testCases.length} test cases will produce {groups.length} test class{groups.length === 1 ? '' : 'es'}
      </div>

      <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1rem' }}>
        {groups.map((g, idx) => (
          <div key={g.module} style={{
            padding: '0.65rem 0.95rem',
            borderBottom: idx < groups.length - 1 ? '1px solid var(--border-color)' : 'none',
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            backgroundColor: idx % 2 === 0 ? 'var(--bg-main)' : 'var(--bg-card)',
          }}>
            <div style={{ fontWeight: 700, color: 'var(--text-main)', flex: 1, fontSize: '0.88rem' }}>
              {g.module}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {g.testCases.length} method{g.testCases.length === 1 ? '' : 's'}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button style={S.btnOutline as React.CSSProperties} onClick={onClose}>Cancel</button>
        <button style={S.btnPrimary(false) as React.CSSProperties} onClick={handleStartGenerate}>
          <Wand2 size={14} /> Confirm &amp; Generate
        </button>
      </div>
    </div>
  );

  // ─── Generating view ──────────────────────────────────────────────────────
  const renderGenerating = () => {
    if (progress.length > 0) {
      return <div>{renderProgressPanel()}</div>;
    }
    return (
      <div style={{ padding: '2rem 1rem', textAlign: 'center' }}>
        <Loader size={32} className="spin" style={{ color: 'var(--primary)', marginBottom: '1rem' }} />
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
          Preparing generation…
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Analyzing framework and queueing groups.
          <br />
          Streaming will start in a moment.
        </div>
        <button
          style={{ ...S.btnOutline, color: '#dc2626', borderColor: '#fca5a5', marginTop: '1rem' } as React.CSSProperties}
          onClick={handleCancelGenerate}
        >
          <StopCircle size={12} /> Cancel
        </button>
      </div>
    );
  };

  // ─── Progress panel (shown while streaming) ───────────────────────────────
  const renderProgressPanel = () => {
    if (progress.length === 0) return null;
    const showCancel = generating && !streamDone;
    return (
      <div style={{
        border: '1px solid var(--border-color)', borderRadius: '8px',
        padding: '0.75rem 0.95rem', marginBottom: '0.85rem',
        backgroundColor: 'var(--bg-card)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '0.55rem',
        }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-main)' }}>
            {streamDone
              ? `Generation complete · ${completedCount}/${totalGroups}`
              : `Generating · ${completedCount}/${totalGroups} done`}
          </div>
          {showCancel && (
            <button
              style={{ ...S.btnOutline, color: '#dc2626', borderColor: '#fca5a5' } as React.CSSProperties}
              onClick={handleCancelGenerate}
            >
              <StopCircle size={12} /> Cancel
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {progress.map(p => {
            const icon = p.status === 'done'
              ? <CheckCircle2 size={13} style={{ color: '#16a34a' }} />
              : p.status === 'running'
                ? <Loader size={13} className="spin" style={{ color: 'var(--primary)' }} />
                : p.status === 'failed'
                  ? <XCircle size={13} style={{ color: '#dc2626' }} />
                  : <Circle size={13} style={{ color: 'var(--text-muted)' }} />;
            const color = p.status === 'failed' ? '#dc2626'
              : p.status === 'done' ? 'var(--text-main)'
              : 'var(--text-muted)';
            return (
              <div key={p.module} style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.82rem', color,
              }}>
                {icon}
                <span style={{ fontWeight: 600 }}>{p.module}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                  ({p.case_count} case{p.case_count === 1 ? '' : 's'})
                </span>
                {p.status === 'failed' && p.error && (
                  <span style={{ flex: 1, fontSize: '0.76rem', fontWeight: 500 }}>— {p.error}</span>
                )}
                {p.status === 'failed' && p.retryable && (
                  <button
                    style={S.btnOutline as React.CSSProperties}
                    onClick={() => handleRetryGroup(p.module)}
                    disabled={retryingModule === p.module}
                  >
                    {retryingModule === p.module
                      ? <><Loader size={11} className="spin" /> Retrying…</>
                      : <><RefreshCw size={11} /> Retry</>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ─── Results view ─────────────────────────────────────────────────────────
  const renderResults = () => {
    const successCount = results.filter(r => !r.error && r.generated_code).length;
    const failedCount  = results.filter(r => r.error).length;
    const showEmpty    = streamDone && !error && progress.length === 0 && results.length === 0;
    return (
    <div>
      {!streamDone && (
        <div style={S.banner('info') as React.CSSProperties}>
          <Loader size={14} className="spin" />
          <span>
            Generating test scripts… {completedCount} of {totalGroups} done
            {progress.find(p => p.status === 'running') && ` · current: ${progress.find(p => p.status === 'running')!.module}`}
          </span>
        </div>
      )}
      {renderProgressPanel()}
      {error && (
        <div style={S.banner('err') as React.CSSProperties}>
          <XCircle size={14} /> <span>{error}</span>
        </div>
      )}
      {!error && streamDone && successCount > 0 && (
        <div style={S.banner('ok') as React.CSSProperties}>
          <CheckCircle2 size={14} />
          <span>
            Successfully generated {successCount} of {totalGroups} test class{totalGroups === 1 ? '' : 'es'}
            {failedCount > 0 ? ` (${failedCount} failed)` : ''}. Expand a group below to review and Save to framework folder.
          </span>
        </div>
      )}
      {showEmpty && (
        <div style={S.banner('info') as React.CSSProperties}>
          <AlertCircle size={14} />
          <span>No test scripts were produced. Try again or check backend logs.</span>
        </div>
      )}

      {results.map(group => {
        const expanded = expandedGroups.has(group.module);
        const isRefining = refiningModule === group.module;
        const isSaving = savingModule === group.module;
        const fb = saveFeedback && saveFeedback.module === group.module ? saveFeedback : null;
        const overwritePending = pendingOverwrite && pendingOverwrite.module === group.module ? pendingOverwrite : null;
        return (
          <div key={group.module} style={{
            border: '1px solid var(--border-color)', borderRadius: '8px',
            marginBottom: '0.9rem', overflow: 'hidden',
          }}>
            <div
              onClick={() => toggleExpand(group.module)}
              style={{
                padding: '0.7rem 1rem', display: 'flex', alignItems: 'center', gap: '0.6rem',
                cursor: 'pointer', backgroundColor: 'var(--bg-card)',
                borderBottom: expanded ? '1px solid var(--border-color)' : 'none',
              }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <FileCode2 size={14} style={{ color: 'var(--primary)' }} />
              <div style={{ fontWeight: 700, color: 'var(--text-main)', flex: 1 }}>{group.module}</div>
              {group.target_file_path && (
                <code style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{group.target_file_path}</code>
              )}
              {group.warning && (
                <span style={{ ...S.chip, backgroundColor: 'rgba(217,119,6,0.1)', color: '#d97706', borderColor: '#fed7aa' }} title={group.warning}>
                  <AlertTriangle size={11} style={{ verticalAlign: '-2px', marginRight: 2 }} /> warning
                </span>
              )}
              {group.error && <span style={{ ...S.chip, backgroundColor: 'rgba(220,38,38,0.1)', color: '#dc2626', borderColor: '#fecaca' }}>error</span>}
            </div>

            {expanded && (
              <div style={{ padding: '0.85rem 1rem' }}>
                {group.error ? (
                  <>
                    <div style={S.banner('err') as React.CSSProperties}>
                      <AlertCircle size={14} /> <span style={{ flex: 1 }}>{group.error}</span>
                      {group.retryable && (
                        <button
                          style={S.btnOutline as React.CSSProperties}
                          onClick={() => handleRetryGroup(group.module)}
                          disabled={retryingModule === group.module}
                        >
                          {retryingModule === group.module
                            ? <><Loader size={12} className="spin" /> Retrying…</>
                            : <><RefreshCw size={12} /> Retry</>}
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {group.warning && (
                      <div style={{ ...S.banner('info'), color: '#d97706', backgroundColor: 'rgba(217,119,6,0.08)', borderColor: '#fed7aa' } as React.CSSProperties}>
                        <AlertTriangle size={14} /> <span>{group.warning}</span>
                      </div>
                    )}
                    {!!group.validation_report?.violations?.length && (
                      <div style={{ ...S.banner('info'), color: '#b45309', backgroundColor: 'rgba(245,158,11,0.08)', borderColor: '#fcd34d' } as React.CSSProperties}>
                        <AlertTriangle size={14} />
                        <span>
                          Validator warnings: {group.validation_report.violations.length}. You can review diffs and Force Save if acceptable.
                        </span>
                      </div>
                    )}
                    <pre style={{
                      backgroundColor: 'var(--bg-card)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      padding: '0.85rem 1rem',
                      fontSize: '0.78rem',
                      lineHeight: 1.5,
                      maxHeight: '320px',
                      overflow: 'auto',
                      color: 'var(--text-main)',
                      margin: 0,
                      whiteSpace: 'pre' as const,
                    }}>
                      {group.generated_code}
                    </pre>

                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.7rem' }}>
                      <button style={S.btnOutline as React.CSSProperties} onClick={() => handleCopy(group)}>
                        {copiedModule === group.module ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                      </button>
                      <button style={S.btnOutline as React.CSSProperties} onClick={() => handleDownload(group)}>
                        <Download size={12} /> Download
                      </button>
                      <button
                        style={S.btnOutline as React.CSSProperties}
                        onClick={() => handleSave(group, false)}
                        disabled={isSaving}
                      >
                        {isSaving ? <><Loader size={12} className="spin" /> Saving…</> : <><Save size={12} /> Save to Framework</>}
                      </button>
                      {!!collectWarnings(group).length && (
                        <button
                          style={{ ...S.btnOutline, color: '#b45309', borderColor: '#fcd34d' } as React.CSSProperties}
                          onClick={() => handleSave(group, false, true)}
                          disabled={isSaving}
                        >
                          {isSaving ? 'Saving…' : 'Force Save (with warnings comment)'}
                        </button>
                      )}
                    </div>

                    {!!group.changed_files?.length && (
                      <div style={{ marginTop: '0.8rem' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.82rem', marginBottom: '0.45rem', color: 'var(--text-main)' }}>
                          Changed Files
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          {group.changed_files.map(cf => (
                            <div key={cf.path} style={{ border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.55rem 0.65rem', backgroundColor: 'var(--bg-card)' }}>
                              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' }}>
                                <code style={{ fontSize: '0.75rem', color: 'var(--text-main)' }}>{cf.path}</code>
                                <span style={S.chip}>{cf.change_type || 'update'}</span>
                                <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{cf.diff_summary || 'No summary'}</span>
                              </div>
                              {cf.diff_unified && (
                                <pre style={{
                                  margin: 0,
                                  backgroundColor: 'var(--bg-main)',
                                  border: '1px solid var(--border-color)',
                                  borderRadius: '6px',
                                  padding: '0.45rem 0.55rem',
                                  maxHeight: '180px',
                                  overflow: 'auto',
                                  fontSize: '0.72rem',
                                  color: 'var(--text-main)',
                                }}>
                                  {cf.diff_unified}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!!group.source_test_case_ids?.length && (
                      <div style={{ marginTop: '0.85rem' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-main)', marginBottom: '0.35rem' }}>
                          Per Test Case Regenerate
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                          {group.source_test_case_ids.map(tcid => (
                            <button
                              key={tcid}
                              style={S.btnOutline as React.CSSProperties}
                              onClick={() => handleRegenerateCase(group.module, tcid)}
                              disabled={isRefining}
                            >
                              {isRefining ? 'Regenerating…' : `Regenerate ${tcid}`}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {overwritePending && (
                      <div style={{ ...S.banner('info'), marginTop: '0.7rem' } as React.CSSProperties}>
                        <AlertCircle size={14} />
                        <span style={{ flex: 1 }}>File already exists at <code>{overwritePending.targetPath}</code>. Overwrite?</span>
                        <button
                          style={{ ...S.btnOutline, color: '#dc2626', borderColor: '#fca5a5' } as React.CSSProperties}
                          onClick={() => handleSave(group, true, !!collectWarnings(group).length)}
                          disabled={isSaving}
                        >
                          {isSaving ? 'Saving…' : 'Overwrite'}
                        </button>
                        <button
                          style={S.btnOutline as React.CSSProperties}
                          onClick={() => setPendingOverwrite(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {fb && (
                      <div style={{ ...S.banner(fb.ok ? 'ok' : 'err'), marginTop: '0.6rem' } as React.CSSProperties}>
                        {fb.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                        <span>{fb.message}</span>
                      </div>
                    )}

                    <div style={{ marginTop: '0.9rem' }}>
                      <label style={{ display: 'block', marginBottom: '0.3rem', fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-main)' }}>
                        Refine this class
                      </label>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <input
                          type="text"
                          placeholder="e.g. use page object pattern, add logging, replace TODOs"
                          value={refineText[group.module] || ''}
                          onChange={e => setRefineText(prev => ({ ...prev, [group.module]: e.target.value }))}
                          style={{
                            flex: 1, padding: '0.45rem 0.7rem',
                            border: '1px solid var(--border-color)', borderRadius: '6px',
                            fontSize: '0.84rem', backgroundColor: 'var(--bg-card)',
                            color: 'var(--text-main)', outline: 'none',
                          }}
                        />
                        <button
                          style={S.btnOutline as React.CSSProperties}
                          onClick={() => handleRefine(group.module)}
                          disabled={isRefining || !(refineText[group.module] || '').trim() || !streamDone}
                          title={!streamDone ? 'Wait for generation to finish before refining.' : undefined}
                        >
                          {isRefining ? <><Loader size={12} className="spin" /> Refining…</> : <><Wand2 size={12} /> Refine</>}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button style={S.btnOutline as React.CSSProperties} onClick={onClose}>Close</button>
      </div>
    </div>
    );
  };

  const VIEW_LABELS: Record<View, string> = {
    preview:    'Preview',
    generating: 'Generating…',
    results:    'Results',
  };

  return (
    <div style={S.overlay as React.CSSProperties} onClick={generating ? undefined : onClose}>
      <div style={S.dialog as React.CSSProperties} onClick={e => e.stopPropagation()}>
        <div style={S.header as React.CSSProperties}>
          <div style={S.headerTitle as React.CSSProperties}>
            <FileCode2 size={18} style={{ color: 'var(--primary)' }} />
            Generate Test Scripts
            <span style={{
              fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)',
              padding: '2px 8px', borderRadius: '4px', backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-color)', marginLeft: '4px',
            }}>
              {VIEW_LABELS[view]}
            </span>
          </div>
          <button style={S.closeBtn as React.CSSProperties} onClick={onClose} title="Close" disabled={generating}>
            <XCircle size={18} />
          </button>
        </div>

        <div style={S.body as React.CSSProperties}>
          {view === 'preview'    && renderPreview()}
          {view === 'generating' && renderGenerating()}
          {view === 'results'    && renderResults()}
        </div>
      </div>
    </div>
  );
}

