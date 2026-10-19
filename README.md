# Portside — Kenya car import assistant

A Node.js application with a responsive importer assistant, saved conversations and estimates, account recovery, and an admin knowledge dashboard. There are no runtime npm dependencies. Playwright is a development dependency for browser testing.

## Run

Requires Node.js 18 or newer.

```bash
npm start
```

Open http://localhost:3000. `PORT` overrides the port.

| Demo role | Username | Initial password |
|---|---|---|
| Importer | `importer` | `Importer@2026` |
| Admin | `admin` | `Admin@2026` |

`USER_PASSWORD` and `ADMIN_PASSWORD` set the seed passwords when accounts are **first created**. Later password changes persist; changing these environment variables does not overwrite existing accounts. Use strong initial passwords and HTTPS for a hosted installation. `NODE_ENV=production` adds Secure to session cookies, so production requires HTTPS.

## Features

- A public welcome page introduces the assistant, services and how to get started before account access.
- Sign in, register, show/hide password, update name/password, and generate a private recovery code.
- Google sign-in with server-side OpenID Connect, enabled when Google OAuth credentials are configured.
- Password recovery using the username and a saved recovery code. Codes are shown once, downloadable, stored as salted hashes, and replaced after recovery. No email delivery service is configured or implied. Demo users can enable recovery in Account settings.
- Server-owned chat intent matching and knowledge answers. Unknown questions are confirmed only after being saved for admin review.
- Vehicle estimates and three-month timing comparisons with model, first registration, engine, fuel, reference value, freight/insurance and local fees. Choose **Other vehicle** for a custom model and value.
- VIN and shipment API lookups, including shipment milestones, source labels and timestamps.
- Private conversations with reopening, renaming, deletion and explicit completion. Completed chats remain readable; start a new chat to continue.
- Saved estimates, expandable breakdowns and downloadable text exports. Deleting a conversation retains its saved estimates.
- Paginated conversation and estimate libraries.
- Admin question answers, dismissal, knowledge creation/editing/deletion, search, date filters, refresh and retry. Dashboard metrics include an explicit chat completion rate, not an inferred drop-off rate.
- Mobile service shortcuts, keyboard focus management, live status messages, field validation, readable charts, and print styles.
- Requests serialize in the chat UI; request IDs prevent a retry from duplicating a message, service result or metric. New chat and conversation switching ignore responses belonging to a previous view.

## Google sign-in

The welcome screen appears before login. Choose **Log in** or **Get started**, then use your username or **Sign in with Google**. Google sign-in is disabled with a clear availability message until the following server environment variables are configured:

```bash
export GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=your-client-secret
export GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
npm start
```

