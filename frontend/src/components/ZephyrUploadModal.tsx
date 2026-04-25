import React, { useState, useEffect, useRef, ReactNode } from 'react';
import {
  ChevronDown, Eye, EyeOff, CheckCircle2, AlertCircle, Clock,
  XCircle, Settings, Upload, Save, Loader, Check
} from 'lucide-react';

const STORAGE_KEY = 'zephyrSettings';

const DEMO_CASES = [
  { id: 'TC001', name: 'User Login Flow' },
  { id: 'TC002', name: 'Password Reset' },
  { id: 'TC003', name: 'User Registration' },
  { id: 'TC004', name: 'Profile Update' },
  { id: 'TC005', name: 'Logout Flow' },
];

const STATUS_POOL = ['Success', 'Success', 'Success', 'Failed', 'Skipped', 'Warning'];

function pickStatus() {
  return STATUS_POOL[Math.floor(Math.random() * STATUS_POOL.length)];
}

interface FormData {
  apiToken: string;
  baseUrl: string;
  releaseName: string;
}

interface ValidationErrors {
  [key: string]: string;
}

interface TestCase {
  id: string;
  name: string;
  status?: string;
}

interface TCResult {
  testCases: Array<{
    testCaseId: string;
    testCaseTitle: string;
  }>;
}

interface ZephyrUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  tcResults?: TCResult;
  selectedIndices?: number[];
}

function validateForm(form: FormData): ValidationErrors {
  const errs: ValidationErrors = {};
  if (!form.apiToken.trim()) errs.apiToken = 'API Token is required';
  if (!form.baseUrl.trim()) {
    errs.baseUrl = 'Base URL is required';
  } else if (!form.baseUrl.startsWith('https://')) {
    errs.baseUrl = 'Invalid URL format (must be https://...)';
  }
  if (!form.releaseName.trim()) errs.releaseName = 'Release Name is required';
  return errs;
}

