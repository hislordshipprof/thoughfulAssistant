import { useState, useCallback, useRef, useEffect } from 'react';
import { useIpcEvent } from './useIpc';

interface StreamState {
  response: string;
  isStreaming: boolean;
  error: string | null;
}

/**
 * Streaming response hook with time-throttled coalescing.
 *
 * Every IPC token event would otherwise trigger a setState — which re-parses
 * the ENTIRE markdown document (remark + remarkBreaks + remarkMath + KaTeX)
 * from scratch on every flush. That parse is O(n) in document length, so
 * flushing per-token is O(n²) over the stream.
 *
 * rAF coalescing (the previous approach) still flushed at ~60fps. Text never
 * arrives that fast, so 60fps just multiplied the parse work for no visible
 * benefit. Throttling to ~11fps (90ms) collapses many more tokens into each
 * render, cutting markdown/KaTeX parse work ~5-6x while still looking smooth
 * to the eye. A trailing flush guarantees the last partial batch is shown.
 */
const FLUSH_INTERVAL_MS = 90;

export function useStreamingResponse(appendMode = false) {
  const [state, setState] = useState<StreamState>({
    response: '',
    isStreaming: false,
    error: null
  });
  const responseRef = useRef('');
  const streamingRef = useRef(false);
  const pendingFlush = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushToState = useCallback(() => {
    pendingFlush.current = null;
    setState({
      response: responseRef.current,
      isStreaming: streamingRef.current,
      error: null
    });
  }, []);

  // Cancel any pending flush on unmount to avoid setState-after-unmount warnings.
  useEffect(() => () => {
    if (pendingFlush.current !== null) {
      clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
    }
  }, []);

  const onToken = useCallback((token: string) => {
    if (appendMode && !streamingRef.current && responseRef.current) {
      // First token of a new stream with existing content — add prominent separator
      responseRef.current += '\n\n\n---\n\n\n';
    }
    streamingRef.current = true;
    responseRef.current += token;
    // Coalesce updates: only schedule a flush if one isn't already pending.
    // All tokens arriving within FLUSH_INTERVAL_MS collapse into one render.
    if (pendingFlush.current === null) {
      pendingFlush.current = setTimeout(flushToState, FLUSH_INTERVAL_MS);
    }
  }, [appendMode, flushToState]);

  const onDone = useCallback((fullResponse: string) => {
    streamingRef.current = false;
    if (!appendMode) {
      responseRef.current = fullResponse;
    }
    // Cancel any pending coalesced flush — we're about to do a final flush
    // with the authoritative final state (which switches isStreaming → false
    // and triggers the full Prism highlight pass).
    if (pendingFlush.current !== null) {
      clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
    }
    setState({
      response: responseRef.current,
      isStreaming: false,
      error: null
    });
  }, [appendMode]);

  const onError = useCallback((error: string) => {
    streamingRef.current = false;
    if (pendingFlush.current !== null) {
      clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
    }
    setState(prev => ({
      ...prev,
      isStreaming: false,
      error
    }));
  }, []);

  useIpcEvent('onAiToken', onToken);
  useIpcEvent('onAiDone', onDone);
  useIpcEvent('onAiError', onError);

  const reset = useCallback(() => {
    if (pendingFlush.current !== null) {
      clearTimeout(pendingFlush.current);
      pendingFlush.current = null;
    }
    responseRef.current = '';
    streamingRef.current = false;
    setState({ response: '', isStreaming: false, error: null });
  }, []);

  return { ...state, reset };
}
