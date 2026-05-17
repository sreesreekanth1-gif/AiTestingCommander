import React, { useState, useEffect, ReactNode } from 'react';
import {
  Eye, EyeOff, CheckCircle2, AlertCircle, XCircle, Save, Loader,
  Settings, FolderSearch, Wand2, FolderOpen, FileText, Trash2,
} from 'lucide-react';

const STORAGE_KEY = 'frameworkSettings';
const API_BASE = 'http://127.0.0.1:8000';
const OBFUSCATION_KEY = 'tc-gen-framework-v1';

function obfuscate(plain: string): string {
  if (!plain) return '';
  const bytes = new TextEncoder().encode(plain);
  const keyBytes = new TextEncoder().encode(OBFUSCATION_KEY);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  let binary = '';
  for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
  return btoa(binary);
}

function deobfuscate(encoded: string): string {
  if (!encoded) return '';
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const keyBytes = new TextEncoder().encode(OBFUSCATION_KEY);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
    return new TextDecoder().decode(out);
  } catch {
    return '';
  }
}

const LLM_PROVIDERS = ['GROQ', 'Grok', 'Claude', 'Ollama', 'OpenRouter', 'Gemini'] as const;
type LlmProvider = typeof LLM_PROVIDERS[number];

export interface MCPServerDescriptor {
  name: string;
  command: string;
  args: string[];
  transport: string;
  source_file: string;
  env: Record<string, string>;
  enabled: boolean;
  description?: string;
  catalog_source?: boolean;
}

export interface FrameworkSchemaPreview {
  framework_path?: string;
  tech_stack?: { language?: string; test_framework?: string; build_tool?: string };
  directory_layout?: { test_root?: string; page_objects_root?: string };
  naming_conventions?: { test_file_pattern?: string };
  counts?: { total_source_files?: number; test_files?: number; page_object_files?: number };
  base_class_names?: string[];
  page_object_names?: string[];
  sample_imports?: string[];
  mcp_servers?: MCPServerDescriptor[];
  recommended_mcp_servers?: MCPServerDescriptor[];
  config_context?: {
    discovered_files: string[];
    env_vars: Record<string, string>;
    base_urls: string[];
    environments: string[];
    dependencies: Array<{ name: string; source: string }>;
    timeouts: Record<string, string>;
    framework_config: Record<string, any>;
    ambiguities: Array<{
      type: string;
      field: string;
      detail: string;
      values?: string[];
    }>;
    redacted_keys: string[];
  };
}

export interface FrameworkConfig {
  frameworkPath: string;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmModel: string;
  llmEndpoint: string;
  schemaPreview?: FrameworkSchemaPreview;
  healthy: boolean;
  savedAt?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (config: FrameworkConfig) => void;
  onCleared?: () => void;
  initialMessage?: string;
  onGenerateScripts?: (config: FrameworkConfig) => void;
}

interface FormState {
  frameworkPath: string;
  llmProvider: LlmProvider;
  llmApiKey: string;
  llmModel: string;
  llmEndpoint: string;
}

const EMPTY_FORM: FormState = {
  frameworkPath: '',
  llmProvider: 'GROQ',
  llmApiKey: '',
  llmModel: '',
  llmEndpoint: 'http://127.0.0.1:11434',
};

export function loadFrameworkConfig(): FrameworkConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FrameworkConfig;
    parsed.llmApiKey = deobfuscate(parsed.llmApiKey || '');
    return parsed;
  } catch {
    return null;
  }
}

