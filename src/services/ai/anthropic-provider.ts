import Anthropic from '@anthropic-ai/sdk';
import { Agent as HttpsAgent } from 'node:https';
import { AiProvider, AiMessage, AiStreamEvent } from './ai-provider';

const ANTHROPIC_TIMEOUT_MS = 120_000;

function describeError(error: unknown, model: string): string {
  // Do not surface raw SDK errors: upstream errors can contain request data.
  const details = error as { status?: number; name?: string; cause?: { code?: string } } | null;
  switch (details?.status) {
    case 400: case 422:
      return 'Anthropic rejected this request. Check the Claude model ID, model access, and context size in Settings.';
    case 401:
      return 'Anthropic rejected the API key. Check the Anthropic API key in Settings.';
    case 402:
      return 'Anthropic billing is not active for this API key. Check your Anthropic Console billing and credits.';
    case 403:
      return 'Anthropic access denied. Check your workspace permissions and Claude model access.';
    case 404:
      return `Anthropic model "${model}" is not available to this account. Enter another model ID in Settings.`;
    case 413:
      return 'Anthropic request is too large. Clear context or capture fewer screens.';
    case 429:
      return 'Anthropic rate or quota limit reached. Wait before retrying and check your Anthropic usage limits.';
    case 529:
      return 'Anthropic is overloaded. Try again shortly.';
  }
  if (details?.status && details.status >= 500) return 'Anthropic is temporarily unavailable. Try again shortly.';
  if (details?.name === 'APIConnectionTimeoutError' || details?.cause?.code === 'ETIMEDOUT') {
    return 'Anthropic timed out. Check your internet connection or firewall and try again.';
  }
  return 'Could not connect to Anthropic. Check your internet connection, firewall, and Anthropic settings.';
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private apiKey: string;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-5-20250929') {
    this.apiKey = '';
    this.model = model.trim();
    this.setApiKey(apiKey);
  }

  private createClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      timeout: ANTHROPIC_TIMEOUT_MS,
      maxRetries: 1,
      // The default SDK route stalls on some Macs when the IPv6 route is
      // advertised but unavailable. The working IPv4 route remains encrypted.
      ...(process.platform === 'darwin' ? { httpAgent: new HttpsAgent({ family: 4 }) } : {})
    });
  }

  async streamChat(messages: AiMessage[], onEvent: (event: AiStreamEvent) => void): Promise<void> {
    this.cancelStream();
    if (!this.client || !this.model) {
      onEvent({ type: 'error', content: 'Set an Anthropic API key and Claude model in Settings → AI Provider.' });
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    // Separate system message from conversation
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.images?.length
        ? [{ type: 'text' as const, text: m.content }, ...m.images.map(image => ({
          type: 'image' as const, source: { type: 'base64' as const,
            media_type: (image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg',
            data: image.slice(image.indexOf(',') + 1) }
        }))] : m.content }));

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 2048,
          system: systemMsg?.content || '',
          messages: chatMessages
        },
        { signal: controller.signal }
      );

      let hasContent = false;
      for await (const event of stream) {
        if (controller.signal.aborted) return;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          hasContent = true;
          onEvent({ type: 'token', content: event.delta.text });
        }
      }

      if (controller.signal.aborted) return;
      if (hasContent) onEvent({ type: 'done', content: '' });
      else onEvent({ type: 'error', content: 'Anthropic did not return a text answer. Try again or choose another model.' });
    } catch (error) {
      if (!controller.signal.aborted) onEvent({ type: 'error', content: describeError(error, this.model) });
    } finally {
      // An older cancelled request must not clear a newer request's controller.
      if (this.abortController === controller) this.abortController = null;
    }
  }

  cancelStream(): void {
    this.abortController?.abort();
  }

  isConfigured(): boolean {
    return !!this.client && !!this.model;
  }

  async supportsImages(): Promise<boolean> { return this.isConfigured(); }

  setApiKey(key: string): void {
    this.apiKey = key.trim();
    this.client = this.apiKey ? this.createClient(this.apiKey) : null;
  }

  setModel(model: string): void {
    this.model = model.trim();
  }

  getModel(): string { return this.model; }
}
