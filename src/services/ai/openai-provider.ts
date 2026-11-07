import OpenAI from 'openai';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'gpt-6.1-sol') {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    if (!this.client) {
      onEvent({ type: 'error', content: 'OpenAI API key not configured' });
      return;
    }

    this.abortController = new AbortController();

    try {
      // Newer OpenAI models (GPT-5/6 incl. Sol/Astra/Luna, and the o-series)
      // renamed max_tokens → max_completion_tokens, and the o-series only
      // accepts the default temperature. Build params per model family.
      const m = this.model.toLowerCase();
      const isNewFamily = /^(gpt-5|gpt-6|o1|o3|o4)/.test(m);
      const isReasoning = /^(o1|o3|o4)/.test(m);

      const params: any = {
        model: this.model,
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        stream: true
      };
      if (isNewFamily) {
        params.max_completion_tokens = 2048;
      } else {
        params.max_tokens = 2048;
      }
      if (!isReasoning) {
        params.temperature = 0.7;
      }

      const stream = await this.client.chat.completions.create(
        params,
        { signal: this.abortController.signal }
      ) as unknown as AsyncIterable<any>;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          onEvent({ type: 'token', content: delta });
        }
      }

      onEvent({ type: 'done', content: '' });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      onEvent({ type: 'error', content: err.message || 'OpenAI streaming error' });
    } finally {
      this.abortController = null;
    }
  }

  cancelStream(): void {
    this.abortController?.abort();
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this.client = key ? new OpenAI({ apiKey: key }) : null;
  }

  setModel(model: string): void {
    this.model = model;
  }
}
