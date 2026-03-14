import { useState, useCallback, useRef } from 'react';
import { useIpcEvent } from './useIpc';

interface StreamState {
  response: string;
  isStreaming: boolean;
  error: string | null;
}

export function useStreamingResponse(appendMode = false) {
  const [state, setState] = useState<StreamState>({
    response: '',
    isStreaming: false,
    error: null
  });
  const responseRef = useRef('');
  const streamingRef = useRef(false);

  const onToken = useCallback((token: string) => {
    if (appendMode && !streamingRef.current && responseRef.current) {
      // First token of a new stream with existing content — add prominent separator
      responseRef.current += '\n\n\n---\n\n\n';
    }
    streamingRef.current = true;
    responseRef.current += token;
    setState(prev => ({
      ...prev,
      response: responseRef.current,
      isStreaming: true,
      error: null
    }));
  }, [appendMode]);

  const onDone = useCallback((fullResponse: string) => {
    streamingRef.current = false;
    if (!appendMode) {
      responseRef.current = fullResponse;
    }
    // In append mode, responseRef.current already has the accumulated content
    setState({
      response: responseRef.current,
      isStreaming: false,
      error: null
    });
  }, [appendMode]);

  const onError = useCallback((error: string) => {
    streamingRef.current = false;
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
    responseRef.current = '';
    streamingRef.current = false;
    setState({ response: '', isStreaming: false, error: null });
  }, []);

  return { ...state, reset };
}
