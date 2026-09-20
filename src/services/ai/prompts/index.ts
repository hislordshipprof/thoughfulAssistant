import { MessageContent } from '../ai-provider';
import { composeSystemPrompt } from './shared';

export { SYSTEM_PROMPT } from './general';
export { BEHAVIOURAL_SYSTEM_PROMPT } from './behavioural';
export { LEETCODE_SYSTEM_PROMPT, LEETCODE_SYSTEM_PROMPT_LITE, LEETCODE_SYSTEM_PROMPT_GROQ } from './leetcode';
export { LEETCODE_SYSTEM_PROMPT_V2, LEETCODE_SYSTEM_PROMPT_V2_LITE, LEETCODE_SYSTEM_PROMPT_V2_GROQ } from './leetcode-v2';
export { SYSTEM_DESIGN_SYSTEM_PROMPT, SYSTEM_DESIGN_SYSTEM_PROMPT_LITE, SYSTEM_DESIGN_SYSTEM_PROMPT_GROQ } from './system-design';
export { CODE_MOD_SYSTEM_PROMPT, CODE_MOD_SYSTEM_PROMPT_LITE, CODE_MOD_SYSTEM_PROMPT_GROQ } from './code-modification';

import { SYSTEM_PROMPT } from './general';
import { BEHAVIOURAL_SYSTEM_PROMPT } from './behavioural';
import { LEETCODE_SYSTEM_PROMPT, LEETCODE_SYSTEM_PROMPT_LITE, LEETCODE_SYSTEM_PROMPT_GROQ } from './leetcode';
import { LEETCODE_SYSTEM_PROMPT_V2, LEETCODE_SYSTEM_PROMPT_V2_LITE, LEETCODE_SYSTEM_PROMPT_V2_GROQ } from './leetcode-v2';
import { SYSTEM_DESIGN_SYSTEM_PROMPT, SYSTEM_DESIGN_SYSTEM_PROMPT_LITE, SYSTEM_DESIGN_SYSTEM_PROMPT_GROQ } from './system-design';
import { CODE_MOD_SYSTEM_PROMPT, CODE_MOD_SYSTEM_PROMPT_LITE, CODE_MOD_SYSTEM_PROMPT_GROQ } from './code-modification';

/** Prefixes for models that get the FULL prompt. Anything else gets LITE.
 *  Prefix-matched (not exact) so newly released versions automatically pick
 *  the right prompt tier without requiring a code change. Verified against
 *  current Anthropic / OpenAI model lists (April 2026):
 *  - Anthropic: claude-opus-4-{5,6,7}, claude-sonnet-4-{5,6}, claude-mythos-preview
 *  - OpenAI:    gpt-5, gpt-5.4, gpt-5.4-pro, gpt-5.5, gpt-4.1, gpt-4o, gpt-4.5
 *  Lite prompts target compact / mini / haiku tiers and llama-4. */
const FULL_PROMPT_PREFIXES = [
  'gpt-5',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.5',
  'claude-opus-4',
  'claude-opus-5',
  'claude-opus-6',
  'claude-sonnet-4',
  'claude-sonnet-5',
  'claude-mythos',
  'gpt-6',
];

/** Substrings that force LITE even if the prefix matches a flagship.
 *  e.g. "gpt-5-mini" still gets LITE. */
const LITE_OVERRIDE_SUBSTRINGS = ['mini', 'nano', 'haiku', 'oss-'];

export function isLiteModel(model: string): boolean {
  const m = model.toLowerCase();
  if (LITE_OVERRIDE_SUBSTRINGS.some(s => m.includes(s))) return true;
  return !FULL_PROMPT_PREFIXES.some(p => m.startsWith(p));
}

/** Pick the right mode-body for the active mode/model/provider combination.
 *  When `useV2` is true and the mode has a v2 variant (currently only leetcode),
 *  the concise v2 prompt is used instead of the verbose v1. v2 enforces
 *  per-section sentence budgets and a tighter trace format — typically
 *  produces ~40-50% shorter responses without sacrificing correctness. */
