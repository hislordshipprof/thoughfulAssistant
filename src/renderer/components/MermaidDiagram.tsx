import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let initialized = false;
function initMermaid() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    fontFamily: 'inherit',
    themeVariables: {
      background: 'transparent',
      primaryColor: '#2a2a40',
      primaryTextColor: '#e5e7eb',
      primaryBorderColor: '#7c83ff',
      lineColor: '#9aa0ff',
      secondaryColor: '#1f1f33',
      tertiaryColor: '#161626'
    }
  });
  initialized = true;
}

let seq = 0;

interface Props {
  code: string;
  /** While the AI is still streaming, the mermaid source is often incomplete
   *  and won't parse — show the raw code until streaming finishes. */
  streaming?: boolean;
}

/** Renders a mermaid code block as an SVG diagram. Falls back to the raw
 *  source (in a <pre>) when the diagram can't be parsed — which is normal
 *  while the response is still streaming in. */
const MermaidDiagram: React.FC<Props> = ({ code, streaming }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${++seq}`);

  useEffect(() => {
    let cancelled = false;
    // Don't attempt to render partial diagrams mid-stream.
    if (streaming) { setSvg(null); setFailed(false); return; }

    initMermaid();
    const trimmed = code.trim();
    if (!trimmed) return;

    mermaid
      .render(idRef.current + '-' + (++seq), trimmed)
      .then(({ svg }) => { if (!cancelled) { setSvg(svg); setFailed(false); } })
      .catch(() => { if (!cancelled) { setSvg(null); setFailed(true); } });

    return () => { cancelled = true; };
  }, [code, streaming]);

  if (svg) {
    return (
      <div
        className="mermaid-diagram"
        style={{ margin: '10px 0', overflowX: 'auto', textAlign: 'center' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Fallback: show the source while streaming or if it failed to parse.
  return (
    <pre
      style={{
        margin: '8px 0',
        padding: '10px',
        borderRadius: '6px',
        fontSize: '12px',
        background: 'rgba(0,0,0,0.4)',
        color: failed ? '#f59e0b' : '#9aa0ff',
        whiteSpace: 'pre-wrap'
      }}
    >
      {code.trim()}
    </pre>
  );
};

export default MermaidDiagram;