export function clearFrameworkConfig(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export default function FrameworkSettingsModal({ isOpen, onClose, onSaved, onCleared, initialMessage, onGenerateScripts }: Props): ReactNode {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [schemaPreview, setSchemaPreview] = useState<FrameworkSchemaPreview | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const [testing, setTesting] = useState(false);
  const [llmStatus, setLlmStatus] = useState<'verified' | 'failed' | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});
    setSaveFeedback(null);
    const existing = loadFrameworkConfig();
    if (existing) {
      setForm({
        frameworkPath: existing.frameworkPath || '',
        llmProvider: existing.llmProvider || 'GROQ',
        llmApiKey: existing.llmApiKey || '',
        llmModel: existing.llmModel || '',
        llmEndpoint: existing.llmEndpoint || EMPTY_FORM.llmEndpoint,
      });
      setSchemaPreview(existing.schemaPreview || null);
      setLlmStatus(existing.healthy ? 'verified' : null);
    } else {
      setForm(EMPTY_FORM);
      setSchemaPreview(null);
      setLlmStatus(null);
    }
    setAnalyzeError(null);
    setLlmError(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const setField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field as string]) {
      setErrors(prev => { const n = { ...prev }; delete n[field as string]; return n; });
    }
    // Mutating provider clears prior LLM verification
    if (field === 'llmProvider' || field === 'llmApiKey' || field === 'llmModel' || field === 'llmEndpoint') {
      setLlmStatus(null);
      setLlmError(null);
    }
    if (field === 'frameworkPath') {
      setSchemaPreview(null);
      setAnalyzeError(null);
    }
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.frameworkPath.trim()) errs.frameworkPath = 'Framework path is required';
    if (form.llmProvider !== 'Ollama' && !form.llmApiKey.trim()) {
      errs.llmApiKey = 'API key is required for this provider';
    }
    if (form.llmProvider === 'Ollama' && !form.llmEndpoint.trim()) {
      errs.llmEndpoint = 'Endpoint URL is required for Ollama';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`${API_BASE}/select-folder`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAnalyzeError(data?.detail || `Folder picker failed (HTTP ${res.status})`);
        return;
      }
      if (data?.status === 'success' && data?.path) {
        setField('frameworkPath', data.path);
      }
    } catch (e: any) {
      setAnalyzeError(`Cannot reach backend: ${e?.message || e}`);
    } finally {
      setBrowsing(false);
    }
  };

  const handleAnalyze = async () => {
    if (!form.frameworkPath.trim()) {
      setErrors(prev => ({ ...prev, frameworkPath: 'Framework path is required' }));
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    setSchemaPreview(null);
    try {
      const res = await fetch(`${API_BASE}/analyze-framework`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework_path: form.frameworkPath.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAnalyzeError(data?.detail || `Analysis failed (HTTP ${res.status})`);
      } else {
        setSchemaPreview(data?.schema_preview || null);
      }
    } catch (e: any) {
      setAnalyzeError(`Cannot reach backend: ${e?.message || e}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleTestLLM = async () => {
    if (form.llmProvider !== 'Ollama' && !form.llmApiKey.trim()) {
      setErrors(prev => ({ ...prev, llmApiKey: 'API key is required for this provider' }));
      return;
    }
    if (form.llmProvider === 'Ollama' && !form.llmEndpoint.trim()) {
      setErrors(prev => ({ ...prev, llmEndpoint: 'Endpoint URL is required for Ollama' }));
      return;
    }
    setTesting(true);
    setLlmStatus(null);
    setLlmError(null);
    try {
      const res = await fetch(`${API_BASE}/test-llm-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llmProvider: form.llmProvider,
          llmApiKey: form.llmApiKey,
          llmModel: form.llmModel,
          llmEndpoint: form.llmEndpoint,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLlmStatus('failed');
        setLlmError(data?.detail || `HTTP ${res.status}`);
      } else {
        setLlmStatus('verified');
      }
    } catch (e: any) {
      setLlmStatus('failed');
      setLlmError(`Cannot reach backend: ${e?.message || e}`);
    } finally {
      setTesting(false);
    }
  };

  const hasAmbiguities = (schemaPreview?.config_context?.ambiguities?.length ?? 0) > 0;
  const canSave = !!schemaPreview && llmStatus === 'verified' && !hasAmbiguities;

  const handleGenerateScripts = () => {
    if (!onGenerateScripts) return;
    const config: FrameworkConfig = {
      frameworkPath: form.frameworkPath.trim(),
      llmProvider: form.llmProvider,
      llmApiKey: form.llmApiKey,
      llmModel: form.llmModel.trim(),
      llmEndpoint: form.llmEndpoint.trim(),
      healthy: true,
      savedAt: new Date().toISOString(),
    };
    onGenerateScripts(config);
  };

  const handleClear = () => {
    clearFrameworkConfig();
    setForm(EMPTY_FORM);
    setSchemaPreview(null);
    setLlmStatus(null);
    setLlmError(null);
    setAnalyzeError(null);
    setErrors({});
    setSaveFeedback('Cleared.');
    setTimeout(() => setSaveFeedback(null), 2000);
    window.dispatchEvent(new CustomEvent('framework-changed', { detail: { kind: 'cleared' } }));
    if (onCleared) onCleared();
  };

  const handleSave = () => {
    if (!validate()) return;
    if (!canSave) {
      setSaveFeedback('Run Analyze + Test Connection successfully before saving.');
      setTimeout(() => setSaveFeedback(null), 3500);
      return;
    }
    const config: FrameworkConfig = {
      frameworkPath: form.frameworkPath.trim(),
      llmProvider: form.llmProvider,
      llmApiKey: form.llmApiKey,
      llmModel: form.llmModel.trim(),
      llmEndpoint: form.llmEndpoint.trim(),
      schemaPreview: schemaPreview!,
      healthy: true,
      savedAt: new Date().toISOString(),
    };
    try {
      const persisted = { ...config, llmApiKey: obfuscate(config.llmApiKey) };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (e: any) {
      setSaveFeedback(`Failed to persist locally: ${e?.message || e}`);
      return;
    }
    setSaveFeedback('Saved.');
    setTimeout(() => setSaveFeedback(null), 2000);
    window.dispatchEvent(new CustomEvent('framework-changed', { detail: { kind: 'saved', savedAt: config.savedAt } }));
    if (onSaved) onSaved(config);
  };

  // ── styles (match ZephyrUploadModal conventions) ──────────────────────────
  const S = {
    overlay: {
      position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
      zIndex: 1001,
    },
    dialog: {
      backgroundColor: 'var(--bg-main)',
      borderRadius: '12px', maxWidth: '720px', width: '95%',
      minHeight: '80vh', maxHeight: '95vh', display: 'flex' as const, flexDirection: 'column' as const,
      overflow: 'hidden' as const,
      boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
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
    sectionLabel: {
      fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-muted)',
      textTransform: 'uppercase' as const, letterSpacing: '0.06em',
      marginBottom: '0.65rem', marginTop: '0.4rem',
    },
    label: {
      display: 'block' as const, marginBottom: '0.3rem',
      fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-main)',
    },
    input: (hasError: boolean) => ({
      width: '100%', padding: '0.5rem 0.7rem',
      border: `1px solid ${hasError ? '#ef4444' : 'var(--border-color)'}`,
      borderRadius: '6px', fontSize: '0.88rem',
      backgroundColor: hasError ? 'rgba(239,68,68,0.04)' : 'var(--bg-card)',
      color: 'var(--text-main)', outline: 'none',
    }),
    errText: { color: '#ef4444', fontSize: '0.74rem', marginTop: '0.2rem' },
    fieldWrap: { marginBottom: '0.85rem' },
    btnPrimary: (disabled: boolean) => ({
      padding: '0.55rem 1rem',
      backgroundColor: disabled ? 'var(--text-muted)' : 'var(--primary)',
      color: 'white', border: 'none', borderRadius: '6px',
      cursor: disabled ? 'not-allowed' : 'pointer' as const,
      fontWeight: 600, fontSize: '0.83rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
      opacity: disabled ? 0.6 : 1,
    }),
    btnOutline: {
      padding: '0.5rem 0.95rem',
      backgroundColor: 'transparent',
      border: '1px solid var(--border-color)',
      color: 'var(--text-main)', borderRadius: '6px', cursor: 'pointer' as const,
      fontWeight: 600, fontSize: '0.83rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
    },
    banner: (kind: 'ok' | 'err' | 'info' | 'warn') => {
      const colorMap = {
        ok:   { bg: 'rgba(22,163,74,0.1)', border: '#bbf7d0', color: '#16a34a' },
        err:  { bg: 'rgba(220,38,38,0.1)', border: '#fecaca', color: '#dc2626' },
        info: { bg: 'rgba(37,99,235,0.08)', border: 'rgba(37,99,235,0.25)', color: '#2563eb' },
        warn: { bg: 'rgba(217,119,6,0.1)', border: '#fed7aa', color: '#d97706' },
      } as const;
      const c = colorMap[kind];
      return {
        display: 'flex' as const, alignItems: 'center' as const, gap: '0.5rem',
        padding: '0.5rem 0.7rem', borderRadius: '6px',
        backgroundColor: c.bg, border: `1px solid ${c.border}`, color: c.color,
        marginBottom: '0.8rem', fontSize: '0.82rem', fontWeight: 600,
      };
    },
    grid2: { display: 'grid' as const, gridTemplateColumns: '1fr 1fr', gap: '0.85rem' },
    schemaCard: {
      padding: '0.75rem 0.9rem', backgroundColor: 'var(--bg-card)',
      border: '1px solid var(--border-color)', borderRadius: '8px',
      fontSize: '0.82rem', marginBottom: '0.85rem',
    },
    chip: {
      display: 'inline-block' as const, padding: '2px 8px',
      borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
      backgroundColor: 'rgba(37,99,235,0.1)', color: '#2563eb',
      border: '1px solid rgba(37,99,235,0.2)', marginRight: '0.35rem', marginBottom: '0.25rem',
    },
  };

  const renderSchemaPreview = () => {
    if (!schemaPreview) return null;
    const ts = schemaPreview.tech_stack || {};
    const layout = schemaPreview.directory_layout || {};
    const counts = schemaPreview.counts || {};
    const config = schemaPreview.config_context || {};

    return (
      <div style={S.schemaCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.45rem' }}>
          <CheckCircle2 size={14} style={{ color: '#16a34a' }} />
          <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Framework analyzed</span>
        </div>

        {/* Tech stack badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.5rem', marginBottom: '0.5rem' }}>
          {ts.language && <span style={S.chip}>{ts.language}</span>}
          {ts.test_framework && <span style={S.chip}>{ts.test_framework}</span>}
          {ts.build_tool && ts.build_tool !== 'unknown' && <span style={S.chip}>{ts.build_tool}</span>}
        </div>

        <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.55 }}>
          {layout.test_root && <div>Test root: <code style={{ color: 'var(--text-main)' }}>{layout.test_root}</code></div>}
          {layout.page_objects_root && <div>Page objects: <code style={{ color: 'var(--text-main)' }}>{layout.page_objects_root}</code></div>}
          <div>
            {counts.test_files ?? 0} test files · {counts.page_object_files ?? 0} page objects · {counts.total_source_files ?? 0} source files
          </div>
          {schemaPreview.base_class_names && schemaPreview.base_class_names.length > 0 && (
            <div>Base classes: <span style={{ color: 'var(--text-main)' }}>{schemaPreview.base_class_names.join(', ')}</span></div>
          )}
        </div>

        {/* MCP Servers */}
        {schemaPreview.mcp_servers && schemaPreview.mcp_servers.length > 0 && (
          <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              MCP Servers ({schemaPreview.mcp_servers.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '0.4rem' }}>
              {schemaPreview.mcp_servers.map(srv => (
                <span key={srv.name} title={`${srv.command} ${srv.args.join(' ')} — from ${srv.source_file}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.15rem 0.55rem', borderRadius: '999px',
                  fontSize: '0.72rem', fontWeight: 600,
                  backgroundColor: '#e0f2fe', color: '#0369a1',
                  border: '1px solid #bae6fd',
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#0ea5e9', flexShrink: 0 }} />
                  {srv.name}
                  <span style={{ fontWeight: 400, color: '#64748b' }}>{srv.transport}</span>
                </span>
              ))}
            </div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
              Available during script generation. Configure in mcp.json or .cursor/mcp.json.
            </div>
          </div>
        )}

        {/* Configuration context */}
        {config.discovered_files && config.discovered_files.length > 0 && (
          <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Configuration Files ({config.discovered_files.length})
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {config.discovered_files.slice(0, 3).map(f => <div key={f}>{f}</div>)}
              {config.discovered_files.length > 3 && <div>+ {config.discovered_files.length - 3} more</div>}
            </div>
          </div>
        )}

        {/* Base URLs */}
        {config.base_urls && config.base_urls.length > 0 && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {config.base_urls.map(url => (
              <span key={url} style={{ ...S.chip, fontSize: '0.7rem' }}>{url}</span>
            ))}
          </div>
        )}

        {/* Environments */}
        {config.environments && config.environments.length > 0 && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {config.environments.map(env => (
              <span key={env} style={{ ...S.chip, fontSize: '0.7rem', backgroundColor: '#e0f2fe' }}>{env}</span>
            ))}
          </div>
        )}

        {/* Dependencies */}
        {config.dependencies && config.dependencies.length > 0 && (
          <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              Dependencies ({config.dependencies.length})
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {config.dependencies.slice(0, 5).map(dep => (
                <div key={`${dep.name}-${dep.source}`}>{dep.name} <span style={{ color: '#999' }}>({dep.source})</span></div>
              ))}
              {config.dependencies.length > 5 && <div style={{ color: '#999' }}>+ {config.dependencies.length - 5} more</div>}
            </div>
          </div>
        )}

        {/* Redacted keys notice */}
        {config.redacted_keys && config.redacted_keys.length > 0 && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#666' }}>
            {config.redacted_keys.length} sensitive key(s) detected and redacted
          </div>
        )}

        {/* Ambiguities warnings */}
        {config.ambiguities && config.ambiguities.length > 0 && (
          <div style={{ marginTop: '0.6rem' }}>
            {config.ambiguities.map((amb, i) => (
              <div key={i} style={{
                ...S.banner('warn'),
                marginBottom: i < config.ambiguities!.length - 1 ? '0.4rem' : 0,
              } as React.CSSProperties}>
                <AlertCircle size={13} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.75rem', marginBottom: '0.2rem' }}>
                    {amb.type === 'conflict' && 'Configuration Conflict'}
                    {amb.type === 'missing' && 'Missing Configuration'}
                    {amb.type === 'ambiguous' && 'Ambiguous Configuration'}
                    {amb.type === 'unresolved_placeholder' && 'Unresolved Placeholder'}
                    {!['conflict', 'missing', 'ambiguous', 'unresolved_placeholder'].includes(amb.type) && amb.type}
                  </div>
                  <div style={{ fontSize: '0.7rem' }}>{amb.detail}</div>
                </div>
              </div>
            ))}
            <div style={{ fontSize: '0.7rem', color: '#d97706', marginTop: '0.4rem' }}>
              ⚠ Resolve all configuration issues before saving
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={S.overlay as React.CSSProperties} onClick={onClose}>
      <div style={S.dialog as React.CSSProperties} onClick={e => e.stopPropagation()}>
        <div style={S.header as React.CSSProperties}>
          <div style={S.headerTitle as React.CSSProperties}>
            <Settings size={18} style={{ color: 'var(--primary)' }} />
            Test Automation Framework Settings
          </div>
          <button style={S.closeBtn as React.CSSProperties} onClick={onClose} title="Close">
            <XCircle size={18} />
          </button>
        </div>

        <div style={S.body as React.CSSProperties}>
          {initialMessage && (
            <div style={S.banner('info') as React.CSSProperties}>
              <AlertCircle size={14} /> <span>{initialMessage}</span>
            </div>
          )}

          {/* Framework path */}
          <div style={S.sectionLabel as React.CSSProperties}>Framework Directory</div>
          <div style={S.fieldWrap}>
            <label style={S.label}>Local framework path *</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={form.frameworkPath}
                onChange={e => setField('frameworkPath', e.target.value)}
                placeholder="e.g. C:\repos\my-automation"
                style={S.input(!!errors.frameworkPath) as React.CSSProperties}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                style={{ ...S.btnOutline, flexShrink: 0 } as React.CSSProperties}
                onClick={handleBrowse}
                disabled={browsing}
                title="Browse for framework folder"
              >
                {browsing
                  ? <><Loader size={13} className="spin" /> Opening…</>
                  : <><FolderOpen size={13} /> Browse</>}
              </button>
            </div>
            {errors.frameworkPath && <p style={S.errText}>{errors.frameworkPath}</p>}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <button
              style={S.btnPrimary(!form.frameworkPath.trim() || analyzing) as React.CSSProperties}
              onClick={handleAnalyze}
              disabled={!form.frameworkPath.trim() || analyzing}
            >
              {analyzing
                ? <><Loader size={13} className="spin" /> Analyzing…</>
                : <><FolderSearch size={13} /> Analyze Framework</>}
            </button>
          </div>

          {analyzeError && (
            <div style={S.banner('err') as React.CSSProperties}>
              <XCircle size={14} /> <span>{analyzeError}</span>
            </div>
          )}
          {renderSchemaPreview()}

          {/* LLM Connection */}
          <div style={S.sectionLabel as React.CSSProperties}>LLM Connection</div>
          <div style={S.grid2}>
            <div style={S.fieldWrap}>
              <label style={S.label}>Provider *</label>
              <select
                value={form.llmProvider}
                onChange={e => setField('llmProvider', e.target.value as LlmProvider)}
                style={S.input(false) as React.CSSProperties}
              >
                {LLM_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div style={S.fieldWrap}>
              <label style={S.label}>Model {form.llmProvider === 'Ollama' ? '(e.g. llama3)' : '(optional)'}</label>
              <input
                type="text"
                value={form.llmModel}
                onChange={e => setField('llmModel', e.target.value)}
                placeholder={
                  form.llmProvider === 'GROQ'       ? 'llama-3.3-70b-versatile' :
                  form.llmProvider === 'Claude'     ? 'claude-sonnet-4-20250514' :
                  form.llmProvider === 'Ollama'     ? 'llama3' :
                  form.llmProvider === 'OpenRouter' ? 'google/gemini-pro-1.5' :
                  form.llmProvider === 'Gemini'     ? 'gemini-2.0-flash' :
                                                     'grok-beta'
                }
                style={S.input(false) as React.CSSProperties}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          {form.llmProvider !== 'Ollama' && (
            <div style={S.fieldWrap}>
              <label style={S.label}>API key *</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.llmApiKey}
                  onChange={e => setField('llmApiKey', e.target.value)}
                  placeholder="sk-..."
                  style={{ ...S.input(!!errors.llmApiKey), paddingRight: '2.6rem' } as React.CSSProperties}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: '2px' } as React.CSSProperties}
                  title={showKey ? 'Hide' : 'Show'}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {errors.llmApiKey && <p style={S.errText}>{errors.llmApiKey}</p>}
            </div>
          )}

          {form.llmProvider === 'Ollama' && (
            <div style={S.fieldWrap}>
              <label style={S.label}>Endpoint URL *</label>
              <input
                type="url"
                value={form.llmEndpoint}
                onChange={e => setField('llmEndpoint', e.target.value)}
                placeholder="http://127.0.0.1:11434"
                style={S.input(!!errors.llmEndpoint) as React.CSSProperties}
                spellCheck={false}
              />
              {errors.llmEndpoint && <p style={S.errText}>{errors.llmEndpoint}</p>}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <button
              style={S.btnPrimary(
                (form.llmProvider !== 'Ollama' && !form.llmApiKey.trim()) ||
                (form.llmProvider === 'Ollama' && !form.llmEndpoint.trim()) ||
                testing
              ) as React.CSSProperties}
              onClick={handleTestLLM}
              disabled={
                (form.llmProvider !== 'Ollama' && !form.llmApiKey.trim()) ||
                (form.llmProvider === 'Ollama' && !form.llmEndpoint.trim()) ||
                testing
              }
            >
              {testing
                ? <><Loader size={13} className="spin" /> Testing…</>
                : <><Wand2 size={13} /> Test Connection</>}
            </button>
          </div>

          {llmStatus === 'verified' && (
            <div style={S.banner('ok') as React.CSSProperties}>
              <CheckCircle2 size={14} /> <span>{form.llmProvider} connection verified.</span>
            </div>
          )}
          {llmStatus === 'failed' && (
            <div style={S.banner('err') as React.CSSProperties}>
              <XCircle size={14} /> <span>{llmError || 'Connection failed'}</span>
            </div>
          )}

          {saveFeedback && (
            <div style={S.banner('info') as React.CSSProperties}>
              <CheckCircle2 size={14} /> <span>{saveFeedback}</span>
            </div>
          )}

          <div style={{ marginTop: '0.5rem', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            Stored locally in this browser (localStorage). API key obfuscated, not encrypted &mdash; anyone with browser access can recover it. Use Clear Saved Settings to remove.
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '0.85rem 1.5rem',
          borderTop: '1px solid var(--border-color)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem',
          flexShrink: 0,
        }}>
          <button
            style={S.btnOutline as React.CSSProperties}
            onClick={handleClear}
            title="Remove saved framework + LLM settings from this browser"
          >
            <Trash2 size={13} /> Clear Saved Settings
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={S.btnOutline as React.CSSProperties} onClick={onClose}>Cancel</button>
            <button
              style={S.btnPrimary(!canSave) as React.CSSProperties}
              onClick={handleSave}
              disabled={!canSave}
              title={!canSave ? 'Run Analyze + Test Connection first' : 'Save settings'}
            >
              <Save size={13} /> Save Settings
            </button>
            {onGenerateScripts && (
              <button
                style={S.btnPrimary(llmStatus !== 'verified') as React.CSSProperties}
                onClick={handleGenerateScripts}
                disabled={llmStatus !== 'verified'}
                title={llmStatus !== 'verified' ? 'Test LLM connection first' : 'Open script generation'}
              >
                <FileText size={13} /> Generate Test Scripts
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
