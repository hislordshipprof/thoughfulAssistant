import OpenAI from 'openai';
import type { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';
import { DEFAULT_GROQ_MODEL, groqSupportsImages } from '../../shared/groq';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function describeError(error: unknown): string {
  // Do not surface raw SDK errors: they can include upstream request data.
  const details = error as { status?: number; name?: string } | null;
  switch (details?.status) {
    case 401: return 'Groq rejected the API key. Check the Groq answer API key in Settings.';
    case 403: return 'Groq access denied. Check your project permissions and model access.';
    case 404: return 'Groq model not found or unavailable to your account. Choose another model in Settings.';
    case 413: return 'Groq request is too large. Clear context or capture fewer screens.';
    case 429: return 'Groq rate or quota limit reached. Wait before retrying and check your Groq usage limits.';
    case 400: case 422: return 'Groq rejected this request. Check the model ID, model access, and context size in Settings.';
  }
  if (details?.status && details.status >= 500) return 'Groq is temporarily unavailable. Try again shortly.';
  if (details?.name === 'APIConnectionTimeoutError') return 'Groq timed out. Check your connection and try again.';
  return 'Could not complete the Groq request. Check your internet connection and Groq settings.';
}

export class GroqProvider implements AiProvider {
  readonly name = 'groq';
  private client: OpenAI | null = null;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = DEFAULT_GROQ_MODEL) {
    this.model = model.trim();
    this.setApiKey(apiKey);
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    this.cancelStream();
    if (!this.client || !this.model) {
      onEvent({ type: 'error', content: 'Set a Groq answer API key and model in Settings → AI Provider.' });
      return;
    }
    if (!groqSupportsImages(this.model) && messages.some(message => message.images?.length)) {
      onEvent({ type: 'error', content: 'This Groq model has no verified image support. Capture again to use screen OCR, or choose a vision model.' });
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    try {
      const gptOss = this.model === 'openai/gpt-oss-120b' || this.model === 'openai/gpt-oss-20b';
      // Groq-only options differ between GPT-OSS and other reasoning models.
      const reasoningOptions = gptOss ? { include_reasoning: false, reasoning_effort: 'low' as const }
        : groqSupportsImages(this.model) ? { reasoning_format: 'hidden', reasoning_effort: 'low' as const } : {};
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(message => message.role === 'user' && message.images?.length
          ? { role: 'user' as const, content: [
            { type: 'text' as const, text: message.content },
            ...message.images.map(url => ({ type: 'image_url' as const, image_url: { url } }))
          ] }
          : { role: message.role, content: message.content }),
        stream: true,
        temperature: 0.7,
        max_completion_tokens: 4096,
        ...reasoningOptions
      }, { signal: controller.signal });

      let hasContent = false;
      let finishReason: string | null = null;
      for await (const chunk of stream) {
        if (controller.signal.aborted) return;
        const choice = chunk.choices[0];
        const content = choice?.delta?.content;
        if (content) { hasContent = true; onEvent({ type: 'token', content }); }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      if (controller.signal.aborted) return;
      if (finishReason === 'length') {
        onEvent({ type: 'error', content: 'Groq reached the output limit. Ask a shorter question or request a more concise answer.' });
      } else if (!hasContent || finishReason !== 'stop') {
        onEvent({ type: 'error', content: 'Groq did not return a complete text answer. Try again or choose another model.' });
      } else {
        onEvent({ type: 'done', content: '' });
      }
    } catch (error) {
      if (!controller.signal.aborted) onEvent({ type: 'error', content: describeError(error) });
    } finally {
      // An older cancelled request must not clear a newer request's controller.
      if (this.abortController === controller) this.abortController = null;
    }
  }

  cancelStream(): void { this.abortController?.abort(); }
  isConfigured(): boolean { return !!this.client && !!this.model; }
  async supportsImages(): Promise<boolean> { return this.isConfigured() && groqSupportsImages(this.model); }
  getModel(): string { return this.model; }
  setModel(model: string): void { this.model = model.trim(); }
  setApiKey(key: string): void {
    this.client = key.trim() ? new OpenAI({ apiKey: key.trim(), baseURL: GROQ_BASE_URL, timeout: 60000, maxRetries: 0 }) : null;
  }
}
