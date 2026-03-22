import OpenAI from 'openai';
import { AiProvider, AiMessage, AiStreamEvent, MessageContent, getTextContent } from './ai-provider';

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
    // image — pass data URL directly, GPT-4.1/4o accepts base64 data URLs
    return {
      type: 'image_url' as const,
      image_url: { url: block.dataUrl, detail: 'auto' as const }
    };
  });
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'gpt-4.1') {
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
      const openAiMessages = messages.map(m => ({
        role: m.role,
        content: toOpenAiContent(m.content)
      }));

      const tApiStart = performance.now();
      console.log(`[openai-timing] sending request to ${this.model}...`);

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: openAiMessages as any,
          stream: true,
          temperature: 0.7,
          max_completion_tokens: 16384
        },
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