export default function ZephyrUploadModal({ isOpen, onClose, tcResults, selectedIndices = [] }: ZephyrUploadModalProps): ReactNode {
  const [view, setView] = useState<'connection' | 'uploading' | 'results'>('connection');
  const [form, setForm] = useState<FormData>({ apiToken: '', baseUrl: '', releaseName: '' });
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [showToken, setShowToken] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'verified' | 'failed' | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [savedSettings, setSavedSettings] = useState<FormData | null>(null);

  const [tcList, setTcList] = useState<TestCase[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentAction, setCurrentAction] = useState('');
  const [stats, setStats] = useState({ success: 0, failed: 0, warning: 0, skipped: 0 });
  const [failedCases, setFailedCases] = useState<TestCase[]>([]);
  const [selectedFailed, setSelectedFailed] = useState<Set<string>>(new Set());
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const uploadRef = useRef<NodeJS.Timeout | null>(null);
  const prevStatsRef = useRef({ success: 0, failed: 0, warning: 0, skipped: 0 });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setForm(f => ({ ...f, ...parsed }));
        setSavedSettings(parsed);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (isOpen) {
      setView('connection');
      setConnectionStatus(null);
      setErrors({});
      setCancelConfirm(false);
    } else {
      if (uploadRef.current) clearTimeout(uploadRef.current);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const buildCaseList = (overrideIds?: Set<string>) => {
    let base: TestCase[];
    if (tcResults?.testCases?.length) {
      const source = selectedIndices.length > 0
        ? tcResults.testCases.filter((_, i) => selectedIndices.includes(i))
        : tcResults.testCases;
      base = source.map(tc => ({ id: tc.testCaseId, name: tc.testCaseTitle }));
    } else {
      base = DEMO_CASES;
    }
    return overrideIds ? base.filter(tc => overrideIds.has(tc.id)) : base;
  };

  const handleFieldChange = (field: keyof FormData, value: string) => {
    setForm(f => ({ ...f, [field]: value }));
    if (errors[field]) setErrors(e => { const n = { ...e }; delete n[field]; return n; });
  };

  const handleVerify = async () => {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setVerifying(true);
    setConnectionStatus(null);
    await new Promise(r => setTimeout(r, 1500));
    setVerifying(false);
    setConnectionStatus('verified');
  };

  const handleSave = () => {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const settings = { apiToken: form.apiToken, baseUrl: form.baseUrl, releaseName: form.releaseName };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    setSavedSettings(settings);
    setSaveFeedback('Settings saved!');
    setTimeout(() => setSaveFeedback(null), 2000);
  };

  const startUpload = (retryIds?: Set<string>) => {
    const cases = buildCaseList(retryIds);
    if (!cases.length) return;
    const list = cases.map(tc => ({ ...tc, status: 'pending' }));
    setTcList(list);
    setProgress(0);
    setCurrentAction('Preparing upload...');
    setCancelConfirm(false);
    setView('uploading');
    if (retryIds) {
      prevStatsRef.current = { ...stats, failed: 0, warning: 0 };
    } else {
      prevStatsRef.current = { success: 0, failed: 0, warning: 0, skipped: 0 };
    }

    const results = list.map(tc => ({ ...tc }));
    let i = 0;
    const total = results.length;

    const tick = () => {
      if (i >= total) {
        const newStats = { success: 0, failed: 0, warning: 0, skipped: 0 };
        const failed: TestCase[] = [];
        results.forEach(tc => {
          if (tc.status === 'Success') newStats.success++;
          else if (tc.status === 'Failed') { newStats.failed++; failed.push({ ...tc }); }
          else if (tc.status === 'Warning') { newStats.warning++; failed.push({ ...tc }); }
          else if (tc.status === 'Skipped') newStats.skipped++;
        });
        const prev = prevStatsRef.current;
        setStats({
          success: prev.success + newStats.success,
          failed: newStats.failed,
          warning: prev.warning + newStats.warning,
          skipped: prev.skipped + newStats.skipped,
        });
        setFailedCases(failed);
        setSelectedFailed(new Set());
        setProgress(100);
        setCurrentAction('Upload complete!');
        setTimeout(() => setView('results'), 600);
        return;
      }

      results[i] = { ...results[i], status: 'Uploading' };
      setTcList([...results]);
      setCurrentAction(`Uploading ${results[i].id} – ${results[i].name}...`);
      setProgress(Math.round((i / total) * 100));

      const delay = 600 + Math.random() * 500;
      uploadRef.current = setTimeout(() => {
        results[i] = { ...results[i], status: pickStatus() };
        setTcList([...results]);
        setProgress(Math.round(((i + 1) / total) * 100));
        i++;
        uploadRef.current = setTimeout(tick, 300 + Math.random() * 200);
      }, delay);
    };

    uploadRef.current = setTimeout(tick, 400);
  };

  const handleCancel = () => {
    if (cancelConfirm) {
      if (uploadRef.current) clearTimeout(uploadRef.current);
      setView('connection');
      setCancelConfirm(false);
    } else {
      setCancelConfirm(true);
    }
  };

  const toggleSelectFailed = (id: string) => {
    setSelectedFailed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedFailed(checked ? new Set(failedCases.map(tc => tc.id)) : new Set());
  };

  // ─── Shared styles ─────────────────────────────────────────────────────────

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
      maxWidth: view === 'results' ? '860px' : '680px',
      width: '95%',
      maxHeight: '90vh',
      display: 'flex' as const,
      flexDirection: 'column' as const,
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
    body: { flex: 1, overflowY: 'auto' as const, padding: '1.5rem' },
    label: {
      display: 'block' as const, marginBottom: '0.35rem',
      fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-main)',
    },
    input: (hasError: boolean) => ({
      width: '100%', padding: '0.55rem 0.75rem',
      border: `1px solid ${hasError ? '#ef4444' : 'var(--border-color)'}`,
      borderRadius: '6px', fontSize: '0.9rem',
      backgroundColor: hasError ? 'rgba(239,68,68,0.04)' : 'var(--bg-card)',
      color: 'var(--text-main)', outline: 'none',
      transition: 'border-color 0.15s',
    }),
    errText: { color: '#ef4444', fontSize: '0.76rem', marginTop: '0.25rem' },
    fieldWrap: { marginBottom: '0.9rem' },
    btnPrimary: (disabled: boolean) => ({
      padding: '0.6rem 1.1rem',
      backgroundColor: disabled ? 'var(--text-muted)' : 'var(--primary)',
      color: 'white', border: 'none', borderRadius: '6px',
      cursor: disabled ? 'not-allowed' : 'pointer' as const,
      fontWeight: 600, fontSize: '0.85rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
      opacity: disabled ? 0.6 : 1,
    }),
    btnOutline: {
      padding: '0.6rem 1.1rem',
      backgroundColor: 'transparent',
      border: '1px solid var(--border-color)',
      color: 'var(--text-main)', borderRadius: '6px', cursor: 'pointer' as const,
      fontWeight: 600, fontSize: '0.85rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
    },
    btnDanger: {
      padding: '0.55rem 1rem',
      backgroundColor: '#ef4444', color: 'white',
      border: 'none', borderRadius: '6px', cursor: 'pointer' as const,
      fontWeight: 600, fontSize: '0.82rem',
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '0.4rem',
    },
  };

  // ─── Status helpers ─────────────────────────────────────────────────────────

  const STATUS_CFG = {
    Success:   { bg: 'rgba(22,163,74,0.1)',   color: '#16a34a', border: '#bbf7d0' },
    Failed:    { bg: 'rgba(220,38,38,0.1)',   color: '#dc2626', border: '#fecaca' },
    Skipped:   { bg: 'rgba(202,138,4,0.1)',   color: '#ca8a04', border: '#fef08a' },
    Warning:   { bg: 'rgba(234,88,12,0.1)',   color: '#ea580c', border: '#fed7aa' },
    Uploading: { bg: 'rgba(37,99,235,0.1)',   color: '#2563eb', border: '#bfdbfe' },
    pending:   { bg: 'var(--bg-card)',        color: 'var(--text-muted)', border: 'var(--border-color)' },
  };

  const badgeStyle = (status: string) => {
    const cfg = STATUS_CFG[status as keyof typeof STATUS_CFG] || STATUS_CFG.pending;
    return {
      display: 'inline-flex' as const, alignItems: 'center' as const, gap: '3px',
      padding: '2px 8px', borderRadius: '9999px',
      fontSize: '0.72rem', fontWeight: 700,
      backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
      whiteSpace: 'nowrap' as const,
    };
  };

  const StatusIcon = ({ status, size = 14 }: { status: string; size?: number }) => {
    const cls = 'spin';
    if (status === 'Success')   return <CheckCircle2 size={size} style={{ color: '#16a34a', flexShrink: 0 }} />;
    if (status === 'Failed')    return <XCircle      size={size} style={{ color: '#dc2626', flexShrink: 0 }} />;
    if (status === 'Skipped')   return <Clock        size={size} style={{ color: '#ca8a04', flexShrink: 0 }} />;
    if (status === 'Warning')   return <AlertCircle  size={size} style={{ color: '#ea580c', flexShrink: 0 }} />;
    if (status === 'Uploading') return <Loader       size={size} className={cls} style={{ color: '#2563eb', flexShrink: 0 }} />;
    return null;
  };

  // ─── Connection view ─────────────────────────────────────────────────────────

  const renderConnection = () => (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      {/* Main form */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '1rem' }}>
          Connection Settings
        </p>

        {/* API Token */}
        <div style={S.fieldWrap}>
          <label style={S.label}>API Token *</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showToken ? 'text' : 'password'}
              value={form.apiToken}
              onChange={e => handleFieldChange('apiToken', e.target.value)}
              placeholder="Enter your Zephyr API token"
              style={{ ...S.input(!!errors.apiToken), paddingRight: '2.6rem' } as React.CSSProperties}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: '2px' } as React.CSSProperties}
              title={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {errors.apiToken && <p style={S.errText}>{errors.apiToken}</p>}
        </div>

        {/* Base URL */}
        <div style={S.fieldWrap}>
          <label style={S.label}>Base URL *</label>
          <input
            type="url"
            value={form.baseUrl}
            onChange={e => handleFieldChange('baseUrl', e.target.value)}
            placeholder="https://yourorg.atlassian.net"
            style={S.input(!!errors.baseUrl) as React.CSSProperties}
          />
          {errors.baseUrl && <p style={S.errText}>{errors.baseUrl}</p>}
        </div>

        {/* Release Name */}
        <div style={S.fieldWrap}>
          <label style={S.label}>Release Name *</label>
          <input
            type="text"
            value={form.releaseName}
            onChange={e => handleFieldChange('releaseName', e.target.value)}
            placeholder="e.g. v2.4.0 – Sprint 12"
            style={S.input(!!errors.releaseName) as React.CSSProperties}
          />
          {errors.releaseName && <p style={S.errText}>{errors.releaseName}</p>}
        </div>

        {/* Status banners */}
        {connectionStatus === 'verified' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.75rem', borderRadius: '6px', backgroundColor: 'rgba(22,163,74,0.1)', border: '1px solid #bbf7d0', color: '#16a34a', marginBottom: '0.9rem', fontSize: '0.85rem', fontWeight: 600 }}>
            <CheckCircle2 size={15} /> Connection verified successfully!
          </div>
        )}
        {connectionStatus === 'failed' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.75rem', borderRadius: '6px', backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid #fecaca', color: '#dc2626', marginBottom: '0.9rem', fontSize: '0.85rem', fontWeight: 600 }}>
            <XCircle size={15} /> Verification failed. Check your credentials.
          </div>
        )}
        {saveFeedback && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.75rem', borderRadius: '6px', backgroundColor: 'rgba(22,163,74,0.1)', border: '1px solid #bbf7d0', color: '#16a34a', marginBottom: '0.9rem', fontSize: '0.85rem', fontWeight: 600 }}>
            <Check size={15} /> {saveFeedback}
          </div>
        )}

        {/* Buttons row */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <button style={S.btnOutline as React.CSSProperties} onClick={handleVerify} disabled={verifying}>
            {verifying
              ? <><Loader size={13} className="spin" /> Verifying...</>
              : <><CheckCircle2 size={13} /> Verify Connection</>}
          </button>
          <button style={S.btnOutline as React.CSSProperties} onClick={handleSave}>
            <Save size={13} /> Save Details
          </button>
        </div>

        {/* Upload CTA */}
        <button
          style={{ ...S.btnPrimary(false), width: '100%', justifyContent: 'center', padding: '0.7rem 1.1rem' } as React.CSSProperties}
          onClick={() => startUpload()}
        >
          <Upload size={15} />
          Start Upload
          {tcResults?.testCases?.length
            ? ` (${selectedIndices.length > 0 ? selectedIndices.length : tcResults.testCases.length} test cases)`
            : ` (${DEMO_CASES.length} demo cases)`}
        </button>
      </div>

      {/* Settings panel */}
      <div style={{ width: settingsPanelOpen ? '200px' : '32px', flexShrink: 0, transition: 'width 0.25s ease', overflow: 'hidden', borderLeft: '1px solid var(--border-color)', paddingLeft: settingsPanelOpen ? '1rem' : '0', paddingTop: '0' }}>
        <button
          onClick={() => setSettingsPanelOpen(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0', marginLeft: settingsPanelOpen ? 0 : '4px', whiteSpace: 'nowrap' } as React.CSSProperties}
          title="Toggle saved settings"
        >
          <Settings size={17} />
          {settingsPanelOpen && <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>Saved Settings</span>}
          {settingsPanelOpen && <ChevronDown size={13} style={{ marginLeft: 'auto' }} />}
        </button>

        {settingsPanelOpen && (
          <div style={{ marginTop: '0.9rem', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {savedSettings ? (
              <>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '2px', textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>Base URL</span>
                  <span style={{ fontWeight: 500, wordBreak: 'break-all', fontSize: '0.78rem' }}>{savedSettings.baseUrl || '—'}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '2px', textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>Release Name</span>
                  <span style={{ fontWeight: 500, fontSize: '0.78rem' }}>{savedSettings.releaseName || '—'}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '2px', textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>API Token</span>
                  <span style={{ fontWeight: 500, letterSpacing: '2px', fontSize: '0.82rem' }}>
                    {'•'.repeat(Math.min(16, savedSettings.apiToken?.length || 0))}
                  </span>
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>No saved settings yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ─── Upload progress view ─────────────────────────────────────────────────

  const renderUploading = () => (
    <div>
      {/* Progress bar */}
      <div style={{ marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Overall Progress</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--primary)' }}>{progress}%</span>
        </div>
        <div style={{ height: '9px', backgroundColor: 'var(--border-color)', borderRadius: '999px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, backgroundColor: 'var(--primary)', borderRadius: '999px', transition: 'width 0.35s ease' }} />
        </div>
      </div>

      {/* Current action */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.85rem', borderRadius: '6px', backgroundColor: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.2)', color: '#2563eb', marginBottom: '1.1rem', fontSize: '0.85rem' }}>
        <Loader size={13} className="spin" style={{ flexShrink: 0 }} />
        <span>{currentAction}</span>
      </div>

      {/* Test case list */}
      <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.1rem' }}>
        <div style={{ padding: '0.5rem 1rem', backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '90px 1fr 110px', gap: '0.5rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', alignItems: 'center' }}>
          <span>ID</span><span>Test Case</span><span style={{ textAlign: 'right' }}>Status</span>
        </div>
        <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
          {tcList.map((tc, i) => (
            <div
              key={i}
              style={{ padding: '0.55rem 1rem', display: 'grid', gridTemplateColumns: '90px 1fr 110px', gap: '0.5rem', alignItems: 'center', borderBottom: '1px solid var(--border-color)', fontSize: '0.85rem', backgroundColor: tc.status === 'Uploading' ? 'rgba(37,99,235,0.04)' : (i % 2 === 0 ? 'var(--bg-main)' : 'var(--bg-card)'), transition: 'background-color 0.2s' }}
            >
              <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '0.82rem' }}>{tc.id}</span>
              <span style={{ color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tc.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' }}>
                <StatusIcon status={tc.status || ''} size={13} />
                <span style={badgeStyle(tc.status || '')}>{tc.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Cancel area */}
      {cancelConfirm ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.85rem', flex: 1, color: 'var(--text-main)' }}>
            Cancel the upload? Current progress will be saved.
          </span>
          <button style={S.btnDanger as React.CSSProperties} onClick={handleCancel}>Confirm Cancel</button>
          <button style={S.btnOutline as React.CSSProperties} onClick={() => setCancelConfirm(false)}>Continue Uploading</button>
        </div>
      ) : (
        <button
          style={{ ...S.btnOutline, color: '#dc2626', borderColor: '#fca5a5' } as React.CSSProperties}
          onClick={handleCancel}
        >
          <XCircle size={14} /> Cancel Upload
        </button>
      )}
    </div>
  );

  // ─── Results view ─────────────────────────────────────────────────────────

  const renderResults = () => {
    const allSelected = failedCases.length > 0 && selectedFailed.size === failedCases.length;
    return (
      <div>
        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1.4rem' }}>
          {[
            { label: 'Success',  value: stats.success, ...STATUS_CFG.Success },
            { label: 'Failed',   value: stats.failed,  ...STATUS_CFG.Failed },
            { label: 'Warnings', value: stats.warning, ...STATUS_CFG.Warning },
            { label: 'Skipped',  value: stats.skipped, ...STATUS_CFG.Skipped },
          ].map(s => (
            <div key={s.label} style={{ padding: '0.85rem 0.5rem', borderRadius: '8px', backgroundColor: s.bg, border: `1px solid ${s.border}`, textAlign: 'center' }}>
              <div style={{ fontSize: '1.65rem', fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: s.color, marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
            </div>
          ))}
        </div>

        {failedCases.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '1.1rem 1rem', borderRadius: '8px', backgroundColor: 'rgba(22,163,74,0.08)', border: '1px solid #bbf7d0', color: '#16a34a', fontSize: '0.9rem', fontWeight: 600, marginBottom: '1.25rem' }}>
            <CheckCircle2 size={18} /> All test cases uploaded successfully!
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Failed / Warning Cases ({failedCases.length})
              </span>
            </div>

            {/* Table */}
            <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.1rem' }}>
              {/* Header */}
              <div style={{ padding: '0.5rem 1rem', backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '32px 80px 1fr 1fr 90px', gap: '0.5rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={e => toggleSelectAll(e.target.checked)}
                  style={{ width: '14px', height: '14px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                  title="Select all"
                />
                <span>ID</span>
                <span>Test Case</span>
                <span>Error / Reason</span>
                <span style={{ textAlign: 'center' }}>Status</span>
              </div>
              {/* Rows */}
              <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                {failedCases.map((tc, i) => (
                  <div
                    key={i}
                    style={{ padding: '0.55rem 1rem', display: 'grid', gridTemplateColumns: '32px 80px 1fr 1fr 90px', gap: '0.5rem', alignItems: 'center', borderBottom: '1px solid var(--border-color)', fontSize: '0.83rem', backgroundColor: selectedFailed.has(tc.id) ? 'rgba(37,99,235,0.05)' : (i % 2 === 0 ? 'var(--bg-main)' : 'var(--bg-card)'), cursor: 'pointer', transition: 'background-color 0.15s' }}
                    onClick={() => toggleSelectFailed(tc.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedFailed.has(tc.id)}
                      onChange={() => toggleSelectFailed(tc.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ width: '14px', height: '14px', cursor: 'pointer', accentColor: 'var(--primary)' }}
                    />
                    <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '0.8rem' }}>{tc.id}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tc.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tc.status === 'Failed' ? 'Upload rejected by server' : 'Uploaded with validation warnings'}
                    </span>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <span style={badgeStyle(tc.status || '')}>{tc.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Footer buttons */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {failedCases.length > 0 && (
            <button
              style={S.btnPrimary(selectedFailed.size === 0) as React.CSSProperties}
              onClick={() => selectedFailed.size > 0 && startUpload(selectedFailed)}
              disabled={selectedFailed.size === 0}
            >
              <Upload size={14} />
              Retry Selected ({selectedFailed.size})
            </button>
          )}
          <button
            style={S.btnOutline as React.CSSProperties}
            onClick={() => { setView('connection'); setConnectionStatus(null); }}
          >
            Back to Connection
          </button>
        </div>
      </div>
    );
  };

  // ─── Main render ──────────────────────────────────────────────────────────

  const VIEW_LABELS: Record<string, string | null> = { connection: null, uploading: 'Uploading…', results: 'Results' };

  return (
    <div style={S.overlay as React.CSSProperties} onClick={onClose}>
      <div style={S.dialog as React.CSSProperties} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={S.header as React.CSSProperties}>
          <div style={S.headerTitle as React.CSSProperties}>
            <Upload size={19} style={{ color: 'var(--primary)', flexShrink: 0 }} />
            Upload to Zephyr
            {VIEW_LABELS[view] && (
              <span style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: '4px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', marginLeft: '4px' }}>
                {VIEW_LABELS[view]}
              </span>
            )}
          </div>
          <button style={S.closeBtn as React.CSSProperties} onClick={onClose} title="Close">
            <XCircle size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={S.body as React.CSSProperties}>
          {view === 'connection' && renderConnection()}
          {view === 'uploading' && renderUploading()}
          {view === 'results'   && renderResults()}
        </div>
      </div>
    </div>
  );
}
