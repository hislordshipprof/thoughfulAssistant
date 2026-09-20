import OpenAI from 'openai';
import { AiProvider, AiMessage, AiStreamEvent, MessageContent, StreamOptions } from './ai-provider';

/** Model-specific token cap. Falls back to a safe default for unknown models. */
function defaultMaxTokensFor(model: string): number {
  if (model.startsWith('gpt-5')) return 32768;
  if (model.startsWith('gpt-4.1')) return 32768;
  if (model.startsWith('gpt-4o')) return 16384;
  return 8192;
}

/** Whether this model accepts a custom `temperature` parameter.
 *  Some 2026 OpenAI models (GPT-5.5 family + the o-series reasoning models)
 *  only support the default temperature of 1 and reject any custom value
 *  with a 400 error. Source: tested via API in April 2026.
 *  See: https://developers.openai.com/api/docs/models/gpt-5.5 */
function supportsCustomTemperature(model: string): boolean {
  // GPT-5.5 family: gpt-5.5, gpt-5.5-pro
  if (model.startsWith('gpt-5.5')) return false;
  // Reasoning models (o-series): o1, o3, o4 — temperature locked at 1
  if (/^o\d/.test(model)) return false;
  // Everything else (gpt-5.4, gpt-5, gpt-4.1, gpt-4o, gpt-4.5) accepts custom temperature
  return true;
}

type OpenAiContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' | 'auto' } }
>;

function toOpenAiContent(content: string | MessageContent[]): OpenAiContent {
  if (typeof content === 'string') return content;

  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    // image — pass data URL directly, GPT-4.1/4o accepts base64 data URLs.
    // detail is explicit 'high' (not 'auto'): screenshots carry dense MCQ/code
    // text that must stay legible to the model. Images are already downscaled to
    // the vision profile's maxDim in screen-capture.ts, so 'high' tiling is
    // bounded there rather than left to a model-side heuristic.
    return {
      type: 'image_url' as const,
      image_url: { url: block.dataUrl, detail: 'high' as const }
    };
  });
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'gpt-5.4') {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async streamChat(
    messages: AiMessage[],
    onEvent: (event: AiStreamEvent) => void,
    options: StreamOptions = {}
  ): Promise<void> {
    if (!this.client) {
      onEvent({ type: 'error', content: 'OpenAI API key not configured' });
      return;
    }

    this.abortController = new AbortController();

    try {
      const openAiMessages = messages.map(m => ({
        role: m.role,
        content: toOpenAiContent(m.content)
      }));

      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens ?? defaultMaxTokensFor(this.model);
      const acceptsTemperature = supportsCustomTemperature(this.model);

      const tApiStart = performance.now();
      console.log(`[openai-timing] sending request to ${this.model} (temp=${acceptsTemperature ? temperature : 'default(1)'}, max=${maxTokens})...`);

      const createParams = {
        model: this.model,
        messages: openAiMessages as any,
        stream: true as const,
        // GPT-5.5 family + o-series reject any custom temperature with 400.
        // Omit the parameter for those models so they use the default (1).
        ...(acceptsTemperature ? { temperature } : {}),
        max_completion_tokens: maxTokens
      };
      // Route requests that share a system-prompt prefix to the same cache
      // shard. The prefix (large system prompt) is identical per mode, so
      // keying on mode maximises automatic prefix-cache hits and TTFT.
      // prompt_cache_key is a valid REST param but untyped in openai@4.104, so
      // it's attached via cast — the typed fields above keep the streaming
      // overload (and the async-iterable return type) intact.
      (createParams as any).prompt_cache_key = `overlay-${options.mode || 'general'}`;

      const stream = await this.client.chat.completions.create(
        createParams,
        { signal: this.abortController.signal }
      );

      const tStreamCreated = performance.now();
      console.log(`[openai-timing] stream created: ${(tStreamCreated - tApiStart).toFixed(0)}ms`);

      let firstToken = true;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          if (firstToken) {
            console.log(`[openai-timing] first token: ${(performance.now() - tApiStart).toFixed(0)}ms`);
            firstToken = false;
          }
          onEvent({ type: 'token', content: delta });
        }
      }

      console.log(`[openai-timing] stream complete: ${(performance.now() - tApiStart).toFixed(0)}ms`);
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

  getModel(): string {
    return this.model;
  }
}
