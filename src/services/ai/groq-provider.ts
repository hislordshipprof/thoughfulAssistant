import OpenAI from 'openai';
import { AiProvider, AiMessage, AiStreamEvent, MessageContent } from './ai-provider';

const GROQ_VISION_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct'];

function supportsVision(model: string): boolean {
  return GROQ_VISION_MODELS.some(m => model.includes(m));
}

type GroqContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
>;

function toGroqContent(content: string | MessageContent[], model: string): GroqContent {
  if (typeof content === 'string') return content;

  if (supportsVision(model)) {
    return content.map(block => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      return {
        type: 'image_url' as const,
        image_url: { url: block.dataUrl, detail: 'auto' as const }
      };
    });
  }

  // Non-vision models — extract text only, replace images with notice
  const hasImages = content.some(b => b.type === 'image');
  const result: Array<{ type: 'text'; text: string }> = [];
  for (const block of content) {
    if (block.type === 'text') {
      result.push({ type: 'text' as const, text: block.text });
    } else {
      result.push({
        type: 'text' as const,
        text: '[Image omitted — this model does not support vision. The screenshot content is not available. Do NOT guess or hallucinate the problem. Only respond based on text context provided (transcript, typed notes). If no text context describes the problem, say you cannot see the screen and need a vision-capable model.]'
      });
    }
  }
  if (hasImages) {
    console.warn(`[groq] WARNING: ${model} does not support vision — ${content.filter(b => b.type === 'image').length} image(s) replaced with text notice`);
  }
  if (result.length === 1) return result[0].text;
  return result;
}

export class GroqProvider implements AiProvider {
  readonly name = 'groq';
  private client: OpenAI | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'meta-llama/llama-4-scout-17b-16e-instruct') {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
      });
    }
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    if (!this.client) {
      onEvent({ type: 'error', content: 'Groq API key not configured' });
      return;
    }

    this.abortController = new AbortController();

    try {
      const groqMessages = messages.map(m => ({
        role: m.role,
        content: toGroqContent(m.content, this.model)
      }));

      const tApiStart = performance.now();
      console.log(`[groq-timing] sending request to ${this.model}...`);

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: groqMessages as any,
          stream: true,
          temperature: 0.7,
          max_completion_tokens: 8192
        },
        { signal: this.abortController.signal }
      );

      const tStreamCreated = performance.now();
      console.log(`[groq-timing] stream created: ${(tStreamCreated - tApiStart).toFixed(0)}ms`);

      let firstToken = true;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          if (firstToken) {
            console.log(`[groq-timing] first token: ${(performance.now() - tApiStart).toFixed(0)}ms`);
            firstToken = false;
          }
          onEvent({ type: 'token', content: delta });
        }
      }

      console.log(`[groq-timing] stream complete: ${(performance.now() - tApiStart).toFixed(0)}ms`);
      onEvent({ type: 'done', content: '' });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      onEvent({ type: 'error', content: err.message || 'Groq streaming error' });
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
    this.client = key ? new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' }) : null;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }
}
