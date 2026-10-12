# Personal Hinge MCP server

This optional server connects your own Hinge profile to ChatGPT and Claude through HTTPS Streamable HTTP and owner-password OAuth with PKCE. Both clients share one Hinge session in Redis. Connecting the MCP server and signing in to Hinge are separate steps.

## Connect your chat apps

Server URL: `https://hinge-mcp.vercel.app/mcp`

- **ChatGPT:** use this URL for your custom MCP connection, with OAuth and automatic client registration (DCR). Authorize with the server's owner password in the browser. See [OpenAI's authentication documentation](https://developers.openai.com/plugins/build/auth).
- **Claude chat:** open Customize → Connectors → Add custom connector, enter the URL, choose OAuth sign-in and **Register automatically**, then authorize with the same owner password. This server supports DCR, not Claude's published client identity. See [Claude's custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Then ask for `hinge_status`. If logged out, request login once with your international phone number (`+` and country code), and submit the code only if it arrives. A Hinge session established in either client is available to the other. Profile edits still require review of the exact change and explicit confirmation.

## Missing OTP diagnosis

On October 12, 2026, a diagnostic call to Hinge's `/auth/sms/v2/initiate` returned **HTTP 200 with an empty response body**, but the owner reported no OTP delivery. The SDK previously discarded that body, and our tool incorrectly returned “SMS code sent.” This response establishes neither SMS dispatch nor delivery. The delivery failure's cause remains unverified. [Upstream issue #5](https://github.com/wrsrsh/hinge-ts/issues/5) independently reports this same symptom with working OTP delivery in the official app; its proposed attestation explanation is unconfirmed.

The connector now reports `delivery_unconfirmed`, records only timestamp/status/body type/outcome for 24 hours, and exposes that record through `hinge_status`. It does not store raw diagnostic response bodies, OTPs, or tokens in that record. A shared 60-second cooldown prevents duplicate requests across chat apps and is extended for Hinge's `Retry-After` on HTTP 429. Failed requests do not automatically retry. Authentication requires a returned token before reporting success.

If the official Hinge app receives an OTP but this server does not, investigate the unofficial API client's request compatibility using a successful request from your own device. An empty 200 response alone cannot identify an app-version, network, carrier, or account issue. A commenter on upstream issue #5 reports that a code requested in the official app worked with SDK verification. To try that workaround, call `hinge_login_start` with your phone number and `send_sms: false`, request a code in the official app for the same number, then call `hinge_login_verify`. This prepares and persists the server device without sending another SMS. Cross-device verification is unverified for this account, so success is reported only if Hinge returns a token. If the app also fails, use [Hinge's SMS troubleshooting guidance](https://help.hinge.co/hc/en-us/articles/360011289613-Why-Aren-t-I-Receiving-My-SMS-text-verification). Hinge states that a lockout after repeated failures requires waiting at least 24 hours.

## Deployment and checks

Vercel project root: `mcp-server`. Deploy through the connected Git repository. Configure `OWNER_PASSWORD` and either `KV_REST_API_URL` / `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in Vercel. Set `PUBLIC_URL` to your canonical HTTPS origin when needed.

`HINGE_APP_VERSION` overrides the existing `10.7.0` compatibility setting; `HINGE_BUILD_NUMBER` optionally overrides the SDK's build number. These settings are not evidence of current API compatibility and should come from a verified working client.

From `mcp-server`:

```sh
npm ci
npm run typecheck
npm test
```

Tests simulate Hinge and Redis at the HTTP boundary and send no real SMS. They cover empty success responses, error bodies, rate limits, concurrent requests, device persistence, token validation, email verification, and MCP tool results. Passing tests does not establish live OTP delivery.
