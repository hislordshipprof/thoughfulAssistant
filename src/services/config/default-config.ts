import { AppConfig } from './config-schema';

export const defaultConfig: AppConfig = {
  ai: {
    provider: 'openai',
    openaiKey: '',
    anthropicKey: '',
    openaiModel: 'gpt-6.1-sol',
    anthropicModel: 'claude-sonnet-5-5',
    interviewMode: 'general'
  },
  audio: {
    transcriptionMode: 'deepgram',
    deepgramKey: '',
    groqKey: '',
    googleSttKey: '',
    googleProjectId: '',
    captureSystemAudio: true,
    captureMicrophone: true
  },
  ocr: {
    intervalSeconds: 30,
    autoCapture: false
  },
  overlay: {
    opacity: 0.85,
    width: 500,
    height: 600,
    x: 100,
    y: 100,
    clickThrough: false
  },
  hotkeys: {
    toggleOverlay: { vkCodes: [0x11, 0x10, 0x48], label: 'Ctrl+Shift+H' },
    askAi: { vkCodes: [0x11, 0x10, 0x41], label: 'Ctrl+Shift+A' },
    captureScreen: { vkCodes: [0x11, 0x10, 0x53], label: 'Ctrl+Shift+S' },
    toggleRecording: { vkCodes: [0x11, 0x10, 0x52], label: 'Ctrl+Shift+R' },
    toggleInteract: { vkCodes: [0x11, 0x10, 0x49], label: 'Ctrl+Shift+I' },
    cancelStream: { vkCodes: [0x1B], label: 'Escape' },
    resetAll: { vkCodes: [0x11, 0x10, 0x4E], label: 'Ctrl+Shift+N' },
    scrollUp: { vkCodes: [0x11, 0x10, 0x26], label: 'Ctrl+Shift+Up' },
    scrollDown: { vkCodes: [0x11, 0x10, 0x28], label: 'Ctrl+Shift+Down' },
    quitApp: { vkCodes: [0x11, 0x10, 0x51], label: 'Ctrl+Shift+Q' },
    moveWindowUp: { vkCodes: [0x11, 0x12, 0x26], label: 'Ctrl+Alt+Up' },
    moveWindowDown: { vkCodes: [0x11, 0x12, 0x28], label: 'Ctrl+Alt+Down' },
    moveWindowLeft: { vkCodes: [0x11, 0x12, 0x25], label: 'Ctrl+Alt+Left' },
    moveWindowRight: { vkCodes: [0x11, 0x12, 0x27], label: 'Ctrl+Alt+Right' },
    hideApp: { vkCodes: [0x11, 0x48], label: 'Ctrl+H' },
    toggleTypingMode: { vkCodes: [0x11, 0x10, 0x57], label: 'Ctrl+Shift+W' }
  },
  resume: '',
  jobDescription: ''
};
