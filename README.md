# Generic Spin Wheel Backend

A separate spin-wheel project that ports the core behavior of the older Dostt spin-wheel app into a generic Postgres-based stack.

It works with:
- local PostgreSQL through Docker Compose
- hosted PostgreSQL
- Supabase Postgres through a standard `DATABASE_URL`

This repo does not depend on `supabase-js`.

## What it includes

- reusable generic DB client
- local PostgreSQL via Docker Compose
- separate command to create spin-wheel tables automatically
- served frontend with login, wheel, countdowns, tester panel, reward modal, transfer modal
- Express API for player registration, spin, state, transfers, tester reset, and public config
- deterministic daily reward logic from the older repo
- tester-only forced rewards and custom transfer amounts
- once-per-day transfer restriction for normal users
- optional Redash + Dostt + Slack transfer integration through environment variables

## Setup

1. Copy `.env.example` to `.env`
2. Install dependencies:
   `npm install`
3. Start local PostgreSQL:
   `docker compose up -d`
4. Create the spin-wheel tables:
   `npm run db:create-tables`
5. Test database connectivity:
   `npm run db:test`
6. Start the backend:
   `npm run dev`
7. Open:
   `http://localhost:3000`

## Main commands

```bash
npm run db:create-tables
npm run db:test
npm run dev
```

## Docker

Build the production image locally:

```bash
docker build -t generic-db-client:local .
```

Run it against a Postgres database:

```bash
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e DATABASE_URL=postgresql://app_user:app_password@host.docker.internal:5432/app_db \
  -e DB_SSL=false \
  generic-db-client:local
```

Then open:
`http://localhost:3000`

## GHCR publishing

This repo includes a GitHub Actions workflow that builds and publishes a Docker image to GitHub Container Registry (GHCR) on every push to `main`.

Published image pattern:

```text
ghcr.io/<github-owner>/<repo>:latest
ghcr.io/<github-owner>/<repo>:sha-<commit>
```

For this repo, the image name will be:

```text
ghcr.io/marieswar-sketch/generic-db-client
```

## Kubero deployment

Kubero runs on top of Kubernetes. The easiest path for this app is:

1. Create a managed Kubernetes cluster
2. Install Kubero with the Kubero CLI
3. Create a Kubero pipeline/environment
4. Create an app with deployment strategy set to `Docker`
5. Point the app to:
   `ghcr.io/marieswar-sketch/generic-db-client:latest`
6. Set the app container port to:
   `3000`
7. If the image is private, add GHCR pull credentials in Kubero
8. Add a PostgreSQL add-on in Kubero, or use an external Postgres database
9. Set app environment variables in Kubero
10. Run the schema once against the target database using:
   `npm run db:create-tables`

### Recommended Kubero environment variables

```env
PORT=3000
DATABASE_URL=postgresql://...
DB_SSL=true
TESTER_MOBILE_NUMBERS=9500365660,9600692495
TRANSFER_MODE=provider
REDASH_API_KEY=...
REDASH_QUERY_ID=...
DOSTT_AUTH_KEY=...
SLACK_WEBHOOK_URL=...
```

Notes:
- Keep real secrets only in Kubero secrets or local `.env`
- Do not commit live secrets into `.env.example`
- Use Kubero's PostgreSQL add-on unless you already have an external managed Postgres
- If GHCR image access is private, Kubero must be configured with a GitHub username/token that can pull `ghcr.io/marieswar-sketch/generic-db-client`

## Default API routes

- `GET /health`
- `GET /api/config`
- `POST /api/players/register`
- `GET /api/players/:mobileNumber/state`
- `POST /api/spin`
- `POST /api/transfers`
- `POST /api/test/reset`

## Example `.env`

### Local PostgreSQL

```env
DATABASE_URL=postgresql://app_user:app_password@localhost:5432/app_db
DB_SSL=false
PORT=3000
```

### Supabase Postgres

```env
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
DB_SSL=true
PORT=3000
```

## Transfer integration

Set `TRANSFER_MODE=mock` for local testing with no external provider.

To mimic the older repo's transfer flow, set:

```env
TRANSFER_MODE=provider
REDASH_API_KEY=...
REDASH_QUERY_ID=...
DOSTT_AUTH_KEY=...
SLACK_WEBHOOK_URL=...
```

If these are not configured, the app can still run locally in mock mode.
