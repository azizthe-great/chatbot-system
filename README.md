# Portside — Kenya vehicle import assistant

Portside is a Node.js web application with a plain HTML/CSS/JavaScript frontend. Accounts, sessions, conversations, saved estimates, the admin knowledge base, customer vehicles and enquiries, and audit events are stored in a database. Customers can register, sign in with Google, and recover their password with a one-time recovery code. Import-cost, shipment and VIN results use clearly labelled demo data unless a provider adapter is configured.

## Requirements

- Node.js 20 or newer.
- Nothing else. The database is built in: Portside runs PostgreSQL inside the Node process ([PGlite](https://pglite.dev/)) and stores it in `data/portside-db`. A separate PostgreSQL server is optional.

## Quick start

1. In the project folder, copy the settings file:

   ```bash
   cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
   ```

2. Open `.env` and fill in the administrator account, with a password of at least 12 characters:

   ```
   ADMIN_NAME=Your name
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD=choose-a-long-password
   ```

3. Install and start (on Windows PowerShell, use `npm.cmd` if `npm` is blocked):

   ```bash
   npm install
   npm start
   ```

4. Open http://localhost:3000 and sign in with that email and password. Then change the password in **Account**; the one in `.env` is only used to create the account the first time.

The database and the administrator are created automatically on the first start. Customers create their own accounts on the welcome page. Stop the server with Ctrl+C.

To start again from an empty database, stop the server and delete the `data/portside-db` folder. The `data/` folder is excluded from git. The `npm run users:create-admin` and `users:create-customer` commands still work for adding more accounts; stop the server first, because only one process can open the local database at a time.

## Tests

```bash
npm test                      # API tests on a fresh in-memory database
npx playwright install chromium
npm run test:e2e              # browser tests with two seeded accounts
```

Tests never touch `data/portside-db` or a configured `DATABASE_URL`.

## Using a PostgreSQL server instead (optional)

For a shared or production deployment, use PostgreSQL 15 or newer:

1. Create a role and database, for example:

   ```sql
   CREATE ROLE portside_user LOGIN PASSWORD 'choose-a-password';
   CREATE DATABASE portside OWNER portside_user;
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL=postgresql://portside_user:choose-a-password@localhost:5432/portside`. URL-encode special characters in the password. Keep `.env` private; `.gitignore` excludes it.
3. Apply migrations with `npm run db:migrate`, then start the server as above. With `DATABASE_URL` set, migrations are not run automatically.

## Environment settings

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string; leave unset to use the built-in local database |
| `PORTSIDE_DATA_DIR` | Folder for the built-in local database; defaults to `data/portside-db` |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Administrator account created on start if it does not exist yet |
| `HOST` | Bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |
| `NODE_ENV` | Use `production` for production deployment behavior |
| `SESSION_TTL_HOURS` | Session lifetime; defaults to 8 hours |
| `COOKIE_SECURE` | Set `true` behind HTTPS; also enabled automatically when `NODE_ENV=production` |
| `TRUST_PROXY` | Set `true` only when deployed behind a trusted reverse proxy |
| `LOG_LEVEL` | Fastify log level; defaults to `info` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Enable Google sign-in; see below |
| `PORTSIDE_QUOTE_URL`, `PORTSIDE_ADVISOR_URL`, `PORTSIDE_VIN_URL`, `PORTSIDE_TRACKING_URL`, `PORTSIDE_PROVIDER_TOKEN` | Optional provider adapters; see below |

Never use real customer information or production credentials in local development. This phase has not been security-reviewed for production deployment.

## API endpoints

Errors use `{ "error": { "code": "...", "message": "..." } }`. Request validation failures return HTTP 400; unauthenticated requests return 401; authorization failures return 403; records not owned by the signed-in customer are returned as 404.

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /api/auth/register` | Public; rate limited | Create a customer account, sign in, and receive a one-time recovery code |
| `POST /api/auth/reset-password` | Public; rate limited | Reset a password with email and recovery code; signs out all sessions |
| `GET /api/auth/config` | Public | Whether Google sign-in is configured |
| `GET /api/auth/google`, `GET /api/auth/google/callback` | Public; browser navigation | Google OpenID Connect sign-in |
| `POST /api/auth/login` | Public; rate limited | Sign in with email and password |
| `POST /api/auth/logout` | Public; clears current cookie/session | Sign out |
| `GET /api/auth/me` | Signed in | Current account |
| `POST /api/profile` | Signed in | Change name, password or recovery code |
| `GET /api/catalog` | Signed in | Vehicle models and which providers are connected |
| `GET`/`POST /api/conversations`, `GET`/`POST`/`DELETE /api/conversations/:id` | Owner | List (paginated), create, read, rename/complete and delete conversations |
| `POST /api/chat` | Owner with `conversationId`; public without | Send a message; `requestId` makes retries safe |
| `POST /api/services/:service` | Owner | Run `quote`, `advisor`, `vin` or `tracking` inside a conversation |
| `GET`/`POST /api/quotes`, `DELETE /api/quotes/:id` | Owner | Saved estimates |
| `GET /api/knowledge` | Signed in | Admin-approved answers |
| `GET /api/admin` | Admin | Dashboard metrics, unanswered queue and knowledge, with date and search filters |
| `POST /api/answers` | Admin | Answer an unanswered question |
| `POST /api/admin/knowledge`, `DELETE /api/admin/knowledge/:id` | Admin | Create, edit or delete answers |
| `DELETE /api/admin/questions/:id` | Admin | Dismiss an unanswered question |
| `GET /api/vehicles` | Customer | List the signed-in customer’s vehicles |
| `POST /api/vehicles` | Customer | Save a vehicle |
| `GET /api/vehicles/:id` | Owning customer | Read one vehicle |
| `PATCH /api/vehicles/:id` | Owning customer | Update one vehicle |
| `GET /api/enquiries` | Customer | List the signed-in customer’s enquiries |
| `POST /api/enquiries` | Customer | Submit an enquiry and receive a reference |
| `GET /api/enquiries/:id` | Owning customer | Read one enquiry |
| `GET /api/admin/enquiries` | Admin | List customer enquiries |
| `PATCH /api/admin/enquiries/:id` | Admin | Update enquiry status/priority |
| `GET /health` | Public | Basic process health check |

Legacy `/api/login`, `/api/logout`, and `/api/session` routes remain as compatibility aliases; the old demo username accounts are no longer provisioned. Non-GET requests from another origin are rejected.

## Database migrations

Migration files live in `migrations/` and run in numeric order. Applied migration filenames are recorded in `schema_migrations`; each migration is run transactionally. Back up the database before applying new production migrations. `001_initial.sql` creates users, customer profiles, vehicles, enquiries, audit events, and hashed-token sessions. `002_assistant.sql` adds Google and recovery-code columns to users, plus conversations, messages, saved estimates, knowledge, unanswered questions, and query events.

## Google sign-in

The welcome screen appears before login. Choose **Log in** or **Get started**, then use your email or **Sign in with Google**. Google sign-in is disabled with a clear availability message until the following server environment variables are configured:

Set these in `.env` or the server environment:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

In the [Google Cloud console](https://console.cloud.google.com/auth/overview), configure your app's OAuth consent screen and create an OAuth client with application type **Web application**. Add `http://localhost:3000/api/auth/google/callback` as an **Authorized redirect URI**, exactly matching `GOOGLE_REDIRECT_URI`. If using `http://127.0.0.1:3000`, add and configure that exact URI instead, and access Portside using the same host. For a deployed app, use `https://your-domain/api/auth/google/callback` and `NODE_ENV=production`. A testing-mode consent screen may require adding allowed test users. Follow Google's [web server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred) for credential and consent-screen configuration.

The client secret stays on the server. No Google SDK or tracking script is loaded by the welcome page. Selecting the Google button navigates to Google to authorize the basic `openid email profile` scopes. The server validates the callback, exchanges the code and verifies the signed identity token before issuing a Portside session. State, a short-lived browser-bound cookie, PKCE and nonce protect the authorization round trip. Cancellation and verification failures return to the login screen with safe messages; codes and error parameters are removed from the address bar.

Google accounts are identified by Google's stable subject identifier, never automatically linked by matching an email address. New Google users receive the customer role. Existing password and admin accounts keep their existing sign-in method. Google users can update their Portside display name; password and recovery settings remain managed through Google. No Google access or refresh tokens are stored in the database. The OAuth browser cookie uses SameSite=Lax for the redirect; the normal Portside session remains HttpOnly with SameSite=Strict.

The flow follows Google's [OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect). Real sign-in needs valid credentials and a consent screen from your Google Cloud project; automated tests use mocked Google responses and test signing keys.

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

Set them in `.env` or your hosting environment. Provider secrets stay on the server. Requests are JSON POSTs with a 12-second timeout and an optional `Authorization: Bearer ...` header. Each URL must implement the contract below; an arbitrary third-party API generally needs an adapter. Provider accounts, approved data sources and credentials must be supplied to enable real data.

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

## Troubleshooting

- **"No administrator account exists" in the server log**: Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and restart.
- **"The local database is in use by another Portside process"**: Stop the running server with Ctrl+C before running `users:create-admin` or starting a second server.
- **Database connection error on start**: You have `DATABASE_URL` set in `.env`. Comment it out to use the built-in local database, or see the PostgreSQL section above.
- **PowerShell blocks npm**: Use `npm.cmd` rather than changing the machine’s execution policy.
- **Port 3000 is busy**: Set another `PORT` in `.env`, then restart the server.

PostgreSQL server only:

- **Connection refused**: Ensure the PostgreSQL service is running and the port (usually 5432) is correct.
- **Password authentication failed**: Check the role password in `DATABASE_URL`; URL-encode special characters in the password.
- **Database does not exist**: Create the database using the SQL above.

## Current limits

Password recovery uses recovery codes; no email delivery service is configured. There is no production tax calculator, live shipping or vehicle-history provider, payment processing, document upload, email/SMS notification, or AI web search. The existing quote, timing, tracking, and VIN demonstrations remain illustrative only.
