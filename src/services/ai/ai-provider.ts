export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiStreamEvent {
  type: 'token' | 'done' | 'error';
  content: string;
}

export interface AiProvider {
  readonly name: string;
  streamChat(
    messages: AiMessage[],
    onEvent: (event: AiStreamEvent) => void
  ): Promise<void>;
  cancelStream(): void;
  isConfigured(): boolean;
}
