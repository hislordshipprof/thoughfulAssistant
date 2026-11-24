# macOS overlay controls

The core shortcuts follow [Cluely's documented live-insights controls](https://docs.cluely.com/feature/liveinsights). This is not a claim of identical capture compatibility or invisibility.

| Action | Default |
| --- | --- |
| Show / hide (session continues) | Command + Backslash |
| Open chat; send a question when the chat input is focused | Command + Enter |
| Capture the current screen and get an answer | Command + Shift + Enter |
| Queue a screen capture | Command + Shift + S |
| Start / stop microphone and system audio | Command + Shift + R |
| Toggle full click-through | Command + Shift + I |
| Move overlay | Command + Option + Arrow |
| Scroll answer | Command + Shift + Up / Down |
| Stop answer globally | Command + Shift + X |
| Exit typing and stop answer locally | Escape in the question field |
| New conversation | Command + Shift + N |
| Quit | Command + Option + Q |

The header also has capture, answer, click-through, Settings and Hide buttons, plus a drag handle. The menu-bar speech-bubble icon stays available when the overlay is hidden or click-through is enabled. Settings restores interaction. Typing explicitly focuses the overlay; simply showing it does not.

Saved legacy defaults migrate once on macOS. Customized bindings are retained and their actual keys are shown in Settings and button tooltips. Registration conflicts appear in Settings; the visible controls/menu remain available. Bare Escape is never captured globally on macOS. Command + Shift + Q is deliberately not used because it conflicts with macOS logout.

## Privacy limits

Capture protection is requested before showing the window. Settings can turn it off, and that choice survives hide/show and relaunch. The status reads **requested / limited**, **off**, or **unavailable**; it does not measure another application's recording output.

Electron 33 uses the macOS window-sharing exclusion API. [Electron documents that ScreenCaptureKit-based applications can still capture protected windows](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable). Test a recording with the exact sharing software and capture mode you intend to use, and inspect the recording from the viewer's side. Do not assume Zoom, Meet, Teams, OBS, or full-display sharing excludes this overlay.

Hiding the Dock/app-switcher entry is optional and separate from capture protection. The app remains in Activity Monitor and can be detected by other software. No process concealment or monitoring bypass is implemented. macOS screen-recording permissions still apply.

## Microphone, system audio and screen answers

Requires Apple Silicon and macOS 13 or later. Press **Command + Shift + R**, the Record button, or the menu-bar recording item. Choose Microphone and/or System audio in Settings → Audio. Stop releases capture; hiding the overlay does not stop it. The status and meters reflect capture state, with a separate starting/permission state and actionable errors.

The Mac helper uses AVAudioEngine for microphone input and ScreenCaptureKit for system audio. The default Mac speech mode uses Apple's on-device recognizer, requires Speech Recognition permission and an available Dictation language, and does not silently fall back to Apple's servers. Ollama is used for answers, not speech transcription. Configured cloud speech providers remain optional and receive audio only when selected and recording is started. Raw audio is not saved to disk.

On first use, allow Microphone, Speech Recognition and Screen & System Audio Recording as needed in System Settings → Privacy & Security. Depending on macOS, the permission entry can be named InterviewOverlay or overlay-audio. Quit and reopen after changing screen permission. If the local speech language is unavailable, enable/download that Dictation language or explicitly choose a configured speech provider.

**Command + Shift + Enter** always takes a fresh screenshot, replacing old queued captures. The overlay temporarily hides during capture and restores afterward. Settings selects a particular monitor or the monitor under the pointer. For multiple captures, use **Command + Shift + S**, type your question and Send. Up to three captures are kept in memory. Clear all removes them from the queue; reset also clears conversation history.

Image-capable models receive the screenshot. Ollama capabilities are checked through its local API; text-only/unverified models receive locally extracted English OCR text instead. Empty OCR produces an error rather than a screen-based guess. With a local Ollama model and on-device speech, inference stays local. Selecting a cloud AI model sends the screen image/text, transcript and other configured context to that provider. Automatic screen capture is off by default.

## Verification

Run `npm run test:controls`, `npm run test:media`, both TypeScript projects with `--noEmit`, and `npm run build`. For the real Electron UI, run `node_modules/.bin/electron scripts/smoke-controls.cjs` and `node_modules/.bin/electron scripts/smoke-media.cjs`. These tests create temporary settings and use loopback mock AI. The media smoke test runs real OCR against a synthetic window and injects synthetic helper events; it does not listen to a microphone or capture the desktop. Hardware levels, real on-device transcription, OS permission prompts, system-audio routing and third-party screen-share exclusion still require a hands-on check on the target Mac.

Build Apple Silicon artifacts with `npm run package:mac`. These local packages are ad-hoc signed, not notarized.
