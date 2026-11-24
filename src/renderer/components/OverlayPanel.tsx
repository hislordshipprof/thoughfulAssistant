import React, { useEffect, useState } from 'react';
import AiResponseView from './AiResponseView';
import TranscriptView from './TranscriptView';
import StatusBar from './StatusBar';
import type { ShortcutBinding, WindowState } from '../../shared/controls';
import type { AudioState, ScreenState } from '../../shared/media';

interface OverlayPanelProps {
  response: string;
  isStreaming: boolean;
  error: string | null;
  transcriptEntries: any[];
  isRecording: boolean;
  audioState: AudioState;
  audioLevels: { mic: number; system: number };
  audioError: string | null;
  screenState: ScreenState;
  aiProvider: string | null;
  windowState: WindowState | null;
  hotkeys: Record<string, ShortcutBinding>;
  shortcutFailures: string[];
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onHide: () => void;
  onTogglePassthrough: () => void;
  onSendChat: () => void;
  onExitTyping: () => void;
  onCancel: () => void;
  isPassthrough: boolean;
  isTypingMode: boolean;
  screenshots: string[];
  extraContext: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
  onSettingsClick: () => void;
  onToggleRecording: () => void;
  onAskAi: () => void;
  onCaptureScreen: () => void;
  onRemoveScreenshot: (index: number) => void;
  onClearScreenshots: () => void;
  onExtraContextChange: (text: string) => void;
}

type Tab = 'ai' | 'transcript';

