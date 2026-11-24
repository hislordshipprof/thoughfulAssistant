import React, { useState, useEffect, useRef } from 'react';
import { useIpc } from '../hooks/useIpc';
import { controlNames, type ShortcutBinding } from '../../shared/controls';
import type { CaptureDisplay, ScreenPermissionState } from '../../shared/media';
import { GROQ_MODELS, groqSupportsImages } from '../../shared/groq';
import { getSystemPrompt, type SystemPromptMode } from '../../services/ai/prompt-templates';

const ANTHROPIC_MODELS = [
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001'
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  shortcutFailures: string[];
}

interface Settings {
  ai: {
    provider: string;
    groqKey: string;
    groqModel: string;
    openaiKey: string;
    anthropicKey: string;
    openaiModel: string;
    anthropicModel: string;
    ollamaUrl: string;
    ollamaModel: string;
    interviewMode: string;
    systemPromptMode: SystemPromptMode;
    customSystemPrompt: string;
  };
  audio: {
    transcriptionMode: string;
    deepgramKey: string;
    groqKey: string;
    googleSttKey: string;
    googleProjectId: string;
    captureMicrophone: boolean;
    captureSystemAudio: boolean;
    autoAnswer: boolean;
    speechLocale: string;
  };
  ocr: {
    intervalSeconds: number;
    autoCapture: boolean;
    displayId: string;
  };
  overlay: {
    opacity: number;
    width: number;
    height: number;
    captureProtection: boolean;
    hideDock: boolean;
  };
  hotkeys: Record<string, ShortcutBinding>;
  resume: string;
  jobDescription: string;
}

