# Kubero deployment guide

This app is ready to run in Kubero as a Docker-based web application.

## 1. Install Kubero

Kubero requires a Kubernetes cluster first.

Recommended beginner path:
- create a managed Kubernetes cluster
- install Kubero CLI
- run Kubero install

Official references:
- https://www.kubero.dev/docs/
- https://www.kubero.dev/docs/usermanual/deployment/
- https://www.kubero.dev/docs/usermanual/addons/

## 2. Container image

This repo publishes a Docker image to GHCR on pushes to `main`.

Image:

```text
ghcr.io/marieswar-sketch/generic-db-client:latest
```

## 3. Create the Kubero app

In Kubero:

1. Create a pipeline and environment
2. Create a new app
3. Choose deployment strategy: `Docker`
4. Image:
   `ghcr.io/marieswar-sketch/generic-db-client:latest`
5. Workload type:
   `web`
6. Port:
   `3000`
7. If the image is private, add GHCR registry credentials in Kubero so it can pull the image

## 4. Database

Preferred option:
- add Kubero PostgreSQL add-on

Alternative:
- use an external managed Postgres database

The app expects:

```env
DATABASE_URL=postgresql://...
DB_SSL=true
```

If using a local/private Postgres inside the cluster, `DB_SSL=false` may be appropriate.

## 5. App environment variables

Configure these in Kubero:

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
REDASH_ELIGIBILITY_QUERY_ID=...
```

## 6. Initialize the schema

Run the schema once against the target database:

```bash
npm run db:create-tables
```

Schema source:

```text
sql/create_spin_wheel_tables.sql
```

## 7. Recharge gate daily job

The server runs the recharge gate itself (`src/recharge-gate-scheduler.js`),
daily at `RECHARGE_GATE_RUN_AT_IST` (default 02:00 IST). It locks rewards for
unpaid users with 5+ unique spin days, using the Redash list from
`REDASH_ELIGIBILITY_QUERY_ID`. It doesn't start if that variable is unset.
A Postgres advisory lock means only one replica runs it, and on boot it
catches up if the last successful run is more than 23h old. Every run is
logged and recorded in `recharge_gate_runs`. For a manual run, use
`npm run job:recharge-gate:dry` / `npm run job:recharge-gate`.

## 8. Validation checklist

- app starts and `/health` returns `200`
- UI loads through Kubero ingress
- player registration works
- spin works
- transfer works with configured provider mode
- Slack notifications appear only when webhook is configured
