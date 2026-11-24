import { EventEmitter } from 'events';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OllamaProvider } from './ollama-provider';
import { GroqProvider } from './groq-provider';
import { buildContextMessage, getSystemPrompt, type SystemPromptMode } from './prompt-templates';

export class AiManager extends EventEmitter {
  private providers: Map<string, AiProvider> = new Map();
  private activeProvider: AiProvider | null = null;
  private conversationHistory: AiMessage[] = [];
  private currentResponse = '';
  private isStreaming = false;
  private extraContext = '';
  private streamRevision = 0;
  private streamingProvider: AiProvider | null = null;

  constructor() {
    super();
  }

  initializeProviders(
    openaiKey: string,
    anthropicKey: string,
    openaiModel?: string,
    anthropicModel?: string,
    ollamaUrl?: string,
    ollamaModel?: string,
    groqKey: string = '',
    groqModel?: string
  ): void {
    if (openaiKey) {
      this.providers.set('openai', new OpenAiProvider(openaiKey, openaiModel));
    }
    if (anthropicKey) {
      this.providers.set('anthropic', new AnthropicProvider(anthropicKey, anthropicModel));
    }
    if (ollamaUrl && ollamaModel) {
      this.providers.set('ollama', new OllamaProvider(ollamaUrl, ollamaModel));
    }
    this.providers.set('groq', new GroqProvider(groqKey, groqModel));

    // Default to OpenAI, fallback to Anthropic
    this.activeProvider = this.providers.get('openai') || this.providers.get('anthropic') || this.providers.get('ollama') || null;
  }

  setModel(provider: string, model: string): void {
    const p = this.providers.get(provider);
    if (p) {
      (p as any).setModel(model);
      console.log(`[ai] ${provider} model set to: ${model}`);
    }
  }

  setActiveProvider(name: string): boolean {
    const provider = this.providers.get(name);
    // Keep the user's selection even when it is missing credentials. Never
    // silently transmit their context to the previously selected provider.
    if (this.activeProvider !== (provider || null) && this.isStreaming) this.cancelStream();
    this.activeProvider = provider || null;
    return !!provider?.isConfigured();
  }

  getConfigurationError(): string | null {
    if (!this.activeProvider) return 'No AI provider configured. Check Settings → AI Provider.';
    if (!this.activeProvider.isConfigured()) return `Configure the ${this.activeProvider.name} API key and model in Settings → AI Provider.`;
    return null;
  }

  async supportsImages(): Promise<boolean> { return await this.activeProvider?.supportsImages?.() ?? false; }

  async ask(
    transcript: string,
    ocrText: string,
    userQuery?: string,
    interviewMode?: string,
    resume?: string,
    jobDescription?: string,
    images?: string[],
    customSystemPrompt?: string,
    systemPromptMode: SystemPromptMode = 'default'
  ): Promise<void> {
    const configurationError = this.getConfigurationError();
    if (configurationError || !this.activeProvider) {
      this.emit('error', configurationError);
      return;
    }

    this.streamingProvider?.cancelStream();
    const revision = ++this.streamRevision;
    this.streamingProvider = this.activeProvider;

    const systemPrompt = getSystemPrompt(
      interviewMode || 'general',
      resume,
      jobDescription,
      customSystemPrompt,
      systemPromptMode
    );
    const contextMessage = buildContextMessage(transcript, ocrText, userQuery, interviewMode);

    const messages: AiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: contextMessage, ...(images?.length ? { images } : {}) }
    ];

    this.currentResponse = '';
    this.isStreaming = true;
    this.emit('stream-start');

    await this.activeProvider.streamChat(messages, (event: AiStreamEvent) => {
      if (revision !== this.streamRevision || !this.isStreaming) return;
      switch (event.type) {
        case 'token':
          this.currentResponse += event.content;
          this.emit('token', event.content);
          break;
        case 'done':
          this.isStreaming = false;
          this.conversationHistory.push(
            { role: 'user', content: contextMessage },
            { role: 'assistant', content: this.currentResponse }
          );
          this.emit('done', this.currentResponse);
          break;
        case 'error':
          this.isStreaming = false;
          this.emit('error', event.content);
          break;
      }
    });
  }

  cancelStream(): void {
    this.streamRevision++;
    this.streamingProvider?.cancelStream();
    this.streamingProvider = null;
    this.isStreaming = false;
    this.emit('cancelled');
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  getActiveProviderName(): string | null {
    if (this.activeProvider instanceof OllamaProvider || this.activeProvider instanceof GroqProvider) {
      return `${this.activeProvider.name} · ${this.activeProvider.getModel()}`;
    }
    return this.activeProvider?.name || null;
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys()).filter(k => this.providers.get(k)?.isConfigured());
  }

  setExtraContext(text: string): void {
    this.extraContext = text;
  }

  getExtraContext(): string {
    return this.extraContext;
  }

  updateApiKey(provider: string, key: string): void {
    const existing = this.providers.get(provider);
    if (existing) {
      (existing as any).setApiKey(key);
    } else if (provider === 'openai') {
      this.providers.set('openai', new OpenAiProvider(key));
    } else if (provider === 'anthropic') {
      this.providers.set('anthropic', new AnthropicProvider(key));
    } else if (provider === 'groq') {
      this.providers.set('groq', new GroqProvider(key));
    }
  }

  configureOllama(baseUrl: string, model: string): void {
    const existing = this.providers.get('ollama') as OllamaProvider | undefined;
    if (existing) {
      existing.setBaseUrl(baseUrl);
      existing.setModel(model);
    } else {
      this.providers.set('ollama', new OllamaProvider(baseUrl, model));
    }
  }
}
