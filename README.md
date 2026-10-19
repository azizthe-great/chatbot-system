# Portside — Kenya vehicle import assistant

Portside is a Node.js web application with a plain HTML/CSS/JavaScript frontend. The current backend adds persistent accounts, customer-owned vehicles and enquiries, administrator case updates, and audit events. Import-cost, shipment and VIN screens remain clearly labelled demonstrations; they are not connected to live services.

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
| `GET /api/enquiries` | Customer | List the signed-in customer’s enquiries |
| `POST /api/enquiries` | Customer | Submit an enquiry and receive a reference |
| `GET /api/enquiries/:id` | Owning customer | Read one enquiry |
| `GET /api/admin/enquiries` | Admin | List customer enquiries |
| `PATCH /api/admin/enquiries/:id` | Admin | Update enquiry status/priority |
| `GET /health` | Public | Basic process health check |

Legacy `/api/login`, `/api/logout`, and `/api/session` routes remain as compatibility aliases; the old demo username accounts are no longer provisioned. The assistant activity, knowledge queue, and chatbot endpoints remain prototype features, and dashboard activity is still in memory.

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

There is no public customer registration or password reset yet; use the local account setup command. Sessions and records are persisted in PostgreSQL, while the assistant’s demo query counts, unresolved questions, and saved answers are still process memory. There is no production tax calculator, live shipping or vehicle-history provider, payment processing, document upload, email/SMS notification, or AI web search. The existing quote, timing, tracking, and VIN demonstrations remain illustrative only.
