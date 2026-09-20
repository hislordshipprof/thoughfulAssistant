import { EventEmitter } from 'events';
import { AiProvider, AiMessage, AiStreamEvent, StreamOptions } from './ai-provider';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GroqProvider } from './groq-provider';
import { buildContextMessage, getSystemPrompt, isLiteModel } from './prompt-templates';
import { buildEpochSummaryBlock, buildAntiRepetitionBlock, buildTopicGapBlock } from './prompts/shared';

/** Per-mode generation tuning. Lower temp for code/factual tasks where
 *  hallucinated line numbers or wrong traces are costly; higher for open
 *  conversation where some variation reads more natural. */
function tuningFor(mode: string | undefined): { temperature: number } {
  switch (mode) {
    case 'leetcode':
    case 'code_modification':
      return { temperature: 0.2 };
    case 'system_design':
      return { temperature: 0.4 };
    case 'general':
      // General mode is dominated by MCQ / factual screen-help where
      // accuracy and consistency matter much more than variation. Same
      // question must give the same answer.
      return { temperature: 0.2 };
    case 'behavioural':
      // Higher temp for natural conversational variation in interview Q&A.
      return { temperature: 0.7 };
    default:
      // Unknown mode — moderate default
      return { temperature: 0.5 };
  }
}

/** Decide whether to inject the anti-repetition block for the active mode.
 *  Anti-repetition tells the model "don't repeat your previous answers" —
 *  helpful when fresh angles are desirable across turns, harmful when the
 *  same question (e.g. MCQ on the same screenshot) deserves the same answer.
 *
 *  ON for: behavioural (vary projects across Q&A), system_design (phase 4+
 *    deep-dives benefit from fresh angles), leetcode/code_modification follow-ups,
 *    general (coding follow-ups need fresh responses, not full re-generation;
 *    MCQ answers are unaffected because the correct letter stays the same).
 */
function shouldUseAntiRepetition(_mode: string | undefined): boolean {
  return true;
}

/** Per-mode hard cap on conversation history messages. Independent of the
 *  char-budget pruning in buildSmartHistory — this kicks in even when there's
 *  budget room left, because for some modes long history is bias not context.
 *
 *  General mode: each ask is typically a fresh screenshot (different MCQ,
 *  different page). Long history of prior answers biases the model and adds
 *  no useful context. Cap to last 4 exchanges (8 messages).
 *
 *  Other modes: no extra cap — char-budget pruning handles it. Interview
 *  modes benefit from full conversational continuity within budget.
 */
function capHistoryForMode(history: AiMessage[], mode: string | undefined): AiMessage[] {
  if (mode === 'general') {
    const MAX_GENERAL_MSGS = 8;
    if (history.length > MAX_GENERAL_MSGS) {
      return history.slice(-MAX_GENERAL_MSGS);
    }
  }
  return history;
}

/** Max chars for the epoch summary of old compressed messages */
const EPOCH_SUMMARY_MAX_CHARS = 2000;
/** Time gap (ms) after which we assume the interviewer may have changed topics */
const NEW_TOPIC_GAP_MS = 5 * 60 * 1000;
/** Hard cap on conversation history entries to prevent unbounded growth.
 *  500 entries = 250 exchanges — more than any interview will produce.
 *  buildSmartHistory() handles the real pruning per model budget. */
const MAX_HISTORY_ENTRIES = 500;

export class AiManager extends EventEmitter {
  private providers: Map<string, AiProvider> = new Map();
  private activeProvider: AiProvider | null = null;
  private streamingProvider: AiProvider | null = null;
  private conversationHistory: AiMessage[] = [];
  private currentResponse = '';
  private isStreaming = false;
  private extraContext = '';
  private epochSummary: string | null = null;
  private lastRequestTimestamp = 0;
  /** Monotonic attempt counter. Incremented at the start of every ask() and
   *  every cancelStream(). Token callbacks check the captured attempt id and
   *  discard tokens from stale attempts — prevents abandoned provider streams
   *  from interleaving into the UI when failover or re-entry happens. */
  private activeAttemptId = 0;

  constructor() {
    super();
  }

