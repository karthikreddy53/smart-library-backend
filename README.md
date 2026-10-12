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

Set `LIBRARY_ADMIN_USERNAME`, a unique `LIBRARY_ADMIN_PASSWORD` of at least
12 characters, and a random `SESSION_SECRET` of at least 32 characters in
`.env`. Keep `.env` private. The database is created in `data/` by default.
The server serves the frontend files included in this repository.

## Deploy on Render

Create a new Blueprint from this repository and select `render.yaml`. Render
will install the production dependencies, start the web service, and generate
a random `SESSION_SECRET`. Set `FRONTEND_URL` to the exact Vercel deployment
origin (without a trailing slash), and set a unique administrator username
and password in the service environment. Do not use `admin123`.

The included free service stores SQLite data under `/tmp`, which is
ephemeral. Records may be lost when the service restarts or redeploys. Use
sample data only unless you configure a persistent disk on a plan that
supports one.

## API

- `GET /api/health` — public service/database health check
- `POST /api/login` — authenticate with the configured administrator account
- `POST /api/logout` — invalidate the current session
- `GET /api/session` — verify the current session
- Books, members, loans, and circulation endpoints require a valid session.

The API permits credentialed cross-origin requests from the configured
`FRONTEND_URL` and local development origins. Production session cookies use
`Secure` and `SameSite=None` so the Vercel frontend can authenticate to the
Render API. Admin sessions expire after eight hours, and login attempts are
rate-limited.
