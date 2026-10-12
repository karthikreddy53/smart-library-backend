# Smart Library Management System — Backend

Express API for the Smart Library Management System. It provides the book,
member, loan, authentication, and health endpoints, backed by SQLite.

## Run locally

Requirements: Node.js 22.13 or newer and npm.

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Before starting, set `LIBRARY_ADMIN_USERNAME`, a unique
`LIBRARY_ADMIN_PASSWORD` of at least 12 characters, a random `SESSION_SECRET`
of at least 32 characters, and `FRONTEND_URL`. Do not use `admin123` on a
publicly reachable server. Keep `.env` private.

The deployment repository includes the static frontend files beside
`server.js`. In the original combined checkout, the server instead serves the
sibling `../frontend/` directory. If neither frontend copy exists, `/` reports
API status and `/login` redirects to `FRONTEND_URL`.

## Deploy the complete app on Railway

Import `karthikreddy53/smart-library-backend` in Railway. Railway detects
`package.json` and runs `npm start`. Configure `LIBRARY_ADMIN_USERNAME`, a
unique `LIBRARY_ADMIN_PASSWORD` (at least 12 characters), and `SESSION_SECRET`
(at least 32 random characters). Set `DATA_DIR` to a Railway Volume mount path
to retain SQLite data. Do not use `admin123` or real student records.

The bundled frontend and API use one origin, so the app does not require a
second Vercel project. Generate a Railway public domain for the web service;
the final site opens at that domain. For a separate Vercel frontend, set
`FRONTEND_URL` to its exact origin and update its `vercel.json` rewrite to the
Railway backend URL.

## API

- `GET /api/health` — public service/database health check
- `POST /api/login` — authenticate with the configured administrator account
- `POST /api/logout` — invalidate the current session
- `GET /api/session` — verify the current session
- Books, members, loans, and circulation endpoints require a valid session.

The server allows credentialed requests only from `FRONTEND_URL` and local
development origins. Admin sessions expire after eight hours. Login attempts
are rate-limited.
