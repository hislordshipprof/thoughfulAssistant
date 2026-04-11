import Anthropic from '@anthropic-ai/sdk';
import { AiProvider, AiMessage, AiStreamEvent, MessageContent, getTextContent } from './ai-provider';

type AnthropicContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
>;

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  // data:image/jpeg;base64,/9j/4AAQ...
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    return { mediaType: 'image/jpeg', base64: dataUrl };
  }
  return { mediaType: match[1], base64: match[2] };
}

function toAnthropicContent(content: string | MessageContent[]): AnthropicContent {
  if (typeof content === 'string') return content;

  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    // image — Anthropic expects raw base64 + media_type, not a data URL
    const { mediaType, base64 } = parseDataUrl(block.dataUrl);
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: mediaType,
        data: base64
      }
    };
  });
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-5-20250929') {
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
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: toAnthropicContent(m.content)
      }));

    try {
      const tApiStart = performance.now();
      console.log(`[anthropic-timing] sending request to ${this.model}...`);

      // Send system prompt as content block with cache_control for prompt caching.
      // Anthropic caches the system prompt prefix server-side — on cache hits,
      // time-to-first-token drops by up to 85%. Min 1024 tokens for Sonnet 4.5.
      const systemText = systemMsg ? getTextContent(systemMsg.content) : '';
      const systemParam = systemText
        ? [{ type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } }]
        : [];

      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 4096,
          system: systemParam,
          messages: chatMessages as any
        },
        { signal: this.abortController.signal }
      );

      let firstToken = true;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (firstToken) {
            console.log(`[anthropic-timing] first token: ${(performance.now() - tApiStart).toFixed(0)}ms`);
            firstToken = false;
          }
          onEvent({ type: 'token', content: event.delta.text });
        }
      }

      const elapsed = (performance.now() - tApiStart).toFixed(0);
      // Log cache performance — cache_read_input_tokens > 0 means cache hit
      const finalMsg = await stream.finalMessage();
      const usage = finalMsg.usage as any;
      console.log(`[anthropic-timing] stream complete: ${elapsed}ms | tokens: in=${usage.input_tokens} out=${usage.output_tokens} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`);
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

  getModel(): string {
    return this.model;
  }
}
