import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#818cf8',
    primaryTextColor: '#e4e4e7',
    primaryBorderColor: '#6366f1',
    lineColor: '#818cf8',
    secondaryColor: '#1e1b4b',
    tertiaryColor: 'rgba(255,255,255,0.05)',
    fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    fontSize: '14px'
  },
  flowchart: { htmlLabels: true, useMaxWidth: false, curve: 'basis', nodeSpacing: 30, rankSpacing: 50 },
  securityLevel: 'strict'
});

const codeTheme = {
  ...oneDark,
  'comment': { ...oneDark['comment'], color: 'rgba(255, 255, 255, 0.55)' },
  'prolog': { ...oneDark['prolog'], color: 'rgba(255, 255, 255, 0.55)' },
};

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
    <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? 'Copied!' : (label || 'Copy')}
    </button>
  );
};

let mermaidCounter = 0;

const MermaidDiagram: React.FC<{ chart: string }> = ({ chart }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Date.now()}-${mermaidCounter++}`;
    mermaid.render(id, chart)
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) setSvg(renderedSvg);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to render diagram');
      });
    return () => { cancelled = true; };
  }, [chart]);

  if (error) {
    return (
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 1 }}>
          <CopyButton text={chart} />
        </div>
        <SyntaxHighlighter
          style={codeTheme as any}
          language="text"
          PreTag="div"
          customStyle={{ margin: '8px 0', padding: '10px', borderRadius: '6px', fontSize: '12px', background: 'rgba(0,0,0,0.4)' }}
        >
          {chart}
        </SyntaxHighlighter>
      </div>
    );
  }

  if (!svg) return <div style={{ padding: '12px', color: 'rgba(255,255,255,0.35)' }}>Rendering diagram...</div>;

  return (
    <div style={{ position: 'relative', margin: '8px 0', padding: '12px', borderRadius: '6px', background: 'rgba(0,0,0,0.3)', overflow: 'auto' }}>
      <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 1 }}>
        <CopyButton text={chart} label="Copy" />
      </div>
      <div ref={containerRef} className="mermaid-svg-container" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
};

const SECTION_HEADING_RE = /^\[([A-Z][A-Z\s]*)\]$/;

const AiResponseView: React.FC<AiResponseViewProps> = ({ response, isStreaming, error }) => {

  if (error) {
    return (
      <div className="ai-response-error">
        Error: {error}
      </div>
    );
  }

  if (!response && !isStreaming) {
    return (
      <div className="ai-response-empty">
        Press Ctrl+Shift+A to ask AI, or wait for auto-analysis.
      </div>
    );
  }

  // Memoised markdown components — recreated only when streaming state flips.
  // Without useMemo, a new components object is created on every render, which
  // defeats ReactMarkdown's internal bail-out and forces full re-parse + Prism
  // tokenisation on every token. Keying on isStreaming means: one stable
  // identity during streaming (cheap plain-pre code blocks), then ONE swap
  // at end-of-stream to the full Prism+Mermaid render.
  const markdownComponents = useMemo(() => ({
    p({ children, ...props }: any) {
      const childArray = React.Children.toArray(children);
      const first = childArray[0];
      if (typeof first === 'string') {
        const headingMatch = SECTION_HEADING_RE.exec(first.trim());
        if (headingMatch) {
          if (childArray.length === 1) {
            return <div className="ai-section-heading">{headingMatch[1]}</div>;
          }
          const rest = childArray.slice(1);
          const skipBr = rest.length > 0 && React.isValidElement(rest[0]) && (rest[0] as any).type === 'br';
          const remaining = skipBr ? rest.slice(1) : rest;
          return (
            <>
              <div className="ai-section-heading">{headingMatch[1]}</div>
              {remaining.length > 0 && <p {...props}>{remaining}</p>}
            </>
          );
        }
      }
      return <p {...props}>{children}</p>;
    },
    code({ node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const inline = !match;
      const codeText = String(children).replace(/\n$/, '');

      // During streaming: render code blocks as plain monospace <pre>.
      // Skips Prism tokenisation (~20-50ms per block) on every token update,
      // which is the single biggest CPU cost during a streaming response.
      // The full Prism+Mermaid render fires once at end-of-stream when
      // isStreaming flips false and useMemo rebuilds this components object.
      if (isStreaming && match) {
        return (
          <pre style={{
            margin: '8px 0',
            padding: '10px',
            borderRadius: '6px',
            fontSize: '12px',
            background: 'rgba(0,0,0,0.4)',
            color: '#e0e0e0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
            overflow: 'auto',
          }}>{codeText}</pre>
        );
      }

      // Non-streaming: full render with Prism highlighting + Mermaid diagrams
      if (match && match[1] === 'mermaid') {
        return <MermaidDiagram chart={codeText} />;
      }
      return !inline ? (
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 1 }}>
            <CopyButton text={codeText} />
          </div>
          <SyntaxHighlighter
            style={codeTheme as any}
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
  }), [isStreaming]);

  return (
    <div className="ai-response">
      {response && !isStreaming && (
        <div className="ai-response-copy-row">
          <CopyButton text={response} label="Copy All" />
        </div>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {response}
      </ReactMarkdown>
      {isStreaming && <span className="ai-cursor" />}
    </div>
  );
};

export default AiResponseView;