function pickModeBody(mode: string, model?: string, provider?: string, useV2 = false): string {
  const lite = model ? isLiteModel(model) : false;
  switch (mode) {
    case 'leetcode':
      if (provider === 'groq') return useV2 ? LEETCODE_SYSTEM_PROMPT_V2_GROQ : LEETCODE_SYSTEM_PROMPT_GROQ;
      if (lite) return useV2 ? LEETCODE_SYSTEM_PROMPT_V2_LITE : LEETCODE_SYSTEM_PROMPT_LITE;
      return useV2 ? LEETCODE_SYSTEM_PROMPT_V2 : LEETCODE_SYSTEM_PROMPT;
    case 'system_design':
      if (provider === 'groq') return SYSTEM_DESIGN_SYSTEM_PROMPT_GROQ;
      return lite ? SYSTEM_DESIGN_SYSTEM_PROMPT_LITE : SYSTEM_DESIGN_SYSTEM_PROMPT;
    case 'code_modification':
      if (provider === 'groq') return CODE_MOD_SYSTEM_PROMPT_GROQ;
      return lite ? CODE_MOD_SYSTEM_PROMPT_LITE : CODE_MOD_SYSTEM_PROMPT;
    case 'behavioural':
      // Single body across tiers — behavioural prompt is already tight enough
      // that lite models can follow it. Add lite/groq variants here later if
      // the smaller models start over-explaining.
      return BEHAVIOURAL_SYSTEM_PROMPT;
    default:
      return SYSTEM_PROMPT;
  }
}

/**
 * Assemble the final system prompt. Composition order is fixed and applied
 * by `composeSystemPrompt()`:
 *
 *   resume → JD → shared baseline → mode body → custom prompt → confidentiality lock
 *
 * The confidentiality lock is always last so a user-supplied custom prompt
 * cannot override it via recency bias. The shared baseline (voice rules,
 * formatting, context priority, screenshot etiquette, self-correction) is
 * defined once in `shared.ts` and reused across every mode.
 */
export function getSystemPrompt(
  mode: string,
  resume?: string,
  jobDescription?: string,
  model?: string,
  provider?: string,
  customPrompt?: string,
  useV2 = false
): string {
  const modeBody = pickModeBody(mode, model, provider, useV2);
  const lite = model ? isLiteModel(model) : false;
  const tier = provider === 'groq' ? 'GROQ' : lite ? 'LITE' : 'FULL';
  console.log(`[prompt] mode=${mode}, model=${model}, provider=${provider}, tier=${tier}, version=${useV2 ? 'V2' : 'V1'}`);

  return composeSystemPrompt({
    resume,
    jobDescription,
    modeBody,
    customPrompt,
  });
}

/**
 * Build multimodal context message with text + images.
 *
 * Order is deliberate: stable context first → variable context next → phase
 * directive last. Phase directive is ALWAYS the final text block so recency
 * favours the model following the right phase rule. User-typed notes are
 * scoped to "content priority over other sources" — they do NOT override
 * phase structure.
 *
 * Block order:
 *   1. Custom prompt reminder (if set) — terse, one line
 *   2. Profile activation (if resume/JD present) — terse hint, full content
 *      lives in the cached system prompt
 *   3. Transcript
 *   4. Screenshots (text label + image blocks)
 *   5. User-typed notes (priority for content, NOT structure)
 *   6. Phase directive (LAST — recency-prioritised)
 */
