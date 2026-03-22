import { EventEmitter } from 'events';
import { AiProvider, AiMessage, AiStreamEvent, getTextContent } from './ai-provider';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { buildContextMessage, getSystemPrompt, isLiteModel } from './prompt-templates';

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

  /**
   * Ask the AI with multimodal context: transcript, screenshots (images), and optional user query.
   * Screenshots are sent directly as images to vision models — no OCR needed.
   */
  async ask(
    transcript: string,
    screenshots: string[],
    userQuery?: string,
    interviewMode?: string,
    resume?: string,
    jobDescription?: string
  ): Promise<void> {
    if (!this.activeProvider) {
      this.emit('error', 'No AI provider configured');
      return;
    }

    if (this.isStreaming) {
      this.activeProvider.cancelStream();
    }

    const model = this.activeProvider.getModel();
    const systemPrompt = getSystemPrompt(interviewMode || 'general', resume, jobDescription, model);

    // For lite models in leetcode mode, determine phase externally from history
    let litePhase: number | undefined;
    if (interviewMode === 'leetcode' && isLiteModel(model)) {
      const assistantMsgCount = this.conversationHistory.filter(m => m.role === 'assistant').length;
      litePhase = assistantMsgCount === 0 ? 1 : 2;
      console.log(`[ai-manager] lite model (${model}) — external phase: ${litePhase} (${assistantMsgCount} prior assistant msgs)`);
    }

    const contextContent = buildContextMessage(transcript, screenshots, userQuery, interviewMode, litePhase);

    // Log conversation history state
    const historySlice = this.conversationHistory.slice(-10);
    console.log(`[ai-manager] conversation history: ${this.conversationHistory.length} total msgs, using last ${historySlice.length}`);
    historySlice.forEach((msg, i) => {
      const preview = typeof msg.content === 'string'
        ? msg.content.slice(0, 100).replace(/\n/g, '\\n')
        : msg.content.map(c => c.type === 'text' ? `text(${c.text.length})` : `img`).join(', ');
      console.log(`[ai-manager]   history[${i}] ${msg.role}: "${preview}${typeof msg.content === 'string' && msg.content.length > 100 ? '...' : ''}"`);
    });

    const messages: AiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historySlice,
      { role: 'user', content: contextContent }
    ];

    console.log(`[ai-manager] sending ${messages.length} messages to provider (1 system + ${historySlice.length} history + 1 new user)`);

    this.currentResponse = '';
    this.isStreaming = true;
    this.emit('stream-start');

    // Store a text-only version for conversation history (don't re-send images)
    const historyText = contextContent
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    await this.activeProvider.streamChat(messages, (event: AiStreamEvent) => {
      switch (event.type) {
        case 'token':
          this.currentResponse += event.content;
          this.emit('token', event.content);
          break;
        case 'done':
          this.isStreaming = false;
          // Store text-only in history to avoid re-sending large base64 images
          this.conversationHistory.push(
            { role: 'user', content: historyText },
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
