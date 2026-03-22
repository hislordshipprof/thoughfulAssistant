/** A single text block in a message */
export interface TextContent {
  type: 'text';
  text: string;
}

/** A single image block in a message (base64 data URL) */
export interface ImageContent {
  type: 'image';
  dataUrl: string; // data:image/jpeg;base64,... or data:image/png;base64,...
}

export type MessageContent = TextContent | ImageContent;

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContent[];
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
  getModel(): string;
}

/** Helper to extract plain text from a message's content */
export function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}
