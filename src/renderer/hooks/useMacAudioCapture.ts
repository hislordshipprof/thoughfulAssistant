// Hook that drives microphone capture on macOS in response to main-process
// requests. Produces Int16 PCM mono at 24 kHz (what the Windows WASAPI
// addon would produce) and ships each ~20 ms chunk to main via IPC.
import { useEffect, useRef } from 'react';

interface ElectronAPI {
  onMacAudioStart: (cb: () => void) => () => void;
  onMacAudioStop: (cb: () => void) => () => void;
  sendMacAudioChunk: (samples: ArrayBuffer) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

const TARGET_SAMPLE_RATE = 24000;
const CHUNK_MS = 20;

export function useMacAudioCapture(): void {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.onMacAudioStart) return;

    const start = async () => {
      if (streamRef.current) return; // already running
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
        streamRef.current = stream;

        // ScriptProcessorNode is deprecated but universally supported and
        // doesn't need a separate worklet file (easier to bundle).
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;

        const bufferSize = 2048; // ~43 ms at 48 kHz
        const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
        processorRef.current = processor;

        const srcRate = ctx.sampleRate;
        const ratio = TARGET_SAMPLE_RATE / srcRate;

        processor.onaudioprocess = (ev) => {
          const input = ev.inputBuffer.getChannelData(0);
          const outLen = Math.floor(input.length * ratio);
          const out = new Int16Array(outLen);
          for (let i = 0; i < outLen; i++) {
            const srcIdx = Math.floor(i / ratio);
            let s = input[srcIdx];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          // Transfer the buffer to the main process without copying.
          window.electronAPI.sendMacAudioChunk(out.buffer);
        };

        source.connect(processor);
        processor.connect(ctx.destination); // required to drive onaudioprocess
        console.log('[mac-audio] renderer mic capture started, ctx rate=', srcRate);
      } catch (err) {
        console.error('[mac-audio] getUserMedia failed:', err);
      }
    };

    const stop = () => {
      try {
        processorRef.current?.disconnect();
        sourceRef.current?.disconnect();
        audioCtxRef.current?.close();
        streamRef.current?.getTracks().forEach(t => t.stop());
      } catch {
        // ignore teardown errors
      }
      processorRef.current = null;
      sourceRef.current = null;
      audioCtxRef.current = null;
      streamRef.current = null;
      console.log('[mac-audio] renderer mic capture stopped');
    };

    const offStart = window.electronAPI.onMacAudioStart(start);
    const offStop = window.electronAPI.onMacAudioStop(stop);

    return () => {
      offStart?.();
      offStop?.();
      stop();
    };
  }, []);
}