In the [Google Cloud console](https://console.cloud.google.com/auth/overview), configure your app's OAuth consent screen and create an OAuth client with application type **Web application**. Add `http://localhost:3000/api/auth/google/callback` as an **Authorized redirect URI**, exactly matching `GOOGLE_REDIRECT_URI`. If using `http://127.0.0.1:3000`, add and configure that exact URI instead, and access Portside using the same host. For a deployed app, use `https://your-domain/api/auth/google/callback` and `NODE_ENV=production`. A testing-mode consent screen may require adding allowed test users. Follow Google's [web server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred) for credential and consent-screen configuration.

The client secret stays on the server. No Google SDK or tracking script is loaded by the welcome page. Selecting the Google button navigates to Google to authorize the basic `openid email profile` scopes. The server validates the callback, exchanges the code and verifies the signed identity token before issuing a Portside session. State, a short-lived browser-bound cookie, PKCE and nonce protect the authorization round trip. Cancellation and verification failures return to the login screen with safe messages; codes and error parameters are removed from the address bar.

Google accounts are identified by Google's stable subject identifier, never automatically linked by matching an email or local username. New Google users receive the ordinary user role. Existing password and admin accounts keep their existing sign-in method. Google users can update their Portside display name; password and recovery settings remain managed through Google. No Google access or refresh tokens are stored in the data file. The OAuth browser cookie uses SameSite=Lax for the redirect; the normal Portside session remains HttpOnly with SameSite=Strict.

The flow follows Google's [OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect). Real sign-in needs valid credentials and a consent screen from your Google Cloud project; automated tests use mocked Google responses and test signing keys.

## Data and persistence

Accounts, conversations, estimates, activity and knowledge persist in `data/portside.json`. Writes use a temporary file and atomic rename; the data directory and files use restrictive permissions. The directory is excluded from Git. Back it up to preserve account and conversation data.

`PORTSIDE_DATA_FILE` selects another file; `:memory:` disables disk persistence for tests. Sessions remain in memory and expire after eight hours. Restarting the server signs users out but retains their saved work. Password changes and recovery revoke existing sessions.

The JSON store is intended for a single Node process and modest data volumes. A shared database and session store are needed before running multiple server instances. Do not run simultaneous processes against the same data file.

## Service data and provider connections

**The default service results are demo data, not current tax guidance or live vehicle/shipping records.** Every result and export carries its source and limitations. No provider is silently substituted when a configured provider fails.

The default illustrative calculator uses annual age bands (5% per year, capped at 70%), a 25% duty example, example excise bands based on fuel/engine, 16% VAT, 2% IDF and 1.5% RDL. These are deliberately sample calculation rules, not a verified KRA assessment. The result includes entered freight and local fees. Timing compares the same sample rules at zero, one and two months; holding costs, exchange-rate changes, eligibility and future policy are excluded. A change within the same sample age/engine band may leave a result unchanged.

Sample references:

- VIN: `JTMBE31V006123456`
- BL: `BL-KE-1024`
- Container: `MSKU1234567`

Configure each service independently using a trusted adapter URL:

```bash
PORTSIDE_QUOTE_URL=https://your-adapter.example/quote
PORTSIDE_ADVISOR_URL=https://your-adapter.example/advisor
PORTSIDE_VIN_URL=https://your-adapter.example/vin
PORTSIDE_TRACKING_URL=https://your-adapter.example/tracking
PORTSIDE_PROVIDER_TOKEN=your-private-server-token
```

These are environment variables, not an automatically loaded `.env` file. Export them in your shell or configure them through your hosting environment. Provider secrets stay on the server. Requests are JSON POSTs with a 12-second timeout and an optional `Authorization: Bearer ...` header. Each URL must implement the contract below; an arbitrary third-party API generally needs an adapter. Provider accounts, approved data sources and credentials must be supplied to enable real data.

Vehicle request:

```json
{"model":"Toyota Harrier","registration":"2019-12","engine":2000,"fuel":"Petrol","value":1850000,"freight":120000,"fees":80000}
```

VIN/tracking request:

```json
{"reference":"JTMBE31V006123456"}
```

Response:

```json
{
  "title": "Provider estimate",
  "rows": [["Customs value", 1850000], ["Charges", 950000]],
  "total": 2800000,
  "notice": "Identify the source, effective date, assumptions and exclusions here."
}
```

`rows` contains at most 40 label/value pairs; values are strings or numbers. Numeric values are displayed as Ksh, so use strings for nonmonetary quantities. `total` is required and must be a nonnegative number for quote/advisor responses. For timing, return comparison rows for now, +1 and +2 months; `total` represents the current estimate. VIN/tracking omit `total`. The server sets `source: "provider"`, a retrieval timestamp, and the validated input. Provider estimates can be saved and exported like demo estimates.

## API overview

Authentication is cookie based. Account login, registration, recovery and the Google configuration/start/callback routes are public; application data requires a session. Mutating requests reject mismatched Origin headers. Admin permissions and ownership checks are enforced server side.

| Route | Purpose |
|---|---|
| `POST /api/login`, `/api/register`, `/api/reset-password`, `/api/logout` | Account access |
| `GET /api/auth/config` | Public Google sign-in availability; no secrets |
| `GET /api/auth/google`, `/api/auth/google/callback` | Start Google authorization / handle callback |
| `GET /api/session`, `POST /api/profile` | Session and account settings |
| `GET /api/catalog` | Models, current month and provider availability |
| `GET/POST /api/conversations` | Paginated list / create |
| `GET/POST/DELETE /api/conversations/:id` | Open / rename or complete / delete |
| `POST /api/chat` | `{conversationId, requestId, message}` → stored conversation and reply |
| `POST /api/services/:service` | `{conversationId, requestId, input}` → stored result; service is quote/advisor/vin/tracking |
| `GET/POST /api/quotes` | Paginated saved estimates / save `{conversationId, messageId}` |
| `DELETE /api/quotes/:id` | Remove own saved estimate |
| `GET /api/admin` | Metrics and paginated queue/knowledge; `from`, `to`, `search`, `queuePage`, `knowledgePage` filters |
| `POST /api/answers` | Answer a queued question using `{id, answer}` |
| `POST /api/admin/knowledge` | Create/update `{id?, question, answer}` |
| `DELETE /api/admin/knowledge/:id`, `/api/admin/questions/:id` | Delete answer / dismiss question |

`GET /api/knowledge` and `POST /api/activity` remain compatible with the original prototype. `/api/chat` without a conversation ID retains the original basic rule-based response for compatibility; the frontend uses the persisted conversation contract.

Date filters use Africa/Nairobi calendar dates, inclusive at both ends. Activity counts include chat messages and submitted service forms. Completion rate uses nonempty conversations created in the chosen date range. Search filters questions and knowledge; date filters apply to activity and unanswered questions. Saved knowledge is not date-filtered.

## Checks

```bash
npm install
npm run check
npm test
npm run test:e2e
```

Browser tests use `/usr/bin/google-chrome` when available. Set `PORTSIDE_CHROME_PATH` for another Chrome executable, or run `npx playwright install chromium` to use Playwright's browser. Tests start an isolated in-memory server on port 3107; do not run another service there. Backend tests use memory or a temporary directory and do not alter application data.

The checks cover calculations/validation, provider failures, persistence across processes, account recovery, ownership/roles, idempotent retries, saved estimates, admin knowledge CRUD, browser registration, estimate export, conversation reopening, delayed chat responses, mobile layout and tracking.