const OverlayPanel: React.FC<OverlayPanelProps> = ({
  response,
  isStreaming,
  error,
  transcriptEntries,
  isRecording,
  audioState, audioLevels, audioError, screenState,
  aiProvider,
  windowState, hotkeys, shortcutFailures, inputRef,
  onHide, onTogglePassthrough, onSendChat, onExitTyping, onCancel,
  isPassthrough,
  isTypingMode,
  screenshots,
  extraContext,
  scrollRef,
  onSettingsClick,
  onToggleRecording,
  onAskAi,
  onCaptureScreen,
  onRemoveScreenshot,
  onClearScreenshots,
  onExtraContextChange
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('ai');
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  useEffect(() => {
    if (isStreaming) setActiveTab('ai');
  }, [isStreaming]);

  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateElapsed = () => setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  const recordingTime = `${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`;
  const privacyLabel = windowState?.contentProtection === 'requested'
    ? 'Capture protection requested · limited'
    : windowState?.contentProtection === 'off' ? 'Capture protection off' : 'Capture protection unavailable';

  return (
    <div className="overlay-panel">
      <div className="overlay-header">
        <div className="assist-brand" title="Drag to move">
          <span className="assist-drag-handle" aria-hidden="true">••</span>
          <span className="overlay-header-title">Assist</span>
          <span className={`recording-pill ${isRecording ? 'is-recording' : audioState.isStarting ? 'is-starting' : ''}`}>
            <span className="recording-dot" aria-hidden="true" />
            {audioState.isStarting ? 'Starting' : isRecording ? `Listening ${recordingTime}` : 'Ready'}
          </span>
        </div>
        <div className="overlay-header-controls">
          <button
            type="button"
            className={`overlay-header-btn ${isRecording ? 'btn-active-red' : ''}`}
            onClick={onToggleRecording}
            aria-pressed={isRecording}
            aria-label="Toggle recording"
            title={`${audioState.isStarting ? 'Cancel starting' : isRecording ? 'Stop recording' : 'Start recording'} (${hotkeys.toggleRecording.label})`}
          >
            {audioState.isStarting ? '…' : isRecording ? '■' : '●'}
          </button>
          <button
            type="button"
            className="overlay-header-btn"
            onClick={onCaptureScreen}
            disabled={screenState.busy}
            aria-label="Capture screen"
            title={`Capture screen (${hotkeys.captureScreen.label})`}
          >
            {'▣'}
          </button>
          <button
            type="button"
            className="overlay-header-btn"
            onClick={onAskAi}
            disabled={screenState.busy}
            aria-label="Get answer from screen"
            title={`Get answer from screen (${hotkeys.askAi.label})`}
          >
            {'✦'}
          </button>
          <button type="button" className="overlay-header-btn" onClick={onTogglePassthrough}
            aria-label="Enable click-through" title={`Click-through (${hotkeys.toggleInteract.label} to restore)`}>◇</button>
          <button
            type="button"
            className="overlay-header-btn"
            onClick={onSettingsClick}
            title="Settings"
            aria-label="Settings"
          >
            {'···'}
          </button>
          <button type="button" className="overlay-header-btn" onClick={onHide} aria-label="Hide overlay"
            title={`Hide overlay — session continues (${hotkeys.toggleOverlay.label})`}>×</button>
        </div>
      </div>

      <div className="assist-context-row">
        <div className="privacy-notice" role="status" title={windowState?.protectionNote || privacyLabel}>
          <span aria-hidden="true">◈</span> {privacyLabel}
        </div>
        <div className="provider-chip" title="Current answer provider">{aiProvider || 'No AI provider'}</div>
        {shortcutFailures.length > 0 && <button type="button" className="shortcut-warning" onClick={onSettingsClick}>
          {shortcutFailures.length} shortcut issue{shortcutFailures.length === 1 ? '' : 's'}
        </button>}
      </div>

      {(audioState.isStarting || isRecording || audioError) && <div className="audio-panel" role="status">
        {audioError ? <div className="audio-error">{audioError} <button type="button" onClick={onSettingsClick}>Audio settings</button></div>
          : audioState.isStarting ? <span>Starting audio… Allow macOS permission prompts. Press Record again to cancel.</span>
          : <><span className="audio-panel-title">Live audio</span>
            {audioState.microphone && <label>Mic <meter aria-label="Microphone input level" min={0} max={1} value={audioLevels.mic} /></label>}
            {audioState.systemAudio && <label>System <meter aria-label="System audio input level" min={0} max={1} value={audioLevels.system} /></label>}
            <button type="button" onClick={onToggleRecording}>Stop</button></>}
      </div>}
      {screenState.message && <div className="screen-notice" role="status">{screenState.message}</div>}

      {screenshots.length > 0 && <div className="screenshot-strip" aria-label="Attached screen captures">
        <div className="screenshot-strip-header">
          <span className="screenshot-count"><span aria-hidden="true">▣</span> Viewed screen · {screenshots.length}</span>
          <button type="button" className="screenshot-clear-all" onClick={onClearScreenshots} title="Clear all captures">Clear</button>
        </div>
        <div className="screenshot-thumbnails">
          {screenshots.map((url, i) => <div key={i} className="screenshot-thumb">
            <img src={url} alt={`Screen capture ${i + 1}`} />
            <button type="button" className="screenshot-thumb-remove" onClick={() => onRemoveScreenshot(i)}
              aria-label={`Remove screen capture ${i + 1}`} title="Remove">×</button>
            <span className="screenshot-thumb-number">{i + 1}</span>
          </div>)}
        </div>
      </div>}

      <div className="overlay-tabs" role="tablist" aria-label="Assistant content">
        <button
          id="assist-tab"
          type="button"
          className={`overlay-tab ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
          role="tab"
          aria-selected={activeTab === 'ai'}
          aria-controls="assist-tab-panel"
        >
          Assist
        </button>
        <button
          id="transcript-tab"
          type="button"
          className={`overlay-tab ${activeTab === 'transcript' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcript')}
          role="tab"
          aria-selected={activeTab === 'transcript'}
          aria-controls="assist-tab-panel"
        >
          Transcript {transcriptEntries.length > 0 ? `(${transcriptEntries.length})` : ''}
        </button>
      </div>

      <div id="assist-tab-panel" className="tab-content" ref={scrollRef} role="tabpanel"
        aria-labelledby={activeTab === 'ai' ? 'assist-tab' : 'transcript-tab'}>
        {activeTab === 'ai' ? (
          <div className="assist-answer-surface">
            <div className="assist-answer-heading">
              <div>
                <span className="assist-answer-eyebrow">AI response</span>
                <h1>What should I say?</h1>
              </div>
              {isStreaming && <span className="thinking-pill"><span /> Thinking</span>}
            </div>
            <AiResponseView response={response} isStreaming={isStreaming} error={error}
              askShortcut={hotkeys.askAi.label} />
          </div>
        ) : (
          <TranscriptView entries={transcriptEntries} />
        )}
      </div>

      <div className="extra-context">
        {isTypingMode && (
          <div className="typing-mode-header">
            <span className="typing-mode-badge">TYPING</span>
            <span className="typing-mode-hint">Esc to exit</span>
          </div>
        )}
        <div className={`composer-shell${isTypingMode ? ' is-active' : ''}`}>
          <textarea
            ref={inputRef}
            aria-label="Question or extra context"
            className={`extra-context-input${isTypingMode ? ' extra-context-active' : ''}`}
            value={extraContext}
            onChange={e => onExtraContextChange(e.target.value)}
            placeholder={`Ask a question, or ${hotkeys.chat.label}`}
            rows={2}
            onMouseDown={() => {
              void window.electronAPI.setFocusable(true).then(() => inputRef.current?.focus());
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); onExitTyping(); onCancel(); }
            }}
          />
          <div className="chat-controls">
            <div className="composer-modes"><span className="smart-pill">✦ Smart</span><span>{hotkeys.askAi.label} screen</span></div>
            <div className="composer-actions">
              {(isStreaming || screenState.busy) && <button type="button" className="composer-stop" onClick={onCancel}>Stop</button>}
              <button type="button" className="composer-send" onClick={onSendChat}
                disabled={!extraContext.trim() || screenState.busy} aria-label="Send question">↑</button>
            </div>
          </div>
        </div>
      </div>

      <StatusBar
        isRecording={isRecording}
        audioState={audioState}
        isStreaming={isStreaming}
        aiProvider={aiProvider}
        windowState={windowState}
        isPassthrough={isPassthrough}
      />
    </div>
  );
};

export default OverlayPanel;
