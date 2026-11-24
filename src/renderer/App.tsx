import React, { useState, useCallback, useEffect, useRef } from 'react';
import OverlayPanel from './components/OverlayPanel';
import SettingsModal from './components/SettingsModal';
import { useStreamingResponse } from './hooks/useStreamingResponse';
import { useHotkeys } from './hooks/useHotkeys';
import { useIpcEvent } from './hooks/useIpc';
import { defaultHotkeys, type ShortcutBinding, type WindowState } from '../shared/controls';
import type { AudioState, AudioLevel, ScreenState } from '../shared/media';

const App: React.FC = () => {
  const [interviewMode, setInterviewMode] = useState('general');
  const { response, isStreaming, error, reset } = useStreamingResponse(interviewMode === 'leetcode');
  const [transcriptEntries, setTranscriptEntries] = useState<any[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioState, setAudioState] = useState<AudioState>({ isRecording: false, isStarting: false, microphone: false, systemAudio: false });
  const [audioLevels, setAudioLevels] = useState({ mic: 0, system: 0 });
  const [audioError, setAudioError] = useState<string | null>(null);
  const [screenState, setScreenState] = useState<ScreenState>({ busy: false, message: '' });
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [windowState, setWindowState] = useState<WindowState | null>(null);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [extraContext, setExtraContext] = useState('');
  const [isTypingMode, setIsTypingMode] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [hotkeys, setHotkeys] = useState<Record<string, ShortcutBinding>>(() => defaultHotkeys(window.electronAPI.platform));
  const [shortcutFailures, setShortcutFailures] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isPassthrough = windowState?.passthrough ?? false;

  const runControl = useCallback(async (action: string, query?: string) => {
    setControlError(null);
    if (action === 'toggleRecording') setAudioError(null);
    try { await window.electronAPI.runControl(action, query); }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (action === 'toggleRecording') setAudioError(message); else setControlError(message);
    }
  }, []);

  useIpcEvent('onTranscriptUpdate', setTranscriptEntries);
  useIpcEvent('onScreenshots', setScreenshots);
  useIpcEvent('onWindowState', setWindowState);
  useIpcEvent('onAudioStatus', useCallback((state: AudioState) => {
    setAudioState(state);
    if (state.isStarting || state.isRecording) setAudioError(null);
    if (!state.isRecording) setAudioLevels({ mic: 0, system: 0 });
  }, []));
  useIpcEvent('onAudioLevel', useCallback((event: AudioLevel) => setAudioLevels(prev => ({ ...prev, [event.source]: event.level })), []));
  useIpcEvent('onAudioError', setAudioError);
  useIpcEvent('onScreenState', setScreenState);
  useIpcEvent('onStatusUpdate', useCallback((status: any) => {
    if (status.aiProvider !== undefined) setAiProvider(status.aiProvider);
  }, []));
  useIpcEvent('onTypingMode', useCallback((active: boolean) => {
    setIsTypingMode(active);
    if (active && window.electronAPI.platform === 'darwin') inputRef.current?.focus();
    if (!active) inputRef.current?.blur();
  }, []));
  useIpcEvent('onExtraContextClear', useCallback(() => setExtraContext(''), []));
  useIpcEvent('onTypingEvent', useCallback((event: any) => {
    if (event.type === 'char') setExtraContext(prev => prev + event.char);
    else if (event.command === 'backspace') setExtraContext(prev => prev.slice(0, -1));
    else if (event.command === 'enter') setExtraContext(prev => prev + '\n');
  }, []));
  useEffect(() => { void window.electronAPI.setExtraContext(extraContext); }, [extraContext]);
  useEffect(() => {
    document.body.classList.toggle('full-passthrough', isPassthrough);
    return () => document.body.classList.remove('full-passthrough');
  }, [isPassthrough]);

  const focusChat = useCallback(() => {
    setSettingsOpen(false);
    setIsTypingMode(true);
    void window.electronAPI.setFocusable(true).then(() => inputRef.current?.focus());
  }, []);
  const sendChat = useCallback(() => {
    if (extraContext.trim()) void runControl('submitChat', extraContext);
    else focusChat();
  }, [extraContext, runControl, focusChat]);
  useHotkeys({
    chat: () => {
      if (document.activeElement === inputRef.current && extraContext.trim()) sendChat();
      else focusChat();
    },
    focusChat,
    openSettings: () => setSettingsOpen(true),
    resetAll: () => {
      reset(); setTranscriptEntries([]); setScreenshots([]); setExtraContext(''); setIsTypingMode(false);
    },
    scrollUp: () => scrollRef.current?.scrollBy({ top: -150, behavior: 'smooth' }),
    scrollDown: () => scrollRef.current?.scrollBy({ top: 150, behavior: 'smooth' })
  });

  useEffect(() => {
    void window.electronAPI.getConfig().then(config => {
      setAiProvider(config.ai.provider);
      setInterviewMode(config.ai.interviewMode);
      setHotkeys(config.hotkeys);
    });
    void window.electronAPI.getWindowState().then(setWindowState);
    void window.electronAPI.getAudioStatus().then(setAudioState);
    void window.electronAPI.getShortcutFailures().then(setShortcutFailures);
  }, []);

  return (
    <>
      <OverlayPanel
        response={response} isStreaming={isStreaming} error={controlError || error}
        transcriptEntries={transcriptEntries} isRecording={audioState.isRecording} aiProvider={aiProvider}
        audioState={audioState} audioLevels={audioLevels} audioError={audioError} screenState={screenState}
        windowState={windowState} isPassthrough={isPassthrough} isTypingMode={isTypingMode}
        screenshots={screenshots} extraContext={extraContext} scrollRef={scrollRef} inputRef={inputRef}
        hotkeys={hotkeys} shortcutFailures={shortcutFailures}
        onSettingsClick={() => setSettingsOpen(true)}
        onToggleRecording={() => void runControl('toggleRecording')}
        onAskAi={() => void runControl('askAi')}
        onCaptureScreen={() => void runControl('captureScreen')}
        onHide={() => void runControl('hideOverlay')}
        onTogglePassthrough={() => void runControl('toggleInteract')}
        onSendChat={sendChat}
        onExitTyping={() => { setIsTypingMode(false); void runControl('exitTyping'); }}
        onCancel={() => void runControl('cancelStream')}
        onRemoveScreenshot={index => void window.electronAPI.removeScreenshot(index)}
        onClearScreenshots={() => void window.electronAPI.clearScreenshots()}
        onExtraContextChange={setExtraContext}
      />
      <SettingsModal isOpen={settingsOpen} shortcutFailures={shortcutFailures} onClose={() => {
        setSettingsOpen(false);
        void window.electronAPI.setFocusable(false);
        void window.electronAPI.getConfig('ai').then(ai => setInterviewMode(ai.interviewMode));
      }} />
      {isPassthrough && <div className="interact-mode-badge">CLICK-THROUGH · {hotkeys.toggleInteract.label} to interact</div>}
    </>
  );
};

export default App;
