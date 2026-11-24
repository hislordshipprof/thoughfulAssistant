# Anthropic connectivity on macOS

InterviewOverlay uses the Anthropic Messages API directly. On macOS, its Anthropic client uses an IPv4 HTTPS agent because some networks advertise an IPv6 route to `api.anthropic.com` that is not actually reachable. The request remains protected by HTTPS.

The model field accepts any model ID available to the configured Anthropic account. The suggestions are conveniences, not a fixed allowlist.

Errors shown in the overlay distinguish invalid credentials, billing, permissions, unavailable models, rate limits, oversized requests, timeouts, and temporary service failures. Raw SDK errors are intentionally not shown because they may contain request details.

Run the deterministic provider checks without a network connection or real credential:

```sh
npm run test:anthropic
```
