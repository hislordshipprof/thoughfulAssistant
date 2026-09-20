import Anthropic from '@anthropic-ai/sdk';
import { AiProvider, AiMessage, AiStreamEvent, MessageContent, StreamOptions, getTextContent } from './ai-provider';

/** Per-model output token cap. Anthropic accepts up to these limits in 2026.
 *  Source: https://platform.claude.com/docs/en/about-claude/models/overview */
function defaultMaxTokensFor(model: string): number {
  if (model.startsWith('claude-opus-4-7') || model.startsWith('claude-opus-4-6')) return 32000;
  if (model.startsWith('claude-opus')) return 32000;
  if (model.startsWith('claude-sonnet-4-6') || model.startsWith('claude-sonnet-4-5')) return 64000;
  if (model.startsWith('claude-sonnet')) return 8192;
  if (model.startsWith('claude-haiku-4')) return 16000;
  return 8192;
}

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

  constructor(apiKey: string, model: string = 'claude-sonnet-4-6') {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async streamChat(
    messages: AiMessage[],
    onEvent: (event: AiStreamEvent) => void,
    options: StreamOptions = {}
  ): Promise<void> {
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

    // Multi-turn caching: mark the last assistant turn (if any) as a second
    // cache breakpoint so the conversation prefix (system + earlier turns)
    // hits cache on follow-up requests. The current user turn always misses.
    // Anthropic supports up to 4 breakpoints; we use 2 (system + history tail).
    const lastAssistantIdx = (() => {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role === 'assistant') return i;
      }
      return -1;
    })();
    if (lastAssistantIdx >= 0) {
      const msg = chatMessages[lastAssistantIdx];
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text' as const, text: msg.content, cache_control: { type: 'ephemeral' as const } } as any];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const last = msg.content[msg.content.length - 1] as any;
        last.cache_control = { type: 'ephemeral' };
      }
    }

    try {
      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens ?? defaultMaxTokensFor(this.model);

      const tApiStart = performance.now();
      console.log(`[anthropic-timing] sending request to ${this.model} (temp=${temperature}, max=${maxTokens})...`);

      // System prompt is marked cacheable — 5-min ephemeral TTL refreshes free
      // on every hit. Min cacheable length: Sonnet 4.6 = 2048 tok, Opus 4.7 = 4096.
      //
      // The epoch summary (appended by ai-manager for long conversations) is
      // VOLATILE — it changes as the conversation grows. If it sat inside the
      // cached block, every summary change would invalidate the whole ~17k-token
      // prompt prefix and force a full re-prefill. So we split at the epoch
      // marker: the stable prefix carries the cache breakpoint, and the volatile
      // summary follows it as a separate, uncached block.
      const systemText = systemMsg ? getTextContent(systemMsg.content) : '';
      const EPOCH_MARKER = '<earlier_conversation';
      let systemParam: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[];
      const epochIdx = systemText.indexOf(EPOCH_MARKER);
      if (epochIdx > 0) {
        const stablePrefix = systemText.slice(0, epochIdx).trimEnd();
        const volatileSuffix = systemText.slice(epochIdx);
        systemParam = [
          { type: 'text' as const, text: stablePrefix, cache_control: { type: 'ephemeral' as const } },
          { type: 'text' as const, text: volatileSuffix } // uncached — changes per turn
        ];
      } else {
        systemParam = systemText
          ? [{ type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } }]
          : [];
      }

      const supportsTemperature = !this.model.includes('claude-opus-4-7');
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: maxTokens,
          ...(supportsTemperature ? { temperature } : {}),
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
