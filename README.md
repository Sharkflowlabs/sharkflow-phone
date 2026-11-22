# Sharkflow Phone

A one-person texting and calling inbox for Sharkflow Labs, on Twilio + Cloudflare Workers + D1.

- SMS inbox per contact, sending texts, STOP/START handling, opt-in required before texting
- Browser calling (Twilio Voice JS SDK), inbound calls ring the browser (and optionally `FORWARD_TO`), voicemail
- Pipeline stage + next follow-up date per contact, CSV import, password login

Full setup guide (Twilio, Cloudflare, toll-free / 10DLC answers): https://claude.ai/artifact/T3NV7vYKFGdo1urGUP3sZ3

## Layout
- `src/worker.js` – API (`/api/*`), Twilio webhooks (`/twilio/*`), serves `public/`
- `public/` – the UI (plain HTML/CSS/JS; `vendor/twilio.min.js` is the Voice SDK, `npm run vendor` refreshes it)
- `schema.sql` – database tables (safe to re-run; the deploy workflow runs it)
- `.github/workflows/deploy.yml` – deploys on push to `main` (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)

## Twilio webhooks (all POST)
| Where | URL |
| --- | --- |
| Number > A message comes in | `https://APP/twilio/sms` |
| Number > A call comes in | `https://APP/twilio/voice-in` |
| TwiML App > Voice Request URL | `https://APP/twilio/voice-out` |

All webhooks check Twilio's signature, so they only work with the real Auth Token.

## Local dev
```
npm ci
cp .dev.vars.example .dev.vars   # fill in test values
npm run db:local
npm run dev                      # http://localhost:8787
npm test                         # smoke tests against the dev server (fresh local DB, password test-pass, auth token authtoken123)
```
