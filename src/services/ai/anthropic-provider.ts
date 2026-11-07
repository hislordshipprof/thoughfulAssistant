import Anthropic from '@anthropic-ai/sdk';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'claude-sonnet-5-5') {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    if (!this.client) {
      onEvent({ type: 'error', content: 'Anthropic API key not configured' });
      return;
    }

    this.abortController = new AbortController();

    // Separate system message from conversation
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 2048,
          system: systemMsg?.content || '',
          messages: chatMessages
        },
        { signal: this.abortController.signal }
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onEvent({ type: 'token', content: event.delta.text });
        }
      }

      onEvent({ type: 'done', content: '' });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      onEvent({ type: 'error', content: err.message || 'Anthropic streaming error' });
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
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }

  setModel(model: string): void {
    this.model = model;
  }
}