export function buildContextMessage(
  transcript: string,
  screenshots: string[],
  userQuery?: string,
  interviewMode?: string,
  litePhase?: number,
  hasResume?: boolean,
  hasJobDescription?: boolean,
  hasCustomPrompt?: boolean
): MessageContent[] {
  const content: MessageContent[] = [];
  const isTechnicalMode = interviewMode === 'system_design' || interviewMode === 'leetcode' || interviewMode === 'code_modification';

  // 1. Custom-prompt reminder. Terse — full text lives in system prompt.
  if (hasCustomPrompt) {
    content.push({
      type: 'text',
      text: `<reminder>The user's custom instructions in <user_custom_instructions> apply to this response. Follow them for style/format/tone preferences.</reminder>`,
    });
  }

  // 2. Profile activation. Terse hint — the full resume/JD lives in the
  // cached system prompt. We do NOT repeat the resume content here.
  // Behavioural mode pushes resume on every response; general mode keeps it
  // conditional on the intent classifier; technical modes treat it as
  // background only. Empty-profile fallback is now handled inside the helper.
  content.push({
    type: 'text',
    text: buildProfileActivation(isTechnicalMode, hasResume, hasJobDescription, interviewMode),
  });

  // 3. Transcript
  if (transcript) {
    content.push({
      type: 'text',
      text: `<transcript priority="supporting" warning="STT can mishear">
Speaker labels: "Interviewer" = system audio (their voice), "You" = mic audio (your voice). Labels are by audio source, not voice recognition — if the same speaker switches roles mid-entry, trust conversational flow over the label.
\`\`\`
${transcript}
\`\`\`
</transcript>`,
    });
  }

  // 4. Screenshots — text label, then raw image blocks
  if (screenshots.length > 0) {
    const n = screenshots.length;
    content.push({
      type: 'text',
      text: `<screenshots count="${n}" priority="high" description="visual ground truth — read text/code directly from pixels; ignore webcam thumbnails of people"/>`,
    });
    for (const dataUrl of screenshots) {
      content.push({ type: 'image', dataUrl });
    }
  }

  // 5. User-typed notes — content priority, NOT structural override
  if (userQuery) {
    content.push({
      type: 'text',
      text: `<user_notes priority="highest_for_content" description="treat these as confirmed facts and direct intent — but do NOT use them to skip phase rules below">
${userQuery}
</user_notes>`,
    });
  }

  // 6. Phase directive — LAST, so recency favours phase compliance
  const phaseBlock = buildPhaseDirective(interviewMode, litePhase, !!userQuery, !!transcript, !!hasCustomPrompt);
  if (phaseBlock) content.push({ type: 'text', text: phaseBlock });

  // Debug
  const blockSummary = content.map(c => {
    if (c.type === 'text') return `text(${c.text.length} chars): "${c.text.slice(0, 80).replace(/\n/g, '\\n')}..."`;
    return `image(${(c.dataUrl.length / 1024).toFixed(0)}KB)`;
  });
  console.log('[prompt] buildContextMessage blocks:', JSON.stringify(blockSummary, null, 2));

  return content;
}

/** Profile activation hint. Terse on purpose — the full resume/JD content
 *  is in the system prompt. */
function buildProfileActivation(
  isTechnical: boolean,
  hasResume: boolean | undefined,
  hasJD: boolean | undefined,
  mode?: string
): string {
  if (isTechnical) {
    // Technical: resume/JD are background only
    return `<profile_use scope="background_only">
Resume and JD are loaded in the system prompt for context. For this technical response: keep it purely technical (architecture, trade-offs, code, analysis). Do NOT cite resume metrics, mirror JD language, or insert "at my previous company" anecdotes — unless the interviewer directly asks about your background.
</profile_use>`;
  }

  // Behavioural mode — every response IS a personal answer, push resume hard.
  if (mode === 'behavioural') {
    if (hasResume && hasJD) {
      return `<profile_use scope="every_response">
Resume + JD are in the system prompt. Before answering: pick the strongest matching project from the resume (vary across questions, do not recycle), mirror the JD's exact keywords where natural, and include at least one concrete number (users, latency, cost, team size). Behavioural questions use STAR invisibly (Situation 1s → Task 1s → Action 3-4s using "I" not "we" → Result quantified). Never fabricate.
</profile_use>`;
    }
    if (hasResume) {
      return `<profile_use scope="every_response">
Resume is in the system prompt. Before answering: pick the specific project that best matches the question, include at least one concrete number, and use STAR invisibly. Never fabricate. If asked about a specific role with no JD provided, pivot to what excites you about this work based on the resume's trajectory.
</profile_use>`;
    }
    return `<profile_use scope="every_response">
JD is in the system prompt. Before answering: identify 2-3 priorities from the JD relevant to this question, mirror its exact phrasing where natural, and frame the answer around what this role values rather than generic industry statements. If no resume is loaded, use believable generic professional examples but never fabricate specific employers or metrics.
</profile_use>`;
  }

  // General mode — DO NOT force resume into every response. The intent
  // classifier in the directive decides whether resume content is appropriate.
  // Meta/prep and screen-help responses skip resume entirely; only
  // behavioural/personal queries pull from it.
  if (hasResume && hasJD) {
    return `<profile_use scope="conditional" trigger="behavioural_personal_only">
Resume + JD are in the system prompt. Use them ONLY when the typed query is asking about my background, experience, or opinion (BEHAVIOURAL_PERSONAL bucket per the directive below). For META_PREP and SCREEN_HELP responses, skip the resume entirely — those answers are about what is on screen, not about me. When you do use them: pick the strongest matching project, mirror JD keywords, include one concrete number, STAR invisibly. Never fabricate.
</profile_use>`;
  }
  if (hasResume) {
    return `<profile_use scope="conditional" trigger="behavioural_personal_only">
Resume is in the system prompt. Use it ONLY when the typed query is asking about my background, experience, or opinion (BEHAVIOURAL_PERSONAL bucket per the directive below). For META_PREP and SCREEN_HELP responses, skip the resume entirely. When you do use it: pick the most relevant project, include one concrete number, STAR invisibly. Never fabricate.
</profile_use>`;
  }
  if (hasJD) {
    return `<profile_use scope="conditional" trigger="behavioural_personal_only">
JD is in the system prompt. Use it ONLY when the typed query is asking about my motivations, fit, or the role itself. For META_PREP and SCREEN_HELP responses, skip the JD — those answers are about what is on screen.
</profile_use>`;
  }
  return `<profile_status>No resume or job description loaded. For behavioural questions use believable but generic professional examples ("In a previous role, I…"). Do not apologise for missing context.</profile_status>`;
}

