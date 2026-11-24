# macOS screen permission repair — 1.1.1

The app previously treated Electron's `getMediaAccessStatus('screen') === 'denied'`
as a reason to abort before ever requesting consent. Electron 33's screen status
only distinguishes approved from not approved (including never requested).
Unlike microphone access, `askForMediaAccess('screen')` is unsupported.

The repair calls `desktopCapturer.getSources` with zero-size thumbnails on an
explicit request. In Electron 33 this calls macOS `CGRequestScreenCaptureAccess`
before enumeration. Source results are discarded; no image is encoded, stored,
OCR'd, or sent to AI. Capture only proceeds after a fresh check says granted.
Denied/restricted/revoked access fails closed. Background capture never prompts
and stops on a missing permission instead of repeatedly reporting the same error.

Settings now shows the build version and screen permission status, with buttons
to request consent, open the exact macOS privacy pane, and restart. Restart asks
for confirmation and explains that unsaved conversation/context is cleared.
Saved keys/configuration are not reset. A status refresh is read-only.

## Use

1. Launch `/Applications/InterviewOverlay.app`, not a copy inside a mounted DMG.
2. Open Settings → Screen Capture → Request screen access.
3. Approve in macOS Screen & System Audio Recording. If already listed but
   still unapproved, open that pane and enable the installed app.
4. Save any edited settings, then Restart app (or use macOS Quit & Reopen).
5. Try Capture screen. Get Answer sends the captured context to your selected AI.

The app uses ad-hoc signing because no valid signing identity was available.
Updating its contents can change the signature and invalidate a previous grant.
This repair does not bypass TCC, approve permissions automatically, reset other
apps' permissions, or guarantee permission persistence across future builds.
A stable Apple signing identity is needed for that distribution improvement.

## Verification

`npm run test:permissions` covers first request, denial, successful approval,
restriction, concurrency, revoked permissions, zero thumbnails, periodic capture,
IPC and restart confirmation. `scripts/smoke-permissions.cjs` tests the real
renderer/preload/main integration with synthetic permission/capture responses.
No real desktop contents or cloud AI requests are used by these tests.

Implementation references:

- [Electron 33 desktop capturer](https://github.com/electron/electron/blob/v33.4.11/shell/browser/api/electron_api_desktop_capturer.cc#L285-L290)
- [Chromium screen permission status](https://github.com/chromium/chromium/blob/130.0.6723.191/chrome/browser/permissions/system/system_media_capture_permissions_mac.mm#L119-L122)
- [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)
