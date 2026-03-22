import React, { useState, useEffect } from 'react';
import AiResponseView from './AiResponseView';
import TranscriptView from './TranscriptView';
import StatusBar from './StatusBar';

interface OverlayPanelProps {
  response: string;
  isStreaming: boolean;
  error: string | null;
  transcriptEntries: any[];
  isRecording: boolean;
  aiProvider: string | null;
  isStealthActive: boolean;
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
  aiProvider,
  isStealthActive,
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

  // Auto-switch to AI tab when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setActiveTab('ai');
    }
  }, [isStreaming]);

  return (
    <div className="overlay-panel">
      {/* Screenshot strip — accumulated captures */}
      {screenshots.length > 0 && (
        <div className="screenshot-strip">
          <div className="screenshot-strip-header">
            <span className="screenshot-count">{screenshots.length} capture{screenshots.length > 1 ? 's' : ''}</span>
            <button className="screenshot-clear-all" onClick={onClearScreenshots} title="Clear all">
              Clear all
            </button>
          </div>
          <div className="screenshot-thumbnails">
            {screenshots.map((url, i) => (
              <div key={i} className="screenshot-thumb">
                <img src={url} alt={`Capture ${i + 1}`} />
                <button
                  className="screenshot-thumb-remove"
                  onClick={() => onRemoveScreenshot(i)}
                  title="Remove"
                >
                  {'\u2715'}
                </button>
                <span className="screenshot-thumb-number">{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draggable header */}
      <div className="overlay-header">
        <span className="overlay-header-title">Interview Assistant</span>
        <div className="overlay-header-controls">
          <button
            className={`overlay-header-btn ${isRecording ? 'btn-active-red' : ''}`}
            onClick={onToggleRecording}
            title={isRecording ? 'Stop Recording (Ctrl+Shift+R)' : 'Start Recording (Ctrl+Shift+R)'}
          >
            {isRecording ? '\u23F9' : '\u23FA'}
          </button>
          <button
            className="overlay-header-btn"
            onClick={onCaptureScreen}
            title="Capture Screen (Ctrl+Shift+S)"
          >
            {'\u2316'}
          </button>
          <button
            className="overlay-header-btn"
            onClick={onAskAi}
            title="Ask AI (Ctrl+Shift+A)"
          >
            {'\u2726'}
          </button>
          <button
            className="overlay-header-btn"
            onClick={onSettingsClick}
            title="Settings"
          >
            {'\u2699'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="overlay-tabs">
        <button
          className={`overlay-tab ${activeTab === 'ai' ? 'active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI Response
        </button>
        <button
          className={`overlay-tab ${activeTab === 'transcript' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcript')}
        >
          Transcript {transcriptEntries.length > 0 ? `(${transcriptEntries.length})` : ''}
        </button>
      </div>

      {/* Main content */}
      <div className="tab-content" ref={scrollRef}>
        {activeTab === 'ai' ? (
          <AiResponseView
            response={response}
            isStreaming={isStreaming}
            error={error}
          />
        ) : (
          <TranscriptView entries={transcriptEntries} />
        )}
      </div>

      {/* Extra context input */}
      <div className="extra-context">
        {isTypingMode && (
          <div className="typing-mode-header">
            <span className="typing-mode-badge">TYPING</span>
            <span className="typing-mode-hint">Esc to exit</span>
          </div>
        )}
        <textarea
          className={`extra-context-input${isTypingMode ? ' extra-context-active' : ''}`}
          value={extraContext}
          onChange={e => onExtraContextChange(e.target.value)}
          placeholder={isTypingMode ? 'Typing mode active — type anywhere...' : 'Ctrl+Shift+W to type here without losing focus...'}
          rows={2}
          onMouseDown={(e) => {
            (window as any).electronAPI?.setFocusable?.(true);
            setTimeout(() => (e.target as HTMLTextAreaElement).focus(), 50);
          }}
          onBlur={() => (window as any).electronAPI?.setFocusable?.(false)}
        />
      </div>

      {/* Status bar at bottom */}
      <StatusBar
        isRecording={isRecording}
        isStreaming={isStreaming}
        aiProvider={aiProvider}
        isStealthActive={isStealthActive}
        isPassthrough={isPassthrough}
      />
    </div>
  );
};

export default OverlayPanel;
