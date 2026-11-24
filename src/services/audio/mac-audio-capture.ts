import { EventEmitter } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { AudioChunk, CaptureBackend, CaptureOptions } from './capture-backend';

export class MacAudioCapture extends EventEmitter implements CaptureBackend {
  readonly supportsLocalSpeech = true;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private cancelStart: (() => void) | null = null;

  async startCapture(system: (chunk: AudioChunk) => void, mic: (chunk: AudioChunk) => void,
    options: CaptureOptions = { captureMicrophone: true, captureSystemAudio: true }): Promise<boolean> {
    if (this.child) throw new Error('Audio capture is already starting or running');
    if (!options.captureMicrophone && !options.captureSystemAudio) throw new Error('Enable Microphone or System audio in Settings.');
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'overlay-audio')
      : path.resolve(__dirname, '../../build/mac/overlay-audio');
    if (!fs.existsSync(helper)) throw new Error('Mac audio helper is missing. Run npm run build:mac-audio, or reinstall the latest Mac build.');
    const args = [
      ...(options.captureMicrophone ? ['--mic'] : []),
      ...(options.captureSystemAudio ? ['--system'] : []),
      ...(options.localSpeech ? ['--local-speech'] : []),
      `--locale=${options.speechLocale || 'en-US'}`
    ];
    const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-2000); });
    // Prevent EPIPE from becoming an uncaught process error during rapid Stop/Quit.
    child.stdin.on('error', () => {});
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail('Timed out waiting for Mac audio permissions. Check the permission dialogs and try recording again.'), 90000);
      const fail = (message: string) => {
        clearTimeout(timer);
        if (!settled) { settled = true; this.cancelStart = null; reject(new Error(message)); }
        else if (this.child === child) this.emit('error', new Error(message));
        if (this.child === child) this.stopCapture();
      };
      this.cancelStart = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Audio start cancelled')); }
      };
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (this.child !== child) return;
        try {
          if (line.length > 1024 * 1024) throw new Error('Oversized audio message');
          const message = JSON.parse(line);
          if (message.type === 'ready') {
            settled = true; clearTimeout(timer); this.cancelStart = null; this.ready = true; resolve(true);
          } else if (message.type === 'error') {
            fail(message.message || 'Mac audio capture failed. Check Microphone and Screen & System Audio Recording permissions.');
          } else if (message.type === 'transcript' && ['mic', 'system'].includes(message.source) && typeof message.text === 'string') {
            this.emit('transcription', { source: message.source, text: message.text, isFinal: !!message.isFinal });
          } else if (message.type === 'level' && ['mic', 'system'].includes(message.source)) {
            this.emit('level', { source: message.source, level: Math.max(0, Math.min(1, Number(message.level) || 0)) });
          } else if (message.type === 'audio' && typeof message.samples === 'string' && ['mic', 'system'].includes(message.source)) {
            const samples = Buffer.from(message.samples, 'base64');
            if (samples.length % 2 !== 0) throw new Error('Invalid PCM sample length');
            const chunk = { samples, sampleRate: 24000, channels: 1, isLoopback: message.source === 'system' };
            if (chunk.isLoopback) system(chunk); else mic(chunk);
          }
        } catch (error) { fail(`Mac audio protocol error: ${String(error)}`); }
      });
      child.on('error', error => fail(`Could not start Mac audio: ${error.message}`));
      child.on('exit', (code, signal) => {
        lines.close(); clearTimeout(timer);
        if (this.child !== child) return;
        fail(`Mac audio stopped (${signal || code}). Check macOS permissions.${stderr.includes('privacy') ? ' macOS blocked a privacy-sensitive resource.' : ''}`);
      });
    });
  }

  stopCapture(): void {
    this.cancelStart?.(); this.cancelStart = null;
    const child = this.child;
    this.child = null; this.ready = false;
    if (!child) return;
    child.stdin.end('stop\n');
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 1500);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }

  isCapturing(): boolean { return this.ready; }
}
