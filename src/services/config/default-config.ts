import { AppConfig } from './config-schema';
import { defaultHotkeys } from '../../shared/controls';
import { DEFAULT_GROQ_MODEL } from '../../shared/groq';

export const defaultConfig: AppConfig = {
  ai: {
    provider: 'openai',
    groqKey: '',
    groqModel: DEFAULT_GROQ_MODEL,
    openaiKey: '',
    anthropicKey: '',
    openaiModel: 'gpt-4o',
    anthropicModel: 'claude-sonnet-4-5-20250929',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2:1b',
    interviewMode: 'general',
    systemPromptMode: 'default',
    customSystemPrompt: ''
  },
  audio: {
    transcriptionMode: process.platform === 'darwin' ? 'macos-speech' : 'deepgram',
    deepgramKey: '',
    groqKey: '',
    googleSttKey: '',
    googleProjectId: '',
    captureSystemAudio: true,
    captureMicrophone: true,
    autoAnswer: true,
    speechLocale: 'en-US',
    macDefaultsApplied: false
  },
  ocr: {
    intervalSeconds: 30,
    autoCapture: false,
    displayId: 'cursor'
  },
  overlay: {
    opacity: 0.85,
    width: 500,
    height: 600,
    x: 100,
    y: 100,
    clickThrough: false,
    captureProtection: true,
    hideDock: true
  },
  hotkeys: defaultHotkeys(process.platform),
  controlsVersion: 0,
  resume: '',
  jobDescription: ''
};
