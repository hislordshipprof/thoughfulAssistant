import React, { useState, useEffect } from 'react';
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
    openaiModel: string;
    anthropicModel: string;
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
  };
  resume: string;
  jobDescription: string;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const api = useIpc();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [jdUploading, setJdUploading] = useState(false);
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [jdFileName, setJdFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
      }
    } catch (err) {
      setUploadError('File upload failed unexpectedly');
      console.error('File upload error:', err);
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      api.getConfig().then(setSettings);
      // Enable keyboard focus so user can type in input fields
      (window as any).electronAPI?.setFocusable?.(true);
    } else {
      // Restore no-focus mode when settings closes
      (window as any).electronAPI?.setFocusable?.(false);
    }
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
    try {
      await api.setConfig('ai', settings.ai);
      await api.setConfig('audio', settings.audio);
      await api.setConfig('ocr', settings.ocr);
      await api.setConfig('overlay', settings.overlay);
      await api.setConfig('resume', settings.resume);
      await api.setConfig('jobDescription', settings.jobDescription);
      onClose();
    } catch (err) {
      console.error('Failed to save settings:', err);
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

        <div className="settings-section">
          <div className="settings-section-title">AI Provider</div>
          <div className="settings-field">
            <label className="settings-label">Provider</label>
            <select
              className="settings-select"
              value={settings.ai.provider}
              onChange={e => update('ai', 'provider', e.target.value)}
            >
              <option value="openai">OpenAI (GPT-6 Sol)</option>
              <option value="anthropic">Anthropic (Claude 5)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Interview Mode</label>
            <select
              className="settings-select"
              value={settings.ai.interviewMode}
              onChange={e => update('ai', 'interviewMode', e.target.value)}
            >
              <option value="general">General — assessments, screen help, mixed (Default)</option>
              <option value="behavioural">Behavioural — "tell me about yourself", STAR stories</option>
              <option value="leetcode">LeetCode / Coding Interview</option>
              <option value="system_design">System Design Interview</option>
              <option value="code_modification">Code Modification / Review</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">OpenAI Model</label>
            <select
              className="settings-select"
              value={settings.ai.openaiModel}
              onChange={e => update('ai', 'openaiModel', e.target.value)}
            >
              <option value="gpt-6.1-sol">GPT-6.1 Sol (Latest Balanced)</option>
              <option value="gpt-6-astra">GPT-6 Astra (Best Quality, Reasoning)</option>
              <option value="gpt-6-sol">GPT-6 Sol (Balanced)</option>
              <option value="gpt-6-luna">GPT-6 Luna (Fast, Cheapest)</option>
              <option value="gpt-5">GPT-5</option>
              <option value="gpt-5-mini">GPT-5 Mini</option>
              <option value="gpt-5-nano">GPT-5 Nano</option>
              <option value="gpt-4.1">GPT-4.1</option>
              <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="o3">o3 (Reasoning)</option>
              <option value="o3-mini">o3 Mini (Reasoning, Fast)</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">Anthropic Model</label>
            <select
              className="settings-select"
              value={settings.ai.anthropicModel}
              onChange={e => update('ai', 'anthropicModel', e.target.value)}
            >
              <option value="claude-opus-5-5">Claude Opus 5.5 (Latest, Best Quality)</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (Latest, Balanced)</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5 (Latest, Fast)</option>
              <option value="claude-fable-5-1">Claude Fable 5.1 (Latest, Creative)</option>
              <option value="claude-sonnet-4-5-20250929">Claude Sonnet 4.5</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
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
        </div>

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

        <div className="settings-section">
          <div className="settings-section-title">Screen Capture</div>
          <div className="settings-field">
            <label className="settings-label">OCR Interval (seconds)</label>
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

        <div className="settings-section">
          <div className="settings-section-title">Overlay</div>
          <div className="settings-field">
            <label className="settings-label">Opacity ({Math.round(settings.overlay.opacity * 100)}%)</label>
            <input
              type="range"
              min={10}
              max={100}
              value={settings.overlay.opacity * 100}
              onChange={e => {
                const val = parseInt(e.target.value) / 100;
                update('overlay', 'opacity', val);
                api.setOpacity(val);
              }}
              style={{ width: '100%' }}
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

        <div className="settings-section">
          <div className="settings-section-title">My Profile</div>
          {uploadError && (
            <div style={{ color: '#ff6b6b', fontSize: '11px', marginBottom: '8px' }}>{uploadError}</div>
          )}
          <div className="settings-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <label className="settings-label" style={{ margin: 0 }}>Resume / Background</label>
              <button
                className="settings-select"
                style={{ width: 'auto', padding: '2px 10px', fontSize: '11px', cursor: 'pointer' }}
                onClick={() => handleFileUpload('resume')}
                disabled={resumeUploading}
              >
                {resumeUploading ? 'Reading…' : 'Upload File'}
              </button>
            </div>
            {resumeFileName && (
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginBottom: '4px' }}>
                {resumeFileName} ({settings.resume.length.toLocaleString()} chars)
              </div>
            )}
            <textarea
              className="settings-input"
              rows={6}
              value={settings.resume}
              onChange={e => { updateField('resume', e.target.value); if (!e.target.value) setResumeFileName(null); }}
              placeholder="Paste your resume here or click Upload File (.txt, .md, .pdf, .docx). This will be used as context so the AI can answer questions about you."
              style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '11px', lineHeight: 1.5 }}
            />
          </div>
          <div className="settings-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <label className="settings-label" style={{ margin: 0 }}>Job Description</label>
              <button
                className="settings-select"
                style={{ width: 'auto', padding: '2px 10px', fontSize: '11px', cursor: 'pointer' }}
                onClick={() => handleFileUpload('jobDescription')}
                disabled={jdUploading}
              >
                {jdUploading ? 'Reading…' : 'Upload File'}
              </button>
            </div>
            {jdFileName && (
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginBottom: '4px' }}>
                {jdFileName} ({settings.jobDescription.length.toLocaleString()} chars)
              </div>
            )}
            <textarea
              className="settings-input"
              rows={6}
              value={settings.jobDescription}
              onChange={e => { updateField('jobDescription', e.target.value); if (!e.target.value) setJdFileName(null); }}
              placeholder="Paste the job description here or click Upload File (.txt, .md, .pdf, .docx). Responses will be tailored to align your experience with this role."
              style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '11px', lineHeight: 1.5 }}
            />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Hotkeys</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
            <div>Ctrl+H — Hide app</div>
            <div>Ctrl+Shift+H — Toggle overlay</div>
            <div>Ctrl+Shift+A — Ask AI</div>
            <div>Ctrl+Shift+S — Capture screen</div>
            <div>Ctrl+Shift+R — Toggle recording</div>
            <div>Ctrl+Shift+I — Toggle interact mode</div>
            <div>Ctrl+Shift+N — Reset / New conversation</div>
            <div>Ctrl+Shift+Up/Down — Scroll content</div>
            <div>Ctrl+Shift+Q — Quit app</div>
            <div>Ctrl+Shift+W — Toggle typing mode</div>
            <div>Ctrl+Alt+Arrows — Move window</div>
            <div>Escape — Cancel AI stream / Exit typing</div>
          </div>
        </div>

        <div className="settings-footer">
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
