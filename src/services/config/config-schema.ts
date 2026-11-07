import { z } from 'zod';

export const HotkeySchema = z.object({
  vkCodes: z.array(z.number()),
  label: z.string()
});

export const ConfigSchema = z.object({
  ai: z.object({
    provider: z.enum(['openai', 'anthropic']).default('openai'),
    openaiKey: z.string().default(''),
    anthropicKey: z.string().default(''),
    openaiModel: z.string().default('gpt-5'),
    anthropicModel: z.string().default('claude-sonnet-5-5'),
    interviewMode: z.enum(['leetcode', 'general']).default('general')
  }),
  audio: z.object({
    transcriptionMode: z.enum(['deepgram', 'realtime', 'groq-whisper', 'whisper', 'google-stt']).default('deepgram'),
    deepgramKey: z.string().default(''),
    groqKey: z.string().default(''),
    googleSttKey: z.string().default(''),
    googleProjectId: z.string().default(''),
    captureSystemAudio: z.boolean().default(true),
    captureMicrophone: z.boolean().default(true)
  }),
  ocr: z.object({
    intervalSeconds: z.number().min(5).max(300).default(30),
    autoCapture: z.boolean().default(false)
  }),
  overlay: z.object({
    opacity: z.number().min(0.1).max(1).default(0.85),
    width: z.number().min(200).max(1200).default(500),
    height: z.number().min(200).max(1000).default(600),
    x: z.number().default(100),
    y: z.number().default(100),
    clickThrough: z.boolean().default(false)
  }),
  hotkeys: z.object({
    toggleOverlay: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x48], label: 'Ctrl+Shift+H' }),      // Ctrl+Shift+H
    askAi: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x41], label: 'Ctrl+Shift+A' }),               // Ctrl+Shift+A
    captureScreen: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x53], label: 'Ctrl+Shift+S' }),       // Ctrl+Shift+S
    toggleRecording: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x52], label: 'Ctrl+Shift+R' }),     // Ctrl+Shift+R
    toggleInteract: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x49], label: 'Ctrl+Shift+I' }),      // Ctrl+Shift+I
    cancelStream: HotkeySchema.default({ vkCodes: [0x1B], label: 'Escape' }),                             // Escape
    resetAll: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x4E], label: 'Ctrl+Shift+N' }),             // Ctrl+Shift+N
    scrollUp: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x26], label: 'Ctrl+Shift+Up' }),            // Ctrl+Shift+Up
    scrollDown: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x28], label: 'Ctrl+Shift+Down' }),        // Ctrl+Shift+Down
    quitApp: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x51], label: 'Ctrl+Shift+Q' }),              // Ctrl+Shift+Q
    moveWindowUp: HotkeySchema.default({ vkCodes: [0x11, 0x12, 0x26], label: 'Ctrl+Alt+Up' }),          // Ctrl+Alt+Up
    moveWindowDown: HotkeySchema.default({ vkCodes: [0x11, 0x12, 0x28], label: 'Ctrl+Alt+Down' }),      // Ctrl+Alt+Down
    moveWindowLeft: HotkeySchema.default({ vkCodes: [0x11, 0x12, 0x25], label: 'Ctrl+Alt+Left' }),      // Ctrl+Alt+Left
    moveWindowRight: HotkeySchema.default({ vkCodes: [0x11, 0x12, 0x27], label: 'Ctrl+Alt+Right' }),    // Ctrl+Alt+Right
    hideApp: HotkeySchema.default({ vkCodes: [0x11, 0x48], label: 'Ctrl+H' }),                          // Ctrl+H
    toggleTypingMode: HotkeySchema.default({ vkCodes: [0x11, 0x10, 0x57], label: 'Ctrl+Shift+W' })    // Ctrl+Shift+W
  }),
  resume: z.string().default(''),
  jobDescription: z.string().default('')
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type HotkeyConfig = z.infer<typeof HotkeySchema>;
