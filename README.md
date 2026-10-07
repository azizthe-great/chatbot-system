# Portside — Kenya car import assistant

Frontend prototype for landed-cost quotes, import timing advice, vehicle history, shipment tracking, and an admin learning loop.

## Run

Requires Node.js 18 or newer. No npm dependencies are needed.

```bash
npm start
```

Open http://localhost:3000. Sign in with a demo account. Admins can switch between **Import assistant** and **Admin dashboard** using the top navigation. On a small screen, the service cards stack above the chat.

## Demo accounts

| Role | Username | Password |
|---|---|---|
| User | `importer` | `Importer@2026` |
| Admin | `admin` | `Admin@2026` |

Users access the import assistant. Admins also access activity metrics and can answer unresolved questions. Credentials are verified on the server, passwords are hashed in memory, and session cookies are HttpOnly and SameSite=Strict. Sessions expire after eight hours. Sign out invalidates the server session.

Override the defaults with `USER_PASSWORD` and `ADMIN_PASSWORD` environment variables before starting the server. These are prototype accounts; there is no registration, password reset, database persistence, or production authentication setup yet.

## Try the demo

- Select a landed-cost quote or timing comparison, fill in the vehicle form, and preview the result.
- Vehicle history sample VIN: `JTMBE31V006123456`.
- Tracking sample BL: `BL-KE-1024`; container: `MSKU1234567`.
- Ask an unrecognized question, open the admin dashboard, save an answer, and ask the same question again. Matching ignores case, common punctuation, and extra spaces.
- Queries, model counts, unanswered questions, and saved answers are shared through server memory across signed-in users. New chat clears only the visible conversation. Restarting the server resets demo records and signs everyone out.

## Prototype limits

All monetary figures and service records are illustrative UI fixtures, not current KRA rates or live data. Each model has a fixed cost example; registration, engine, and fuel inputs do not change the result yet. Timing savings show a hypothetical scenario, not an actual depreciation assessment. The dashboard uses shared demo activity; drop-off rate is unavailable until session completion is tracked in the backend. The admin view and admin endpoints require an admin session.

The frontend does not call the existing `/api/chat` endpoint. That endpoint retains the original rule-based chatbot pending backend implementation. PHP/MySQL and XAMPP/WAMP setup should be documented if that stack is chosen for the backend; the current prototype uses Node.js.

## Files

- `public/index.html` — importer and admin screens
- `public/styles.css` — responsive styling
- `public/app.js` — demo flows, intent parsing, login and dashboard
- `auth.js` — hashed demo credentials and eight-hour cookie sessions
- `server.js` — web server, authentication, role checks, shared demo activity and knowledge
- `chatbot.js` — original rule-based backend replies
- `test/chatbot.test.js` — original backend tests
- `test/auth.test.js` — login, roles, learning loop and logout checks

## Check

```bash
node --check public/app.js
npm test
```

Next: agree on the backend stack and database outline, define the shared JSON contract, and replace frontend fixtures with tax, tracking, VIN, and knowledge endpoints.
