// Hook that drives audio capture on macOS in response to main-process
// requests. Produces Int16 PCM mono at 24 kHz (what the Windows WASAPI
// addon would produce) and ships each chunk to main via IPC.
//
// Two independent streams:
//   • Microphone (your voice) — always attempted. getUserMedia({audio}).
//   • System audio (interviewer) — best-effort via desktopCapturer loopback
//     (macOS 13+). If it fails, mic capture is unaffected.
import { useEffect, useRef } from 'react';

const TARGET_SAMPLE_RATE = 24000;

interface PcmPipe {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  stream: MediaStream;
}

// Wire a MediaStream through an AudioContext, resample to 24 kHz mono Int16,
// and hand each chunk to `sink`.
function makePcmPipe(stream: MediaStream, sink: (buf: ArrayBuffer) => void): PcmPipe {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const ratio = TARGET_SAMPLE_RATE / ctx.sampleRate;

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
    sink(out.buffer);
  };

  source.connect(processor);
  processor.connect(ctx.destination); // required to drive onaudioprocess
  return { ctx, source, processor, stream };
}

function teardownPipe(pipe: PcmPipe | null): void {
  if (!pipe) return;
  try {
    pipe.processor.disconnect();
    pipe.source.disconnect();
    pipe.ctx.close();
    pipe.stream.getTracks().forEach(t => t.stop());
  } catch {
    // ignore teardown errors
  }
}

export function useMacAudioCapture(): void {
  const micPipeRef = useRef<PcmPipe | null>(null);
  const loopbackPipeRef = useRef<PcmPipe | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.onMacAudioStart) return;

    const startMic = async () => {
      if (micPipeRef.current) return;
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
        micPipeRef.current = makePcmPipe(stream, (buf) =>
          window.electronAPI.sendMacAudioChunk(buf)
        );
        console.log('[mac-audio] mic capture started');
      } catch (err) {
        console.error('[mac-audio] mic getUserMedia failed:', err);
      }
    };

    // System-audio (loopback) capture via getDisplayMedia. Electron's main
    // process answers the request with the screen source + 'loopback' audio,
    // which is captured through ScreenCaptureKit on macOS 13+ (no picker).
    // We keep only the audio track. Non-fatal — mic capture is independent.
    const startLoopback = async () => {
      if (loopbackPipeRef.current) return;
      try {
        if (!navigator.mediaDevices?.getDisplayMedia) return;
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,   // required by the API; main supplies a 1x1 source
          audio: true    // main maps this to 'loopback' (system audio)
        });

        // Drop the video track immediately — we only want system audio.
        stream.getVideoTracks().forEach(t => t.stop());

        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach(t => t.stop());
          console.log('[mac-audio] no system-audio track (needs macOS 13+ / Screen Recording permission)');
          return;
        }

        loopbackPipeRef.current = makePcmPipe(stream, (buf) =>
          window.electronAPI.sendMacAudioLoopbackChunk(buf)
        );
        console.log('[mac-audio] system-audio (ScreenCaptureKit loopback) capture started');
      } catch (err) {
        // Non-fatal — mic capture continues.
        console.log('[mac-audio] system-audio capture unavailable:', (err as Error)?.message);
      }
    };

    const start = () => {
      startMic();
      startLoopback();
    };

    const stop = () => {
      teardownPipe(micPipeRef.current);
      teardownPipe(loopbackPipeRef.current);
      micPipeRef.current = null;
      loopbackPipeRef.current = null;
      console.log('[mac-audio] capture stopped');
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
