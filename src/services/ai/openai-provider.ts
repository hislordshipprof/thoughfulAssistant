import OpenAI from 'openai';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'gpt-5') {
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
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: 0.7,
          max_tokens: 2048
        },
        { signal: this.abortController.signal }
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
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
