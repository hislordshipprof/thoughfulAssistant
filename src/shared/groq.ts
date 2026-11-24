// Suggestions verified against https://console.groq.com/docs/models (2026-10-22).
// Custom model IDs remain supported; unknown models use screen OCR, not images.
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const GROQ_MODELS = [
  { id: DEFAULT_GROQ_MODEL, label: 'GPT-OSS 120B · text + screen OCR' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B · fast text + screen OCR' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B · vision (preview)' }
] as const;

export function groqSupportsImages(model: string): boolean {
  // Explicit opt-in by verified model, never inferred from an arbitrary name.
  return model.trim() === 'qwen/qwen3.8-27b' || model.trim() === 'meta-models/muse-spark-open';
}
