import React from 'react';
import type { WindowState } from '../../shared/controls';
import type { AudioState } from '../../shared/media';

interface StatusBarProps {
  isRecording: boolean;
  audioState: AudioState;
  isStreaming: boolean;
  aiProvider: string | null;
  windowState: WindowState | null;
  isPassthrough: boolean;
}

const StatusBar: React.FC<StatusBarProps> = ({
  isRecording,
  audioState,
  isStreaming,
  aiProvider,
  windowState,
  isPassthrough
}) => {
  return (
    <div className="status-bar" title={windowState?.protectionNote}>
      <div className="status-indicator">
        <div className={`status-dot ${isStreaming || isRecording ? 'active' : 'inactive'}`} />
        <span className="status-label">
          {isStreaming ? 'Preparing answer' : audioState.isStarting ? 'Starting audio' : isRecording ? 'Listening for context' : 'Ready when you are'}
        </span>
      </div>
      <span className="status-spacer" />
      <span className="status-label">{aiProvider || 'No provider'}</span>
      {isPassthrough && <span className="status-mode-pill">Click-through</span>}
    </div>
  );
};

export default StatusBar;
