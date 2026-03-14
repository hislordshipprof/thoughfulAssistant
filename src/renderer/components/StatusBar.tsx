import React from 'react';

interface StatusBarProps {
  isRecording: boolean;
  isStreaming: boolean;
  aiProvider: string | null;
  isStealthActive: boolean;
  isPassthrough: boolean;
}

const StatusBar: React.FC<StatusBarProps> = ({
  isRecording,
  isStreaming,
  aiProvider,
  isStealthActive,
  isPassthrough
}) => {
  return (
    <div className="status-bar">
      <div className="status-indicator">
        <div className={`status-dot ${isRecording ? 'active' : 'inactive'}`} />
        <span className="status-label">{isRecording ? 'REC' : 'MIC OFF'}</span>
      </div>

      <div className="status-indicator">
        <div className={`status-dot ${isStealthActive ? 'active' : 'error'}`} />
        <span className="status-label">{isStealthActive ? 'STEALTH' : 'VISIBLE'}</span>
      </div>

      <div className="status-indicator">
        <div className={`status-dot ${isStreaming ? 'active' : 'inactive'}`} />
        <span className="status-label">{isStreaming ? 'AI...' : (aiProvider || 'NO AI')}</span>
      </div>

      {isPassthrough && (
        <div className="status-indicator">
          <div className="status-dot active" />
          <span className="status-label">PASSTHROUGH</span>
        </div>
      )}
    </div>
  );
};

export default StatusBar;
