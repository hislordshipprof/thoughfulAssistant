import React from 'react';

interface StatusBarProps {
  isRecording: boolean;
  isStreaming: boolean;
  aiProvider: string | null;
  isStealthActive: boolean;
  isPassthrough: boolean;
  onToggleStealth: () => void;
}

const StatusBar: React.FC<StatusBarProps> = ({
  isRecording,
  isStreaming,
  aiProvider,
  isStealthActive,
  isPassthrough,
  onToggleStealth
}) => {
  return (
    <div className="status-bar">
      <div className="status-indicator">
        <div className={`status-dot ${isRecording ? 'active' : 'inactive'}`} />
        <span className="status-label">{isRecording ? 'REC' : 'OFF'}</span>
      </div>

      <div className="status-separator" />

      <div className="status-indicator status-clickable" onClick={onToggleStealth} title="Toggle stealth mode">
        <div className={`status-dot ${isStealthActive ? 'active' : 'error'}`} />
        <span className="status-label">{isStealthActive ? 'STEALTH' : 'VISIBLE'}</span>
      </div>

      <div className="status-separator" />

      <div className="status-indicator">
        <div className={`status-dot ${isStreaming ? 'active' : 'inactive'}`} />
        <span className="status-label">{isStreaming ? 'AI...' : (aiProvider?.toUpperCase() || 'NO AI')}</span>
      </div>

      {isPassthrough && (
        <>
          <div className="status-separator" />
          <div className="status-indicator">
            <div className="status-dot active" />
            <span className="status-label">PASS</span>
          </div>
        </>
      )}
    </div>
  );
};

export default StatusBar;
