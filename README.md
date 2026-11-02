# Portside — Kenya vehicle import assistant

Portside is a Node.js web application with a plain HTML/CSS/JavaScript frontend. The backend provides persistent accounts, customer-owned vehicles and enquiries, administrator case updates, shipment management, and audit events. The import-cost estimator can show a clearly marked historical 2021 KRA rate illustration, but it is not connected to KRA and does not provide current tax rates or a final customs total. VIN/chassis lookup validates identifiers, but no live vehicle data provider or carrier tracking provider is configured.

## Requirements

- Node.js 20 or newer (Fastify 5 requires Node 20+; Node 22 LTS or newer is recommended).
- PostgreSQL 15 or newer, running locally or at an approved database host.
- VS Code is optional.

## Windows and VS Code setup

1. Install Node.js from [nodejs.org](https://nodejs.org/) and PostgreSQL from [postgresql.org/download/windows](https://www.postgresql.org/download/windows/). In the PostgreSQL installer, include **Command Line Tools**. Remember the password you set for the local PostgreSQL superuser.
2. Open this project folder in VS Code. Open **Terminal → New Terminal** and confirm `node --version` is at least `v20` and `psql --version` works. If PowerShell blocks `npm.ps1`, use `npm.cmd` in the commands below.
3. Install the project dependencies:

   ```powershell
   npm.cmd install
   ```

4. Create an application database role and database. Open pgAdmin, connect to the local PostgreSQL server using the installer password, and open **Query Tool**. Run these SQL statements. The development role password is local-only; change it and set the same value in `.env` if you prefer.

   ```sql
   CREATE ROLE portside_user LOGIN PASSWORD 'portside_local_dev';
   CREATE DATABASE portside OWNER portside_user;
   ```

   Exit `psql` with `\q`.
5. Portside defaults to the local PostgreSQL URL shown in `.env.example`, so you can start without creating `.env`. If you want a different role password, copy the file and edit the connection string in PowerShell:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Set `DATABASE_URL` to match your local role password. Keep `.env` private; `.gitignore` excludes it.
6. Apply the versioned schema migrations:

   ```powershell
   npm.cmd run db:migrate
   ```

7. Create your initial local administrator. The command prompts for name, email, password, and confirmation; the password entry is hidden and must be at least 12 characters. It does not create a default account.

   ```powershell
   npm.cmd run users:create-admin
   ```

   Create customer accounts the same way with `npm.cmd run users:create-customer`. Public self-registration is not enabled in this phase.
8. Start Portside and open `http://localhost:3000`:

   ```powershell
   npm.cmd start
   ```

9. Run automated tests:

   ```powershell
   npm.cmd test
   ```

The test suite uses an isolated in-memory database adapter and does not connect to or alter the configured PostgreSQL database. A PostgreSQL server is still required to run the application, migrations, and user creation command. The tests exercise API behavior and app restart behavior against the same test adapter; they are not a substitute for verifying schema migrations against a real PostgreSQL instance.

## Environment settings

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string; defaults to the local `portside` database |
| `HOST` | Bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |
| `NODE_ENV` | Use `production` for production deployment behavior |
| `SESSION_TTL_HOURS` | Session lifetime; defaults to 8 hours |
| `COOKIE_SECURE` | Set `true` behind HTTPS; also enabled automatically when `NODE_ENV=production` |
| `TRUST_PROXY` | Set `true` only when deployed behind a trusted reverse proxy |
| `VEHICLE_LOOKUP_TIMEOUT_MS` | Vehicle provider timeout in milliseconds; defaults to 5000 and is bounded from 500 to 15000 |
| `LOG_LEVEL` | Fastify log level; defaults to `info` |

Never use real customer information or production credentials in local development. This phase has not been security-reviewed for production deployment.

## API endpoints

Errors use `{ "error": { "code": "...", "message": "..." } }`. Request validation failures return HTTP 400; unauthenticated requests return 401; authorization failures return 403; records not owned by the signed-in customer are returned as 404.

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /api/auth/register` | Public; rate limited | Create a customer account and sign in |
| `POST /api/auth/login` | Public; rate limited | Sign in with email and password |
| `POST /api/auth/logout` | Public; clears current cookie/session | Sign out |
| `GET /api/auth/me` | Signed in | Current account |
| `GET /api/vehicles` | Customer | List the signed-in customer’s vehicles |
| `POST /api/vehicles` | Customer | Save a vehicle |
| `GET /api/vehicles/:id` | Owning customer | Read one vehicle |
| `PATCH /api/vehicles/:id` | Owning customer | Update one vehicle |
| `POST /api/vehicle-lookup` | Signed in | Look up a VIN or chassis number through the configured provider interface |
| `POST /api/import-cost-estimate` | Customer | Return an itemized, non-persistent Kenya import-cost estimate |
| `GET /api/enquiries` | Customer | List the signed-in customer’s enquiries |
| `POST /api/enquiries` | Customer | Submit an enquiry and receive a reference |
| `GET /api/enquiries/:id` | Owning customer | Read one enquiry |
| `GET /api/shipments` | Customer | List the signed-in customer's shipments and milestone history |
| `GET /api/shipments/:reference` | Owning customer | Read a shipment using its Portside tracking reference |
| `GET /api/admin/enquiries` | Admin | List customer enquiries |
| `PATCH /api/admin/enquiries/:id` | Admin | Update enquiry status/priority |
| `GET /api/admin/customers` | Admin | List active customers for shipment assignment |
| `GET /api/admin/customers/:id/records` | Admin | List a selected customer's vehicles and enquiries for shipment association |
| `GET /api/admin/shipments` | Admin | List shipments and their manual milestone history |
| `POST /api/admin/shipments` | Admin | Create a shipment and its initial milestone |
| `PATCH /api/admin/shipments/:id` | Admin | Update carrier, ports, and dates |
| `POST /api/admin/shipments/:id/milestones` | Admin | Append the next lifecycle milestone |
| `GET /health` | Public | Basic process health check |

Legacy `/api/login`, `/api/logout`, and `/api/session` routes remain as compatibility aliases; the old demo username accounts are no longer provisioned. The assistant activity, knowledge queue, and chatbot endpoints remain prototype features, and dashboard activity is still in memory.

## Vehicle intelligence

The Vehicle history workflow accepts a 17-character VIN (excluding I, O, and Q) or a 5–40 character chassis number containing letters, digits, or hyphens. `POST /api/vehicle-lookup` requires a signed-in user and is limited to 10 requests per 15 minutes per client. It normalizes the identifier and calls an injected provider that implements `lookup({ identifier, identifierType, signal })` and returns normalized vehicle details, history availability, photos, and market value. The request is aborted after `VEHICLE_LOOKUP_TIMEOUT_MS`.

No external vehicle-history provider or credentials are configured in this project. Until a supported provider adapter is implemented and configured, valid lookups return `status: "unavailable"` with `reason: "provider_not_configured"`. An adapter can return `status: "not_found"` for a provider no-match; that is not evidence of a clean history. The app does not infer mileage, accident, theft, ownership, or a clean history. Provider failures return safe generic errors; timeouts return HTTP 504 and provider rate limits return HTTP 429. Provider-supplied results are labelled by source and are not independently verified by Portside.

Provider adapters should keep API credentials server-side in environment variables or a secret manager, never in frontend files or source control. Confirm the provider's supported markets, data coverage, and terms before connecting it. When provider results include make and model, customers can save that vehicle through the existing customer-owned vehicle endpoint. Saved vehicles remain scoped to their owner. Lookup reports themselves are not persisted, and this feature adds no database tables or migrations.

## Kenya import-cost estimator

The existing landed-cost chat action now calls `POST /api/import-cost-estimate`. The endpoint requires a customer session, is limited to 10 requests per 15 minutes per client, validates the vehicle/purchase inputs, and does not save estimates. Supported currencies are KES, USD, GBP, EUR, JPY, AED, ZAR, CAD, AUD, SGD, INR, CNY, and HKD. Foreign values are converted only when the customer enters a positive KSh-per-unit exchange rate together with its date and source. The supplied source is displayed as user-provided, not certified by Portside.

The quote form has editable presets for Toyota Harrier, Toyota Prado, Mazda CX-5, and Nissan X-Trail. Selecting one fills example vehicle details and placeholder KSh purchase, freight, and insurance amounts. The dependent make/model selectors also offer BMW M Series and X Series categories; those series choices identify make/model only and do not imply a specific trim, engine, or price. Sample costs are illustrative only, not current prices or quotes, and should be replaced with actual amounts. Presets never fill customs value; enter that only when assessed or supplied by KRA/a licensed clearing agent. No preset produces an official or final landed cost.

Tax and fee rules are centralized in `src/config/import-cost-rules.js`. The estimator currently applies rates from KRA's vehicle import guide dated 27 January 2021 as a **historical reference only**: import duty 25%, excise duty 20% for engine capacity up to 1,500 cc or 25% above that (petrol, diesel, and hybrid only), VAT 16%, IDF 3.5%, and RDL 2%. The KRA page's prose says IDF is 3.5%, while its worked example uses 4%; the illustration follows the prose rate and calls out the discrepancy. These rates must not be represented as current or as a live KRA result. Because historical rules are enabled, the application always withholds a final total. Other charges remain unconfigured, and the historical excise rule is unavailable for unsupported fuels (including electric vehicles). Customers may enter a customs value only when supplied by KRA or a clearing agent. The purchase price, freight, and insurance are shown as transaction inputs and are not substituted for official customs valuation. No database migration is used.

KRA's [2021 vehicle import guide](https://www.kra.go.ke/news-center/blog/1075-what-you-need-to-know-when-importing-a-motor-vehicle) provides historical formula examples only. KRA issued a [used-vehicle CRSP notice effective 1 July 2025](https://www.zd.kra.go.ke/news-center/public-notices/2223-current-retail-selling-price-crsp-for-used-motor-vehicles), a [CRSP implementation clarification](https://www.kra.go.ke/news-center/press-release/2224-clarification-on-implementation-of-revised-current-retail-selling-price-crsp-list-for-used-motor-vehicles), and a [September 2026 valuation statement](https://www.kra.go.ke/news-center/press-release/2392-clarification-on-concerns-regarding-cargo-clearance-raised-by-clearing-agents-and-motor-vehicle-dealers) saying the valuation matter was before the court. The project has no documented KRA API connection. Vehicle classification, applicable exemptions, assessed value, current effective law, and non-tax charges need confirmation with KRA or a licensed clearing agent before an estimate can be treated as current. See [KRA foreign-exchange rates](https://www.kra.go.ke/foreign-exchange) and [CBK indicative rates](https://www.centralbank.go.ke/rates/forex-exchange-rates/) for reference; neither is automatically applied as a customs conversion rate by this app.

The historical ruleset never yields a final total. Do not remove that safeguard or change it to current without a current official rate source, confirmation of taxable bases and vehicle classifications, and updated tests. A future KRA integration requires an official API or data feed and credentials supplied through local environment settings or a secret manager; the current estimator does not make live KRA requests. Any estimate is not an official customs assessment or clearing quote.

## Customer dashboard and shipment tracking

The customer dashboard loads only the signed-in customer's saved vehicles, enquiries, and shipment records. Shipment API queries include the authenticated customer ID, and unknown or other-customer references return the same not-found response. Customers can use the existing vehicle lookup and import-estimate workflows from the dashboard; they cannot change shipment status.

Administrators create shipments at `purchase_confirmed`, which creates a unique `PST-SHP-<year>-<random>` reference and an initial manually entered event. The documented forward-only lifecycle is `purchase_confirmed` → `export_processing` → `awaiting_vessel` → `departed` → `in_transit` → `arrived_destination` → `customs_clearance` → `released_delivered`. Each status update must advance exactly one step and appends a timestamped event with its admin actor. Administrators may edit carrier, ports, and dates. Estimated arrival dates and carrier/port details are manual entries, not provider data. Event timestamps cannot be future-dated or precede the previous event.

Shipment storage is introduced by forward-only migration `002_shipments.sql`. It creates `shipments` and `shipment_milestones`, with owner and actor foreign keys, status checks, a unique tracking reference, and indexes. It does not rewrite existing records. Apply it with `npm.cmd run db:migrate` after reviewing the migration and backing up any production database; the application does not automatically run migrations. The project tests use an in-memory adapter and do not apply this migration to PostgreSQL. No real shipment records were created for development or tests.

## Database migrations

Migration files live in `migrations/` and run in numeric order. Applied migration filenames are recorded in `schema_migrations`; each migration is run transactionally. Back up the database before applying new production migrations. The initial schema creates users, customer profiles, vehicles, enquiries, audit events, and hashed-token sessions, with foreign keys, checks, and indexes.

## Troubleshooting

- **Password authentication failed**: Ensure the `portside_user` role password matches the local default (`portside_local_dev`) or the URL in `.env`.
- **Connection refused**: Ensure the PostgreSQL Windows service is running and the port (usually 5432) is correct.
- **Password authentication failed**: Check the role password in `DATABASE_URL`; URL-encode special characters in the password.
- **Database does not exist**: Create `portside` and assign it to `portside_user` using the SQL setup above.
- **`psql` is not recognized**: Re-run the PostgreSQL installer with Command Line Tools selected, then reopen VS Code so PATH refreshes.
- **PowerShell blocks npm**: Use `npm.cmd` rather than changing the machine’s execution policy.
- **Port 3000 is busy**: Set another `PORT` in `.env`, then restart the server.

## Phase 1 limits

There is no configured production tax calculator, live shipping provider, payment processing, document upload, email/SMS notification, or AI web search. Shipment milestones are stored and entered manually; no vessel positions or carrier events are available. Vehicle lookup validates VIN/chassis input, but live specifications and history remain unavailable until a supported provider is integrated. Assistant query counts, unresolved questions, and saved answers remain process memory.
