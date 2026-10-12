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

For a combined local checkout, the server serves the sibling `frontend/` files
when they exist. Otherwise, `/` reports API status and `/login` redirects to
`FRONTEND_URL`.

## Deploy on Render

Create a Blueprint from this repository and select this folder/repository as the
root. Render reads `render.yaml`; provide the exact Vercel frontend origin for
`FRONTEND_URL`, choose an admin username, and set a unique strong admin
password. Render generates `SESSION_SECRET`. The service URL used by the
frontend rewrite is `https://smart-library-backend.onrender.com`.

The free Render service uses `/tmp` for SQLite data. Its local database is
ephemeral and can be cleared when the service restarts or redeploys. Use only
sample data on this free demo; choose persistent storage or a managed database
before storing real library records.

## API

- `GET /api/health` — public service/database health check
- `POST /api/login` — authenticate with the configured administrator account
- `POST /api/logout` — invalidate the current session
- `GET /api/session` — verify the current session
- Books, members, loans, and circulation endpoints require a valid session.

The server allows credentialed requests only from `FRONTEND_URL` and local
development origins. Admin sessions expire after eight hours. Login attempts
are rate-limited.
