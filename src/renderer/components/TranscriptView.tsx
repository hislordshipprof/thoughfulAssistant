import React, { useEffect, useRef } from 'react';

interface TranscriptEntry {
  id: string;
  text: string;
  source: 'system' | 'mic';
  timestamp: number;
  isFinal: boolean;
}

interface TranscriptViewProps {
  entries: TranscriptEntry[];
}

const TranscriptView: React.FC<TranscriptViewProps> = ({ entries }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div style={{ color: 'rgba(255,255,255,0.3)', padding: '12px', textAlign: 'center' }}>
        Start recording to see the live transcript.
      </div>
    );
  }

  return (
    <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto' }}>
      {entries.map(entry => (
        <div key={entry.id} className={`transcript-entry ${entry.isFinal ? '' : 'transcript-partial'}`}>
          <span className={`transcript-source ${entry.source}`}>
            {entry.source === 'system' ? 'Interviewer' : 'You'}
          </span>
          <span className="transcript-time">
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <div className="transcript-text">{entry.text}</div>
        </div>
      ))}
    </div>
  );
};

export default TranscriptView;
