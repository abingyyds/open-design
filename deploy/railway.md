# Railway deployment

Railway deployments start in maintenance by default. In maintenance the
daemon serves `/api/health` for Railway and returns HTTP 503 for application
requests. Keep the existing volume attached for project data and incident
review.

## Required variables

```env
NODE_ENV=production
OD_BIND_HOST=0.0.0.0
OD_DATA_DIR=/data
OD_PLATFORM_ENABLED=1
SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
OD_SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
```

The private Railway URL is used for account authentication. Hosted
Open Design disables agent runs, model proxy requests, and automation
endpoints. Login does not provision model keys. The Railway image skips the
Codex CLI install. The standard local Docker image retains the CLI and
automation endpoints.

Railway provides `PORT` automatically. Do not set `OD_PORT` unless you have a
specific reason to override local runs.

## Volume

Create one Railway Volume and mount it at:

```text
/data
```

See the [daemon data directory contract](../AGENTS.md#daemon-data-directory-contract)
for the volume and isolated hosted-task data roots.

## Deploy

1. Create a Railway service from `abingyyds/open-design`.
2. Select branch `main`.
3. Keep the root directory as the repository root.
4. Railway will use `railway.toml` and `deploy/Dockerfile`.
5. Add the variables above.
6. Keep the existing volume mounted.
7. Deploy in maintenance and verify that `/api/health` reports
   `maintenance: true` and the home page returns HTTP 503.
8. Set `OD_HOSTED_MAINTENANCE=0` on the Open Design service to enable
   authenticated access. Verify that the home page returns HTTP 200 and
   unauthenticated project API requests return HTTP 401. Railway keeps the
   maintenance page active if tenant authentication is disabled. Set
   `OD_HOSTED_MAINTENANCE=1` to restore the maintenance page.

## Local hosted task isolation check

Run from the repository root with a local Docker engine:

```sh
corepack pnpm --filter @open-design/daemon build
docker build -f deploy/hosted-worker.Dockerfile -t open-design-hosted-worker:local-isolation apps/daemon
od_test_image=$(docker image inspect open-design-hosted-worker:local-isolation --format '{{.Id}}')
OD_HOSTED_TEST_IMAGE="$od_test_image" corepack pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/platform/hosted-task-isolation.test.ts
```

The standalone test exercises the worker boundary with real Codex workers,
a local gateway and synthetic credentials. Hosted HTTP requests cannot start
these workers.
