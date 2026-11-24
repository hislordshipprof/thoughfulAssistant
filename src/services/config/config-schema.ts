import { z } from 'zod';
import { defaultHotkeys } from '../../shared/controls';
import { DEFAULT_GROQ_MODEL } from '../../shared/groq';

export const HotkeySchema = z.object({
  vkCodes: z.array(z.number()),
  label: z.string()
});

export const ConfigSchema = z.object({
  ai: z.object({
    provider: z.enum(['openai', 'anthropic', 'ollama', 'groq']).default('openai'),
    groqKey: z.string().trim().default(''),
    groqModel: z.string().trim().min(1, 'Choose a Groq model').default(DEFAULT_GROQ_MODEL),
    openaiKey: z.string().default(''),
    anthropicKey: z.string().trim().default(''),
    openaiModel: z.string().default('gpt-4o'),
    anthropicModel: z.string().trim().min(1, 'Choose an Anthropic model').default('claude-sonnet-4-5-20250929'),
    ollamaUrl: z.string().default('http://127.0.0.1:11434'),
    ollamaModel: z.string().default('llama3.2:1b'),
    interviewMode: z.enum(['leetcode', 'general']).default('general'),
    systemPromptMode: z.enum(['default', 'append', 'replace']).default('default'),
    customSystemPrompt: z.string().max(30000, 'System prompt must be 30,000 characters or fewer').default('')
  }),
  audio: z.object({
    transcriptionMode: z.enum(['deepgram', 'realtime', 'groq-whisper', 'whisper', 'google-stt', 'macos-speech']).default(process.platform === 'darwin' ? 'macos-speech' : 'deepgram'),
    deepgramKey: z.string().default(''),
    groqKey: z.string().default(''),
    googleSttKey: z.string().default(''),
    googleProjectId: z.string().default(''),
    captureSystemAudio: z.boolean().default(true),
    captureMicrophone: z.boolean().default(true),
    autoAnswer: z.boolean().default(true),
    speechLocale: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).default('en-US'),
    macDefaultsApplied: z.boolean().default(false)
  }),
  ocr: z.object({
    intervalSeconds: z.number().min(5).max(300).default(30),
    autoCapture: z.boolean().default(false),
    displayId: z.string().default('cursor')
  }),
  overlay: z.object({
    opacity: z.number().min(0.1).max(1).default(0.85),
    width: z.number().min(200).max(1200).default(500),
    height: z.number().min(200).max(1000).default(600),
    x: z.number().default(100),
    y: z.number().default(100),
    clickThrough: z.boolean().default(false),
    captureProtection: z.boolean().default(true),
    hideDock: z.boolean().default(true)
  }),
  hotkeys: z.record(HotkeySchema).default(() => defaultHotkeys(process.platform)),
  controlsVersion: z.number().default(0),
  resume: z.string().default(''),
  jobDescription: z.string().default('')
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type HotkeyConfig = z.infer<typeof HotkeySchema>;
