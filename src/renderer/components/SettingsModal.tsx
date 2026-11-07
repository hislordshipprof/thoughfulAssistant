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
              <option value="openai">OpenAI (GPT-5)</option>
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
              <option value="general">General (Default)</option>
              <option value="leetcode">LeetCode / Coding Interview</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label">OpenAI Model</label>
            <select
              className="settings-select"
              value={settings.ai.openaiModel}
              onChange={e => update('ai', 'openaiModel', e.target.value)}
            >
              <option value="gpt-5">GPT-5 (Latest, Best Quality)</option>
              <option value="gpt-5-mini">GPT-5 Mini (Latest, Fast)</option>
              <option value="gpt-5-nano">GPT-5 Nano (Latest, Fastest)</option>
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
          <div className="settings-field">
            <label className="settings-label">Resume / Background</label>
            <textarea
              className="settings-input"
              rows={6}
              value={settings.resume}
              onChange={e => updateField('resume', e.target.value)}
              placeholder="Paste your resume or background info here. This will be used as context so the AI can answer questions about you."
              style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '11px', lineHeight: 1.5 }}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Job Description</label>
            <textarea
              className="settings-input"
              rows={6}
              value={settings.jobDescription}
              onChange={e => updateField('jobDescription', e.target.value)}
              placeholder="Paste the job description here. Responses will be tailored to align your experience with this role."
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
