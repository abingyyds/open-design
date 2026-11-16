# Railway deployment

Railway deployments currently serve a security maintenance page. The daemon
keeps `/api/health` available for Railway and returns HTTP 503 for application
requests. It does not open the platform credential database or start task and
terminal services. Keep the existing volume attached so data is available for
incident review.

## Required variables

```env
NODE_ENV=production
OD_BIND_HOST=0.0.0.0
OD_DATA_DIR=/data
OD_PLATFORM_ENABLED=1
SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
OD_SUBROUTER_BASE_URL=http://subrouter.railway.internal:8080
OD_SUBROUTER_GATEWAY_BASE_URL=https://api.subrouter.com
OD_SUBROUTER_RESPONSES_MODELS=
```

The private Railway URL is used for login and account management. Codex model
traffic must use the public gateway because Codex requires `/v1/responses`,
which is not exposed by the current private SubRouter service.
The platform model picker only exposes OpenAI/Codex-shaped models that are
compatible with that Responses transport. If a deployment has an additional
Responses-compatible model id, add it to `OD_SUBROUTER_RESPONSES_MODELS`.

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
7. Deploy and verify that `/api/health` returns `ok: true` and
   `maintenance: true`, and that the public home page returns HTTP 503.

## Local hosted task isolation check

Run from the repository root with a local Docker engine:

```sh
corepack pnpm --filter @open-design/daemon build
docker build -f deploy/hosted-worker.Dockerfile -t open-design-hosted-worker:local-isolation apps/daemon
od_test_image=$(docker image inspect open-design-hosted-worker:local-isolation --format '{{.Id}}')
OD_HOSTED_TEST_IMAGE="$od_test_image" corepack pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/platform/hosted-task-isolation.test.ts
```

The tests use real Codex workers, a local fixture gateway, and synthetic
credentials. They exercise both the internal Worker boundary and the
authenticated run and chat routes, including event streaming, file transfer,
cancellation, and cleanup. The test harness enables the hosted listener on
loopback and sets `OD_HOSTED_WORKER_IMAGE` to the id of the local fixture image.
The deployed hosted service continues to start in maintenance mode.