  initializeProviders(openaiKey: string, anthropicKey: string, openaiModel?: string, anthropicModel?: string, groqKey?: string, groqModel?: string): void {
    if (openaiKey) {
      this.providers.set('openai', new OpenAiProvider(openaiKey, openaiModel));
    }
    if (anthropicKey) {
      this.providers.set('anthropic', new AnthropicProvider(anthropicKey, anthropicModel));
    }
    if (groqKey) {
      this.providers.set('groq', new GroqProvider(groqKey, groqModel));
    }

    // Default to OpenAI, fallback to Anthropic, then Groq
    this.activeProvider = this.providers.get('openai') || this.providers.get('anthropic') || this.providers.get('groq') || null;
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
   * Build the fallback chain: active provider first, then all other configured providers.
   */
  private getFallbackChain(): AiProvider[] {
    const chain: AiProvider[] = [];
    if (this.activeProvider?.isConfigured()) {
      chain.push(this.activeProvider);
    }
    for (const [, provider] of this.providers) {
      if (provider.isConfigured() && provider !== this.activeProvider) {
        chain.push(provider);
      }
    }
    return chain;
  }

  /**
   * Compute explicit phase for phased interview modes.
   * All models get explicit phase — self-detection is unreliable and causes phase bleed.
   */
  private computePhase(interviewMode: string): number | undefined {
    if (!(interviewMode === 'leetcode' || interviewMode === 'system_design' || interviewMode === 'code_modification')) return undefined;

    const assistantMsgCount = this.conversationHistory.filter(m => m.role === 'assistant').length;
    if (interviewMode === 'system_design') {
      // Phase 1: scope qs, Phase 2: requirements + estimation, Phase 3:
      // architecture + diagram, Phase 4+: adaptive deep-dive (no re-draw).
      if (assistantMsgCount === 0) return 1;
      if (assistantMsgCount === 1) return 2;
      if (assistantMsgCount === 2) return 3;
      return 4;
    } else if (interviewMode === 'code_modification') {
      // Phase 1: analysis, Phase 2: fixes, Phase 3+: follow-up
      if (assistantMsgCount === 0) return 1;
      if (assistantMsgCount === 1) return 2;
      return 3;
    } else {
      // Leetcode: Phase 1 once, then Phase 2
      return assistantMsgCount === 0 ? 1 : 2;
    }
  }

  /**
   * Model-aware character budget for conversation history.
   *
   * Sized so that a full interview (~45-90 min) fits without epoch pruning
   * on premium models. Even the smallest context window (gpt-4o at 128K tokens
   * ≈ 512K chars) leaves ample room after system prompt (~10K tokens) and
   * current-turn context (transcript + screenshots ≈ 10-15K tokens).
   *
   * Tier 1 — Premium (full-prompt models): 200K chars (~50K tokens)
   *   gpt-5.4 (1M ctx), gpt-4.1 (1M), gpt-4o (128K),
   *   claude-sonnet-4-5 (200K), claude-opus-4-6 (1M)
   *   Covers an entire 90-min interview without epoch summaries on 1M models.
   *   On 128K models (gpt-4o) uses ~40% of context — still very comfortable.
   *
   * Tier 2 — Standard (lite models): 80K chars (~20K tokens)
   *   gpt-5.4-mini (1M), gpt-4.1-mini (1M), gpt-4o-mini (128K),
   *   claude-haiku-4-5 (200K), gpt-oss-120b
   *   Covers most interviews. Epoch summaries kick in only for very long sessions.
   *
   * Tier 3 — Compact (Groq): 30K chars (~7.5K tokens)
   *   llama-4-scout-17b (128K on Groq) — rate-limited, optimize for speed.
   *   Still enough for ~15-20 full exchanges of context.
   */
  private getHistoryCharBudget(model: string, provider: string): number {
    if (provider === 'groq') return 30000;
    if (!isLiteModel(model)) return 200000;
    return 80000;
  }

  /**
   * Build smart history with character-budget windowing.
   * Replaces the old `slice(-10)` — adapts to message length so short exchanges
   * get more history depth while long exchanges stay within token limits.
   * Messages that fall outside the budget are compressed into an epoch summary.
   */
  private buildSmartHistory(charBudget: number): AiMessage[] {
    const history = this.conversationHistory;
    if (history.length === 0) {
      this.epochSummary = null;
      return [];
    }

    const recent: AiMessage[] = [];
    let usedChars = 0;
    let cutoffIndex = -1;

    // Walk backward from newest, accumulate within budget
    for (let i = history.length - 1; i >= 0; i--) {
      const msgChars = this.getMessageCharCount(history[i]);

      if (usedChars + msgChars > charBudget && recent.length > 0) {
        cutoffIndex = i;
        break;
      }

      recent.unshift(history[i]);
      usedChars += msgChars;
    }

    // Compress messages that didn't fit into an epoch summary, then prune them.
    // Apply mutations atomically to avoid race with concurrent ask() calls.
    if (cutoffIndex >= 0) {
      const oldMessages = history.slice(0, cutoffIndex + 1);
      const newEpoch = this.compressToEpochSummary(oldMessages);
      const prunedHistory = history.slice(cutoffIndex + 1);
      this.epochSummary = newEpoch;
      this.conversationHistory = prunedHistory;
    } else {
      this.epochSummary = null;
    }

    console.log(`[ai-manager] smart history: ${recent.length}/${this.conversationHistory.length} msgs within ${usedChars} char budget, epoch summary: ${this.epochSummary ? this.epochSummary.length + ' chars' : 'none'}`);

    return recent;
  }

  /** Get character count of text content in a message (ignores images). */
  private getMessageCharCount(msg: AiMessage): number {
    if (typeof msg.content === 'string') return msg.content.length;
    return msg.content
      .filter(c => c.type === 'text')
      .reduce((sum, c) => sum + c.text.length, 0);
  }

  /**
   * Compress old messages into a concise epoch summary.
   * Preserves problem statements, key decisions, and approach summaries
   * while stripping metadata headers and phase instructions.
   */
  private compressToEpochSummary(messages: AiMessage[]): string {
    const lines: string[] = [];
    let totalChars = 0;

    for (let i = 0; i < messages.length && totalChars < EPOCH_SUMMARY_MAX_CHARS; i++) {
      const msg = messages[i];
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ');

      // Give more space to early messages (problem statement, initial approach)
      const isEarly = i < 4;
      const maxLineChars = isEarly ? 400 : 200;

      if (msg.role === 'user') {
        // Extract meaningful content, skip XML wrappers and injected metadata
        const meaningful = text.split('\n')
          .filter(l => {
            const t = l.trim();
            return t.length > 15
              && !t.startsWith('<')         // XML tag opens / closes
              && !t.startsWith('##')        // legacy markdown headers
              && !t.startsWith('[PRIORITY')
              && !t.startsWith('```')
              && !t.startsWith('Speaker labels:')
              && !t.startsWith('These labels are based');
          })
          .slice(0, isEarly ? 3 : 1);

        if (meaningful.length > 0) {
          const line = `[Context] ${meaningful.join(' ').slice(0, maxLineChars)}`;
          lines.push(line);
          totalChars += line.length;
        }
      } else if (msg.role === 'assistant') {
        // Keep opening lines from assistant responses (approach, key answer)
        const meaningful = text.split('\n')
          .filter(l => l.trim().length > 15 && !l.startsWith('---'))
          .slice(0, isEarly ? 4 : 2);

        if (meaningful.length > 0) {
          const line = `[Your response] ${meaningful.join(' ').slice(0, maxLineChars)}`;
          lines.push(line);
          totalChars += line.length;
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Ask the AI with multimodal context: transcript, screenshots (images), and optional user query.
   * Screenshots are sent directly as images to vision models — no OCR needed.
   * Automatically falls back to the next configured provider if the active one fails before streaming tokens.
   */
  async ask(
    transcript: string,
    screenshots: string[],
    userQuery?: string,
    interviewMode?: string,
    resume?: string,
    jobDescription?: string,
    customPrompt?: string,
    usePromptV2 = false
  ): Promise<void> {
    const fallbackChain = this.getFallbackChain();
    if (fallbackChain.length === 0) {
      this.emit('error', 'No AI provider configured');
      return;
    }

    // Re-entry guard. If a previous ask() is still streaming (user pressed
    // askAi again, or hotkey debouncing failed), cancel it FIRST so its
    // in-flight tokens don't interleave with this new one. Bumping
    // activeAttemptId invalidates all stale callbacks; a microtask tick
    // gives the abort signal a chance to propagate before we set up the
    // new attempt's state.
    if (this.isStreaming) {
      this.activeAttemptId++;
      this.streamingProvider?.cancelStream();
      this.streamingProvider = null;
      this.isStreaming = false;
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    // Each ask() is one logical attempt. Capture the id so callbacks within
    // this invocation can detect if a newer attempt has superseded them.
    const myAttemptId = ++this.activeAttemptId;

    // Track time between requests for new-topic detection
    const now = Date.now();
    const timeSinceLastMs = this.lastRequestTimestamp > 0 ? now - this.lastRequestTimestamp : 0;
    this.lastRequestTimestamp = now;

    this.isStreaming = true;
    this.emit('stream-start');

    let lastError = '';

    for (let i = 0; i < fallbackChain.length; i++) {
      // Stale-attempt guard: if a newer ask() superseded us between iterations,
      // bail out without further work or events.
      if (myAttemptId !== this.activeAttemptId) {
        console.log(`[ai-manager] attempt ${myAttemptId} superseded by ${this.activeAttemptId} — abandoning`);
        return;
      }

      const provider = fallbackChain[i];
      const isLast = i === fallbackChain.length - 1;
      const model = provider.getModel();
      const providerName = provider.name;

      // Model-aware history: budget scales with model capability.
      // Then apply per-mode hard cap (general mode: last 4 exchanges only —
      // each ask is a fresh screen so old history is bias not context).
      const charBudget = this.getHistoryCharBudget(model, providerName);
      const smartHistory = this.buildSmartHistory(charBudget);
      const cappedHistory = capHistoryForMode(smartHistory, interviewMode);
      if (cappedHistory.length < smartHistory.length) {
        console.log(`[ai-manager] mode '${interviewMode}' history cap: ${smartHistory.length} → ${cappedHistory.length} msgs`);
      }

      // Rebuild provider-specific prompt and context (different models may use different prompt variants)
      const litePhase = this.computePhase(interviewMode || 'general');
      if (litePhase !== undefined) {
        console.log(`[ai-manager] ${model} — explicit phase: ${litePhase}`);
      }

      const baseSystemPrompt = getSystemPrompt(interviewMode || 'general', resume, jobDescription, model, providerName, customPrompt, usePromptV2);
      const contextContent = buildContextMessage(transcript, screenshots, userQuery, interviewMode, litePhase, !!resume, !!jobDescription, !!(customPrompt && customPrompt.trim()));

      // Store text-only version BEFORE injecting transient instructions (so they don't persist in history)
      const historyText = contextContent
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      // Inject epoch summary into system prompt for long conversations
      let systemPrompt = baseSystemPrompt;
      if (this.epochSummary) {
        systemPrompt += `\n\n${buildEpochSummaryBlock(this.epochSummary)}`;
        console.log(`[ai-manager] epoch summary injected into system prompt (${this.epochSummary.length} chars)`);
      }

      // Anti-repetition: instruct LLM not to repeat previous responses.
      // GATED by mode — general mode skips this because consistent answers
      // to MCQ/factual questions matter more than fresh angles.
      const assistantCount = this.conversationHistory.filter(m => m.role === 'assistant').length;
      const useAntiRep = assistantCount > 0 && shouldUseAntiRepetition(interviewMode);
      if (useAntiRep) {
        contextContent.push({ type: 'text', text: buildAntiRepetitionBlock(assistantCount) });
      }

      // Time-gap awareness: nudge LLM when interviewer may have changed topics
      if (timeSinceLastMs > NEW_TOPIC_GAP_MS && this.conversationHistory.length > 0) {
        const gapMinutes = Math.round(timeSinceLastMs / 60000);
        contextContent.push({ type: 'text', text: buildTopicGapBlock(gapMinutes) });
        console.log(`[ai-manager] time-gap warning injected (${gapMinutes} min gap)`);
      }

      const messages: AiMessage[] = [
        { role: 'system', content: systemPrompt },
        ...cappedHistory,
        { role: 'user', content: contextContent }
      ];

      console.log(`[ai-manager] trying ${providerName} (${model}) — ${messages.length} msgs (1 system + ${cappedHistory.length} history + 1 user), epoch: ${this.epochSummary ? 'yes' : 'no'}, anti-rep: ${useAntiRep ? 'yes' : 'no'} (mode=${interviewMode || 'general'})`);

      this.currentResponse = '';
      this.streamingProvider = provider;

      // Timing: measure TTFT and total response time
      const t0 = performance.now();
      let firstTokenTime = 0;
      let tokenCount = 0;

      // Per-mode tuning (temperature). max_tokens picks the model-aware default
      // inside the provider unless explicitly overridden here.
      const streamOptions: StreamOptions = {
        ...tuningFor(interviewMode),
        mode: interviewMode,
      };

      // Try streaming with this provider. Every callback is guarded by
      // myAttemptId so late tokens from an abandoned provider (e.g. one
      // that errored but whose underlying HTTP request still completes)
      // are silently discarded instead of interleaving into the UI.
      const error = await new Promise<string | null>((resolve) => {
        let settled = false;
        const safeResolve = (v: string | null) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };

        provider.streamChat(messages, (event: AiStreamEvent) => {
          // Stale-attempt guard: discard everything from a superseded attempt.
          if (myAttemptId !== this.activeAttemptId) return;

          switch (event.type) {
            case 'token':
              tokenCount++;
              if (tokenCount === 1) {
                firstTokenTime = performance.now();
                console.log(`[ai-perf] ⚡ TTFT: ${(firstTokenTime - t0).toFixed(0)}ms (${providerName}/${model})`);
              }
              this.currentResponse += event.content;
              this.emit('token', event.content);
              break;
            case 'done':
              safeResolve(null);
              break;
            case 'error':
              safeResolve(event.content);
              break;
          }
        }, streamOptions).catch((err: Error) => {
          if (myAttemptId !== this.activeAttemptId) return;
          safeResolve(err.message || 'Provider threw an exception');
        });
      });

      // Stale-attempt guard: a newer ask() has taken over while we were
      // awaiting. Don't emit done/error and don't store history.
      if (myAttemptId !== this.activeAttemptId) {
        console.log(`[ai-manager] attempt ${myAttemptId} superseded mid-stream — abandoning`);
        return;
      }

      if (!error) {
        // Log total timing
        const totalMs = performance.now() - t0;
        const streamMs = firstTokenTime > 0 ? totalMs - (firstTokenTime - t0) : 0;
        const charsPerSec = streamMs > 0 ? (this.currentResponse.length / (streamMs / 1000)).toFixed(0) : '?';
        console.log(`[ai-perf] ✅ ${providerName}/${model} — total: ${totalMs.toFixed(0)}ms | TTFT: ${(firstTokenTime - t0).toFixed(0)}ms | stream: ${streamMs.toFixed(0)}ms | ${tokenCount} tokens | ${this.currentResponse.length} chars | ${charsPerSec} chars/s`);

        // Success — store history and finish
        this.isStreaming = false;
        this.streamingProvider = null;
        this.conversationHistory.push(
          { role: 'user', content: historyText },
          { role: 'assistant', content: this.currentResponse }
        );
        // Hard cap: drop oldest entries if history exceeds limit
        if (this.conversationHistory.length > MAX_HISTORY_ENTRIES) {
          this.conversationHistory = this.conversationHistory.slice(-MAX_HISTORY_ENTRIES);
        }
        this.emit('done', this.currentResponse);
        return;
      }

      lastError = error;

      // CRITICAL: cancel the abandoned provider's stream BEFORE moving on.
      // Without this, the underlying HTTP request keeps streaming tokens that
      // would interleave with the next provider's response in the UI.
      try {
        provider.cancelStream();
      } catch (cancelErr) {
        console.warn(`[ai-manager] failed to cancel ${providerName} stream:`, cancelErr);
      }

      // If tokens were already streamed, don't retry — partial response is visible to user
      if (this.currentResponse.length > 0) {
        console.log(`[ai-manager] ${providerName} failed mid-stream: ${error}`);
        this.isStreaming = false;
        this.streamingProvider = null;
        this.emit('error', error);
        return;
      }

      // No tokens streamed yet — safe to retry with next provider
      if (!isLast) {
        console.log(`[ai-manager] ${providerName} failed: ${error} — falling back to ${fallbackChain[i + 1].name}`);
      }
    }

    // All providers failed
    this.isStreaming = false;
    this.streamingProvider = null;
    this.emit('error', lastError || 'All providers failed');
  }

  cancelStream(): void {
    // Bump attempt id BEFORE cancelling so any in-flight callbacks from the
    // current provider are immediately invalidated and discarded.
    this.activeAttemptId++;
    this.streamingProvider?.cancelStream();
    this.streamingProvider = null;
    this.isStreaming = false;
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.epochSummary = null;
    this.lastRequestTimestamp = 0;
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
    } else if (provider === 'groq') {
      this.providers.set('groq', new GroqProvider(key));
    }
  }
}
