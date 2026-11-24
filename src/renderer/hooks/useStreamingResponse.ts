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

  const onStarted = useCallback(() => {
    responseRef.current = appendMode && responseRef.current ? responseRef.current + '\n\n---\n\n' : '';
    streamingRef.current = true;
    setState({ response: responseRef.current, isStreaming: true, error: null });
  }, [appendMode]);

  const onCancelled = useCallback(() => {
    streamingRef.current = false;
    setState(prev => ({ ...prev, isStreaming: false }));
  }, []);

  const onToken = useCallback((token: string) => {
    streamingRef.current = true;
    responseRef.current += token;
    setState(prev => ({
      ...prev,
      response: responseRef.current,
      isStreaming: true,
      error: null
    }));
  }, []);

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
  useIpcEvent('onAiStarted', onStarted);
  useIpcEvent('onAiCancelled', onCancelled);
  useIpcEvent('onAiDone', onDone);
  useIpcEvent('onAiError', onError);

  const reset = useCallback(() => {
    responseRef.current = '';
    streamingRef.current = false;
    setState({ response: '', isStreaming: false, error: null });
  }, []);

  return { ...state, reset };
}
