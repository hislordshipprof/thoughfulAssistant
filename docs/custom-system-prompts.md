# Custom system prompts

InterviewOverlay applies the selected system-prompt behavior to typed chat, screen answers, and automatic system-audio answers across every AI provider.

- **Built-in prompt** keeps the existing General or LeetCode instructions plus the saved resume and job description.
- **Built-in + custom instructions** appends the custom text after the built-in prompt and profile context.
- **Replace with my prompt** sends only the custom text as the system message. It intentionally excludes the built-in prompt, resume, and job description.

Transcript, OCR, screen context, and typed questions remain user-context messages. An empty Append or Replace prompt cannot be saved through Settings; manually edited empty configurations safely fall back to the built-in prompt.

The prompt is stored locally in the same application settings file as the provider configuration. Cloud providers receive it with each answer request. Local Ollama receives it only through the configured local Ollama endpoint.

Run deterministic prompt checks with:

```sh
npm run test:prompt
```
