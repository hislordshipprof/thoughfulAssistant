import { EventEmitter } from 'events';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { buildContextMessage, getSystemPrompt } from './prompt-templates';

export class AiManager extends EventEmitter {
  private providers: Map<string, AiProvider> = new Map();
  private activeProvider: AiProvider | null = null;
  private conversationHistory: AiMessage[] = [];
  private currentResponse = '';
  private isStreaming = false;
  private extraContext = '';

  constructor() {
    super();
  }

  initializeProviders(openaiKey: string, anthropicKey: string, openaiModel?: string, anthropicModel?: string): void {
    if (openaiKey) {
      this.providers.set('openai', new OpenAiProvider(openaiKey, openaiModel));
    }
    if (anthropicKey) {
      this.providers.set('anthropic', new AnthropicProvider(anthropicKey, anthropicModel));
    }

    // Default to OpenAI, fallback to Anthropic
    this.activeProvider = this.providers.get('openai') || this.providers.get('anthropic') || null;
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
    if (provider && provider.isConfigured()) {
      this.activeProvider = provider;
      return true;
    }
    return false;
  }

  async ask(transcript: string, ocrText: string, userQuery?: string, interviewMode?: string, resume?: string, jobDescription?: string): Promise<void> {
    if (!this.activeProvider) {
      this.emit('error', 'No AI provider configured');
      return;
    }

    if (this.isStreaming) {
      this.activeProvider.cancelStream();
    }

    const systemPrompt = getSystemPrompt(interviewMode || 'general', resume, jobDescription);
    const contextMessage = buildContextMessage(transcript, ocrText, userQuery, interviewMode);

    const messages: AiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: contextMessage }
    ];

    this.currentResponse = '';
    this.isStreaming = true;
    this.emit('stream-start');

    await this.activeProvider.streamChat(messages, (event: AiStreamEvent) => {
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
    this.activeProvider?.cancelStream();
    this.isStreaming = false;
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  getActiveProviderName(): string | null {
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
    }
  }
}
