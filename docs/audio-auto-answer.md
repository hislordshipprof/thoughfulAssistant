# System-audio auto-answer — 1.1.2

When recording is active and **Auto-answer system audio** is enabled, finalized
system-audio transcript updates are debounced for two seconds. A new system
transcript update restarts the timer; microphone speech, stopping recording,
manual answer controls, or disabling the setting cancels a pending answer.

The automatic request sends the recent transcript to the selected AI provider.
It does not take a screenshot or attach an earlier screenshot. The response
automatically opens the Assist tab. Each unchanged finalized transcript
turn is submitted at most once.

The feature is enabled by default, including when upgrading an existing config.
Disable it under Settings → Speech-to-Text to keep recording/transcription manual.
The setting may consume speech-to-text and answer-provider API quota while active.

Verification uses synthetic audio and loopback servers only:

- `npm run test:media` covers debounce, cancellation, disable, and deduplication.
- `scripts/smoke-media.cjs` covers the real Electron main/preload/renderer flow,
  confirms a system transcript creates an answer, and confirms no screenshot is
  attached to that automatic request.
