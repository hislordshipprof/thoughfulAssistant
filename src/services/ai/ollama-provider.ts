import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';

export interface OllamaModelInfo {
  name: string;
  model: string;
  size: number;
  modifiedAt?: string;
  details?: {
    family?: string;
    parameterSize?: string;
    quantizationLevel?: string;
    contextLength?: number;
  };
}

export interface OllamaStatus {
  connected: boolean;
  version?: string;
  models: OllamaModelInfo[];
  error?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string };
    return data.error || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

export async function getOllamaStatus(baseUrl: string): Promise<OllamaStatus> {
  const url = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const [versionResponse, tagsResponse] = await Promise.all([
      fetch(`${url}/api/version`, { signal: controller.signal }),
      fetch(`${url}/api/tags`, { signal: controller.signal })
    ]);

    if (!versionResponse.ok) throw new Error(await readError(versionResponse));
    if (!tagsResponse.ok) throw new Error(await readError(tagsResponse));

    const versionData = await versionResponse.json() as { version?: string };
    const tagsData = await tagsResponse.json() as {
      models?: Array<{
        name: string;
        model?: string;
        size?: number;
        modified_at?: string;
        details?: {
          family?: string;
          parameter_size?: string;
          quantization_level?: string;
          context_length?: number;
        };
      }>;
    };

    return {
      connected: true,
      version: versionData.version,
      models: (tagsData.models || []).map(model => ({
        name: model.name,
        model: model.model || model.name,
        size: model.size || 0,
        modifiedAt: model.modified_at,
        details: model.details ? {
          family: model.details.family,
          parameterSize: model.details.parameter_size,
          quantizationLevel: model.details.quantization_level,
          contextLength: model.details.context_length
        } : undefined
      }))
    };
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'Timed out connecting to Ollama'
      : (error?.message || 'Unable to connect to Ollama');
    return { connected: false, models: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private abortController: AbortController | null = null;
  private visionCapability: Promise<boolean> | null = null;

  supportsImages(): Promise<boolean> {
    if (!this.visionCapability) {
      this.visionCapability = fetch(`${this.baseUrl}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }), signal: AbortSignal.timeout(5000)
      }).then(async response => {
        if (!response.ok) return false;
        const data = await response.json() as { capabilities?: string[] };
        return data.capabilities?.includes('vision') === true;
      }).catch(() => false);
    }
    return this.visionCapability;
  }

  constructor(baseUrl: string, model: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model.trim();
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    if (!this.isConfigured()) {
      onEvent({ type: 'error', content: 'Ollama URL and model are required' });
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    let completed = false;

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map(message => ({ role: message.role, content: message.content,
            ...(message.images?.length ? { images: message.images.map(image => image.replace(/^data:image\/[^;]+;base64,/, '')) } : {}) })),
          stream: true,
          options: {
            temperature: 0.7,
            num_predict: 2048
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }
      if (!response.body) {
        throw new Error('Ollama returned an empty response stream');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        if (!line.trim()) return;
        const chunk = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.message?.content) {
          onEvent({ type: 'token', content: chunk.message.content });
        }
        if (chunk.done) completed = true;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      }

      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
      if (!controller.signal.aborted) {
        onEvent({ type: 'done', content: '' });
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      const prefix = completed ? 'Ollama stream ended unexpectedly' : 'Ollama request failed';
      onEvent({ type: 'error', content: `${prefix}: ${error?.message || 'Unknown error'}` });
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  cancelStream(): void {
    this.abortController?.abort();
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  setModel(model: string): void {
    this.model = model.trim();
    this.visionCapability = null;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.visionCapability = null;
  }

  getModel(): string {
    return this.model;
  }
}