interface OllamaStatus {
  connected: boolean;
  version?: string;
  models: Array<{
    name: string;
    model: string;
    size: number;
    details?: { family?: string; parameterSize?: string; quantizationLevel?: string; contextLength?: number };
  }>;
  error?: string;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, shortcutFailures }) => {
  const api = useIpc();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [loadingOllama, setLoadingOllama] = useState(false);
  const [displays, setDisplays] = useState<CaptureDisplay[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [screenPermission, setScreenPermission] = useState<ScreenPermissionState | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const permissionRevision = useRef(0);

  useEffect(() => {
    const revision = ++permissionRevision.current;
    if (!isOpen || api.platform !== 'darwin') return;
    setPermissionBusy(false);
    setPermissionError(null);
    const refresh = () => { void api.getScreenPermission().then(value => {
      if (permissionRevision.current === revision) setScreenPermission(value);
    }).catch(() => {
      if (permissionRevision.current === revision) setPermissionError('Could not read screen permission status.');
    }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { permissionRevision.current++; window.removeEventListener('focus', refresh); };
  }, [isOpen, api]);

  useEffect(() => {
    if (isOpen) {
      setSaveError(null);
      void api.listDisplays().then(setDisplays).catch(() => setDisplays([]));
      api.getConfig().then((config: Settings) => {
        setSettings(config);
        setLoadingOllama(true);
        api.getOllamaStatus(config.ai.ollamaUrl)
          .then(setOllamaStatus)
          .finally(() => setLoadingOllama(false));
      });
      // Enable keyboard focus so user can type in input fields
      (window as any).electronAPI?.setFocusable?.(true);
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

  const refreshOllama = async () => {
    if (!settings) return;
    setLoadingOllama(true);
    try {
      setOllamaStatus(await api.getOllamaStatus(settings.ai.ollamaUrl));
    } finally {
      setLoadingOllama(false);
    }
  };

  const permissionAction = async (action: 'request' | 'settings' | 'restart') => {
    const revision = permissionRevision.current;
    setPermissionBusy(true); setPermissionError(null);
    try {
      if (action === 'request') {
        const value = await api.requestScreenPermission();
        if (revision === permissionRevision.current) setScreenPermission(value);
      } else if (action === 'settings') await api.openScreenPermissionSettings();
      else await api.restartForPermissions();
    } catch {
      if (revision === permissionRevision.current) setPermissionError('Could not complete the permission action. Open macOS Privacy & Security settings manually.');
    } finally {
      if (revision === permissionRevision.current) setPermissionBusy(false);
    }
  };

  const save = async () => {
    if (!settings) return;
    if (settings.ai.systemPromptMode !== 'default' && !settings.ai.customSystemPrompt.trim()) {
      setSaveError('Enter a custom system prompt or switch Prompt behavior to Built-in.');
      return;
    }
    setSaving(true);
    setSaveError(null);
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
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const mode = settings.audio.transcriptionMode;
  const needsDeepgramKey = mode === 'deepgram';
  const needsGroqKey = mode === 'groq-whisper';
  const needsGoogleKey = mode === 'google-stt';
  const customPromptRequired = settings.ai.systemPromptMode !== 'default' && !settings.ai.customSystemPrompt.trim();
  const promptPreview = getSystemPrompt(
    settings.ai.interviewMode,
    settings.resume,
    settings.jobDescription,
    settings.ai.customSystemPrompt,
    settings.ai.systemPromptMode
  );

  return (
    <div className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings"
        onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
        <div className="settings-topbar">
          <div>
            <div className="settings-kicker">InterviewOverlay</div>
            <div className="settings-title">Settings{screenPermission ? ` · v${screenPermission.appVersion}` : ''}</div>
          </div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">×</button>
        </div>

        {api.platform === 'darwin' && <div className="settings-section" aria-label="Screen Capture Permission">
          <div className="settings-section-title">Screen Capture</div>
          <p className="privacy-explanation" role="status" data-testid="screen-permission-status">
            {screenPermission?.status === 'granted' ? 'Screen recording access is approved for this app session.'
              : screenPermission?.status === 'restricted' ? 'Screen recording is restricted by macOS or device management.'
              : 'Screen recording access needs approval, or the app needs restarting after approval.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            <button type="button" className="settings-btn settings-btn-secondary" onClick={() => void permissionAction('request')}
              disabled={permissionBusy || screenPermission?.status === 'restricted'}>Request screen access</button>
            <button type="button" className="settings-btn settings-btn-secondary" onClick={() => void permissionAction('settings')}
              disabled={permissionBusy}>Open macOS Settings</button>
            <button type="button" className="settings-btn settings-btn-secondary" onClick={() => void permissionAction('restart')}
              disabled={permissionBusy}>Restart app</button>
          </div>
          <p className="privacy-explanation">Request access, enable InterviewOverlay under Screen &amp; System Audio Recording, then restart.
            The permission request does not collect screenshots or send anything to AI. Save any settings changes before restarting.</p>
          {permissionError && <p role="alert" className="privacy-explanation">{permissionError}</p>}
        </div>}

        <div className="settings-section">
          <div className="settings-section-title">AI Provider</div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="ai-provider">Provider</label>
            <select
              id="ai-provider"
              className="settings-select"
              value={settings.ai.provider}
              onChange={e => update('ai', 'provider', e.target.value)}
            >
              <option value="openai">OpenAI (GPT-4o)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="ollama">Ollama (Local / Cloud)</option>
              <option value="groq">Groq (Cloud)</option>
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
          {settings.ai.provider === 'openai' && (
            <>
              <div className="settings-field">
                <label className="settings-label">OpenAI Model</label>
                <select
                  className="settings-select"
                  value={settings.ai.openaiModel}
                  onChange={e => update('ai', 'openaiModel', e.target.value)}
                >
                  <option value="gpt-4o">GPT-4o (Best Quality)</option>
                  <option value="gpt-4o-mini">GPT-4o Mini (Fast)</option>
                  <option value="gpt-4.1">GPT-4.1 (Latest)</option>
                  <option value="gpt-4.1-mini">GPT-4.1 Mini (Latest Fast)</option>
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
            </>
          )}

          {settings.ai.provider === 'anthropic' && (
            <>
              <div className="settings-field">
                <label className="settings-label" htmlFor="anthropic-model">Anthropic Model</label>
                <input
                  id="anthropic-model"
                  className="settings-input"
                  type="text"
                  list="anthropic-model-list"
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.ai.anthropicModel}
                  aria-describedby="anthropic-model-help"
                  onChange={e => update('ai', 'anthropicModel', e.target.value)}
                  placeholder="claude-sonnet-4-5-20250929"
                />
                <datalist id="anthropic-model-list">
                  {ANTHROPIC_MODELS.map(model => <option key={model} value={model} />)}
                </datalist>
                <p id="anthropic-model-help" style={{ fontSize: '11px', color: '#aaa' }}>
                  Choose a suggestion or enter a Claude model ID available to your Anthropic account.
                </p>
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
            </>
          )}

          {settings.ai.provider === 'groq' && (
            <>
              <div className="settings-field">
                <label className="settings-label" htmlFor="groq-answer-key">Groq answer API key</label>
                <input id="groq-answer-key" className="settings-input" type="password"
                  autoComplete="off" spellCheck={false} value={settings.ai.groqKey}
                  onChange={e => update('ai', 'groqKey', e.target.value)} placeholder="gsk_..." />
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="groq-answer-model">Groq answer model</label>
                <input id="groq-answer-model" className="settings-input" type="text"
                  list="groq-model-list" autoComplete="off" spellCheck={false}
                  value={settings.ai.groqModel} aria-describedby="groq-model-help"
                  onChange={e => update('ai', 'groqModel', e.target.value)} placeholder="openai/gpt-oss-120b" />
                <datalist id="groq-model-list">
                  {GROQ_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                </datalist>
                <p id="groq-model-help" style={{ fontSize: '11px', color: '#aaa' }}>
                  Choose a suggestion or enter a Groq chat model ID available to your account.
                  {' '}{groqSupportsImages(settings.ai.groqModel)
                    ? 'This model receives captured screen images. Vision models are preview / access-dependent.'
                    : 'Screen questions use locally extracted text (OCR); images and diagrams are not sent.'}
                </p>
              </div>
              <p style={{ fontSize: '11px', color: '#aaa' }}>
                Groq runs in the cloud, not in local Ollama. Submitted questions, conversation context,
                transcripts, and included screen context are sent to Groq. This answer key is separate
                from the optional Groq Whisper transcription key below. Obtain a key from console.groq.com/keys.
              </p>
            </>
          )}

          {settings.ai.provider === 'ollama' && (
            <>
              <div className="settings-field">
                <label className="settings-label">Ollama URL</label>
                <input
                  className="settings-input"
                  type="text"
                  value={settings.ai.ollamaUrl}
                  onChange={e => update('ai', 'ollamaUrl', e.target.value)}
                  placeholder="http://127.0.0.1:11434"
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Model</label>
                <input
                  className="settings-input"
                  type="text"
                  list="ollama-model-list"
                  value={settings.ai.ollamaModel}
                  onChange={e => update('ai', 'ollamaModel', e.target.value)}
                  placeholder="e.g. llama3.2:1b or glm-4.7:cloud"
                />
                <datalist id="ollama-model-list">
                  {(ollamaStatus?.models || []).map(model => (
                    <option key={model.name} value={model.name}>
                      {model.name.includes('cloud') ? 'Cloud' : (model.details?.parameterSize || 'Local')}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="settings-field">
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  onClick={refreshOllama}
                  disabled={loadingOllama}
                >
                  {loadingOllama ? 'Checking Ollama…' : 'Refresh Models'}
                </button>
                <div style={{ marginTop: '6px', fontSize: '11px', color: ollamaStatus?.connected ? '#4ade80' : '#f87171' }}>
                  {ollamaStatus?.connected
                    ? `Connected to Ollama ${ollamaStatus.version || ''} · ${ollamaStatus.models.length} model${ollamaStatus.models.length === 1 ? '' : 's'}`
                    : (ollamaStatus?.error || 'Ollama connection not checked')}
                </div>
                <div style={{ marginTop: '4px', fontSize: '11px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                  {settings.ai.ollamaModel.includes('cloud')
                    ? 'Cloud model: prompts and context are sent through your signed-in Ollama account.'
                    : 'Local model: inference stays on this Mac.'}
                  {' '}Cloud models appear after running <code>ollama signin</code> and <code>ollama pull model:cloud</code>.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="settings-section" aria-labelledby="instructions-title">
          <div className="settings-section-heading">
            <div>
              <div className="settings-section-title" id="instructions-title">Instructions</div>
              <p className="settings-section-copy">Control how every provider answers typed, screen, and audio questions.</p>
            </div>
            <span className="settings-feature-badge">System</span>
          </div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="system-prompt-mode">Prompt behavior</label>
            <select id="system-prompt-mode" className="settings-select"
              value={settings.ai.systemPromptMode}
              onChange={event => update('ai', 'systemPromptMode', event.target.value)}>
              <option value="default">Built-in prompt</option>
              <option value="append">Built-in + custom instructions</option>
              <option value="replace">Replace with my prompt</option>
            </select>
            <p className="privacy-explanation">
              {settings.ai.systemPromptMode === 'replace'
                ? 'Replace sends only your custom prompt. Resume, job description, and built-in interview guidance are excluded.'
                : settings.ai.systemPromptMode === 'append'
                  ? 'Custom instructions are added after the built-in prompt and profile context.'
                  : 'Uses the existing General or LeetCode prompt with your resume and job description.'}
            </p>
          </div>
          <div className="settings-field">
            <div className="settings-label-row">
              <label className="settings-label" htmlFor="custom-system-prompt">Custom system prompt</label>
              <span className="settings-character-count">{settings.ai.customSystemPrompt.length.toLocaleString()} / 30,000</span>
            </div>
            <textarea id="custom-system-prompt" className="settings-input system-prompt-input"
              rows={8} maxLength={30000} value={settings.ai.customSystemPrompt}
              aria-describedby="custom-system-prompt-help"
              onChange={event => update('ai', 'customSystemPrompt', event.target.value)}
              placeholder="Example: Answer in short, natural first-person talking points. Put the recommended response first." />
            <div className="settings-inline-actions">
              <p id="custom-system-prompt-help" className={customPromptRequired ? 'settings-validation-error' : 'privacy-explanation'}>
                {customPromptRequired ? 'A custom prompt is required for this behavior.' : 'This is stored locally with your other app settings.'}
              </p>
              <button type="button" className="settings-text-button"
                onClick={() => setSettings(previous => previous ? {
                  ...previous,
                  ai: { ...previous.ai, systemPromptMode: 'default', customSystemPrompt: '' }
                } : previous)}>
                Reset
              </button>
            </div>
          </div>
          <details className="prompt-preview">
            <summary>Preview final system prompt</summary>
            <pre>{promptPreview}</pre>
          </details>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Speech-to-Text</div>
          <div className="settings-field">
            <label><input type="checkbox" checked={settings.audio.captureMicrophone}
              onChange={event => update('audio', 'captureMicrophone', event.target.checked)} /> Microphone (your voice)</label>
          </div>
          <div className="settings-field">
            <label><input type="checkbox" checked={settings.audio.captureSystemAudio}
              onChange={event => update('audio', 'captureSystemAudio', event.target.checked)} /> System audio (calls / other apps)</label>
          </div>
          <div className="settings-field">
            <label><input type="checkbox" checked={settings.audio.autoAnswer}
              onChange={event => update('audio', 'autoAnswer', event.target.checked)} /> Auto-answer system audio</label>
            <p className="privacy-explanation">After about two seconds of silence, finalized system-audio speech is sent to the selected AI as transcript context. Microphone speech cancels a pending answer. This may use provider API quota.</p>
          </div>
          <p className="privacy-explanation">Press Record or {settings.hotkeys.toggleRecording.label} to start/stop. Source/provider changes apply to the next recording.
            On Mac, allow Microphone and Screen &amp; System Audio Recording in System Settings → Privacy &amp; Security. Capture is only active while recording is on.</p>
          <div className="settings-field">
            <label className="settings-label">Provider</label>
            <select
              className="settings-select"
              value={settings.audio.transcriptionMode}
              onChange={e => update('audio', 'transcriptionMode', e.target.value)}
            >
              {api.platform === 'darwin' && <option value="macos-speech">macOS on-device speech (no API key)</option>}
              <option value="deepgram">Deepgram Nova-2 (Best - Streaming)</option>
              <option value="groq-whisper">Groq Whisper (Fast Batch)</option>
              <option value="realtime">OpenAI Realtime API (Streaming)</option>
              <option value="whisper">OpenAI Whisper (Chunked)</option>
              <option value="google-stt">Google Speech-to-Text</option>
            </select>
          </div>

          {mode === 'macos-speech' ? <div className="settings-field">
            <label className="settings-label" htmlFor="speech-locale">Speech language</label>
            <input id="speech-locale" className="settings-input" value={settings.audio.speechLocale}
              placeholder="en-US" onChange={event => update('audio', 'speechLocale', event.target.value)} />
            <p className="privacy-explanation">Requires Speech Recognition permission and an available on-device language.
              Enable/download the matching Dictation language in macOS Keyboard settings if needed. No automatic cloud fallback. Ollama handles answers; macOS handles transcription.</p>
          </div> : <p className="privacy-explanation">Audio is sent to the selected speech provider and requires its API key, even when answers use local Ollama.</p>}

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
            <label className="settings-label" htmlFor="capture-display">Display to read</label>
            <select id="capture-display" className="settings-select" value={settings.ocr.displayId}
              onChange={event => update('ocr', 'displayId', event.target.value)}>
              <option value="cursor">Display under the mouse pointer</option>
              {displays.map(display => <option key={display.id} value={display.id}>{display.label}</option>)}
              {settings.ocr.displayId !== 'cursor' && !displays.some(display => display.id === settings.ocr.displayId) &&
                <option value={settings.ocr.displayId}>Selected display (disconnected)</option>}
            </select>
            <p className="privacy-explanation">{settings.hotkeys.askAi.label} captures the current screen and answers it. The overlay briefly hides during its own capture.
              Image-capable models receive screenshots; text-only models receive locally extracted text. Cloud models receive that screen context.</p>
          </div>
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
            <label><input type="checkbox" checked={settings.overlay.captureProtection}
              onChange={e => update('overlay', 'captureProtection', e.target.checked)} /> Request capture protection</label>
            <p className="privacy-explanation">Best effort only. macOS ScreenCaptureKit can still capture this window.
              Test your exact screen-sharing setup before relying on it. The app remains visible in Activity Monitor.</p>
          </div>
          {api.platform === 'darwin' && <div className="settings-field">
            <label><input type="checkbox" checked={settings.overlay.hideDock}
              onChange={e => update('overlay', 'hideDock', e.target.checked)} /> Hide Dock / app-switcher entry</label>
            <p className="privacy-explanation">The menu-bar icon stays available for Settings, Show / Hide and Quit.</p>
          </div>}
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
            {Object.entries(settings.hotkeys).map(([name, binding]) => (
              <div key={name} className={shortcutFailures.includes(name) ? 'shortcut-unavailable' : undefined}>
                {binding.label} — {controlNames[name] || name}
                {shortcutFailures.includes(name) ? ' (unavailable / conflict)' : ''}
              </div>
            ))}
            <div>Escape — Exit chat / stop answer while typing; close Settings</div>
            <p>Typing deliberately focuses the overlay. Global shortcuts work without focusing it.</p>
          </div>
        </div>

        <div className="settings-footer">
          {saveError && <div className="audio-error" role="alert">{saveError}</div>}
          <button className="settings-btn settings-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="settings-btn settings-btn-primary" onClick={save} disabled={saving || customPromptRequired}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
