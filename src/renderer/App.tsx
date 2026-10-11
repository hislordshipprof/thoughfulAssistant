import React, { useState, useCallback, useEffect, useRef } from 'react';
import OverlayPanel from './components/OverlayPanel';
import SettingsModal from './components/SettingsModal';
import { useStreamingResponse } from './hooks/useStreamingResponse';
import { useHotkeys } from './hooks/useHotkeys';
import { useIpcEvent } from './hooks/useIpc';

/** Max characters for typed extra context (prevent unbounded growth) */
const MAX_EXTRA_CONTEXT_CHARS = 50000;

const App: React.FC = () => {
  const [interviewMode, setInterviewMode] = useState<string>('general');
  const { response, isStreaming, error, reset } = useStreamingResponse(true);
  const [transcriptEntries, setTranscriptEntries] = useState<any[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPassthrough, setIsPassthrough] = useState(false);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [isStealthActive, setIsStealthActive] = useState(true);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [extraContext, setExtraContext] = useState('');
  const [isTypingMode, setIsTypingMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledAway = useRef(false);
  const wasStreaming = useRef(false);

  // Listen for transcript updates
  useIpcEvent('onTranscriptUpdate', useCallback((entries: any[]) => {
    setTranscriptEntries(entries);
  }, []));

  // Listen for status updates
  useIpcEvent('onStatusUpdate', useCallback((status: any) => {
    setIsRecording(status.isRecording ?? false);
    setAiProvider(status.aiProvider ?? null);
    setIsStealthActive(status.isStealthActive ?? true);
  }, []));

  // Listen for screenshot captures (array of all accumulated screenshots)
  useIpcEvent('onScreenshots', useCallback((dataUrls: string[]) => {
    setScreenshots(dataUrls);
  }, []));

  // Typing mode — keystroke injection from native LL hook
  useIpcEvent('onTypingMode', useCallback((active: boolean) => {
    setIsTypingMode(active);
  }, []));

  // Clear extra context textarea when AI request consumes it
  useIpcEvent('onExtraContextClear', useCallback(() => {
    setExtraContext('');
  }, []));

  useIpcEvent('onTypingEvent', useCallback((event: any) => {
    if (event.type === 'char') {
      setExtraContext(prev => {
        if (prev.length >= MAX_EXTRA_CONTEXT_CHARS) return prev;
        const newVal = prev + event.char;
        window.electronAPI?.setExtraContext?.(newVal);
        return newVal;
      });
    } else if (event.type === 'command') {
      if (event.command === 'backspace') {
        setExtraContext(prev => {
          const newVal = prev.slice(0, -1);
          window.electronAPI?.setExtraContext?.(newVal);
          return newVal;
        });
      } else if (event.command === 'enter') {
        setExtraContext(prev => {
          if (prev.length >= MAX_EXTRA_CONTEXT_CHARS) return prev;
          const newVal = prev + '\n';
          window.electronAPI?.setExtraContext?.(newVal);
          return newVal;
        });
      }
    }
  }, []));

  // Register hotkey handlers
  useHotkeys({
    toggleInteract: useCallback(() => {
      setIsPassthrough(prev => {
        const next = !prev;
        document.body.classList.toggle('full-passthrough', next);
        return next;
      });
    }, []),
    openSettings: useCallback(() => {
      setSettingsOpen(true);
    }, []),
    toggleRecording: useCallback(() => {
      // State will be updated via onStatusUpdate from main process
    }, []),
    resetAll: useCallback(() => {
      reset();
      setTranscriptEntries([]);
      setScreenshots([]);
      setExtraContext('');
      setIsTypingMode(false);
      window.electronAPI?.setExtraContext?.('');
    }, [reset]),
    scrollUp: useCallback(() => {
      scrollRef.current?.scrollBy({ top: -150, behavior: 'smooth' });
    }, []),
    scrollDown: useCallback(() => {
      scrollRef.current?.scrollBy({ top: 150, behavior: 'smooth' });
    }, [])
  });

  // Reset scroll lock when a new stream starts
  useEffect(() => {
    if (isStreaming && !wasStreaming.current) {
      userScrolledAway.current = false;
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  // Track user scroll — if they scroll up, stop auto-scrolling
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      userScrolledAway.current = !atBottom;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to bottom as tokens stream in, unless user scrolled away
  useEffect(() => {
    if (scrollRef.current && isStreaming && !userScrolledAway.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [response, isStreaming]);

  // Load initial config
  useEffect(() => {
    window.electronAPI?.getConfig?.('ai').then((ai: any) => {
      if (ai?.provider) setAiProvider(ai.provider);
      if (ai?.interviewMode) setInterviewMode(ai.interviewMode);
    }).catch((err: unknown) => console.warn('[app] Failed to load AI config:', err));
    window.electronAPI?.getConfig?.('overlay').then((overlay: any) => {
      if (overlay?.fontSize) {
        document.documentElement.style.setProperty('--content-font-size', overlay.fontSize + 'px');
      }
    }).catch((err: unknown) => console.warn('[app] Failed to load overlay config:', err));
    window.electronAPI?.getRecordingState?.().then((state: boolean) => {
      setIsRecording(state);
    }).catch((err: unknown) => console.warn('[app] Failed to load recording state:', err));
  }, []);

  const handleToggleRecording = useCallback(async () => {
    const newState = await window.electronAPI?.toggleRecording();
    setIsRecording(newState);
  }, []);

  const handleAskAi = useCallback(async () => {
    const ocrText = await window.electronAPI?.getLastOcrText() || '';
    await window.electronAPI?.askAi('', ocrText);
  }, []);

  const handleCaptureScreen = useCallback(async () => {
    await window.electronAPI?.captureScreen();
  }, []);

  const handleToggleStealth = useCallback(async () => {
    const newState = await window.electronAPI?.toggleStealth();
    setIsStealthActive(newState);
  }, []);

  const handleExtraContextChange = useCallback((text: string) => {
    setExtraContext(text);
    window.electronAPI?.setExtraContext?.(text);
  }, []);

  return (
    <>
      <OverlayPanel
        response={response}
        isStreaming={isStreaming}
        error={error}
        transcriptEntries={transcriptEntries}
        isRecording={isRecording}
        aiProvider={aiProvider}
        isStealthActive={isStealthActive}
        isPassthrough={isPassthrough}
        isTypingMode={isTypingMode}
        screenshots={screenshots}
        extraContext={extraContext}
        scrollRef={scrollRef}
        onSettingsClick={() => setSettingsOpen(true)}
        onToggleRecording={handleToggleRecording}
        onAskAi={handleAskAi}
        onCaptureScreen={handleCaptureScreen}
        onRemoveScreenshot={(index) => window.electronAPI?.removeScreenshot(index)}
        onClearScreenshots={() => {
          window.electronAPI?.clearScreenshots();
          setScreenshots([]);
        }}
        onExtraContextChange={handleExtraContextChange}
        onToggleStealth={handleToggleStealth}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // Refresh interviewMode in case it changed
          window.electronAPI?.getConfig?.('ai').then((ai: any) => {
            if (ai?.interviewMode) setInterviewMode(ai.interviewMode);
          });
        }}
      />
      {isPassthrough && <div className="interact-mode-badge">PASSTHROUGH</div>}
    </>
  );
};

export default App;
