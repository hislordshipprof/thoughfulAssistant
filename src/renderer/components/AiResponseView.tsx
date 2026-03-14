import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface AiResponseViewProps {
  response: string;
  isStreaming: boolean;
  error: string | null;
}

const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    (window as any).electronAPI?.copyToClipboard?.(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className="copy-btn"
      onClick={handleCopy}
      title="Copy to clipboard"
    >
      {copied ? 'Copied!' : (label || 'Copy')}
    </button>
  );
};

const AiResponseView: React.FC<AiResponseViewProps> = ({ response, isStreaming, error }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [response]);

  if (error) {
    return (
      <div className="ai-response" style={{ color: '#ef4444', padding: '12px' }}>
        Error: {error}
      </div>
    );
  }

  if (!response && !isStreaming) {
    return (
      <div className="ai-response" style={{ color: 'rgba(255,255,255,0.3)', padding: '12px', textAlign: 'center' }}>
        Press Ctrl+Shift+A to ask AI, or wait for auto-analysis.
      </div>
    );
  }

  return (
    <div className="ai-response" ref={scrollRef}>
      {response && !isStreaming && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
          <CopyButton text={response} label="Copy All" />
        </div>
      )}
      <ReactMarkdown
        components={{
          code({ node, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const inline = !match;
            const codeText = String(children).replace(/\n$/, '');
            return !inline ? (
              <div style={{ position: 'relative' }}>
                <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 1 }}>
                  <CopyButton text={codeText} />
                </div>
                <SyntaxHighlighter
                  style={oneDark as any}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    margin: '8px 0',
                    padding: '10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    background: 'rgba(0,0,0,0.4)'
                  }}
                >
                  {codeText}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
        }}
      >
        {response}
      </ReactMarkdown>
      {isStreaming && <span className="ai-cursor" />}
    </div>
  );
};

export default AiResponseView;