/** Build the per-turn phase directive. This is the LAST block in the user
 *  message and is recency-prioritised by the model. */
function buildPhaseDirective(
  mode: string | undefined,
  litePhase: number | undefined,
  hasUserQuery: boolean,
  hasTranscript: boolean,
  hasCustomPrompt: boolean
): string {
  if (mode === 'leetcode') {
    if (litePhase === 1) {
      return `<phase n="1">Phase 1 only. Restate the problem, check for constraints, ask clarifying questions if needed. Do NOT discuss approach or code.</phase>`;
    }
    if (litePhase === 2) {
      return `<phase n="2">Phase 2 only. Approach + code + complexity. Do NOT repeat Phase 1 — no restating, no re-checking constraints, no clarifying questions. Go straight into the approach.</phase>`;
    }
    return `<phase>Determine the right phase from your conversation history. One phase per response — never combine.</phase>`;
  }

  if (mode === 'system_design') {
    if (litePhase === 1) {
      return `<phase n="1">Phase 1 only. Ask clarifying questions about functional scope AND non-functional constraints in one response. Do NOT summarise requirements, estimate, or discuss architecture. End naturally so the interviewer can respond.</phase>`;
    }
    if (litePhase === 2) {
      return `<phase n="2">Phase 2 only. Requirements summary + estimation. Restate problem → confirmed functional reqs → confirmed NFRs → declare out of scope → estimation with math → mention entities/API → end with "Want me to sketch the architecture?". Flow directly into math, do not stop after the summary. Every item must trace to what the interviewer confirmed. No architecture yet.</phase>`;
    }
    if (litePhase === 3) {
      return `<phase n="3">Phase 3 only. Architecture NOW — actually do it, do not describe what you will do. Bullet points (one per component, thinking-out-loud transitions), then a \`\`\`mermaid flowchart TD code block (8-12 nodes, labelled arrows), then conversational walkthrough of each component, then a check-in. You MUST output the mermaid code block — never say "I'll draw a diagram." If the interviewer asked a specific question instead, answer that in 3-5 sentences (problem → solution → trade-off).</phase>`;
    }
    // Phase 4+ — adaptive deep dive (architecture is already on the table)
    return `<phase n="4+" mode="adaptive_deep_dive">
Architecture has been presented. Answer ONLY what the interviewer is asking — one conversational turn each.
- Specific question (ordering, fan-out, scaling): 3-5 sentences. Problem → solution → trade-off.
- "Walk me through X" flow: step-by-step, 4-6 sentences.
- Scale/bottleneck: identify 2-3 bottlenecks, brief rationale each.
- "What would you improve?": 2-3 items, one sentence each.
Do NOT redraw the architecture. Do NOT re-list requirements. Use thinking-out-loud phrases ("the tricky part is...", "the trade-off is...").
</phase>`;
  }

  if (mode === 'code_modification') {
    if (litePhase === 1) {
      return `<phase n="1">Phase 1 only. First detect intent (MODE A bug-fix vs MODE B refactoring — see system prompt for signals), state your detected mode, walk through the code (purpose, stack, structure, I/O — 4-6 sentences), then do the three-pass review for your detected mode. NUMBER each issue sequentially across passes. Only issues in VISIBLE code — not missing features. Each issue: severity + line reference. Summary count must match issue numbers. Do NOT propose fixes. End with "Want me to walk through the [fixes / refactoring]?"</phase>`;
    }
    if (litePhase === 2) {
      return `<phase n="2">Phase 2 only. Re-read your Phase 1 numbered issues. Address EXACTLY those, in the SAME ORDER. Do NOT skip any, introduce new ones, or reframe. You analysed the full code in Phase 1 — do NOT skip claiming "code not visible"; use what you already saw. For each issue: state number + description (matching Phase 1) → code change in a code block → why it works → trade-offs → confirm it preserves behaviour. Structural issues (need helper / refactor) in MODE A: explain why an inline fix isn't possible and describe the structural approach instead of a code block — still counts as addressed. Verify all numbered issues were covered.</phase>`;
    }
    return `<phase n="3+" mode="follow_up">
Phases 1 and 2 are complete. Answer the interviewer's follow-up naturally using your full conversation-history knowledge of the code. You may switch to MODE B (refactoring) if asked. Concrete code blocks for any code changes. Do NOT refuse or claim mode-lock. Prioritise conversation history over the current screenshot if they conflict (the current screenshot may show only a partial view).
</phase>`;
  }

  // BEHAVIOURAL mode — every response is a personal Q&A answer. The system
  // prompt body already enforces STAR, JD-mirroring, talk test, etc. The
  // directive just reinforces shape per turn.
  if (mode === 'behavioural') {
    if (hasCustomPrompt) {
      // Deferential — user's custom prompt drives content/structure/length.
      if (hasUserQuery) {
        return `<directive>
Answer the typed question above as ME in a behavioural interview. Follow the user's custom instructions in <user_custom_instructions> for tone, length, structure, STAR usage, and response strategy — those override defaults. The screenshot is auto-captured context; ignore it unless it visibly contains the question being asked.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
      }
      if (hasTranscript) {
        return `<directive>
Answer what the interviewer is asking from the transcript as ME in a behavioural interview. Follow the user's custom instructions in <user_custom_instructions> for tone, length, structure, STAR usage, and response strategy.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
      }
      return `<directive>
Read the question on screen and answer it as ME in a behavioural interview. Follow the user's custom instructions in <user_custom_instructions>.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
    }

    // No custom prompt — prescriptive behavioural defaults
    if (hasUserQuery) {
      return `<directive>
Answer the typed question above as ME in a behavioural interview. 5-8 sentences. Open with substance — never with "I'm excited about" or "I'm passionate about". Vary sentence starters. STAR invisibly (no labels). Pull at least one concrete number from my resume. Mirror the JD's exact keywords where natural. Talk-test every sentence (would a person say this aloud?). The screenshot is auto-captured context; ignore it unless it visibly contains the question.
</directive>`;
    }
    if (hasTranscript) {
      return `<directive>
Answer what the interviewer is asking from the transcript. 5-8 sentences. Open with substance, vary sentence starters, STAR invisibly, at least one concrete number from my resume, mirror JD keywords, talk-test every sentence.
</directive>`;
    }
    return `<directive>
Read the question on screen and answer it as a behavioural interview answer. 5-8 sentences, STAR invisibly, concrete resume detail, talk test.
</directive>`;
  }

  // GENERAL mode — catch-all. Intent classifier decides response shape.
  //
  // ARCHITECTURE NOTE (2026 best practice — augmentation over override):
  // When the user provides a custom prompt, that prompt is the SOURCE OF TRUTH
  // for tone, length, structure, STAR usage, persona, and response strategy.
  // Our directive must NOT inject competing length caps or structural rules —
  // those would silently override the user's explicit intent.
  //
  // What we still inject either way:
  //   - Read the screen first (load-bearing — fixes the "ignore screenshot"
  //     bug where the model jumps straight to a resume answer)
  //   - Source priority (which input to focus on)
  //   - Sentence-per-line formatting (load-bearing for spoken delivery)
  //   - Anti-screenshot-narration ("don't describe the UI")
  //
  // What we inject ONLY when no custom prompt is present:
  //   - Intent classifier (META_PREP / SCREEN_HELP / BEHAVIOURAL_PERSONAL)
  //   - Per-bucket length defaults
  //   - These are good defaults for the bare-system case but become noise
  //     when the user supplies their own response strategy.

  if (hasCustomPrompt) {
    // Deferential — user's custom prompt drives content/structure/length.
    // We still tell the model to read the screen first (the bug we just fixed).
    if (hasUserQuery) {
      return `<directive>
Step 1: Read the screenshot to identify what is on screen. Step 2: Answer the typed question/request above directly, using the screenshot as ground truth where relevant. Do NOT describe the screenshot or add UI commentary.
Follow the user's custom instructions in <user_custom_instructions> for tone, length, structure, STAR usage, and any response-strategy guidance. The custom prompt is the source of truth for HOW to answer; this directive only specifies WHICH input to focus on.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
    }
    if (hasTranscript) {
      return `<directive>
Step 1: Read the screenshot to identify what is on screen. Step 2: Answer what the interviewer is asking from the transcript, using the screenshot as ground truth where relevant. Do NOT describe the screenshot or add UI commentary.
Follow the user's custom instructions in <user_custom_instructions> for tone, length, structure, STAR usage, and any response-strategy guidance.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
    }
    return `<directive>
Step 1: Identify what is on screen.
Step 2 — IF a coding problem / algorithm question / IDE with problem statement is visible: follow the <coding_exercise_template> — approach explanation, code with inline comments, time/space complexity, and test cases with asserts. ALWAYS include complexity and test cases for coding problems.
Step 2 — IF questions / MCQ / a non-coding task are visible: answer them. For multiple-choice: BEFORE writing the final letter, evaluate EVERY option, confirm letter→option mapping (FIRST=A, SECOND=B, THIRD=C, FOURTH=D, FIFTH=E unless letters are pre-printed), then write the answer (state the correct letter, explain why it is correct, then briefly state why each other option is wrong).
Step 2 — IF no questions or task visible (e.g. a marketing site, dashboard, documentation, article, product page): identify the site/page in 1-2 sentences using visible logo/title/headings, then confirm readiness ("Standing by — let me know what you want to do."). Do NOT fabricate questions. Do NOT lecture about the topic.
Follow the user's custom instructions in <user_custom_instructions> for tone, length, structure, and response-strategy guidance. Do not describe the screenshot UI or add headers/summaries/tips.
Formatting: every sentence on its own line for spoken delivery.
</directive>`;
  }

  // No custom prompt — use the intent classifier from the system prompt body.
  if (hasUserQuery) {
    return `<directive>
Step 1 — READ the screenshot to identify what is on screen (test name, page type, question, code, error, document). Do not skip this step.

Step 2 — CLASSIFY the typed query into ONE bucket and respond per that bucket:

  META_PREP — query asks you to understand context or stand by ("understand what we'll be doing", "stand by", "get ready", "make sure you provide solutions", "watch for the next question", "read the page and tell me what this is").
    → 2-5 short sentences. Identify the test/task, time limit, key rules. End with one line confirming readiness. STOP. Do NOT pull resume content. Do NOT generate a behavioural answer.

  SCREEN_HELP — query asks you to solve / explain / interpret content visible on screen ("what's the answer", "solve this", "explain this", "what does this mean", "code it up", "write the code", "implement this").
    → Use the screenshot as ground truth.
    → For multiple-choice: BEFORE writing the final letter, evaluate EVERY option against the question (do not stop at the first plausible one). For "which is smallest/largest" — compare ALL listed values. For arithmetic — re-compute and compare to each option. Then re-read the screenshot to confirm which letter maps to the option you selected (FIRST=A, SECOND=B, THIRD=C, FOURTH=D, FIFTH=E unless letters are pre-printed). Only then write the answer in the screen_help_template format. The final letter MUST match the option you computed.
    → For explanation: 3-5 sentences.
    → For coding exercises / algorithm problems / "code it up" requests: follow the <coding_exercise_template> in the system prompt — approach explanation, code with inline comments, time and space complexity, and test cases with asserts. ALWAYS include complexity and test cases for coding problems, even if not explicitly asked.
    → Do NOT pull resume content unless the question is about my background.

  BEHAVIOURAL_PERSONAL — query asks about my own experience, opinion, or wants a personal interview-style answer ("tell me about yourself", "describe a time", "what's your strength", "walk me through your experience").
    → 5-8 sentences. Open with substance. Varied sentence starters. STAR invisibly (no labels). At least one concrete number from my resume. Mirror JD keywords. Talk-test every sentence.

IMPORTANT — FOLLOW-UP CHECK: before classifying, check your conversation history. If your previous response was a coding answer (contains code, complexity, test cases) AND the current query is asking about that response (e.g. "why did you use X?", "explain line 12", "what about edge case Y?", "can you optimize this?", "why not use Z?"), follow the <coding_follow_up> guidance — answer conversationally in 2-5 sentences, do NOT regenerate the full solution.

If the query does not clearly fit a bucket, default to SCREEN_HELP — answer what is visible.

Do NOT describe the screenshot or add UI commentary. Every sentence on its own line for spoken delivery.
</directive>`;
  }
  if (hasTranscript) {
    return `<directive>
Step 1 — Read the screenshot to identify what is on screen. Step 2 — Determine what the interviewer is asking from the transcript and answer it. If the question is behavioural/personal, give a 5-8 sentence answer with concrete resume content (STAR invisibly, talk test). If it's about something visible on screen, use the screenshot as ground truth and answer in the natural length the question deserves. If the interviewer asks to code something up or the question is a coding/algorithm problem, follow the <coding_exercise_template> — include approach, code with inline comments, time/space complexity, and test cases with asserts. IMPORTANT: if the interviewer is asking a follow-up about your previous coding response (e.g. "why this approach?", "explain that line", "what about X?"), follow <coding_follow_up> — answer conversationally, do NOT regenerate the full solution. Do not describe the screenshot or add headers/summaries/tips.
</directive>`;
  }
  return `<directive>
Step 1: Identify what is on screen.
Step 2 — IF a coding problem / algorithm question / IDE with problem statement is visible: follow the <coding_exercise_template> — approach explanation, code with inline comments, time/space complexity, and test cases with asserts. ALWAYS include complexity and test cases for coding problems.
Step 2 — IF questions / MCQ / a non-coding task are visible: answer them. For multiple-choice: BEFORE writing the final letter, evaluate EVERY option against the question (do not stop at the first plausible one — for "which is smallest/largest" compare ALL listed values; for arithmetic re-compute and compare to each option). Then re-read the screenshot to confirm letter→option mapping (FIRST=A, SECOND=B, THIRD=C, FOURTH=D, FIFTH=E unless letters are pre-printed). The final letter MUST match the option you computed. Only then write: state the correct letter, explain why it is correct, then briefly state why each other option is wrong.
Step 2 — IF no questions or task visible (e.g. a marketing site, dashboard, documentation, article, product page): identify the site/page in 1-2 sentences using visible logo/title/headings, then confirm readiness ("Standing by — let me know what you want to do."). Do NOT fabricate questions. Do NOT lecture about the topic.
Do not describe the screenshot UI or add headers/summaries/tips.
</directive>`;
}

export function buildFollowUpMessage(previousResponse: string, followUp: string): string {
  return `Previous response:\n${previousResponse}\n\nFollow-up question: ${followUp}`;
}
