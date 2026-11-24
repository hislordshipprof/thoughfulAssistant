# Groq answers (macOS build 1.1.0)

Open Settings → AI Provider → **Groq (Cloud)**. Paste a Groq API key from
[Groq Console](https://console.groq.com/keys), choose a model, then Save.
No Ollama installation or OpenAI API key is needed for Groq.

The default is `openai/gpt-oss-120b`; `openai/gpt-oss-20b` is also suggested.
Both use locally extracted screen text (OCR). The model field accepts custom
Groq chat model IDs. An unavailable model returns an actionable error; the app
does not silently switch providers or models.

For screenshot/image understanding, `qwen/qwen3.8-27b` is suggested as a
**preview** model. Preview availability can change. Known vision models receive
the current captured images; unknown models use OCR until their vision support
is explicitly verified. Current model IDs and capabilities were checked against
[Groq's model catalog](https://console.groq.com/docs/models) and
[vision documentation](https://console.groq.com/docs/vision) on 2026-10-22.

Use Cmd+Enter to focus chat/send, Cmd+Shift+Enter for a fresh screen answer, and
Cmd+Shift+X to stop. Streaming, current conversation context, transcripts and
selected screen context all work with Groq. Screen capture still requires the
normal macOS permission; this feature does not alter or bypass permissions.

## Keys and privacy

Groq is a cloud service. Submitted questions, conversation context, included
transcripts and screen context leave the Mac when you ask Groq for an answer.
Text models receive extracted text; known vision models receive images. Saved
resume/job-description context is also included when configured.

The **Groq answer API key** is separate from Audio → Groq Whisper's transcription
key. Selecting Groq for answers does not change or enable audio recording or
cloud transcription. You may enter the same key in both settings intentionally.
For development, `GROQ_API_KEY` seeds either empty field on startup; saved keys
take precedence. Keys use the app's existing local settings storage (not an
encrypted keychain), so don't share the config file.

This uses Groq's fixed [OpenAI-compatible endpoint](https://console.groq.com/docs/openai),
not an OpenAI-hosted model endpoint. Errors don't echo raw SDK request bodies or
credentials. Requests have no automatic retries; Stop aborts the current request.

## Verification

`npm run test:groq` checks provider requests, streaming, cancellation, errors,
image capability routing, selection safety and config migration without network.
`node_modules/.bin/electron scripts/smoke-groq.cjs` exercises the real UI, IPC and
OpenAI-compatible SSE client against a loopback fixture with synthetic keys and
screen content. It does not call Groq or capture ambient audio/screens.

A real key/account is still needed to verify live Groq authentication, model
access, quotas and response quality. The packaged app is ad-hoc signed, not
Apple-notarized. Replacing an existing installation may require macOS to grant
screen/audio permissions again for the new build.
