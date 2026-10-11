import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIpc } from '../hooks/useIpc';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Settings {
  ai: {
    provider: string;
    openaiKey: string;
    anthropicKey: string;
    groqKey: string;
    openaiModel: string;
    anthropicModel: string;
    groqModel: string;
    interviewMode: string;
  };
  audio: {
    transcriptionMode: string;
    deepgramKey: string;
    groqKey: string;
    googleSttKey: string;
    googleProjectId: string;
  };
  ocr: {
    intervalSeconds: number;
    autoCapture: boolean;
  };
  overlay: {
    opacity: number;
    width: number;
    height: number;
    fontSize: number;
  };
  resume: string;
  jobDescription: string;
  customPrompt: string;
}

const OPACITY_DEBOUNCE_MS = 50;

const HOTKEYS: [string, string][] = [
  ['Ctrl+H', 'Hide app'],
  ['Ctrl+Shift+H', 'Toggle overlay'],
  ['Ctrl+Shift+A', 'Ask AI'],
  ['Ctrl+Shift+S', 'Capture screen'],
  ['Ctrl+Shift+R', 'Toggle recording'],
  ['Ctrl+Shift+I', 'Toggle interact mode'],
  ['Ctrl+Shift+N', 'New conversation'],
  ['Ctrl+Shift+Up/Down', 'Scroll content'],
  ['Ctrl+Shift+Q', 'Quit app'],
  ['Ctrl+Shift+W', 'Toggle typing mode'],
  ['Ctrl+Alt+Arrows', 'Move window'],
  ['Ctrl+Shift+X', 'Cancel AI'],
  ['Escape', 'Exit typing mode'],
];

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const api = useIpc();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [jdUploading, setJdUploading] = useState(false);
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [jdFileName, setJdFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const opacityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFileUpload = async (purpose: 'resume' | 'jobDescription') => {
    const setUploading = purpose === 'resume' ? setResumeUploading : setJdUploading;
    const setFileName = purpose === 'resume' ? setResumeFileName : setJdFileName;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await (window as any).electronAPI?.pickAndExtractFile?.(purpose);
      if (!result) return; // dialog canceled
      if (result.success) {
        updateField(purpose, result.text);
        setFileName(result.fileName);
      } else {
        setUploadError(`Failed to read ${result.fileName}: ${result.error}`);
        console.error(`File extraction failed: ${result.error}`);
      }
    } catch (err) {
      setUploadError('File upload failed unexpectedly');
      console.error('File upload error:', err);
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (isOpen) {
      api.getConfig()
        .then((cfg) => { if (!cancelled) setSettings(cfg); })
        .catch((err: any) => {
          if (!cancelled) {
            console.error('[settings] Failed to load config:', err);
            setSaveError('Failed to load settings');
          }
        });
      (window as any).electronAPI?.setFocusable?.(true);
    } else {
      (window as any).electronAPI?.setFocusable?.(false);
    }
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen || !settings) return null;

  const update = (section: keyof Settings, key: string, value: any) => {
    setSettings(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        [section]: { ...(prev[section] as any), [key]: value }
      };
    });
  };

  const updateField = (key: 'resume' | 'jobDescription', value: string) => {
    setSettings(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.setConfig('ai', settings.ai);
      await api.setConfig('audio', settings.audio);
      await api.setConfig('ocr', settings.ocr);
      await api.setConfig('overlay', settings.overlay);
      await api.setConfig('resume', settings.resume);
      await api.setConfig('jobDescription', settings.jobDescription);
      await api.setConfig('customPrompt', settings.customPrompt);
      onClose();
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      console.error('Failed to save settings:', err);
      setSaveError(`Failed to save: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const mode = settings.audio.transcriptionMode;
  const needsDeepgramKey = mode === 'deepgram';
  const needsGroqKey = mode === 'groq-whisper';
  const needsGoogleKey = mode === 'google-stt';

  return (
    <div className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal">
        <div className="settings-title">Settings</div>

        {/* ── AI Provider ── */}
        <div className="settings-section">
          <div className="settings-section-title">AI Provider</div>
          <div className="settings-field">
            <label className="settings-label">Provider</label>
            <select
              className="settings-select"
              value={settings.ai.provider}
              onChange={e => update('ai', 'provider', e.target.value)}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="groq">Groq (Fastest Inference)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Interview Mode</label>
            <select
              className="settings-select"
              value={settings.ai.interviewMode}
              onChange={e => update('ai', 'interviewMode', e.target.value)}
            >
              <option value="general">General — assessments, screen help, mixed contexts (Default)</option>
              <option value="behavioural">Behavioural Interview — Tell me about yourself, STAR stories</option>
              <option value="leetcode">LeetCode / Coding Interview</option>
              <option value="system_design">System Design Interview</option>
              <option value="code_modification">Code Modification Interview</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={settings.ai.usePromptV2}
                onChange={e => update('ai', 'usePromptV2', e.target.checked)}
              />
              Use v2 concise prompt (LeetCode mode only) — ~40% shorter responses
            </label>
          </div>
          <div className="settings-field">
            <label className="settings-label">OpenAI Model</label>
            <select
              className="settings-select"
              value={settings.ai.openaiModel}
              onChange={e => update('ai', 'openaiModel', e.target.value)}
            >
              <option value="gpt-5.4">GPT-5.4 — RECOMMENDED (best price/quality)</option>
              <option value="gpt-5.5">GPT-5.5 (best for hard coding, ~2x cost)</option>
              <option value="gpt-4.1">GPT-4.1 (lowest TTFT, best for conversational)</option>
              <option value="gpt-5.4-mini">GPT-5.4 Mini (fast + cheap)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Anthropic Model</label>
            <select
              className="settings-select"
              value={settings.ai.anthropicModel}
              onChange={e => update('ai', 'anthropicModel', e.target.value)}
            >
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6 — RECOMMENDED (best speed/quality, ~1.7s TTFT)</option>
              <option value="claude-opus-4-7">Claude Opus 4.7 (most thorough, ~3s TTFT, 2× output length)</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 (fastest, ~0.6s TTFT, weaker on small text)</option>
              <option value="claude-opus-4-6">Claude Opus 4.6 (capable, prior generation)</option>
              <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (stable, prior generation)</option>
              <option value="claude-sonnet-4-5-20250929">Claude Sonnet 4.5 (pinned date version)</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (pinned date version)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Groq Model</label>
            <select
              className="settings-select"
              value={settings.ai.groqModel}
              onChange={e => update('ai', 'groqModel', e.target.value)}
            >
              <option value="meta-llama/llama-4-scout-17b-16e-instruct">Llama 4 Scout 17B (Vision — Preview)</option>
              <option value="openai/gpt-oss-120b">GPT-OSS 120B (Reasoning, no vision)</option>
              <option value="openai/gpt-oss-20b">GPT-OSS 20B (Fastest, reasoning, no vision)</option>
              <option value="llama-3.3-70b-versatile">Llama 3.3 70B Versatile (no vision)</option>
              <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant (Fast, no vision)</option>
              <option value="qwen/qwen3-32b">Qwen 3 32B (Preview, no vision)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">OpenAI API Key</label>
            <input
              className="settings-input"
              type="password"
              value={settings.ai.openaiKey}
              onChange={e => update('ai', 'openaiKey', e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Anthropic API Key</label>
            <input
              className="settings-input"
              type="password"
              value={settings.ai.anthropicKey}
              onChange={e => update('ai', 'anthropicKey', e.target.value)}
              placeholder="sk-ant-..."
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Groq API Key</label>
            <input
              className="settings-input"
              type="password"
              value={settings.ai.groqKey}
              onChange={e => update('ai', 'groqKey', e.target.value)}
              placeholder="gsk_..."
            />
          </div>
        </div>

        {/* ── Speech-to-Text ── */}
        <div className="settings-section">
          <div className="settings-section-title">Speech-to-Text</div>
          <div className="settings-field">
            <label className="settings-label">Provider</label>
            <select
              className="settings-select"
              value={settings.audio.transcriptionMode}
              onChange={e => update('audio', 'transcriptionMode', e.target.value)}
            >
              <option value="deepgram">Deepgram Nova-2 (Best - Streaming)</option>
              <option value="groq-whisper">Groq Whisper (Fast Batch)</option>
              <option value="realtime">OpenAI Realtime API (Streaming)</option>
              <option value="whisper">OpenAI Whisper (Chunked)</option>
              <option value="google-stt">Google Speech-to-Text</option>
            </select>
          </div>

          {needsDeepgramKey && (
            <div className="settings-field">
              <label className="settings-label">Deepgram API Key</label>
              <input
                className="settings-input"
                type="password"
                value={settings.audio.deepgramKey || ''}
                onChange={e => update('audio', 'deepgramKey', e.target.value)}
                placeholder="dg-..."
              />
            </div>
          )}

          {needsGroqKey && (
            <div className="settings-field">
              <label className="settings-label">Groq API Key</label>
              <input
                className="settings-input"
                type="password"
                value={settings.audio.groqKey || ''}
                onChange={e => update('audio', 'groqKey', e.target.value)}
                placeholder="gsk_..."
              />
            </div>
          )}

          {needsGoogleKey && (
            <>
              <div className="settings-field">
                <label className="settings-label">Google Cloud API Key</label>
                <input
                  className="settings-input"
                  type="password"
                  value={settings.audio.googleSttKey || ''}
                  onChange={e => update('audio', 'googleSttKey', e.target.value)}
                  placeholder="AIza..."
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Google Cloud Project ID</label>
                <input
                  className="settings-input"
                  type="text"
                  value={settings.audio.googleProjectId || ''}
                  onChange={e => update('audio', 'googleProjectId', e.target.value)}
                  placeholder="my-project-123"
                />
              </div>
            </>
          )}
        </div>

        {/* ── Screen Capture ── */}
        <div className="settings-section">
          <div className="settings-section-title">Screen Capture</div>
          <div className="settings-field">
            <label className="settings-label">Capture Interval (seconds)</label>
            <input
              className="settings-input"
              type="number"
              min={5}
              max={300}
              value={settings.ocr.intervalSeconds}
              onChange={e => update('ocr', 'intervalSeconds', parseInt(e.target.value) || 30)}
            />
          </div>
        </div>

        {/* ── Overlay ── */}
        <div className="settings-section">
          <div className="settings-section-title">Overlay</div>
          <div className="settings-field">
            <label className="settings-label">Opacity ({Math.round(settings.overlay.opacity * 100)}%)</label>
            <input
              className="settings-range"
              type="range"
              min={10}
              max={100}
              value={settings.overlay.opacity * 100}
              onChange={e => {
                const val = parseInt(e.target.value) / 100;
                update('overlay', 'opacity', val);
                if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
                opacityTimerRef.current = setTimeout(() => api.setOpacity(val), OPACITY_DEBOUNCE_MS);
              }}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Font Size ({settings.overlay.fontSize}px)</label>
            <input
              className="settings-range"
              type="range"
              min={10}
              max={24}
              value={settings.overlay.fontSize}
              onChange={e => {
                const val = parseInt(e.target.value);
                update('overlay', 'fontSize', val);
                document.documentElement.style.setProperty('--content-font-size', val + 'px');
              }}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Width (px)</label>
            <input
              className="settings-input"
              type="number"
              min={200}
              max={1200}
              value={settings.overlay.width}
              onChange={e => {
                const val = parseInt(e.target.value) || 500;
                update('overlay', 'width', val);
                (window as any).electronAPI?.setWindowSize?.(val, settings.overlay.height);
              }}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Height (px)</label>
            <input
              className="settings-input"
              type="number"
              min={200}
              max={1000}
              value={settings.overlay.height}
              onChange={e => {
                const val = parseInt(e.target.value) || 600;
                update('overlay', 'height', val);
                (window as any).electronAPI?.setWindowSize?.(settings.overlay.width, val);
              }}
            />
          </div>
        </div>

        {/* ── My Profile ── */}
        <div className="settings-section">
          <div className="settings-section-title">My Profile</div>
          {uploadError && (
            <div className="settings-error-banner">{uploadError}</div>
          )}
          <div className="settings-field">
            <div className="settings-upload-row">
              <label className="settings-label" style={{ margin: 0 }}>Resume / Background</label>
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={() => handleFileUpload('resume')}
                disabled={resumeUploading}
              >
                {resumeUploading ? 'Reading...' : 'Upload File'}
              </button>
            </div>
            {resumeFileName && (
              <div className="settings-file-info">
                <span>{resumeFileName}</span>
                <span className="settings-file-info-secondary">({settings.resume.length.toLocaleString()} chars)</span>
              </div>
            )}
            <textarea
              className="settings-input"
              rows={5}
              value={settings.resume}
              onChange={e => { updateField('resume', e.target.value); if (!e.target.value) setResumeFileName(null); }}
              placeholder="Paste your resume here or click Upload File (.txt, .pdf, .docx). This will be used as context so the AI can answer questions about you."
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>
          <div className="settings-field">
            <div className="settings-upload-row">
              <label className="settings-label" style={{ margin: 0 }}>Job Description</label>
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={() => handleFileUpload('jobDescription')}
                disabled={jdUploading}
              >
                {jdUploading ? 'Reading...' : 'Upload File'}
              </button>
            </div>
            {jdFileName && (
              <div className="settings-file-info">
                <span>{jdFileName}</span>
                <span className="settings-file-info-secondary">({settings.jobDescription.length.toLocaleString()} chars)</span>
              </div>
            )}
            <textarea
              className="settings-input"
              rows={5}
              value={settings.jobDescription}
              onChange={e => { updateField('jobDescription', e.target.value); if (!e.target.value) setJdFileName(null); }}
              placeholder="Paste the job description here or click Upload File (.txt, .pdf, .docx). Responses will be tailored to align your experience with this role."
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>
        </div>

        {/* ── Custom Instructions ── */}
        <div className="settings-section">
          <div className="settings-section-title">Custom Instructions</div>
          <div className="settings-description">
            Tell the AI how it should behave and respond. These instructions take priority over built-in rules and apply to every response.
          </div>
          <div className="settings-field">
            <textarea
              className="settings-input"
              rows={4}
              value={settings.customPrompt || ''}
              onChange={e => setSettings(prev => prev ? { ...prev, customPrompt: e.target.value } : prev)}
              placeholder={'Examples:\n- Always respond in a casual, conversational tone.\n- Keep behavioral answers under 60 seconds spoken.\n- Prefer Python over JavaScript for code examples.'}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>
        </div>

        {/* ── Hotkeys ── */}
        <div className="settings-section">
          <div className="settings-section-title">Hotkeys</div>
          <div className="settings-hotkeys">
            {HOTKEYS.map(([key, desc]) => (
              <React.Fragment key={key}>
                <span className="hotkey-key">{key}</span>
                <span className="hotkey-desc">{desc}</span>
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="settings-footer">
          {saveError && (
            <div className="settings-error-banner" style={{ flex: 1 }}>{saveError}</div>
          )}
          <button className="settings-btn settings-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="settings-btn settings-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
